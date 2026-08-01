/**
 * The pointer-gesture half of drag-to-move / resize — §5.5 of
 * `.claude/plans/init/40-design-mode.md`. It owns the mechanics of one drag: capture the start
 * point and the element's start rect on `pointerdown`, follow the pointer with a rAF-throttled live
 * preview, and on `pointerup` hand the *committed* geometry to `onCommit` — exactly once.
 *
 * All the geometry is the pure `drag.ts` / `overlay-geometry.ts` layer; this hook is thin wiring, so
 * the only things worth asserting about it are behaviours a component test drives through the overlay
 * (one commit per gesture, none for a zero-move click, Esc cancels).
 *
 * The window listeners are installed **once** for the component's life and gated on an
 * `active`-drag ref, rather than added and removed per gesture: a single unmount cleanup then
 * removes exactly what a single mount added, which is leak-proof by construction. While no drag is
 * active every listener is an immediate early-return, so an idle overlay pays nothing.
 *
 * ## Coalescing lives here (§7.2)
 *
 * A whole drag is one undo step. This hook guarantees that structurally: intermediate `pointermove`
 * frames only ever call `setPreviewRect` (local React state, never the document store), and
 * `onCommit` fires once, on `pointerup`, with the final rect. There is no timer and no history-level
 * merge — `history.ts` exposes no coalescing API, and the gesture boundary *is* the command
 * boundary, which is the cleanest realization of "the intermediate previews never touch the stack".
 * `Esc` and `pointercancel` end the gesture with **no** commit.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { SlRect } from '../../../../shared/design/bridge-protocol'
import { clientDeltaToFrame } from '../../../../shared/design/overlay-geometry'
import { applyDrag, type DragHandle, type DragModifiers } from '../../../../shared/design/drag'
import type { GuideLine } from '../../../../shared/design/smart-guides'

/** What a `resolveRect` hook returns: the (possibly snapped) rect to preview, and any guides to draw. */
export interface ResolvedDrag {
  readonly rect: SlRect
  readonly guides: readonly GuideLine[]
}

/** A live drag in progress: what is being dragged, from where, and the box it started on. */
interface ActiveDrag {
  readonly handle: DragHandle
  readonly startClientX: number
  readonly startClientY: number
  readonly startRect: SlRect
}

export interface DragGestureOptions {
  /** The fit-to-pane scale; a client delta is divided by it to reach frame space. */
  readonly scale: number
  /** The selected element's current frame rect — the box a gesture starts from. */
  readonly selectionRect: SlRect | null
  /** Called once per gesture on `pointerup`, with the start and committed frame rects. */
  readonly onCommit: (startRect: SlRect, nextRect: SlRect) => void
  /**
   * Optional post-processor for each raw drag rect (M3.7 smart guides): given the rect `applyDrag`
   * produced and the handle in play, it returns the rect to actually preview/commit (e.g. snapped to
   * a nearby element) plus any guide lines to draw. Defaults to identity with no guides, so a caller
   * that does not pass it behaves exactly as before. Applied to both the live preview and the
   * committed rect, so what the user sees snapped is what commits.
   */
  readonly resolveRect?: (rect: SlRect, handle: DragHandle) => ResolvedDrag
}

export interface DragGestureApi {
  /** Begin a drag of `handle` from a `pointerdown` event. */
  readonly startDrag: (handle: DragHandle, event: React.PointerEvent) => void
  /** The live preview rect while dragging, or `null` when idle — the overlay renders this instead. */
  readonly previewRect: SlRect | null
  /** The guide lines to draw for the current preview (M3.7); empty when idle or none are in range. */
  readonly guides: readonly GuideLine[]
  /** Whether a drag is in progress (the overlay suppresses hover hit-tests while it is). */
  readonly isDragging: boolean
}

function modsOf(event: PointerEvent | React.PointerEvent): DragModifiers {
  return { shift: event.shiftKey, alt: event.altKey }
}

export function useDragGesture(options: DragGestureOptions): DragGestureApi {
  const { scale, selectionRect, onCommit, resolveRect } = options

  const active = useRef<ActiveDrag | null>(null)
  const [previewRect, setPreviewRect] = useState<SlRect | null>(null)
  const [guides, setGuides] = useState<readonly GuideLine[]>([])
  const [dragging, setDragging] = useState(false)

  // Refs so the lifetime-scoped window listeners always read the latest values without ever being
  // reinstalled (their effect has empty deps).
  const scaleRef = useRef(scale)
  scaleRef.current = scale
  const onCommitRef = useRef(onCommit)
  onCommitRef.current = onCommit
  const resolveRectRef = useRef(resolveRect)
  resolveRectRef.current = resolveRect

  useEffect(() => {
    const raf = { id: 0 }
    const queued = { point: null as { x: number; y: number; mods: DragModifiers } | null }

    // The raw rect from `applyDrag`, plus the resolved (snapped) rect and its guides. Returns `null`
    // only when there is no active drag.
    const resolveFor = (
      clientX: number,
      clientY: number,
      mods: DragModifiers,
    ): ResolvedDrag | null => {
      const drag = active.current
      if (drag === null) return null
      const frameDelta = clientDeltaToFrame(
        { x: clientX - drag.startClientX, y: clientY - drag.startClientY },
        scaleRef.current,
      )
      const raw = applyDrag(drag.startRect, drag.handle, frameDelta, mods)
      const resolver = resolveRectRef.current
      return resolver ? resolver(raw, drag.handle) : { rect: raw, guides: [] }
    }

    const endGesture = (): void => {
      if (raf.id !== 0) {
        cancelAnimationFrame(raf.id)
        raf.id = 0
      }
      active.current = null
      queued.point = null
      setPreviewRect(null)
      setGuides([])
      setDragging(false)
    }

    const onMove = (event: PointerEvent): void => {
      if (active.current === null) return
      queued.point = { x: event.clientX, y: event.clientY, mods: modsOf(event) }
      if (raf.id !== 0) return
      raf.id = requestAnimationFrame(() => {
        raf.id = 0
        const point = queued.point
        if (point === null) return
        const resolved = resolveFor(point.x, point.y, point.mods)
        if (resolved !== null) {
          setPreviewRect(resolved.rect)
          setGuides(resolved.guides)
        }
      })
    }

    const onUp = (event: PointerEvent): void => {
      const drag = active.current
      if (drag === null) return
      const resolved = resolveFor(event.clientX, event.clientY, modsOf(event))
      const start = drag.startRect
      endGesture()
      // Commit the final (snapped) geometry once. `buildDragPatch` no-ops a zero-distance gesture, so
      // a click that did not move commits nothing — this hook does not need to special-case it.
      if (resolved !== null) onCommitRef.current(start, resolved.rect)
    }

    const onKey = (event: KeyboardEvent): void => {
      if (active.current === null) return
      if (event.key === 'Escape') {
        // End with no commit — Esc abandons the gesture, restoring the pre-drag box.
        event.preventDefault()
        endGesture()
      }
    }

    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', endGesture)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', endGesture)
      window.removeEventListener('keydown', onKey)
      if (raf.id !== 0) cancelAnimationFrame(raf.id)
    }
  }, [])

  const startDrag = useCallback(
    (handle: DragHandle, event: React.PointerEvent): void => {
      if (selectionRect === null) return
      event.preventDefault()
      event.stopPropagation()
      active.current = {
        handle,
        startClientX: event.clientX,
        startClientY: event.clientY,
        startRect: selectionRect,
      }
      setDragging(true)
    },
    [selectionRect],
  )

  return { startDrag, previewRect, guides, isDragging: dragging }
}
