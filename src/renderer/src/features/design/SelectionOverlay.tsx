/**
 * The selection overlay — §2.1, §4 and §5.5 of `.claude/plans/init/40-design-mode.md`, drawn in the
 * renderer *above* the iframe because the sandboxed frame is opaque-origin and its DOM is
 * unreachable from here.
 *
 * The overlay is a non-scaled layer laid exactly over the scale-to-fit frame box. In Design Mode it
 * swallows pointer events (`pointer-events: auto`), which is the "frozen frame" property of §2.1: the
 * slide's own `:hover` and click handlers never fire, so selection is stable. A `mousemove` becomes a
 * hover hit-test, a `click` becomes a select; the frame answers with geometry in its own 1280×720
 * space and every rect is mapped back through `frameRectToOverlay` so the box lands on the element at
 * any zoom.
 *
 * ## Drag-to-move and resize (M3.5)
 *
 * The selection body and its eight handles are interactive. A drag translates or resizes the box with
 * a **live preview**; on `pointerup` the gesture commits as **one** undoable `setSlideHtml`, patching
 * the slide source through the M3.3 byte-span layer. §7.2 coalescing is structural: only `pointerup`
 * touches the store, and a zero-distance click commits nothing.
 *
 * ## Multi-select, align/distribute, smart guides (M3.7)
 *
 * Selection is an **ordered set** (`designStore.selections`); a plain click selects one element,
 * shift-click toggles one in/out, and a drag on empty canvas marquees every grabbable element the
 * rectangle overlaps (`useMarqueeGesture`). With two or more selected the overlay draws a light
 * outline per element plus a combined bounding box that drags them all as one command
 * (`buildMultiElementPatch`); align/distribute live in the floating `ArrangeBar`. While a single
 * element (or the group) is dragged, `snapRectToGuides` snaps its edges/centre to the other elements
 * and the slide centre, drawing PowerPoint-style guide lines — all re-derived from parent-held state,
 * never a bridge payload (§2.2).
 *
 * ## A selection box is never a dead zone (M3.11 round-3)
 *
 * The selection box is drawn *over* the element it selects, so it intercepts the next click on that
 * element. For a full-bleed selection — one click on empty canvas selects the slide root, whose box
 * is the entire 1280×720 stage — swallowing that click made every later click inert: no element could
 * be selected, no caret could be opened, and with Design Mode now on by default a user reached that
 * state with their first gesture (round-3 blocker, reproduced in the built app).
 *
 * So the box swallows exactly one thing: the synthetic `click` the browser fires on the `pointerup`
 * that ended a real drag, where the pointer has moved and re-hit-testing would select whatever now
 * sits under it. `useDragGesture` classifies the gesture (`DRAG_SLOP_PX`) and this file only asks it
 * — `consumeDragClick` — so the swallow and the commit can never disagree about what a drag is.
 * A **stationary** click falls through to the root's hit-test, which asks the frame for the innermost
 * grabbable element under the pointer. `Esc` (§4.2, `useDeselectKey`) and a visible **Clear
 * selection** button are the two escapes that do not depend on the pointer at all.
 *
 * ## Why a group box needs its own rule (M3.11 round-4)
 *
 * The fall-through above is safe for a single element because the box *is* the element: the click
 * landed on the box, so the box contains the point, so the hit-test can only answer with that element
 * (idempotent) or something inside it — a container's box can never block selecting its children.
 *
 * That argument is **false for a group**. A group box is the union of its members' rects, and a union
 * contains points that belong to no member: the whitespace gap between a title and a subtitle is
 * inside the union and inside neither. Falling through there answers with whatever is actually under
 * the pointer, which on a normal slide is the full-bleed slide root — the exact state this round
 * exists to prevent, reached by clicking *inside* one's own multi-selection.
 *
 * So the rule for a group is decided by the members, not by the union: a stationary click that lands
 * on a member falls through as before (collapsing to that member, which is what PowerPoint, Figma
 * and Keynote do and what round 3 accepted), and a click in the gap is **swallowed — the group
 * survives**. Nudging a group therefore cannot lose it, and the group is still dismissible by `Esc`,
 * by the Clear selection button, and by clicking outside the union.
 *
 * "On a member" means the member's **rotated hull**, not its layout box. Round 4 asked the question
 * of `boxOf(hit)`, which is the unrotated box, and for a member turned by M3.6 that is not the shape
 * on screen — so the rule was wrong in both directions at once (round-5 major, both reproduced in the
 * built app with a member at `rotate(45deg)`). A click on the member's visible corner fell outside
 * its unrotated box, was read as gap and swallowed: the user aimed at an element and got nothing. A
 * click on visibly empty space that happened to lie inside that unrotated box was read as a member,
 * fell through, and the hit-test answered the full-bleed slide root — destroying the multi-selection
 * from a click on apparent whitespace, which is the failure this whole rule exists to prevent. The
 * test is now `rotatedRectContainsPoint` against each member's own source rotation.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  type CSSProperties,
  type JSX,
  type RefObject,
} from 'react'
import type {
  SlCrumb,
  SlEditEventPayload,
  SlHit,
  SlRect,
} from '../../../../shared/design/bridge-protocol'
import type { DragHandle } from '../../../../shared/design/drag'
import type { Point } from '../../../../shared/design/overlay-geometry'
import {
  clientPointToFrame,
  frameRectCentreClient,
  frameRectToOverlay,
  rotatedOverlayStyle,
  unionRects,
} from '../../../../shared/design/overlay-geometry'
import { buildDragPatch } from '../../../../shared/design/drag-commit'
import {
  boxOf,
  rectContainsPoint,
  rotatedRectContainsPoint,
  shiftHit,
} from '../../../../shared/design/hit-geometry'
import { buildMultiElementPatch, type ElementMove } from '../../../../shared/design/multi-commit'
import { snapRectToGuides, type GuideLine } from '../../../../shared/design/smart-guides'
import { buildSlideMap } from '../../../../shared/design/slide-map'
import type { ElementSpan, SlideMap } from '../../../../shared/design/types'
import { isTextEditable } from '../../../../shared/design/text-edit'
import { readStyleProp } from '../../../../shared/design/patch'
import { readRotation } from '../../../../shared/design/transform'
import { CANVAS_HEIGHT, CANVAS_WIDTH } from '../../../../shared/document/types'
import { getSlideHtml, useDeckStore } from '../../stores/deckStore'
import { useDesignStore, type DesignSnapshot } from './designStore'
import { useDesignBridge, type HitMode } from './useDesignBridge'
import { useDragGesture, type ResolvedDrag } from './useDragGesture'
import { useMarqueeGesture } from './useMarqueeGesture'
import { useRotateGesture } from './useRotateGesture'
import { useElementActions } from './useElementActions'
import { useDuplicateKey } from './useDuplicateKey'
import { useDeselectKey } from './useDeselectKey'
import { useTextEditing } from './useTextEditing'
import { useTextEditKey } from './useTextEditKey'

export type SelectionOverlayProps = {
  /** The slide iframe hosting the instrumented document and the agent script. */
  readonly frameRef: RefObject<HTMLIFrameElement | null>
  /** The slide id the frame is showing — the bridge's stale-frame guard. */
  readonly slideId: string
  /** The same scale-to-fit factor `SlideFrame` applies; overlay geometry is in these terms. */
  readonly scale: number
}

