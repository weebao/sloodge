import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { writeDeckPptx } from '../../../../src/main/export/pptx-writer'
import { slideMeasurementScript } from '../../../../src/shared/export/pptx/node'
import { planSlide } from '../../../../src/shared/export/pptx/plan'
import type { PptxFidelity } from '../../../../src/shared/export/pptx/types'
import {
  BOX_TOLERANCE_PCT,
  HIGH_CONFIDENCE,
  assessSlide,
  summarize,
  type SlideAssessment,
} from '../../../fidelity/lib/assess'
import { CORPUS, recordedFileName, type RecordedSlide } from '../../../fidelity/lib/corpus'
import { readbackPptx } from '../../../fidelity/lib/readback'

/**
 * The §5.2 fidelity targets (research/pptx-export-fidelity.md), asserted over the 8-slide corpus.
 *
 * The inputs are recordings made by `tests/fidelity/harness.ts` from the *real* export window: the
 * measurement pass production consumed, and an independent ground truth (text nodes via `Range`,
 * not the exporter's leaf rule). From there everything is the shipped pure pipeline — `planSlide`,
 * `writeDeckPptx` with the real pptxgenjs — read back from the emitted `.pptx`. No app launch, no
 * Python, deterministic.
 *
 * The recordings are pinned to the measurement script that produced them: change
 * `slideMeasurementScript` and this file fails closed until `pnpm fidelity --record` is re-run.
 *
 * Mutations that red this file (each was run): deleting the rotation decomposition in `walker.ts`
 * (`placement` → measured rect) reds the `rot` and box cases; reverting `scoreSlide` to ignore
 * `measure.body` reds the gradient-slide score case; dropping the bare-text deduction reds the
 * silent-lie case on `01-title-body`; dropping `background: { dataUrl }` in `plan.ts` reds the
 * full-bleed-picture case.
 */

const RECORDED_DIR = join(process.cwd(), 'tests', 'fidelity', 'corpus', 'recorded')
const PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
/** Distinguishable from `PNG` so the test can tell which capture became the background. */
const BG_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhQGAWjR9awAAAABJRU5ErkJggg=='

function loadRecorded(): RecordedSlide[] {
  return CORPUS.map((slide) => {
    const path = join(RECORDED_DIR, recordedFileName(slide.file))
    if (!existsSync(path)) {
      throw new Error(
        `${path} missing — run \`pnpm fidelity --record\` (needs Electron, local only)`,
      )
    }
    return JSON.parse(readFileSync(path, 'utf8')) as RecordedSlide
  })
}

async function assessAll(fidelity: PptxFidelity): Promise<SlideAssessment[]> {
  const out: SlideAssessment[] = []
  for (const [i, recorded] of loadRecorded().entries()) {
    const corpus = CORPUS[i]!
    const plan = planSlide({
      measure: recorded.measure,
      fidelity,
      rasterDataUrl: PNG,
      backgroundDataUrl: recorded.measure.body.backgroundImage.includes('gradient') ? BG_PNG : null,
    })
    // oxlint-disable-next-line no-await-in-loop -- one small deck per slide, in order
    const bytes = await writeDeckPptx({ title: corpus.file, author: 'test', slides: [plan] })
    const readback = readbackPptx(bytes)[0]!
    out.push(
      assessSlide({
        corpus,
        truth: recorded.truth,
        measure: recorded.measure,
        readback,
        tier: plan.tier,
        score: plan.confidence,
        reasons: plan.reasons,
      }),
    )
  }
  return out
}

const recorded = loadRecorded()
const auto = await assessAll('auto')
const editable = await assessAll('editable')
const summary = summarize(auto)

