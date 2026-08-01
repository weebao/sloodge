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