/** Layers that only *display* — they must never intercept pointer events (that is the root's job). */
const NO_POINTER: CSSProperties = { pointerEvents: 'none' }
/** The root swallows all pointer events in Design Mode, freezing the slide's own handlers (§2.1). */
const CAPTURE_POINTER: CSSProperties = { pointerEvents: 'auto' }

const HANDLE_CURSOR: Readonly<Record<string, string>> = {
  nw: 'nwse-resize',
  n: 'ns-resize',
  ne: 'nesw-resize',
  e: 'ew-resize',
  se: 'nwse-resize',
  s: 'ns-resize',
  sw: 'nesw-resize',
  w: 'ew-resize',
}

const HANDLES: readonly { readonly key: string; readonly style: CSSProperties }[] = (
  [
    ['nw', '0%', '0%'],
    ['n', '50%', '0%'],
    ['ne', '100%', '0%'],
    ['e', '100%', '50%'],
    ['se', '100%', '100%'],
    ['s', '50%', '100%'],
    ['sw', '0%', '100%'],
    ['w', '0%', '50%'],
  ] as const
).map(([key, left, top]) => ({
  key,
  style: { left, top, pointerEvents: 'auto', cursor: HANDLE_CURSOR[key] } as CSSProperties,
}))

/** How far above the box's top edge the rotation handle floats, and the stalk that reaches it. */
const ROTATE_OFFSET_PX = 24
const ROTATE_STALK: CSSProperties = {
  height: ROTATE_OFFSET_PX,
  transform: `translate(-0.5px, -${String(ROTATE_OFFSET_PX)}px)`,
  pointerEvents: 'none',
}
const ROTATE_HANDLE: CSSProperties = {
  transform: `translate(-50%, calc(-100% - ${String(ROTATE_OFFSET_PX)}px))`,
  pointerEvents: 'auto',
  cursor: 'grab',
}

const SLIDE_SIZE = { width: CANVAS_WIDTH, height: CANVAS_HEIGHT }

function label(hit: Pick<SlCrumb, 'tag' | 'id' | 'classes'>): string {
  const id = hit.id ? `#${hit.id}` : ''
  const cls = hit.classes.length > 0 ? `.${hit.classes[0]}` : ''
  return `${hit.tag}${id}${cls}`
}

/**
 * The elements a gesture starting now will transform: the whole ordered set when multi-selected,
 * else the anchor on its own. Read from the store rather than the render closure at `pointerdown`,
 * and held for the life of the gesture — see `dragTargetRef`.
 */
