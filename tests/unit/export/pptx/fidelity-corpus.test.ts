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
import { readbackPptx, type ReadbackSlide } from '../../../fidelity/lib/readback'

/**
 * The §5.2 fidelity targets (research/pptx-export-fidelity.md), asserted over the 14-slide corpus.
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
 * full-bleed-picture case. From M4.8a review r1: restoring the `!node.isLeaf` guard in `walker.ts`
 * reds the x1 painted-box case; putting `MATRIX_TOLERANCE` back to 1e-6 reds the 28°/62° case;
 * removing the opacity fold reds the ghost-watermark case; removing the `truth.boxes` pairing in
 * `assess.ts` reds the x1 painted-box case and the old-scorer case's box entries.
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

/** The `.pptx` one corpus slide produces, for the cases that assert on emitted XML directly. */
async function readbackOf(file: string, fidelity: PptxFidelity): Promise<ReadbackSlide> {
  const recording = loadRecorded().find((r) => r.file === file)!
  const plan = planSlide({
    measure: recording.measure,
    fidelity,
    rasterDataUrl: PNG,
    backgroundDataUrl: null,
  })
  const bytes = await writeDeckPptx({ title: file, author: 'test', slides: [plan] })
  return readbackPptx(bytes)[0]!
}

const recorded = loadRecorded()
const x1Readback = await readbackOf('x1-ghost-opacity.html', 'editable')
const x4Readback = await readbackOf('x4-shadows.html', 'auto')
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
    expect(recorded).toHaveLength(14)
    expect(summary.textTotal).toBeGreaterThan(40)
    expect(summary.rotationsExpected).toBe(9)
    expect(summary.bodyImageSlides).toBe(1)
  })

  it('record painted boxes and pseudo-elements, which the metric is stated over', () => {
    const x1 = recorded.find((r) => r.file === 'x1-ghost-opacity.html')!
    expect(x1.truth.boxes.length).toBeGreaterThanOrEqual(3)
    expect(x1.truth.pseudos).toEqual([{ hostTag: 'h1', which: '::before' }])
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

  /**
   * The r1 reviewer's out-of-corpus probes, promoted to fixtures. (Top level: these are about the
   * metric and the exporter together, not the §5.2 table.) Each one scored 85–100 through the
   * real export path while dropping a load-bearing construct, and the first cut of the metric — which
   * read text, declared rotations and the body image, and never touched `truth.boxes` — reported them
   * clean. These cases pin the metric, not just the exporter.
   */
  describe('the constructs review r1 caught the exporter dropping', () => {
    const x1 = () => auto.find((a) => a.file === 'x1-ghost-opacity.html')!
    const x1Forced = () => editable.find((a) => a.file === 'x1-ghost-opacity.html')!

    it("x1 flags as a silent lie under the NEW assessor when fed the OLD scorer's output", () => {
      // The score the shipped scorer gave this slide before M4.8a's deductions existed: a clean 100,
      // structured, `reasons: []`. The assessor alone must call it a lie.
      const recording = recorded.find((r) => r.file === 'x1-ghost-opacity.html')!
      const assessed = assessSlide({
        corpus: CORPUS.find((c) => c.file === 'x1-ghost-opacity.html')!,
        truth: recording.truth,
        measure: recording.measure,
        readback: x1Readback,
        tier: 'structured',
        score: 100,
        reasons: [],
      })
      expect(assessed.silentLie).toBe(true)
      expect(assessed.constructsLost).toContain('pseudo: h1::before')
    })

    it('x1: every painted box survives — the empty divider and the clipped blob included', () => {
      // Before the paint rule dropped its `!node.isLeaf` guard, a childless painted <div> hit neither
      // walker branch and vanished with no coverage note at all.
      const forced = x1Forced()
      expect(forced.paintedTotal).toBeGreaterThanOrEqual(3)
      expect(forced.paintedLost).toEqual([])
      const fills = x1Readback.shapes.map((s) => s.fill)
      expect(fills).toContain('38BDF8')
      expect(fills).toContain('F472B6')
    })

    it('x1: the 8% ghost watermark ships transparent, not as an opaque white numeral', () => {
      const ghost = x1Readback.shapes.find((s) => s.text === '01')!
      expect(ghost.runs[0]!.opacity).toBeCloseTo(0.08, 2)
      expect(x1Forced().opacityWrong).toEqual([])
    })

    it('x1 routes to raster in auto: its ::before bar and clipped blob cannot be represented', () => {
      expect(x1().tier).toBe('raster')
      expect(x1().reasons.some((r) => r.includes('::before'))).toBe(true)
    })

    it('x3: all six rotations carry a correct rot, 28° and 62° included', () => {
      const x3 = auto.find((a) => a.file === 'x3-rotations.html')!
      expect(x3.tier).toBe('structured')
      expect(x3.rotationsOk, x3.rotationDetails.join('\n')).toBe(6)
      for (const label of ['TWENTY EIGHT', 'SIXTY TWO']) {
        const detail = x3.rotationDetails.find((d) => d.startsWith(label))!
        expect(detail).not.toContain('rot=0.00')
      }
    })

    it('x2: a gradient on a wrapper div routes to raster instead of putting pale text on white', () => {
      const x2 = auto.find((a) => a.file === 'x2-gradient-panel.html')!
      expect(x2.tier).toBe('raster')
      // Forced structured, the metric names the panel the walker cannot paint.
      const forced = editable.find((a) => a.file === 'x2-gradient-panel.html')!
      expect(forced.paintedLost.some((b) => b.includes('gradient'))).toBe(true)
    })

    it('x4: a drop-shadow-only card keeps a boundary; the inset shadow is scored, not faked', () => {
      const x4 = auto.find((a) => a.file === 'x4-shadows.html')!
      expect(x4.score).toBeLessThan(HIGH_CONFIDENCE)
      expect(x4.reasons.some((r) => r.includes('inset shadow'))).toBe(true)
      const shadowed = x4Readback.shapes.filter((s) => s.hasOuterShadow)
      expect(shadowed.length).toBeGreaterThan(0)
    })

    it('x5: a scaled stat is measured against rendered glyph size, and the skews are named', () => {
      // 64px × 1.4 × 0.75 = 67.2pt. Comparing against the authored 48pt would call this exact.
      const forced = editable.find((a) => a.file === 'x5-scale-skew-flip.html')!
      expect(forced.sizeWrong).toEqual([])
      expect(forced.constructsLost.some((c) => c.startsWith('transform flattened'))).toBe(true)
      expect(auto.find((a) => a.file === 'x5-scale-skew-flip.html')!.tier).toBe('raster')
    })
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