describe('fidelity corpus recordings', () => {
  it('cover every corpus slide and were produced by the current measurement script', () => {
    const scriptHash = createHash('sha256').update(slideMeasurementScript(), 'utf8').digest('hex')
    expect(recorded.map((r) => r.file)).toEqual(CORPUS.map((c) => c.file))
    for (const r of recorded) {
      expect(
        r.measurementScriptSha256,
        `${r.file}: recording is stale — run \`pnpm fidelity --record\``,
      ).toBe(scriptHash)
    }
  })

  it('carry real content (the corpus is not vacuous)', () => {
    expect(summary.textTotal).toBeGreaterThan(40)
    expect(summary.rotationsExpected).toBe(3)
    expect(summary.bodyImageSlides).toBe(1)
  })
})

describe('§5.2 targets over the corpus', () => {
  it(`no slide scores ≥ ${String(HIGH_CONFIDENCE)} and drops a construct — in auto or editable`, () => {
    expect(auto.filter((a) => a.silentLie).map((a) => a.file)).toEqual([])
    expect(editable.filter((a) => a.silentLie).map((a) => a.file)).toEqual([])
  })

  it('a structured slide in auto never loses a declared construct at all', () => {
    for (const a of auto) {
      if (a.tier === 'structured') expect(a.constructsLost, a.file).toEqual([])
    }
  })

  it('rotated elements carry a correct rot: 3/3 within 0.1°', () => {
    const rotated = auto.find((a) => a.file === '07-rotated.html')!
    expect(rotated.tier).toBe('structured')
    expect(rotated.rotationDetails).toHaveLength(3)
    expect(rotated.rotationsOk, rotated.rotationDetails.join('\n')).toBe(3)
  })

  it('the gradient-background slide is structured with a full-bleed picture background', async () => {
    const gradient = recorded.find((r) => r.file === '05-gradient-cards.html')!
    const plan = planSlide({
      measure: gradient.measure,
      fidelity: 'auto',
      rasterDataUrl: PNG,
      backgroundDataUrl: BG_PNG,
    })
    expect(plan.tier).toBe('structured')
    expect(plan.background).toEqual({ dataUrl: BG_PNG })
    const bytes = await writeDeckPptx({ title: 'g', author: 'test', slides: [plan] })
    expect(readbackPptx(bytes)[0]!.background).toBe('picture')
    // And the scorer saw the body: a gradient body is no longer a free 100.
    expect(plan.confidence).toBeLessThan(100)
    expect(plan.reasons.some((r) => r.includes('body gradient'))).toBe(true)
  })

  it('exact hex colour and font size hold at 100% on preserved runs', () => {
    expect(summary.colorTotal).toBeGreaterThan(0)
    expect(auto.flatMap((a) => a.colorWrong)).toEqual([])
    expect(auto.flatMap((a) => a.sizeWrong)).toEqual([])
    expect(summary.colorExact).toBe(summary.colorTotal)
    expect(summary.sizeExact).toBe(summary.colorTotal)
  })

  it(`emitted boxes stay within ${String(BOX_TOLERANCE_PCT)}% of the DOM box (rotated ones included)`, () => {
    expect(summary.boxChecks).toBeGreaterThan(40)
    expect(summary.boxWorstPct).toBeLessThanOrEqual(BOX_TOLERANCE_PCT)
  })

  it('text nodes are preserved verbatim in every structured auto slide (≥ 99% target)', () => {
    expect(summary.textTotal).toBeGreaterThan(0)
    expect(summary.textKept / summary.textTotal).toBeGreaterThanOrEqual(0.99)
  })

  it('01-title-body routes to raster in auto: its bare text beside <strong>/<em> would be dropped', () => {
    // Interim until M4.8b emits run-level text. Before M4.8a this slide scored 100 and shipped with
    // three fragments missing; the deduction exists so the raster fallback fires instead.
    const title = auto.find((a) => a.file === '01-title-body.html')!
    expect(title.tier).toBe('raster')
    expect(title.reasons.some((r) => r.includes('text fragment'))).toBe(true)
    // The loss is real, not hypothetical: forcing editable shows the three fragments gone.
    const forced = editable.find((a) => a.file === '01-title-body.html')!
    expect(forced.lostText).toHaveLength(3)
    expect(forced.silentLie).toBe(false)
  })
})
