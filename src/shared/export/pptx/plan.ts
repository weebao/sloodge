/**
 * The pure per-slide planner (M4.3): measurement pass + fidelity → a `SlidePlan` the pptxgenjs writer
 * can emit, with the structured-vs-raster decision made here and nothing about `electron` or pptxgenjs
 * in sight. This is the join point of the three pure pieces — the scorer (`confidence.ts`), the walker
 * (`walker.ts`), and the coverage honesty metric — so a single unit test can assert, per slide, the
 * tier, the score, the emitted shapes, and the speaker-notes text.
 *
 * The full-slide raster PNG is passed in as a data URL (the renderer always captures it, cheaply,
 * after the settle barrier), so the planner stays pure and testable while still being able to fall
 * back to a picture. A slide that resolves to `raster` but was handed no capture keeps its structured
 * shapes rather than emitting an empty slide — a degraded-but-present slide beats a blank one.
 */

import { chooseTier, scoreSlide } from './confidence'
import { slideTextForNotes, walkSlide } from './walker'
import type { MeasureResult } from './node'
import type { PptxFidelity, SlidePlan } from './types'

/** A slide's visible content coverage below this, in `auto`, tips the decision to raster. */
export const COVERAGE_RASTER_THRESHOLD = 0.75

export type PlanSlideArgs = {
  measure: MeasureResult
  fidelity: PptxFidelity
  /** The full-slide PNG data URL from `capturePage`, or `null` if capture failed/was skipped. */
  rasterDataUrl: string | null
}

/** The degradation note appended to a raster/animated slide's speaker notes (§4.2 / §3.5). */
export const ANIMATION_NOTE =
  '[Sloodge] This slide is animated; the exported image shows its final state.'

export function planSlide(args: PlanSlideArgs): SlidePlan {
  const { measure, fidelity, rasterDataUrl } = args
  const animated = measure.hasAnimation
  const { score, reasons, hardBlocker } = scoreSlide(measure.nodes)
  const walk = walkSlide(measure)

  // `auto` also tips to raster when the structured walk left too much visible content uncovered
  // (images/svg/canvas the pure path cannot embed) — an honest picture beats a slide full of holes.
  const coverageForcesRaster =
    fidelity === 'auto' && walk.coveredFraction < COVERAGE_RASTER_THRESHOLD
  let tier = chooseTier(score, fidelity, hardBlocker)
  if (coverageForcesRaster) tier = 'raster'
  if (coverageForcesRaster)
    reasons.push(
      `only ${String(Math.round(walk.coveredFraction * 100))}% of content structurally representable`,
    )

  const textLayer = slideTextForNotes(measure.nodes)
  const notesParts: string[] = []
  if (textLayer !== '') notesParts.push(`[Slide text]\n${textLayer}`)
  if (animated) notesParts.push(ANIMATION_NOTE)
  const notes = notesParts.join('\n\n')

  // Raster requested/decided but no capture available: keep the structured shapes rather than ship an
  // empty slide. Recorded in reasons so the report is honest about the downgrade.
  if (tier === 'raster' && rasterDataUrl === null) {
    reasons.push('raster capture unavailable — kept structured shapes')
    return {
      tier: 'structured',
      ...(walk.background !== null ? { background: walk.background } : {}),
      shapes: walk.shapes,
      notes,
      confidence: score,
      reasons,
    }
  }

  if (tier === 'raster') {
    return {
      tier: 'raster',
      shapes: [],
      ...(rasterDataUrl !== null ? { rasterDataUrl } : {}),
      notes,
      confidence: score,
      reasons,
    }
  }

  return {
    tier: 'structured',
    ...(walk.background !== null ? { background: walk.background } : {}),
    shapes: walk.shapes,
    notes,
    confidence: score,
    reasons,
  }
}
