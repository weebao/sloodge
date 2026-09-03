/**
 * The pure per-slide planner (M4.3): measurement pass + fidelity → a `SlidePlan` the pptxgenjs writer
 * can emit, with the structured-vs-raster decision made here and nothing about `electron` or pptxgenjs
 * in sight. This is the join point of the three pure pieces — the scorer (`confidence.ts`), the walker
 * (`walker.ts`), and the coverage honesty metric — so a single unit test can assert, per slide, the
 * tier, the score, the emitted shapes, and the speaker-notes text.
 *
 * The captures are passed in as data URLs (the renderer takes them, cheaply, after the settle
 * barrier), so the planner stays pure and testable while still being able to fall back to a picture.
 * A slide that resolves to `raster` but was handed no capture keeps its structured shapes rather than
 * emitting an empty slide — a degraded-but-present slide beats a blank one.
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
  /**
   * A capture of the body's own paint with every descendant hidden — taken only when the body has a
   * gradient/image background (§3.3: "rasterized to a full-bleed background image"). `null` when the
   * body is solid, or when that capture failed.
   */
  backgroundDataUrl: string | null
}

/**
 * The presentational reason recorded when a raster slide had no capture. Purely human-readable — it is
 * listed in the report and nothing branches on it (see `SlideDowngrade`); reword it at will.
 */
export const CAPTURE_FAILED_REASON = 'raster capture unavailable — kept structured shapes'

/** Recorded when the body background had to come from the full capture (text baked in beneath the runs). */
export const BACKGROUND_FROM_FULL_CAPTURE_REASON =
  'body background taken from the full-slide capture (background-only capture unavailable)'

/** Recorded when a gradient/image body background could not be captured at all. */
export const BACKGROUND_LOST_REASON = 'body gradient/image background could not be captured'

/** The degradation note appended to a raster/animated slide's speaker notes (§4.2 / §3.5). */
export const ANIMATION_NOTE =
  '[Sloodge] This slide is animated; the exported image shows its final state.'

export function planSlide(args: PlanSlideArgs): SlidePlan {
  const { measure, fidelity, rasterDataUrl, backgroundDataUrl } = args
  const animated = measure.hasAnimation
  const { score, reasons, hardBlocker } = scoreSlide(measure)
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

  // The slide background. A gradient/image body is a full-bleed picture: the background-only capture
  // when we have it, else the full capture (readable, but the runs sit on baked-in copies of
  // themselves), else nothing — in which case `auto` prefers an honest raster of the whole slide.
  let background: SlidePlan['background'] | undefined = walk.background ?? undefined
  if (walk.bodyImage) {
    const capture = backgroundDataUrl ?? rasterDataUrl
    if (capture !== null) {
      background = { dataUrl: capture }
      if (backgroundDataUrl === null) reasons.push(BACKGROUND_FROM_FULL_CAPTURE_REASON)
    } else {
      reasons.push(BACKGROUND_LOST_REASON)
      if (fidelity === 'auto') tier = 'raster'
    }
  }

  const textLayer = slideTextForNotes(measure.nodes)
  const notesParts: string[] = []
  if (textLayer !== '') notesParts.push(`[Slide text]\n${textLayer}`)
  if (animated) notesParts.push(ANIMATION_NOTE)
  const notes = notesParts.join('\n\n')

  // Raster requested/decided but no capture available: keep the structured shapes rather than ship an
  // empty slide. Reported two ways, deliberately kept apart: `downgrade.kind` is the machine-readable
  // contract consumers branch on, and the `reasons` entry is presentation only — reword it freely.
  if (tier === 'raster' && rasterDataUrl === null) {
    reasons.push(CAPTURE_FAILED_REASON)
    return {
      tier: 'structured',
      downgrade: { kind: 'capture-failed' },
      ...(background !== undefined ? { background } : {}),
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
    ...(background !== undefined ? { background } : {}),
    shapes: walk.shapes,
    notes,
    confidence: score,
    reasons,
  }
}
