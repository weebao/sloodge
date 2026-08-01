/**
 * PowerPoint-style **smart guides** — the M3.7 milestone. While an element is dragged, its edges and
 * centre are compared against the edges/centres of the other elements and the slide's own
 * centre/edges; when one lands within a small threshold, a guide line is shown and the drag snaps to
 * it. Pure frame-space arithmetic — no DOM, no React — so the detection and the snap delta are
 * exhaustively unit-testable (the overlay only draws the returned lines and previews the returned
 * rect).
 *
 * ## How the snap is chosen
 *
 * A move has two independent axes. On each axis the moving rect offers three reference positions —
 * near edge, centre, far edge — and each target (other elements, plus the slide box) offers the same
 * three. The single closest pairing within `threshold` wins that axis; its delta shifts the whole
 * rect so the two references coincide exactly. Choosing one snap per axis (rather than summing) keeps
 * the gesture stable: the element never jumps by more than the threshold, and the two axes cannot
 * fight. A resize or a drag with no alignment in range returns the input rect unchanged and no lines.
 */

import type { SlRect } from './bridge-protocol'

/** A guide line is a full segment on one axis at a fixed cross-axis position, in frame coords. */
export type GuideOrientation = 'vertical' | 'horizontal'

export interface GuideLine {
  readonly orientation: GuideOrientation
  /** The line's fixed coordinate: `x` for a vertical line, `y` for a horizontal one. */
  readonly position: number
  /** The segment's extent along the other axis — `[start, end]`, so the line spans the aligned pair. */
  readonly start: number
  readonly end: number
}

export interface SnapResult {
  /** The moving rect after snapping (unchanged when nothing was in range). */
  readonly rect: SlRect
  /** The guide lines to draw, one per reference the snapped rect now coincides with. */
  readonly guides: readonly GuideLine[]
}

/** The default snap radius in frame px — a few pixels, matching PowerPoint's feel. */
export const GUIDE_THRESHOLD = 6

interface Reference {
  /** The three reference coordinates along one axis: near edge, centre, far edge. */
  readonly coords: readonly number[]
  /** The rect's extent on the cross axis `[min, max]`, for drawing the guide's length. */
  readonly crossMin: number
  readonly crossMax: number
}

function horizontalRefs(rect: SlRect): Reference {
  return {
    coords: [rect.x, rect.x + rect.width / 2, rect.x + rect.width],
    crossMin: rect.y,
    crossMax: rect.y + rect.height,
  }
}

function verticalRefs(rect: SlRect): Reference {
  return {
    coords: [rect.y, rect.y + rect.height / 2, rect.y + rect.height],
    crossMin: rect.x,
    crossMax: rect.x + rect.width,
  }
}

interface AxisSnap {
  readonly delta: number
  readonly position: number
  /** The matched target's cross-axis extent, for drawing the guide's length. */
  readonly targetCrossMin: number
  readonly targetCrossMax: number
}

/**
 * The best snap on one axis: the moving/target reference pair with the smallest absolute gap within
 * `threshold`, or `null` when nothing is in range. Carries the matched target's cross-axis extent so
 * the caller can draw a guide spanning the snapped element and the element it aligned to.
 */
function bestSnap(
  moving: Reference,
  targets: readonly Reference[],
  threshold: number,
): AxisSnap | null {
  let best: AxisSnap | null = null
  for (const target of targets) {
    for (const targetCoord of target.coords) {
      for (const movingCoord of moving.coords) {
        const delta = targetCoord - movingCoord
        if (Math.abs(delta) > threshold) continue
        if (best === null || Math.abs(delta) < Math.abs(best.delta)) {
          best = {
            delta,
            position: targetCoord,
            targetCrossMin: target.crossMin,
            targetCrossMax: target.crossMax,
          }
        }
      }
    }
  }
  return best
}

/**
 * Snap `moving` to the nearest alignment with any of `targets` (the other elements) or the slide box
 * (its edges and centre lines), within `threshold`. Returns the snapped rect and the guide lines to
 * draw. Pure.
 */
export function snapRectToGuides(
  moving: SlRect,
  targets: readonly SlRect[],
  slide: { readonly width: number; readonly height: number },
  threshold: number = GUIDE_THRESHOLD,
): SnapResult {
  const slideRect: SlRect = { x: 0, y: 0, width: slide.width, height: slide.height }
  const allTargets = [...targets, slideRect]

  const hSnap = bestSnap(horizontalRefs(moving), allTargets.map(horizontalRefs), threshold)
  const vSnap = bestSnap(verticalRefs(moving), allTargets.map(verticalRefs), threshold)

  const dx = hSnap?.delta ?? 0
  const dy = vSnap?.delta ?? 0
  const rect: SlRect = { ...moving, x: moving.x + dx, y: moving.y + dy }

  // Guide lengths span the snapped moving rect and the target it aligned to, so the line visibly
  // connects the two elements it relates.
  const guides: GuideLine[] = []
  if (hSnap !== null) {
    guides.push({
      orientation: 'vertical',
      position: hSnap.position,
      start: Math.min(rect.y, hSnap.targetCrossMin),
      end: Math.max(rect.y + rect.height, hSnap.targetCrossMax),
    })
  }
  if (vSnap !== null) {
    guides.push({
      orientation: 'horizontal',
      position: vSnap.position,
      start: Math.min(rect.x, vSnap.targetCrossMin),
      end: Math.max(rect.x + rect.width, vSnap.targetCrossMax),
    })
  }
  return { rect, guides }
}
