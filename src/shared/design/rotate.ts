/**
 * The pure geometry of the rotation gesture — M3.6's sibling to `drag.ts`. A rotation handle drag
 * produces an **angle**, not a rectangle, so it lives in its own module rather than in `applyDrag`'s
 * rect algebra; like `drag.ts` it is scale-independent arithmetic with no DOM, so the whole gesture
 * reduces to functions a test drives directly (§5.5 rotation, roadmap M3.6 "angle snap 0/45/90").
 *
 * Angles are measured about the selection's **centre** — rotation is about centre (the CSS default
 * `transform-origin`), so the box's centre is the pivot and its client position is the one datum the
 * gesture needs. A drag records the pointer's angle from the centre at `pointerdown`; every move's
 * angle minus that start angle is the rotation the user has swept, added to the element's rotation
 * when the gesture began. Measuring the *delta* this way makes the handle grab-point-agnostic: it
 * does not matter where on the handle the pointer landed, only how far around the centre it travels.
 *
 * ## Snapping: free by default, magnetic at 0/45/90, `Shift` forces the grid
 *
 * PowerPoint rotates freely and lets `Shift` force 15° steps; the roadmap asks for a snap at
 * 0/45/90. Both hold: an unmodified drag is free but **magnetic** — within `SNAP_MAGNET_TOLERANCE_DEG`
 * of a multiple of 45° it lands exactly on it, so squaring an element up is a flick rather than a
 * hunt — `Shift` forces the 15° grid (which contains 0/45/90), and `Alt` bypasses the magnet for a
 * deliberate 44°. The first M3.6 cut snapped to 45° *always* unless `Alt` was held, which made a 30°
 * tilt unreachable without a modifier nobody is told about.
 *
 * Every result is a **whole degree**. That is what keeps repeated drags from drifting: each gesture
 * starts from the integer the source already holds (never from an accumulated float), sweeps a
 * pointer-measured delta, and commits an integer again, so ten nudges of 10° land on exactly 100°
 * and the source never carries `rotate(99.99997deg)`.
 */

import type { Point } from './overlay-geometry'

/** The keyboard modifiers that change rotation snapping, read live from the pointer event. */
export interface RotateModifiers {
  /** Force the 15° grid. */
  readonly shift: boolean
  /** Bypass the 45° magnet: whole degrees only. */
  readonly alt: boolean
}

/** The magnetic grid (0/45/90/…), how close a free drag must come to it to snap, and `Shift`'s grid. */
export const SNAP_MAGNET_DEG = 45
export const SNAP_MAGNET_TOLERANCE_DEG = 4
export const SNAP_FORCED_DEG = 15

/** Fold any angle into `[0, 360)`, so `-90°` and `270°` and `630°` all read as `270°`. */
export function normalizeDeg(degrees: number): number {
  return ((degrees % 360) + 360) % 360
}

/**
 * The angle, in degrees, from `centre` to `point` in screen convention (y grows downward, so
 * straight up is `-90°`). Both points are in the same space — the caller supplies client pixels.
 */
export function pointerAngleDeg(centre: Point, point: Point): number {
  return (Math.atan2(point.y - centre.y, point.x - centre.x) * 180) / Math.PI
}

/**
 * The element's rotation after dragging the handle from `startPoint` to `currentPoint` about
 * `centre`, before snapping: the element's rotation when the gesture began plus the angle the
 * pointer has swept around the centre. Grab-point-agnostic (see the header).
 */
export function rotationFromDrag(
  startRotation: number,
  centre: Point,
  startPoint: Point,
  currentPoint: Point,
): number {
  const swept = pointerAngleDeg(centre, currentPoint) - pointerAngleDeg(centre, startPoint)
  return startRotation + swept
}

/**
 * Snap a raw rotation per the header's rule and fold it into `[0, 360)` as a whole degree: `Shift`
 * forces the 15° grid, `Alt` is free, and an unmodified drag is free but lands on a multiple of 45°
 * when within `SNAP_MAGNET_TOLERANCE_DEG` of one. `Alt` wins over `Shift` when both are held — the
 * more permissive intent is the one to honour when a user is asking for precision.
 */
export function snapRotation(degrees: number, mods: RotateModifiers): number {
  const angle = normalizeDeg(degrees)
  if (mods.alt) return normalizeDeg(Math.round(angle))
  if (mods.shift) return normalizeDeg(Math.round(angle / SNAP_FORCED_DEG) * SNAP_FORCED_DEG)
  const nearest = Math.round(angle / SNAP_MAGNET_DEG) * SNAP_MAGNET_DEG
  if (Math.abs(angle - nearest) <= SNAP_MAGNET_TOLERANCE_DEG) return normalizeDeg(nearest)
  return normalizeDeg(Math.round(angle))
}
