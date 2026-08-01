/**
 * The pure geometry of **marquee (rubber-band) multi-select** — the M3.7 milestone. A drag on empty
 * canvas sweeps a rectangle; every grabbable element the rectangle overlaps joins the selection.
 * Nothing here touches the DOM: the frame supplies each candidate's rendered rect and its
 * addressable-ancestor chain (an untrusted *hint* about the slide's own view state, exactly like a
 * hit-test — see `bridge-protocol.ts`), and this decides the set. That keeps the intersection rule
 * exhaustively unit-testable without a layout engine.
 *
 * ## Why ancestor suppression (keep the deepest, drop the containers)
 *
 * Slides are trees: a marquee that covers a shape also covers the `.slide` root and every wrapper
 * around it, all of which are addressable. Selecting all of them would make an align move the
 * container *and* its children, which is nonsense. So among the elements the marquee intersects we
 * keep only the **deepest grabbable** ones — an element is dropped when another intersecting
 * candidate lists it as an ancestor. The result is the set of individual shapes a user means to
 * marquee, the same set PowerPoint's rubber-band would grab on a flat canvas.
 */

import type { SlRect } from './bridge-protocol'

/** One element the marquee may capture: its id, rendered rect, and addressable-ancestor ids. */
export interface MarqueeCandidate {
  readonly slId: string
  readonly rect: SlRect
  /** Ids of every addressable ancestor (any order) — used to drop containers of a deeper hit. */
  readonly ancestorSlIds: readonly string[]
}

/**
 * Whether two axis-aligned rects overlap. Uses strict inequality, so edge-touching (zero-area
 * overlap) does not count and a zero-size marquee — a click, not a sweep — selects nothing.
 */
export function rectsIntersect(a: SlRect, b: SlRect): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y
}

/**
 * The ids of the deepest grabbable elements the marquee rect overlaps, in the candidates' input
 * order (document order, as the frame reports them). An element is excluded when it is an ancestor
 * of another intersecting candidate, so a marquee grabs shapes rather than their containers. Pure.
 */
export function elementsInMarquee(
  marquee: SlRect,
  candidates: readonly MarqueeCandidate[],
): string[] {
  const hits = candidates.filter((candidate) => rectsIntersect(marquee, candidate.rect))
  // Keep a candidate only when no *other* intersecting candidate names it as an ancestor.
  return hits
    .filter(
      (candidate) =>
        !hits.some(
          (other) => other.slId !== candidate.slId && other.ancestorSlIds.includes(candidate.slId),
        ),
    )
    .map((candidate) => candidate.slId)
}
