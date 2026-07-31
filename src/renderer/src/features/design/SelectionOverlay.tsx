/**
 * The selection overlay — §2.1 and §4 of `.claude/plans/init/40-design-mode.md`, drawn in the
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
 * Visual-only this milestone: the corner/edge handles are drawn but inert. Drag and resize are M3.5,
 * which is why the handles carry `pointer-events: none` — they must not yet intercept anything.
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
import type { SlCrumb, SlHit } from '../../../../shared/design/bridge-protocol'
import { clientPointToFrame, frameRectToOverlay } from '../../../../shared/design/overlay-geometry'
import { useDesignStore } from './designStore'
import { useDesignBridge, type HitMode } from './useDesignBridge'

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
 * The eight resize grips, drawn but inert until M3.5. Positions are static, so each style object is
 * built once at module load rather than per render (react-perf: no fresh object as a JSX prop).
 */
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
).map(([key, left, top]) => ({ key, style: { left, top, pointerEvents: 'none' } }))

function label(hit: Pick<SlCrumb, 'tag' | 'id' | 'classes'>): string {
  const id = hit.id ? `#${hit.id}` : ''
  const cls = hit.classes.length > 0 ? `.${hit.classes[0]}` : ''
  return `${hit.tag}${id}${cls}`
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
    [framePoint, requestHit],
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

  // Full style objects (position + no-pointer), memoized so a JSX prop is never a fresh object.
  const hoverStyle = useMemo<CSSProperties | null>(() => {
    if (!hover) return null
    const box = frameRectToOverlay(hover.rect, scale)
    return { left: box.x, top: box.y, width: box.width, height: box.height, pointerEvents: 'none' }
  }, [hover, scale])

  const selectionStyle = useMemo<CSSProperties | null>(() => {
    if (!selection) return null
    const box = frameRectToOverlay(selection.rect, scale)
    return { left: box.x, top: box.y, width: box.width, height: box.height, pointerEvents: 'none' }
  }, [selection, scale])

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
      {hoverStyle && (!selection || selection.slId !== hover?.slId) ? (
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

      {selectionStyle && selection ? (
        <div
          data-testid="design-selection"
          className="absolute border-2 border-accent"
          style={selectionStyle}
        >
          <span className="absolute -top-5 right-0 whitespace-nowrap rounded bg-accent px-1 text-[11px] leading-4 text-white">
            {Math.round(selection.rect.width)} × {Math.round(selection.rect.height)}
          </span>
          {HANDLES.map((handle) => (
            <span
              key={handle.key}
              data-testid={`design-handle-${handle.key}`}
              aria-hidden="true"
              className="absolute h-2 w-2 -translate-x-1/2 -translate-y-1/2 border border-accent bg-white"
              style={handle.style}
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
