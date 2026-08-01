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
 * The selection body and its eight handles are now interactive. A drag translates or resizes the box
 * with a **live preview** (the overlay follows the pointer at the correct scale — the pure `applyDrag`
 * geometry fed a scale-divided frame delta); on `pointerup` the gesture commits as **one** undoable
 * `setSlideHtml`, patching the slide source through the same M3.3 byte-span layer the property panel
 * uses (`buildDragPatch`). The element itself moves on the subsequent hot-reload — the bridge has no
 * optimistic `SL_PREVIEW` message, so the box previews and the element catches up on commit — and the
 * selection rect is updated to the committed geometry so the box stays glued across the reload. §7.2
 * coalescing is structural: intermediate pointer frames only paint the preview; only `pointerup`
 * touches the store, and a zero-distance click commits nothing (`buildDragPatch` no-ops it).
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
import type { SlCrumb, SlHit, SlRect } from '../../../../shared/design/bridge-protocol'
import type { DragHandle } from '../../../../shared/design/drag'
import { clientPointToFrame, frameRectToOverlay } from '../../../../shared/design/overlay-geometry'
import { buildDragPatch } from '../../../../shared/design/drag-commit'
import { getSlideHtml, useDeckStore } from '../../stores/deckStore'
import { useDesignStore } from './designStore'
import { useDesignBridge, type HitMode } from './useDesignBridge'
import { useDragGesture } from './useDragGesture'

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

/**
 * The eight resize grips. Each carries its `data-handle` (read back in the pointerdown handler) and
 * a direction cursor. Positions and cursors are static, so each style object is built once at module
 * load rather than per render (react-perf: no fresh object as a JSX prop).
 */
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

