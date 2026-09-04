/**
 * Small pure helpers over a hit's stored geometry, shared by the multi-select overlay and the
 * align/distribute actions (M3.7) so there is exactly one definition of "the box a gesture starts
 * from" and "shift a hit by a delta". Pure — `SlHit`/`SlRect` in, new value out — so it lives in
 * `src/shared` and is unit-testable without React or the DOM.
 */

import type { SlHit, SlRect } from './bridge-protocol'

/** The gesture box for a hit: its unrotated box if the frame measured one, else its rendered rect. */
export function boxOf(hit: SlHit): SlRect {
  return hit.box ?? hit.rect
}

/**
 * Whether a point in frame space lies within a rect, edges included. Used to ask whether a click
 * inside a group's *union* box landed on an actual member or in the whitespace between two of them
 * — a question the union rect itself cannot answer (M3.11 round-4).
 */
export function rectContainsPoint(rect: SlRect, point: { x: number; y: number }): boolean {
  return (
    point.x >= rect.x &&
    point.x <= rect.x + rect.width &&
    point.y >= rect.y &&
    point.y <= rect.y + rect.height
  )
}

/**
 * Whether a point in frame space lies within a rect that CSS has rotated by `angleDeg` about its own
 * centre — the region the user actually sees, rather than the layout box.
 *
 * The point is un-rotated about the rect's centre and handed to `rectContainsPoint`, which is exact
 * rather than an approximation: rotation is rigid, so a point is inside the rotated rect iff its
 * pre-image is inside the unrotated one. The centre is the right pivot because `SlHit.box` is the
 * unrotated border box *centred on the rendered box*, and CSS's default `transform-origin` is the
 * border box's centre; an element given an off-centre origin is outside what M3.6 writes.
 *
 * Signs: frame coords are y-down, so a positive CSS `rotate()` turns clockwise on screen and the
 * inverse map is a rotation by `-angleDeg` through the ordinary matrix.
 */
export function rotatedRectContainsPoint(
  rect: SlRect,
  angleDeg: number,
  point: { x: number; y: number },
): boolean {
  if (angleDeg === 0) return rectContainsPoint(rect, point)
  const cx = rect.x + rect.width / 2
  const cy = rect.y + rect.height / 2
  const radians = (-angleDeg * Math.PI) / 180
  const cos = Math.cos(radians)
  const sin = Math.sin(radians)
  const dx = point.x - cx
  const dy = point.y - cy
  return rectContainsPoint(rect, {
    x: cx + dx * cos - dy * sin,
    y: cy + dx * sin + dy * cos,
  })
}

/**
 * Shift a hit's stored geometry by `(dx, dy)` so the overlay boxes stay glued after a committed
 * move. Both `rect` and (when present) `box` translate; every other field is preserved.
 */
export function shiftHit(hit: SlHit, dx: number, dy: number): SlHit {
  const shift = (rect: SlRect): SlRect => ({ ...rect, x: rect.x + dx, y: rect.y + dy })
  return {
    ...hit,
    rect: shift(hit.rect),
    ...(hit.box === undefined ? {} : { box: shift(hit.box) }),
  }
}
