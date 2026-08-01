/**
 * The marquee (rubber-band) select gesture — M3.7. A pointer drag that starts on empty canvas sweeps
 * a rectangle; every grabbable element it overlaps becomes selected. The intersection maths is the
 * pure `elementsInMarquee` (`marquee.ts`); this hook is only the pointer wiring, in the same shape as
 * `useDragGesture`: window listeners installed once for the component's life and gated on an active
 * ref, a rAF-coalesced move, and a threshold below which the gesture is *not* a marquee (so a plain
 * click still falls through to the overlay's hit-test).
 *
 * Element rects come from the frame over `SL_ELEMENTS`, fetched once on `pointerdown` — an untrusted
 * hint about the slide's own view state used only to drive ephemeral, re-validatable selection
 * (§2.2). The live selection updates as the rectangle grows, so the boxes light up under the sweep.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { SlHit, SlRect } from '../../../../shared/design/bridge-protocol'
import { clientPointToFrame, type Point } from '../../../../shared/design/overlay-geometry'
import { elementsInMarquee, type MarqueeCandidate } from '../../../../shared/design/marquee'

/** Below this many frame px of travel the gesture is a click, not a marquee. */
const MARQUEE_THRESHOLD = 3

export interface MarqueeGestureOptions {
  /** The fit-to-pane scale, to turn client points into frame coords. */
  readonly scale: number
  /** The overlay root, whose box is the origin for client→frame conversion. */
  readonly rootRef: React.RefObject<HTMLDivElement | null>
  /** Fetch every grabbable element's geometry from the frame (one-shot). */
  readonly requestElements: (onElements: (hits: readonly SlHit[]) => void) => void
  /** Replace the selection with the swept elements (empty clears). Called live as the sweep grows. */
  readonly onSelect: (hits: readonly SlHit[]) => void
}

export interface MarqueeGestureApi {
  /** Begin a marquee from a `pointerdown` on empty canvas. */
  readonly startMarquee: (event: React.PointerEvent) => void
  /** The current marquee rectangle in **frame** coords, or `null` when idle. */
  readonly marqueeRect: SlRect | null
  /** Whether a marquee has passed the click threshold — the overlay suppresses the trailing click. */
  readonly isMarqueeing: boolean
}

/** Normalise two frame points into a positive-size rect. */
function rectOf(a: Point, b: Point): SlRect {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    width: Math.abs(a.x - b.x),
    height: Math.abs(a.y - b.y),
  }
}

export function useMarqueeGesture(options: MarqueeGestureOptions): MarqueeGestureApi {
  const { scale, rootRef, requestElements, onSelect } = options

  const active = useRef<{ start: Point; passed: boolean } | null>(null)
  const candidates = useRef<readonly SlHit[]>([])
  const [marqueeRect, setMarqueeRect] = useState<SlRect | null>(null)
  const [marqueeing, setMarqueeing] = useState(false)

  const scaleRef = useRef(scale)
  scaleRef.current = scale
  const onSelectRef = useRef(onSelect)
  onSelectRef.current = onSelect

  const framePoint = useCallback(
    (clientX: number, clientY: number): Point => {
      const box = rootRef.current?.getBoundingClientRect() ?? { left: 0, top: 0 }
      return clientPointToFrame({ x: clientX, y: clientY }, box, scaleRef.current)
    },
    [rootRef],
  )

  useEffect(() => {
    const raf = { id: 0 }
    const queued = { point: null as Point | null }

    const apply = (point: Point): void => {
      const drag = active.current
      if (drag === null) return
      const rect = rectOf(drag.start, point)
      if (!drag.passed && Math.max(rect.width, rect.height) < MARQUEE_THRESHOLD) return
      drag.passed = true
      setMarqueeing(true)
      setMarqueeRect(rect)

      const byId = new Map(candidates.current.map((hit) => [hit.slId, hit]))
      const cands: MarqueeCandidate[] = candidates.current.map((hit) => ({
        slId: hit.slId,
        rect: hit.rect,
        ancestorSlIds: hit.ancestors.map((crumb) => crumb.slId),
      }))
      const ids = elementsInMarquee(rect, cands)
      const hits = ids.map((id) => byId.get(id)).filter((hit): hit is SlHit => hit !== undefined)
      onSelectRef.current(hits)
    }

    const onMove = (event: PointerEvent): void => {
      if (active.current === null) return
      queued.point = framePoint(event.clientX, event.clientY)
      if (raf.id !== 0) return
      raf.id = requestAnimationFrame(() => {
        raf.id = 0
        if (queued.point !== null) apply(queued.point)
      })
    }

    const end = (): void => {
      if (raf.id !== 0) {
        cancelAnimationFrame(raf.id)
        raf.id = 0
      }
      active.current = null
      queued.point = null
      setMarqueeRect(null)
      // `isMarqueeing` stays true through the trailing click so the overlay's `onClick` can swallow
      // it; it is reset by the next root `pointerdown` (`startMarquee` sets it false), which always
      // precedes any later click, so the flag is never observed stale.
    }

    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', end)
    window.addEventListener('pointercancel', end)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', end)
      window.removeEventListener('pointercancel', end)
      if (raf.id !== 0) cancelAnimationFrame(raf.id)
    }
  }, [framePoint])

  const startMarquee = useCallback(
    (event: React.PointerEvent): void => {
      setMarqueeing(false)
      candidates.current = []
      requestElements((hits) => {
        candidates.current = hits
      })
      active.current = { start: framePoint(event.clientX, event.clientY), passed: false }
    },
    [framePoint, requestElements],
  )

  return { startMarquee, marqueeRect, isMarqueeing: marqueeing }
}
