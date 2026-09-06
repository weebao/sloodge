/**
 * The M3.6 element transforms that are *actions* rather than drags — flip H/V, duplicate, and the
 * commit half of rotate — funnelled through one hook so the overlay's rotation handle, the property
 * panel's buttons, and the `Ctrl/⌘+D` accelerator all share one implementation of "patch the source,
 * push one undoable command, keep the selection right".
 *
 * ## The re-derivation rule, enforced here (§2.2, normative)
 *
 * Every action re-derives the element from the **store's current bytes** and the parent-tracked
 * `slId` (`designStore.selection.slId`) at call time — never a bridge payload, never the render-time
 * prop. The pure builders (`buildFlipPatch` / `buildRotatePatch` / `buildDuplicatePatch`) do the span
 * math; this hook is only wiring. Each action commits through `setSlideHtml` as exactly one command
 * with a `design` origin, so the native Edit menu's undo reverses it byte-exact.
 */

import { useCallback } from 'react'
import type { SlHit } from '../../../../shared/design/bridge-protocol'
import { buildDuplicatePatch, type DuplicateOffset } from '../../../../shared/design/duplicate'
import { buildSlideMap } from '../../../../shared/design/slide-map'
import { buildFlipPatch, buildRotatePatch } from '../../../../shared/design/transform-commit'
import type { FlipAxis } from '../../../../shared/design/transform'
import type { ElementSpan } from '../../../../shared/design/types'
import { getSlideHtml, useDeckStore } from '../../stores/deckStore'
import { useDesignStore } from './designStore'

/** PowerPoint nudges a duplicate down-and-right so it does not sit exactly over the original. */
const DUPLICATE_OFFSET: DuplicateOffset = { dx: 16, dy: 16 }

/**
 * Whether the element's subtree holds any visible text — the one case a flip has a consequence the
 * user may not have meant. `scaleX(-1)` mirrors the glyphs along with the box, because CSS has no
 * way to flip a container and leave its text readable; PowerPoint counter-flips text and Figma
 * mirrors it, and Sloodge mirrors (the transform is the source of truth and a counter-flip would
 * mean editing every text descendant). Mirrored text is legible enough to look like a bug rather
 * than a choice, so the flip goes through and the notice names what happened and how to undo it.
 * Markup is stripped from the inner bytes; what remains is text.
 */
function hasVisibleText(source: string, element: ElementSpan): boolean {
  if (element.inner === null) return false
  const inner = source.slice(element.inner.start, element.inner.end)
  return inner.replace(/<[^>]*>/g, '').trim().length > 0
}

export interface ElementActions {
  /** Flip the selected element on `axis`, one undoable command. */
  readonly flip: (axis: FlipAxis) => void
  /** Duplicate the selected element's subtree and select the clone, one undoable command. */
  readonly duplicate: () => void
  /** Rotate the selected element to `degrees` (already snapped), one undoable command. */
  readonly rotateTo: (startDeg: number, degrees: number) => void
  /** Whether an element is selected — the actions no-op otherwise. */
  readonly hasSelection: boolean
}

export function useElementActions(slideId: string): ElementActions {
  const selection = useDesignStore((state) => state.selection)
  const setSelection = useDesignStore((state) => state.setSelection)
  const setNotice = useDesignStore((state) => state.setNotice)
  const setSlideHtml = useDeckStore((state) => state.setSlideHtml)

  const flip = useCallback(
    (axis: FlipAxis): void => {
      if (selection === null) return
      const current = getSlideHtml(useDeckStore.getState().slideHtml, slideId)
      if (current === undefined) return
      const patched = buildFlipPatch(slideId, current, selection.slId, axis)
      if (patched === current) return
      if (
        !setSlideHtml(
          slideId,
          patched,
          selection.slId,
          axis === 'x' ? 'Flip horizontal' : 'Flip vertical',
        )
      ) {
        return
      }
      const element = buildSlideMap(slideId, current).byId.get(selection.slId)
      if (element !== undefined && hasVisibleText(current, element)) {
        setNotice({
          slideId,
          text: 'Flipped — the text is mirrored with it. Flip the same way again to restore it.',
        })
      }
    },
    [selection, slideId, setSlideHtml, setNotice],
  )

  const rotateTo = useCallback(
    (startDeg: number, degrees: number): void => {
      if (selection === null) return
      if (Math.round(startDeg) === Math.round(degrees)) return
      const current = getSlideHtml(useDeckStore.getState().slideHtml, slideId)
      if (current === undefined) return
      const patched = buildRotatePatch(slideId, current, selection.slId, degrees)
      if (patched === current) return
      setSlideHtml(slideId, patched, selection.slId, `Rotate ${String(degrees)}°`)
    },
    [selection, slideId, setSlideHtml],
  )

  const duplicate = useCallback((): void => {
    if (selection === null) return
    const current = getSlideHtml(useDeckStore.getState().slideHtml, slideId)
    if (current === undefined) return
    const result = buildDuplicatePatch(slideId, current, selection.slId, DUPLICATE_OFFSET)
    if (result === null) return

    // The clone's fresh slId only exists after re-parsing (ids are positional; see duplicate.ts), so
    // resolve it from the patched map by the offset the insert reports, then select it.
    const map = buildSlideMap(slideId, result.source)
    const clone = [...map.byId.values()].find((span) => span.outer.start === result.cloneStart)
    if (clone === undefined) return
    if (!setSlideHtml(slideId, result.source, clone.slId, 'Duplicate element')) return

    const classAttr = clone.attrs['class']
    const idAttr = clone.attrs['id']
    // The clone's box is the original's, shifted by the nudge it actually received — a clone that
    // could not be nudged (see `duplicate.ts`) sits exactly over the original, and its selection box
    // must say so rather than outline empty canvas 16px away.
    const nudge = result.nudged ? DUPLICATE_OFFSET : { dx: 0, dy: 0 }
    const offsetRect = (rect: SlHit['rect']): SlHit['rect'] => ({
      ...rect,
      x: rect.x + nudge.dx,
      y: rect.y + nudge.dy,
    })
    const cloneHit: SlHit = {
      slId: clone.slId,
      tag: clone.tagName,
      id: idAttr?.value ? result.source.slice(idAttr.value.start, idAttr.value.end) : null,
      classes: classAttr?.value
        ? result.source
            .slice(classAttr.value.start, classAttr.value.end)
            .split(/\s+/)
            .filter(Boolean)
        : [],
      rect: offsetRect(selection.rect),
      ...(selection.box === undefined ? {} : { box: offsetRect(selection.box) }),
      ancestors: selection.ancestors,
    }
    setSelection(cloneHit)
    if (!result.nudged) {
      setNotice({
        slideId,
        text: 'Duplicated in place — this element is positioned in percentages, so the copy sits exactly over the original.',
      })
    }
  }, [selection, slideId, setSlideHtml, setSelection, setNotice])

  return { flip, duplicate, rotateTo, hasSelection: selection !== null }
}
