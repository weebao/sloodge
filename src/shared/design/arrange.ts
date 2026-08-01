/**
 * The pure geometry of **align** and **distribute** — the M3.7 milestone of
 * `.claude/plans/init/80-roadmap.md` (Milestone 3b). Like `drag.ts`, nothing here touches the DOM,
 * React, the store, or the source: it is arithmetic on rectangles in the slide's own 1280×720
 * **frame space**, so the whole align/distribute contract is exhaustively unit-testable with no
 * browser and no layout engine. The commit layer (`multi-commit.ts`) turns the new rects into one
 * byte-span patch; this module only decides *where each rect goes*.
 *
 * ## Anchor: the selection's combined bounds (PowerPoint's default)
 *
 * PowerPoint aligns a multi-selection to the bounding box of the whole selection, not to a primary
 * element or to the slide. `alignRects` follows that: the target edge/centre is read off
 * `unionRects(rects)`, so "align left" moves every element's left edge to the selection's leftmost
 * edge, and the element already at that edge does not move. Only the axis the alignment names is
 * touched — an "align left" never changes any element's `y`.
 *
 * ## Distribute: equal spacing between centres (≥3)
 *
 * `distributeRects` equalises the spacing between element **centres** along the axis: the two
 * extreme elements (leftmost / rightmost centre, or top / bottom) stay put and the interior centres
 * are spread evenly between them. Centre-distribution is well-defined for elements of unequal size
 * and for overlapping elements, which edge-gap distribution is not (a gap can go negative), so it is
 * the convention this app commits to (40-design-mode.md open-question 2 left the choice open).
 * Fewer than three elements is a no-op — there is no interior element to move.
 */

import type { SlRect } from './bridge-protocol'
import { unionRects } from './overlay-geometry'

/** The six alignment targets — three horizontal, three vertical (§ roadmap M3.7). */
export type AlignEdge = 'left' | 'hcenter' | 'right' | 'top' | 'vcenter' | 'bottom'

/** The two distribution axes. */
export type DistributeAxis = 'horizontal' | 'vertical'

/** Align needs two elements to be meaningful (one is already "aligned" with itself). */
export const MIN_ALIGN = 2
/** Distribute needs three: two extremes to pin and at least one interior element to move. */
export const MIN_DISTRIBUTE = 3

/** Whether an edge names a horizontal alignment (moves `x`) rather than a vertical one (moves `y`). */
export function isHorizontalAlign(edge: AlignEdge): edge is 'left' | 'hcenter' | 'right' {
  return edge === 'left' || edge === 'hcenter' || edge === 'right'
}

/** The aligned `x` for one rect against combined bounds, for a horizontal edge. */
function alignedX(rect: SlRect, bounds: SlRect, edge: 'left' | 'hcenter' | 'right'): number {
  switch (edge) {
    case 'left':
      return bounds.x
    case 'right':
      return bounds.x + bounds.width - rect.width
    case 'hcenter':
      return bounds.x + bounds.width / 2 - rect.width / 2
  }
}

/** The aligned `y` for one rect against combined bounds, for a vertical edge. */
function alignedY(rect: SlRect, bounds: SlRect, edge: 'top' | 'vcenter' | 'bottom'): number {
  switch (edge) {
    case 'top':
      return bounds.y
    case 'bottom':
      return bounds.y + bounds.height - rect.height
    case 'vcenter':
      return bounds.y + bounds.height / 2 - rect.height / 2
  }
}

/**
 * Align every rect to `edge` of the selection's combined bounds. Returns a rect per input (same
 * order, same length), with **only** the axis the edge names changed; a list of fewer than
 * `MIN_ALIGN` rects is returned unchanged (a copy), so the caller commits nothing. Pure.
 */
export function alignRects(rects: readonly SlRect[], edge: AlignEdge): SlRect[] {
  if (rects.length < MIN_ALIGN) return rects.map((rect) => ({ ...rect }))
  const bounds = unionRects(rects)
  if (bounds === null) return rects.map((rect) => ({ ...rect }))

  if (isHorizontalAlign(edge)) {
    return rects.map((rect) => ({ ...rect, x: alignedX(rect, bounds, edge) }))
  }
  return rects.map((rect) => ({ ...rect, y: alignedY(rect, bounds, edge) }))
}

/** The centre coordinate of a rect along one axis. */
function centre(rect: SlRect, axis: DistributeAxis): number {
  return axis === 'horizontal' ? rect.x + rect.width / 2 : rect.y + rect.height / 2
}

/**
 * Distribute rects so their centres are evenly spaced along `axis`. The two extreme centres stay
 * fixed; interior centres are spread linearly between them. Returns a rect per input in the
 * **original** order, with only the axis coordinate changed. Fewer than `MIN_DISTRIBUTE` rects is a
 * no-op (returned as copies). Pure.
 */
export function distributeRects(rects: readonly SlRect[], axis: DistributeAxis): SlRect[] {
  const out = rects.map((rect) => ({ ...rect }))
  if (rects.length < MIN_DISTRIBUTE) return out

  // Order indices by centre along the axis; ties keep input order (stable via the index tiebreak).
  const order = rects
    .map((rect, index) => ({ index, c: centre(rect, axis) }))
    .toSorted((a, b) => a.c - b.c || a.index - b.index)

  const first = order[0]
  const last = order[order.length - 1]
  if (first === undefined || last === undefined) return out
  const span = last.c - first.c
  const step = span / (order.length - 1)

  order.forEach((entry, rank) => {
    // Extremes are pinned exactly (rank 0 and the last) so distribution never nudges the endpoints.
    const targetCentre = first.c + step * rank
    const rect = out[entry.index]
    if (rect === undefined) return
    if (axis === 'horizontal') rect.x = targetCentre - rect.width / 2
    else rect.y = targetCentre - rect.height / 2
  })
  return out
}
