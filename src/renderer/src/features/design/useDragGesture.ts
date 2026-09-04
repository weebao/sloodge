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
 *
 * ## One threshold decides the whole gesture (M3.11 round-4)
 *
 * A press-and-release is either a click or a drag, and exactly one comparison — `DRAG_SLOP_PX`
 * against the pointer's travel in client space — decides which. Below it nothing commits and the
 * synthetic `click` is left alone, so the overlay's hit-test runs and the gesture is a pure click.
 * At or above it the geometry commits and `consumeDragClick` tells the overlay to swallow that
 * click, because the pointer has moved and re-hit-testing would select whatever now sits under it.
 *
 * The two used to be decided in different places: the overlay compared client pixels to swallow the
 * click, while whether anything committed fell out of `geometryDelta`'s rounding to whole frame
 * pixels — about 0.29 client px at the shipped fit scale. Every movement between the two thresholds
 * therefore both moved the user's content *and* re-hit-tested, which on a multi-selection moved every
 * member and then collapsed the selection to the full-bleed slide root (round-4 major, reproduced
 * from a 2 px nudge). Deriving both from `isDragTravel` is what makes that unrepresentable.
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

/**
 * How far the pointer may travel between `pointerdown` and `pointerup` and still count as a
 * stationary click rather than a drag. Matches Windows' `SM_CXDRAG` default of 4 px: below that the
 * OS itself calls the movement a click, and a threshold under it left no magnitude at which a shaky
 * click was inert. The comparison lives in `isDragTravel` alone — see the header.
 */
export const DRAG_SLOP_PX = 4

/** The one comparison that separates a click from a drag, for both the commit and the swallow. */
function isDragTravel(dx: number, dy: number): boolean {
  return Math.hypot(dx, dy) >= DRAG_SLOP_PX
}

/**
 * A live drag in progress: what is being dragged, from where, and the box it started on.
 *
 * `pointerId` pins the gesture to the pointer that began it. Without it a second touch or pen — a
 * shipped case on Windows tablets — ends the first pointer's drag at the *second* pointer's
 * coordinates, committing a delta the user never made (round-4 major).
 *
 * `lastClientX`/`lastClientY` track where that pointer was last seen, so `Escape` can classify a
 * gesture it ends without a `pointerup` to read coordinates from.
 */
interface ActiveDrag {
  readonly handle: DragHandle
  readonly pointerId: number
  readonly startClientX: number
  readonly startClientY: number
  readonly startRect: SlRect
  lastClientX: number
  lastClientY: number
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
  /**
   * Whether the synthetic `click` now being handled is the one that ended a real drag — and clears
   * the flag, so exactly one click is ever swallowed. `false` for a sub-slop gesture, for a click
   * with no gesture behind it at all, and for the second click after a drag.
   */
  readonly consumeDragClick: () => boolean
}

function modsOf(event: PointerEvent | React.PointerEvent): DragModifiers {
  return { shift: event.shiftKey, alt: event.altKey }
}

export function useDragGesture(options: DragGestureOptions): DragGestureApi {
  const { scale, selectionRect, onCommit, resolveRect } = options

  const active = useRef<ActiveDrag | null>(null)
  // Set when a gesture ends having travelled at least `DRAG_SLOP_PX`, cleared by the click that
  // consumes it and by the next `pointerdown` — so a drag that ended over some other part of the app,
  // whose click the overlay never sees, cannot leave the next click armed to be swallowed.
  const dragClick = useRef(false)
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

    // Ends the gesture and returns its verdict: `true` when the pointer travelled far enough that
    // this was a drag. Every exit — commit, `Escape`, `pointercancel` — goes through here, so the
    // click that follows any of them is classified by the same comparison.
    const endGesture = (): boolean => {
      const drag = active.current
      if (raf.id !== 0) {
        cancelAnimationFrame(raf.id)
        raf.id = 0
      }
      active.current = null
      queued.point = null
      setPreviewRect(null)
      setGuides([])
      setDragging(false)
      if (drag === null) return false
      // Net displacement from the origin, not maximum travel, so an excursion that returns to where
      // it started is a click. Deliberate (round-5 minor, upheld): the drag preview is overlay-local
      // state that never crosses the bridge, so an uncommitted gesture strands no transform and no
      // smart-guide snap, and the fall-through click re-hit-tests at the release point — the origin
      // — which makes it idempotent. Maximum travel would instead commit a zero-delta move.
      const wasDrag = isDragTravel(
        drag.lastClientX - drag.startClientX,
        drag.lastClientY - drag.startClientY,
      )
      dragClick.current = wasDrag
      return wasDrag
    }

    const onMove = (event: PointerEvent): void => {
      const drag = active.current
      if (drag === null || event.pointerId !== drag.pointerId) return
      drag.lastClientX = event.clientX
      drag.lastClientY = event.clientY
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
      if (drag === null || event.pointerId !== drag.pointerId) return
      drag.lastClientX = event.clientX
      drag.lastClientY = event.clientY
      const resolved = resolveFor(event.clientX, event.clientY, modsOf(event))
      const start = drag.startRect
      // The same verdict that arms the swallow decides whether anything commits: a sub-slop gesture
      // is a click, and a click must not move the user's content by the pixel or two that
      // `geometryDelta`'s rounding to whole frame pixels would otherwise make of it.
      const wasDrag = endGesture()
      if (wasDrag && resolved !== null) onCommitRef.current(start, resolved.rect)
    }

    const onKey = (event: KeyboardEvent): void => {
      if (active.current === null) return
      if (event.key === 'Escape') {
        // End with no commit — Esc abandons the gesture, restoring the pre-drag box. The pointer is
        // still down and still moved, so the release's click is classified as a drag's and swallowed:
        // the box has snapped back from under the pointer, and re-hit-testing there answered with the
        // full-bleed slide root (round-4 minor).
        event.preventDefault()
        endGesture()
      }
    }

    const onCancel = (event: PointerEvent): void => {
      const drag = active.current
      if (drag === null || event.pointerId !== drag.pointerId) return
      endGesture()
    }

    // Capture phase, so a new gesture disarms a stale swallow even though `startDrag` stops the
    // event from reaching the overlay root.
    const onDown = (): void => {
      dragClick.current = false
    }

    window.addEventListener('pointerdown', onDown, true)
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onCancel)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onCancel)
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
        pointerId: event.pointerId,
        startClientX: event.clientX,
        startClientY: event.clientY,
        startRect: selectionRect,
        lastClientX: event.clientX,
        lastClientY: event.clientY,
      }
      setDragging(true)
    },
    [selectionRect],
  )

  const consumeDragClick = useCallback((): boolean => {
    const armed = dragClick.current
    dragClick.current = false
    return armed
  }, [])

  return { startDrag, previewRect, guides, isDragging: dragging, consumeDragClick }
}