function gestureTarget(state: Pick<DesignSnapshot, 'selection' | 'selections'>): readonly SlHit[] {
  if (state.selections.length >= 2) return state.selections
  return state.selection === null ? [] : [state.selection]
}

/** The Edit-menu label for a gesture: a resize touched a dimension, otherwise it was a move. */
function gestureLabel(start: SlRect, next: SlRect): string {
  const resized =
    Math.round(start.width) !== Math.round(next.width) ||
    Math.round(start.height) !== Math.round(next.height)
  return resized ? 'Resize element' : 'Move element'
}

export function SelectionOverlay({ frameRef, slideId, scale }: SelectionOverlayProps): JSX.Element {
  const rootRef = useRef<HTMLDivElement>(null)
  const hover = useDesignStore((state) => state.hover)
  const selection = useDesignStore((state) => state.selection)
  const selections = useDesignStore((state) => state.selections)
  const setHover = useDesignStore((state) => state.setHover)
  const setSelection = useDesignStore((state) => state.setSelection)
  const toggleSelection = useDesignStore((state) => state.toggleSelection)
  const setSelections = useDesignStore((state) => state.setSelections)
  const clearTransient = useDesignStore((state) => state.clearTransient)

  const isMulti = selections.length >= 2
  const selectedIds = useMemo(() => new Set(selections.map((hit) => hit.slId)), [selections])

  // `useTextEditing` needs `requestEdit` from the bridge, and the bridge needs the hook's event
  // handler — a cycle the ref breaks, the same way the bridge already holds `onHit` in a ref.
  const editEndRef = useRef<(payload: SlEditEventPayload) => void>(() => undefined)
  const onEditEnd = useCallback((payload: SlEditEventPayload): void => {
    editEndRef.current(payload)
  }, [])
  // Same shape for the frame's "fresh document" signal, which ends a session the reload destroyed.
  const readyRef = useRef<() => void>(() => undefined)
  const onReady = useCallback((): void => {
    readyRef.current()
  }, [])

  // `beginEdit` is created below (it needs the bridge this callback is being passed to), so the
  // double-click response reaches it through a ref.
  const beginEditRef = useRef<(slId: string) => boolean>(() => false)

  const onHit = useCallback(
    (hit: SlHit | null, mode: HitMode): void => {
      if (mode === 'hover') {
        setHover(hit)
        return
      }
      if (mode === 'toggle') {
        toggleSelection(hit)
        return
      }
      // Select first either way: a double-click on a non-editable element (an image, a mixed-content
      // paragraph) still selects it, which is the useful fallback rather than doing nothing.
      setSelection(hit)
      if (mode === 'edit' && hit !== null) beginEditRef.current(hit.slId)
    },
    [setHover, setSelection, toggleSelection],
  )

  const { requestHit, requestElements, requestEdit, pinEdit } = useDesignBridge({
    frameRef,
    slideId,
    enabled: true,
    onHit,
    onEditEnd,
    onReady,
  })

  const { beginEdit, onFrameEditEnd, onFrameReady, editing, notice, dismissNotice } =
    useTextEditing({
      slideId,
      requestEdit,
      pinEdit,
    })
  useEffect(() => {
    editEndRef.current = onFrameEditEnd
  }, [onFrameEditEnd])
  useEffect(() => {
    readyRef.current = onFrameReady
  }, [onFrameReady])
  useEffect(() => {
    beginEditRef.current = beginEdit
  }, [beginEdit])

  // A session that ends by `Enter`/`Escape` leaves focus inside the iframe, where `window` key
  // listeners in the host document never see it — `Ctrl/⌘+D` and the selection keys would all be
  // dead. Pulling focus back to the overlay restores them, and gives the keyboard path somewhere
  // sensible to land.
  //
  // Only when focus went nowhere useful, though. A session also ends because the user clicked the
  // chat composer, a property-panel field, or opened Settings — the frame's `blur` commits it — and
  // whatever took focus must keep it: stealing it back swallowed the next keystrokes and left the
  // Settings modal with a dead `Escape` (round-2 review, executed in Electron).
  const wasEditing = useRef(false)
  useEffect(() => {
    const isEditing = editing !== null
    if (wasEditing.current && !isEditing) {
      const active = document.activeElement
      if (active === null || active === document.body || active === frameRef.current) {
        rootRef.current?.focus()
      }
    }
    wasEditing.current = isEditing
  }, [editing, frameRef])

  // Cache of every grabbable element (rects) for smart-guide snapping, refreshed on each drag start.
  const elementsRef = useRef<readonly SlHit[]>([])

  // The elements the live gesture is transforming, captured at `pointerdown` alongside the start rect
  // `useDragGesture` captures. The commit writes to *these*, never to whatever `selections` holds at
  // `pointerup`: a second pointer's click, or a hit-test response that lands mid-drag, can replace the
  // selection between the two, and applying one element's delta to another moved a subtitle the user
  // never touched (round-4 major).
  const dragTargetRef = useRef<readonly SlHit[]>([])

  // Commit a completed single-element drag as one undoable command (M3.5).
  const onCommitGeometry = useCallback(
    (target: SlHit, startRect: SlRect, nextRect: SlRect): void => {
      const current = getSlideHtml(useDeckStore.getState().slideHtml, slideId)
      if (current === undefined) return
      const patched = buildDragPatch(slideId, current, target.slId, startRect, nextRect)
      if (patched === current) return
      if (
        useDeckStore
          .getState()
          .setSlideHtml(slideId, patched, target.slId, gestureLabel(startRect, nextRect))
      ) {
        setSelection({ ...target, rect: nextRect })
      }
    },
    [slideId, setSelection],
  )

  // Commit a completed group move as one undoable command: shift every selected element by the same
  // delta, patch them all into one source, push a single `setSlideHtml` (M3.7).
  const onCommitGroupMove = useCallback(
    (target: readonly SlHit[], startRect: SlRect, nextRect: SlRect): void => {
      const dx = Math.round(nextRect.x) - Math.round(startRect.x)
      const dy = Math.round(nextRect.y) - Math.round(startRect.y)
      if (dx === 0 && dy === 0) return
      const anchor = target.at(-1)
      if (anchor === undefined) return
      const current = getSlideHtml(useDeckStore.getState().slideHtml, slideId)
      if (current === undefined) return
      const edits: ElementMove[] = target.map((hit) => {
        const start = boxOf(hit)
        return {
          slId: hit.slId,
          startRect: start,
          nextRect: { ...start, x: start.x + dx, y: start.y + dy },
        }
      })
      const patched = buildMultiElementPatch(slideId, current, edits)
      if (patched === current) return
      if (useDeckStore.getState().setSlideHtml(slideId, patched, anchor.slId, 'Move elements')) {
        setSelections(target.map((hit) => shiftHit(hit, dx, dy)))
      }
    },
    [slideId, setSelections],
  )

  const onCommitGesture = useCallback(
    (startRect: SlRect, nextRect: SlRect): void => {
      const target = dragTargetRef.current
      const anchor = target.at(-1)
      if (anchor === undefined) return
      if (target.length >= 2) onCommitGroupMove(target, startRect, nextRect)
      else onCommitGeometry(anchor, startRect, nextRect)
    },
    [onCommitGroupMove, onCommitGeometry],
  )

  // The box a gesture starts from: the group bounding box when multi-selected, else the anchor's own
  // unrotated box.
  const groupBox = useMemo<SlRect | null>(() => {
    if (!isMulti) return null
    return unionRects(selections.map(boxOf))
  }, [isMulti, selections])
  const selectionBox = isMulti ? groupBox : (selection?.box ?? selection?.rect ?? null)

  // Smart-guide snapping (move only): snap the dragged box to the other elements and the slide
  // centre. Targets are re-derived from parent-held element rects, excluding what is being moved.
  const resolveRect = useCallback(
    (raw: SlRect, handle: DragHandle): ResolvedDrag => {
      if (handle !== 'move') return { rect: raw, guides: [] }
      const targets = elementsRef.current.filter((hit) => !selectedIds.has(hit.slId)).map(boxOf)
      return snapRectToGuides(raw, targets, SLIDE_SIZE)
    },
    [selectedIds],
  )

  const { startDrag, previewRect, guides, isDragging, consumeDragClick } = useDragGesture({
    scale,
    selectionRect: selectionBox,
    onCommit: onCommitGesture,
    resolveRect,
  })

  const { startMarquee, marqueeRect, isMarqueeing } = useMarqueeGesture({
    scale,
    rootRef,
    requestElements,
    onSelect: setSelections,
  })

  // What this overlay needs from the slide's *bytes* — a rotation and an element's shape — read from
  // the source, never from a bridge payload (§2.2).
  //
  // `buildSlideMap` is a full pass over the slide, and `slideHtml` changes once per token while the
  // agent streams, so the parse is both lazy and shared: nobody selected means nobody asks and it
  // never runs, and every reader below goes through this one map rather than parsing again. Round-6
  // major 1 measured the alternative — `canEditSelection` parsing on its own doubled the cost to two
  // full parses per token for the ordinary case of watching the agent write with something selected.
  const slideHtml = useDeckStore((state) => state.slideHtml)
  const source = getSlideHtml(slideHtml, slideId)
  const { elementOf, angleOf } = useMemo<{
    elementOf: (slId: string) => ElementSpan | undefined
    angleOf: (slId: string) => number
  }>(() => {
    if (source === undefined) return { elementOf: () => undefined, angleOf: () => 0 }
    let map: SlideMap | null = null
    const lookup = (slId: string): ElementSpan | undefined => {
      map ??= buildSlideMap(slideId, source)
      return map.byId.get(slId)
    }
    return {
      elementOf: lookup,
      angleOf: (slId) => {
        const element = lookup(slId)
        if (element === undefined) return 0
        return readRotation(readStyleProp(source, element, 'transform'))
      },
    }
  }, [source, slideId])

  // The single-element rotation (M3.6). Group selections are not rotated as a unit, so this is 0
  // while multi-selected.
  const sourceAngle = useMemo<number>(
    () => (isMulti || selection === null ? 0 : angleOf(selection.slId)),
    [angleOf, selection, isMulti],
  )

  // What counts as "on a member" for the group-gap rule: each member's box turned by its own source
  // rotation, so the region tested is the one the user sees. See the header.
  //
  // "Its own" is literal: a member rotated only by an ancestor (`<div style="transform:rotate(30deg)">
  // <p>member</p></div>`) reads 0 here and is tested against its unrotated box. That agrees with what
  // the overlay *paints* — M3.6 draws such an element's selection box unrotated too — so the hull never
  // contradicts the handles the user sees, and the cost is one group-gap click swallowed that should
  // have fallen through, or the reverse, both recoverable by clicking again (round-6 minor). When M3.6
  // composes an ancestor's rotation into a member's effective angle, read that here instead.
  const memberHulls = useMemo(
    () =>
      selections.map((hit) => ({
        box: boxOf(hit),
        // With no `box` the only geometry is the *rendered* rect, which is the axis-aligned bounds a
        // rotation already inflated; turning that again would test a region that exists nowhere.
        angle: hit.box === undefined ? 0 : angleOf(hit.slId),
      })),
    [selections, angleOf],
  )

  const actions = useElementActions(slideId)
  useDuplicateKey(actions.duplicate, actions.hasSelection)

  // `Enter`/`F2` edits the selected element. Armed only for a single selection with nothing already
  // open — a group has no one element to type into.
  const beginEditSelected = useCallback((): boolean => {
    if (selection === null) return false
    return beginEdit(selection.slId)
  }, [selection, beginEdit])
  useTextEditKey(beginEditSelected, !isMulti && selection !== null && editing === null)

  const boxRect = previewRect ?? selectionBox
  const getCentre = useCallback((): Point | null => {
    if (boxRect === null) return null
    const rootBox = rootRef.current?.getBoundingClientRect()
    if (rootBox === undefined) return null
    return frameRectCentreClient(boxRect, rootBox, scale)
  }, [boxRect, scale])

  const onCommitRotation = useCallback(
    (startDeg: number, nextDeg: number): void => {
      actions.rotateTo(startDeg, nextDeg)
    },
    [actions],
  )

  const { startRotate, previewAngle, isRotating } = useRotateGesture({
    rotation: sourceAngle,
    getCentre,
    onCommit: onCommitRotation,
  })

  const angle = isRotating && previewAngle !== null ? previewAngle : sourceAngle

  // §4.2's first escape stage. Disarmed while a caret is open — that keystroke is the frame's, and
  // deselecting out from under it would strand the `contenteditable` — and while a gesture is live,
  // because `useDragGesture`/`useRotateGesture` already bind `Escape` to cancel the gesture and one
  // press must not also drop the selection.
  useDeselectKey(
    clearTransient,
    selections.length > 0 && editing === null && !isDragging && !isRotating && !isMarqueeing,
  )

  // A selection belongs to the slide it was made on: its `slId` indexes *that* slide's map and its
  // rect is that slide's geometry. Nothing cleared it on a switch, so the box stayed painted over the
  // next slide at the previous one's coordinates while the panel read "Selection is no longer
  // available" — and where it happened to land over the new slide's own text it swallowed the clicks
  // meant for it (round-3 major). `useTextEditing`'s slide effect already abandons any open session;
  // this drops the hover and the selection, and it is declared after that hook so it runs after it.
  const clearedSlideRef = useRef(slideId)
  useEffect(() => {
    if (clearedSlideRef.current === slideId) return
    clearedSlideRef.current = slideId
    clearTransient()
  }, [slideId, clearTransient])

  // While the group is dragged, the per-element outlines follow the same delta as the group box.
  const previewDelta = useMemo<Point>(() => {
    if (previewRect === null || selectionBox === null) return { x: 0, y: 0 }
    return { x: previewRect.x - selectionBox.x, y: previewRect.y - selectionBox.y }
  }, [previewRect, selectionBox])

  const queued = useRef<{ x: number; y: number; alt: boolean } | null>(null)
  const raf = useRef(0)
  useEffect(
    () => () => {
      if (raf.current !== 0) cancelAnimationFrame(raf.current)
    },
    [],
  )

  const framePoint = useCallback(
    (event: { clientX: number; clientY: number }): { x: number; y: number } => {
      const box = rootRef.current?.getBoundingClientRect() ?? { left: 0, top: 0 }
      return clientPointToFrame({ x: event.clientX, y: event.clientY }, box, scale)
    },
    [scale],
  )

  const onMouseMove = useCallback(
    (event: React.MouseEvent): void => {
      // No hover hit-tests while a drag, rotation, or marquee is live.
      if (isDragging || isRotating || isMarqueeing) return
      const point = framePoint(event)
      queued.current = { ...point, alt: event.altKey }
      if (raf.current !== 0) return
      raf.current = requestAnimationFrame(() => {
        raf.current = 0
        const next = queued.current
        queued.current = null
        if (next) requestHit(next.x, next.y, 'hover', next.alt)
      })
    },
    [framePoint, requestHit, isDragging, isRotating, isMarqueeing],
  )

  const onClick = useCallback(
    (event: React.MouseEvent): void => {
      // The synthetic click that ended a real drag — see the header. Consumed here, at the one place
      // the fall-through hit-test runs, so it is swallowed wherever the release happened to land: on
      // the box, on the root after an `Esc`-cancelled drag snapped the box away, or after a resize.
      if (consumeDragClick()) return
      // A marquee that passed the click threshold ends with a synthetic click the browser fires on
      // pointerup; swallow it so a sweep does not also run a point hit-test that collapses the set.
      if (isMarqueeing) return
      // The second click of a double-click selects nothing: the first already chose the element and
      // `onDoubleClick` edits that choice. Hit-testing again here would let anything that moved the
      // slide between the two clicks pick a different element out from under the gesture.
      if (event.detail === 2) return
      const point = framePoint(event)
      // The group-gap rule — see the header. A single selection's box *is* its element, so its
      // clicks always fall through; a group's box is a union rect, so only the parts of it that are
      // actually a member do, and a click in the whitespace between members keeps the group. Decided
      // from the member rects the overlay already holds — no round trip, so the frame cannot answer
      // after the click has been settled.
      if (groupBox !== null && rectContainsPoint(groupBox, point)) {
        if (!memberHulls.some((hull) => rotatedRectContainsPoint(hull.box, hull.angle, point))) {
          return
        }
      }
      requestHit(point.x, point.y, event.shiftKey ? 'toggle' : 'select', event.altKey)
    },
    [framePoint, requestHit, isMarqueeing, consumeDragClick, groupBox, memberHulls],
  )

  // Double-click edits the element the first click selected — it does *not* hit-test the pointer
  // again. The first click's selection mounts the property panel, and anything that reflows the
  // stage between the two clicks makes a second hit-test at the same screen point land elsewhere;
  // on a fresh deck it landed on the slide root and no caret opened (round-2 review). The store is
  // read directly, not through the render closure, so the first click's hit response counts even
  // when it arrived after this handler's last render. Only with nothing selected — that response
  // still in flight — does it fall back to a hit-test in `edit` mode, which selects and then edits.
  const onDoubleClick = useCallback(
    (event: React.MouseEvent): void => {
      if (isMarqueeing) return
      const current = useDesignStore.getState().selections
      const only = current.length === 1 ? current[0] : undefined
      if (only !== undefined) {
        beginEdit(only.slId)
        return
      }
      const point = framePoint(event)
      requestHit(point.x, point.y, 'edit', event.altKey)
    },
    [framePoint, requestHit, isMarqueeing, beginEdit],
  )

  const onMouseLeave = useCallback((): void => {
    setHover(null)
  }, [setHover])

  // A pointerdown on empty canvas may begin a marquee (a click below the threshold falls through to
  // the hit-test in `onClick`). Only the root itself — not a selection box or handle — starts one.
  const onRootPointerDown = useCallback(
    (event: React.PointerEvent): void => {
      if (event.target !== event.currentTarget) return
      startMarquee(event)
    },
    [startMarquee],
  )

  // Pointerdown on the selection body → move; on a handle → resize. The move path first fetches every
  // element's geometry so smart guides have targets to snap against.
  const onBodyPointerDown = useCallback(
    (event: React.PointerEvent): void => {
      dragTargetRef.current = gestureTarget(useDesignStore.getState())
      requestElements((hits) => {
        elementsRef.current = hits
      })
      startDrag('move', event)
    },
    [startDrag, requestElements],
  )
  const onHandlePointerDown = useCallback(
    (event: React.PointerEvent): void => {
      const handle = event.currentTarget.getAttribute('data-handle') as DragHandle | null
      if (handle === null) return
      dragTargetRef.current = gestureTarget(useDesignStore.getState())
      startDrag(handle, event)
    },
    [startDrag],
  )
  const onRotatePointerDown = useCallback(
    (event: React.PointerEvent): void => {
      startRotate(event)
    },
    [startRotate],
  )
  const stop = useCallback((event: React.MouseEvent): void => {
    event.stopPropagation()
  }, [])

  // Clearing from the canvas itself. This used to be an `sr-only` button, which meant a user who
  // clicked into a full-bleed selection had no visible way out at all; it is the pointer twin of
  // `Esc` and says so on its face. The click must not also reach the root's hit-test, or clearing
  // would immediately re-select whatever is under the button.
  const onClearClick = useCallback(
    (event: React.MouseEvent): void => {
      event.stopPropagation()
      clearTransient()
    },
    [clearTransient],
  )

  // Same reason the Clear button stops propagation: dismissing must not also re-select what is under
  // the notice.
  const onDismissNotice = useCallback(
    (event: React.MouseEvent): void => {
      event.stopPropagation()
      dismissNotice()
    },
    [dismissNotice],
  )

  const hoverStyle = useMemo<CSSProperties | null>(() => {
    if (!hover) return null
    const box = frameRectToOverlay(hover.rect, scale)
    return { left: box.x, top: box.y, width: box.width, height: box.height, pointerEvents: 'none' }
  }, [hover, scale])

  const selectionStyle = useMemo<CSSProperties | null>(() => {
    if (!boxRect) return null
    const box = rotatedOverlayStyle(boxRect, scale, angle)
    return {
      left: box.left,
      top: box.top,
      width: box.width,
      height: box.height,
      transform: box.transform,
      transformOrigin: 'center',
      pointerEvents: 'auto',
      cursor: 'move',
    }
  }, [boxRect, scale, angle])

  // The light per-element outlines shown while multi-selected, each following the live group delta.
  const memberStyles = useMemo<readonly CSSProperties[]>(() => {
    if (!isMulti) return []
    return selections.map((hit) => {
      const rect = boxOf(hit)
      const box = frameRectToOverlay(
        { ...rect, x: rect.x + previewDelta.x, y: rect.y + previewDelta.y },
        scale,
      )
      return {
        left: box.x,
        top: box.y,
        width: box.width,
        height: box.height,
        pointerEvents: 'none',
      }
    })
  }, [isMulti, selections, previewDelta, scale])

  const marqueeStyle = useMemo<CSSProperties | null>(() => {
    if (marqueeRect === null) return null
    const box = frameRectToOverlay(marqueeRect, scale)
    return { left: box.x, top: box.y, width: box.width, height: box.height, pointerEvents: 'none' }
  }, [marqueeRect, scale])

  const guideStyles = useMemo<readonly CSSProperties[]>(() => {
    return guides.map((guide: GuideLine) => {
      if (guide.orientation === 'vertical') {
        return {
          left: guide.position * scale,
          top: guide.start * scale,
          height: (guide.end - guide.start) * scale,
          width: 1,
          pointerEvents: 'none',
        }
      }
      return {
        top: guide.position * scale,
        left: guide.start * scale,
        width: (guide.end - guide.start) * scale,
        height: 1,
        pointerEvents: 'none',
      }
    })
  }, [guides, scale])

  // Breadcrumb only for a single selection; a group has no one chain to show.
  const crumbs = useMemo<readonly Pick<SlCrumb, 'slId' | 'tag' | 'id' | 'classes'>[]>(() => {
    if (isMulti || !selection) return []
    return [...selection.ancestors.toReversed(), selection]
  }, [selection, isMulti])

  const isEditing = editing !== null

  // Whether the selected element can take a caret, for the discoverability hint below. Derived from
  // the source bytes rather than asked of the hook, because editability is a property of the
  // *source* — mixed content, a lock attribute — so it has to recompute when the bytes change.
  const canEditSelection = useMemo(() => {
    if (isMulti || selection === null) return false
    const element = elementOf(selection.slId)
    return element !== undefined && isTextEditable(element)
  }, [isMulti, selection, elementOf])

  const showHover =
    hoverStyle &&
    !isDragging &&
    !isRotating &&
    !isMarqueeing &&
    !isEditing &&
    !selectedIds.has(hover?.slId ?? '')

  return (
    <div
      ref={rootRef}
      role="presentation"
      tabIndex={-1}
      className={`absolute inset-0 outline-none ${isEditing ? '' : 'cursor-crosshair'}`}
      // While a caret is open the overlay stops swallowing pointer events, so clicks land in the
      // frame and place the caret. That is the "hole punched in the overlay" of §9.3, done as a
      // whole-layer pass-through: the session is single-element by construction, and clicking any
      // *other* element must end the session anyway (the frame's blur commits it). The frame's own
      // capture-phase guard keeps the rest of the slide's handlers frozen meanwhile.
      style={isEditing ? NO_POINTER : CAPTURE_POINTER}
      onPointerDown={onRootPointerDown}
      onMouseMove={onMouseMove}
      onMouseLeave={onMouseLeave}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
    >
      {showHover ? (
        <div
          data-testid="design-hover"
          className="absolute border border-dashed border-accent"
          style={hoverStyle}
        >
          {hover ? (
            <span className="absolute -top-5 left-0 whitespace-nowrap rounded bg-accent px-1 text-[11px] leading-4 text-white">
              {label(hover)}
            </span>
          ) : null}
        </div>
      ) : null}

      {/* Smart-guide lines (M3.7), drawn while a drag is snapping. */}
      {guides.map((guide, index) => (
        <div
          key={`${guide.orientation}-${String(guide.position)}`}
          data-testid="design-guide"
          className="absolute bg-fuchsia-500"
          style={guideStyles[index]}
        />
      ))}

      {/* Per-element outlines while multi-selected. */}
      {memberStyles.map((style, index) => (
        <div
          key={selections[index]?.slId ?? index}
          data-testid="design-member"
          className="absolute border border-accent/70"
          style={style}
        />
      ))}

      {selectionStyle && boxRect ? (
        <div
          data-testid={isMulti ? 'design-group' : 'design-selection'}
          data-editing={isEditing ? 'true' : undefined}
          className={
            isMulti
              ? 'absolute border-2 border-dashed border-accent'
              : // §4.1: while editing, the selection box becomes a "text caret frame" — a distinct
                // dashed amber frame, so the two modes are never confused at a glance.
                `absolute border-2 ${isEditing ? 'border-dashed border-amber-500' : 'border-accent'}`
          }
          style={selectionStyle}
          onPointerDown={onBodyPointerDown}
        >
          <span
            className={`absolute -top-5 right-0 whitespace-nowrap rounded px-1 text-[11px] leading-4 text-white ${
              isEditing ? 'bg-amber-600' : 'bg-accent'
            }`}
          >
            {isEditing
              ? 'Editing — Enter or Esc to finish'
              : isMulti
                ? `${String(selections.length)} selected`
                : `${String(Math.round(boxRect.width))} × ${String(Math.round(boxRect.height))}`}
          </span>
          {/* Double-click is invisible until you try it, so say so while the element is selected. */}
          {canEditSelection && !isEditing ? (
            <span
              data-testid="design-edit-hint"
              className="absolute -bottom-5 left-0 whitespace-nowrap rounded bg-black/70 px-1 text-[11px] leading-4 text-white"
            >
              Double-click or press Enter to edit text
            </span>
          ) : null}
          {/* Resize + rotate handles only for a single element; a group only moves — and none while
              editing, where the box is a caret frame rather than a transform target. */}
          {isMulti || isEditing
            ? null
            : HANDLES.map((handle) => (
                <span
                  key={handle.key}
                  data-testid={`design-handle-${handle.key}`}
                  data-handle={handle.key}
                  aria-hidden="true"
                  className="absolute h-2 w-2 -translate-x-1/2 -translate-y-1/2 border border-accent bg-white"
                  style={handle.style}
                  onPointerDown={onHandlePointerDown}
                  // A handle is a control, not a view of the element under it: never fall through.
                  onClick={stop}
                />
              ))}
          {isMulti || isEditing ? null : (
            <>
              <span
                aria-hidden="true"
                className="absolute left-1/2 top-0 -translate-x-1/2 border-l border-accent"
                style={ROTATE_STALK}
              />
              <span
                data-testid="design-handle-rotate"
                data-handle="rotate"
                aria-hidden="true"
                className="absolute left-1/2 top-0 h-3 w-3 -translate-x-1/2 rounded-full border border-accent bg-white"
                style={ROTATE_HANDLE}
                onPointerDown={onRotatePointerDown}
                onClick={stop}
              />
            </>
          )}
        </div>
      ) : null}

      {/* The marquee rectangle while sweeping. */}
      {marqueeStyle ? (
        <div
          data-testid="design-marquee"
          className="absolute border border-accent bg-accent/10"
          style={marqueeStyle}
        />
      ) : null}

      {/* A refused text edit, said where the edit happened. `status` rather than `alert`, matching
          the chat transcript's notice: the element is intact and back to its stored text, so this is
          a caveat on what the user just did, not a failure of the app.

          It does not auto-dismiss, deliberately (round-5 minor, upheld on review): the notice is the
          only account of why an edit did not stick, and a timer that removed it would leave a user
          who looked away with vanished work and no explanation. It has an explicit ✕, a new caret
          clears it, and a slide switch clears it. */}
      {notice !== null ? (
        <div
          role="status"
          data-testid="design-notice"
          className="absolute bottom-9 left-1/2 flex max-w-[80%] -translate-x-1/2 items-center gap-2 rounded bg-amber-600 px-2 py-1 text-[11px] leading-4 text-white"
          style={CAPTURE_POINTER}
        >
          <span>{notice}</span>
          <button
            type="button"
            aria-label="Dismiss"
            className="shrink-0 rounded px-1 hover:bg-black/20"
            onClick={onDismissNotice}
          >
            ✕
          </button>
        </div>
      ) : null}

      {crumbs.length > 0 ? (
        <nav
          aria-label="Selection breadcrumb"
          className="absolute bottom-1 left-1 flex max-w-full items-center gap-1 overflow-hidden rounded bg-black/70 px-2 py-1 text-[11px] text-white"
          style={NO_POINTER}
        >
          {crumbs.map((crumb, index) => (
            <span key={crumb.slId} className="flex items-center gap-1">
              {index > 0 ? <span className="opacity-50">›</span> : null}
              <span className={index === crumbs.length - 1 ? 'font-semibold' : 'opacity-80'}>
                {label(crumb)}
              </span>
            </span>
          ))}
        </nav>
      ) : null}

      {selections.length > 0 ? (
        <button
          type="button"
          data-testid="design-clear-selection"
          className="absolute bottom-1 right-1 rounded bg-black/70 px-2 py-1 text-[11px] leading-4 text-white hover:bg-black/85"
          style={CAPTURE_POINTER}
          onClick={onClearClick}
        >
          Clear selection (Esc)
        </button>
      ) : null}
    </div>
  )
}