function label(hit: Pick<SlCrumb, 'tag' | 'id' | 'classes'>): string {
  const id = hit.id ? `#${hit.id}` : ''
  const cls = hit.classes.length > 0 ? `.${hit.classes[0]}` : ''
  return `${hit.tag}${id}${cls}`
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
  const setHover = useDesignStore((state) => state.setHover)
  const setSelection = useDesignStore((state) => state.setSelection)
  const clearTransient = useDesignStore((state) => state.clearTransient)

  const onHit = useCallback(
    (hit: SlHit | null, mode: HitMode): void => {
      if (mode === 'hover') setHover(hit)
      else setSelection(hit)
    },
    [setHover, setSelection],
  )

  const { requestHit } = useDesignBridge({ frameRef, slideId, enabled: true, onHit })

  // Commit a completed drag as one undoable command: re-derive the element from the *current* store
  // bytes and the parent-tracked sl-id (§2.2 — never a bridge payload), patch the source through the
  // M3.3 byte-span layer, and push a single `setSlideHtml`. The committed geometry is written back
  // onto the selection so the box stays on the element across the hot-reload (there is no measurement
  // round-trip yet). `buildDragPatch` returns the source unchanged for a zero-move gesture, so the
  // guard below commits nothing on a click that did not move.
  const onCommitGeometry = useCallback(
    (startRect: SlRect, nextRect: SlRect): void => {
      if (selection === null) return
      const current = getSlideHtml(useDeckStore.getState().slideHtml, slideId)
      if (current === undefined) return
      const patched = buildDragPatch(slideId, current, selection.slId, startRect, nextRect)
      if (patched === current) return
      if (
        useDeckStore
          .getState()
          .setSlideHtml(slideId, patched, selection.slId, gestureLabel(startRect, nextRect))
      ) {
        setSelection({ ...selection, rect: nextRect })
      }
    },
    [selection, slideId, setSelection],
  )

  const { startDrag, previewRect, isDragging } = useDragGesture({
    scale,
    selectionRect: selection?.rect ?? null,
    onCommit: onCommitGeometry,
  })

  // rAF-throttle and coalesce pointer moves: at most one hover hit-test in flight, newest position
  // wins (§3.3). The queued point is kept in a ref so a burst of moves collapses to one request.
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
      // No hover hit-tests while a drag is live — the pointer is committed to the gesture.
      if (isDragging) return
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
    [framePoint, requestHit, isDragging],
  )

  const onClick = useCallback(
    (event: React.MouseEvent): void => {
      const point = framePoint(event)
      requestHit(point.x, point.y, 'select', event.altKey)
    },
    [framePoint, requestHit],
  )

  const onMouseLeave = useCallback((): void => {
    setHover(null)
  }, [setHover])

  // Pointerdown on the selection body → move; on a handle → resize. One hoisted handler reads which
  // grip fired from its `data-handle`, so the eight handles share a stable prop (no per-render
  // closures, react-perf clean).
  const onBodyPointerDown = useCallback(
    (event: React.PointerEvent): void => {
      startDrag('move', event)
    },
    [startDrag],
  )
  const onHandlePointerDown = useCallback(
    (event: React.PointerEvent): void => {
      const handle = event.currentTarget.getAttribute('data-handle') as DragHandle | null
      if (handle !== null) startDrag(handle, event)
    },
    [startDrag],
  )
  // A click on the selection box must not bubble to the root's select hit-test — the element is
  // already selected, and a post-drag click would fire a redundant round-trip.
  const stop = useCallback((event: React.MouseEvent): void => {
    event.stopPropagation()
  }, [])

  // Full style objects (position + no-pointer), memoized so a JSX prop is never a fresh object.
  const hoverStyle = useMemo<CSSProperties | null>(() => {
    if (!hover) return null
    const box = frameRectToOverlay(hover.rect, scale)
    return { left: box.x, top: box.y, width: box.width, height: box.height, pointerEvents: 'none' }
  }, [hover, scale])

  // The box tracks the live preview while dragging, else the committed selection. The body captures
  // pointer events so it is grabbable; a `move` cursor advertises the affordance.
  const boxRect = previewRect ?? selection?.rect ?? null
  const selectionStyle = useMemo<CSSProperties | null>(() => {
    if (!boxRect) return null
    const box = frameRectToOverlay(boxRect, scale)
    return {
      left: box.x,
      top: box.y,
      width: box.width,
      height: box.height,
      pointerEvents: 'auto',
      cursor: 'move',
    }
  }, [boxRect, scale])

  // Root-first for the breadcrumb: the response gives ancestors nearest-first, and the selection is
  // the final crumb. `toReversed` leaves the source array untouched.
  const crumbs = useMemo<readonly Pick<SlCrumb, 'slId' | 'tag' | 'id' | 'classes'>[]>(() => {
    if (!selection) return []
    return [...selection.ancestors.toReversed(), selection]
  }, [selection])

  return (
    <div
      ref={rootRef}
      role="presentation"
      className="absolute inset-0 cursor-crosshair"
      style={CAPTURE_POINTER}
      onMouseMove={onMouseMove}
      onMouseLeave={onMouseLeave}
      onClick={onClick}
    >
      {hoverStyle && !isDragging && (!selection || selection.slId !== hover?.slId) ? (
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

      {selectionStyle && selection && boxRect ? (
        <div
          data-testid="design-selection"
          className="absolute border-2 border-accent"
          style={selectionStyle}
          onPointerDown={onBodyPointerDown}
          onClick={stop}
        >
          <span className="absolute -top-5 right-0 whitespace-nowrap rounded bg-accent px-1 text-[11px] leading-4 text-white">
            {Math.round(boxRect.width)} × {Math.round(boxRect.height)}
          </span>
          {HANDLES.map((handle) => (
            <span
              key={handle.key}
              data-testid={`design-handle-${handle.key}`}
              data-handle={handle.key}
              aria-hidden="true"
              className="absolute h-2 w-2 -translate-x-1/2 -translate-y-1/2 border border-accent bg-white"
              style={handle.style}
              onPointerDown={onHandlePointerDown}
            />
          ))}
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

      {/* Deselect on background click is handled by the frame returning a null hit. */}
      <button type="button" className="sr-only" onClick={clearTransient}>
        Clear selection
      </button>
    </div>
  )
}
