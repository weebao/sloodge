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
 */

import type { Point } from './overlay-geometry'

/** The keyboard modifiers that change rotation snapping, read live from the pointer event. */
export interface RotateModifiers {
  /** Snap to a finer 15° grid instead of the default 45°. */
  readonly shift: boolean
  /** Free rotation: snap only to whole degrees, overriding the 45°/15° grid. */
  readonly alt: boolean
}

/** Snap increments, in degrees: the default 45° grid, the `Shift` 15° grid, the `Alt` free 1°. */
export const SNAP_COARSE_DEG = 45
export const SNAP_FINE_DEG = 15
export const SNAP_FREE_DEG = 1

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
 * Snap a raw rotation to the active grid and fold it into `[0, 360)`. Default is the 45° grid
 * (0/45/90/…), `Shift` the 15° grid, `Alt` free (whole degrees). `Alt` wins over `Shift` when both
 * are held — the more permissive intent is the one to honour when a user is asking for precision.
 */
export function snapRotation(degrees: number, mods: RotateModifiers): number {
  const increment = mods.alt ? SNAP_FREE_DEG : mods.shift ? SNAP_FINE_DEG : SNAP_COARSE_DEG
  const snapped = Math.round(normalizeDeg(degrees) / increment) * increment
  return normalizeDeg(snapped)
}
