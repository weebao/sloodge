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
 * The §5.2 fidelity targets (research/pptx-export-fidelity.md), asserted over the 26-slide corpus.
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
 * `assess.ts` reds the x1 painted-box case and the old-scorer case's box entries. From review r2:
 * deleting the property census in `node.ts` reds the x7 and x8 cases; dropping the standalone
 * `rotate`/`scale` from `NodeStyle` reds x10; restoring the unconditional `run.bullet` reds the x8
 * bullet case; deleting the `clippedTextPx` measurement reds x9. From review r3: reverting the
 * measurement script's visibility filter to `!== 'hidden'` reds the x14 case below (the collapsed
 * banner reappears as a node and as an emitted shape); dropping the `content`-replacement guard
 * reds the x15 case; removing the root census or the `rootPaint` deduction reds x11; removing
 * `contain` from `clipsBox` or putting it back in `LAYOUT_RESOLVED_PROPERTIES` reds x13; and
 * flattening the census probe back to one shadow root reds x12. From review r4: putting
 * `view-transition-name` back into `LAYOUT_RESOLVED_PROPERTIES` reds the x18 case — it returns to
 * structured at 100 with an empty census — and so does widening that exemption from value-scoped to
 * whole-property. Emulating the pre-r2 walker is not a mutation but a fixture here: it is what the
 * two counterfactual cases below assert directly.
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

/** A corpus fixture's lines with comments and blanks removed, so a pair can be diffed by hand. */
function declarationsOf(file: string): string[] {
  const raw = readFileSync(join(process.cwd(), 'tests', 'fidelity', 'corpus', file), 'utf8')
  return raw
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
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

/**
 * Every slide forced structured and handed a bare `score: 100, reasons: []` — the shape of the
 * pre-M4.8a pipeline's output, which had no deductions for any of this. Judged by the CURRENT
 * assessor, this is the retroactive "how many silent lies were shipping" figure.
 */
async function assessAsOldExporter(): Promise<SlideAssessment[]> {
  const out: SlideAssessment[] = []
  for (const [i, recorded] of loadRecorded().entries()) {
    const corpus = CORPUS[i]!
    const plan = planSlide({
      measure: recorded.measure,
      fidelity: 'editable',
      rasterDataUrl: PNG,
      backgroundDataUrl: null,
    })
    // oxlint-disable-next-line no-await-in-loop -- one small deck per slide, in order
    const bytes = await writeDeckPptx({ title: corpus.file, author: 'test', slides: [plan] })
    out.push(
      assessSlide({
        corpus,
        truth: recorded.truth,
        measure: recorded.measure,
        readback: readbackPptx(bytes)[0]!,
        tier: 'structured',
        score: 100,
        reasons: [],
      }),
    )
  }
  return out
}

/**
 * The recording as the **pre-M4.8a walker** would have read it (review r4).
 *
 * `NodeStyle.rotate`/`scale`/`translate` — the standalone CSS Transforms Level 2 properties, which
 * do NOT fold into the computed `transform` — were introduced at `b42085a` (M4.8a r2). At `c20ce96`
 * and at `fe20e2e`/`d7c37c7` the walker read `transform` and nothing else, so an element authored
 * with `rotate: 20deg` arrived with nothing to place it by. Zeroing those three fields on today's
 * recording reproduces that exporter; everything downstream is the real pipeline and the current,
 * two-halved oracle.
 */
const withoutStandaloneTransforms = <
  T extends { rotate: string; scale: string; translate: string },
>(
  spec: T,
): T => ({ ...spec, rotate: 'none', scale: 'none', translate: 'none' })

function asPreR2Walker(measure: RecordedSlide['measure']): RecordedSlide['measure'] {
  return {
    ...measure,
    nodes: measure.nodes.map((n) => ({
      ...n,
      ancestorTransforms: n.ancestorTransforms.map(withoutStandaloneTransforms),
      style: withoutStandaloneTransforms(n.style),
    })),
  }
}

/** One slide through the real pipeline, forced structured at 100, over the pre-r2 measurement. */
async function assessPreR2Walker(file: string): Promise<SlideAssessment> {
  const recording = loadRecorded().find((r) => r.file === file)!
  const corpus = CORPUS.find((c) => c.file === file)!
  const measure = asPreR2Walker(recording.measure)
  const plan = planSlide({
    measure,
    fidelity: 'editable',
    rasterDataUrl: PNG,
    backgroundDataUrl: null,
  })
  const bytes = await writeDeckPptx({ title: file, author: 'test', slides: [plan] })
  return assessSlide({
    corpus,
    truth: recording.truth,
    measure,
    readback: readbackPptx(bytes)[0]!,
    tier: 'structured',
    score: 100,
    reasons: [],
  })
}

const recorded = loadRecorded()
const x1Readback = await readbackOf('x1-ghost-opacity.html', 'editable')
const x4Readback = await readbackOf('x4-shadows.html', 'auto')
const asOldExporter = await assessAsOldExporter()
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
    expect(recorded).toHaveLength(26)
    expect(summary.textTotal).toBeGreaterThan(40)
    expect(summary.rotationsExpected).toBe(10)
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

    it('x1: a dropped painted box is named as a lost construct, not just counted', () => {
      // Pins the `truth.boxes` pairing itself: without it, `paintedLost` never reaches
      // `constructsLost` and the corpus-wide silent-lie assertions pass over a missing panel.
      const x2 = editable.find((a) => a.file === 'x2-gradient-panel.html')!
      expect(x2.constructsLost.some((c) => c.startsWith('box: '))).toBe(true)
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

  /**
   * Review r2's blockers. Each of these slides went through the REAL export path scoring 90–100 with
   * `constructsLost: []`, because the metric measured only the constructs somebody had thought to
   * name. They are fixtures now so the closed-world census cannot quietly re-open.
   */
  describe('the constructs review r2 caught the metric not measuring', () => {
    const find = (file: string) => auto.find((a) => a.file === file)!
    const forced = (file: string) => editable.find((a) => a.file === file)!

    it('x7: a masked panel is named by the census and routes to raster (was 90, structured)', () => {
      // Emitted a 1280×420 opaque navy rect where the reader sees a 60px strip, and a 940×220 rose
      // rect the reader never sees at all, both painting over the text.
      expect(find('x7-masked-panel.html').tier).toBe('raster')
      expect(forced('x7-masked-panel.html').unmodelledProperties).toContain('mask-image')
      expect(forced('x7-masked-panel.html').constructsLost).toContain('un-modelled CSS: mask-image')
    })

    it('x8: hollow outlined type is named, and the `list-style: none` chips ship no bullets', () => {
      const x8 = forced('x8-hollow-type.html')
      expect(x8.unmodelledProperties).toEqual([
        '-webkit-text-fill-color',
        '-webkit-text-stroke-width',
      ])
      expect(find('x8-hollow-type.html').tier).toBe('raster')
      // The chip row is a `<ul style="list-style: none">`: three `<a:buChar>` used to ship.
      expect(x8.bulletsInvented).toBe(0)
    })

    it('x8: the emitted file carries no bullet glyph at all', async () => {
      const x8 = await readbackOf('x8-hollow-type.html', 'editable')
      expect(x8.shapes.reduce((n, s) => n + s.bullets, 0)).toBe(0)
      expect(x8.shapes.filter((s) => s.text !== '').length).toBeGreaterThanOrEqual(6)
    })

    it('x9: text the browser truncates is not shipped whole (was 100, text 3/3, clean)', () => {
      const x9 = forced('x9-clipped-text.html')
      expect(x9.truncatedShipped).toHaveLength(2)
      expect(x9.truncatedShipped[0]).toContain('Consolidated quarterly revenue')
      expect(
        x9.constructsLost.filter((c) => c.startsWith('clipped text shipped in full')),
      ).toHaveLength(2)
      expect(find('x9-clipped-text.html').tier).toBe('raster')
      expect(find('x9-clipped-text.html').reasons.some((r) => r.includes('truncated'))).toBe(true)
    })

    it('x10: the standalone `rotate:` property carries a correct rot (was rot=0 at confidence 100)', () => {
      // research §1.3(b) reached through CSS Transforms Level 2's syntax: `rotate: 20deg` does not
      // fold into the computed `transform`, so the label shipped upright in a 307×172 box.
      const x10 = find('x10-rotate-property.html')
      expect(x10.tier).toBe('structured')
      expect(x10.rotationsOk, x10.rotationDetails.join('\n')).toBe(1)
      expect(x10.rotationDetails[0]).not.toContain('rot=0.00')
      expect(x10.constructsLost).toEqual([])
      expect(x10.silentLie).toBe(false)
    })

    it('x10: the standalone `scale:` property reaches the emitted glyph size', () => {
      // 46px × 1.6 × 0.75 = 55.2pt. Reading `transform` alone would call the unscaled 34.5pt exact.
      expect(forced('x10-rotate-property.html').sizeWrong).toEqual([])
    })

    it('the oracle catches a rotation shipped upright without being told an angle', () => {
      // `rotationLost` is derived from bounds-vs-layout geometry, not from `corpus.rotations`, so a
      // rotation nobody declared is still caught. Nothing in the corpus trips it today.
      expect(auto.flatMap((a) => a.rotationLost)).toEqual([])
      expect(editable.flatMap((a) => a.rotationLost)).toEqual([])
    })
  })

  /**
   * The §5.2 headline row, both ways round. The research measured 2/8 slides scoring ≥ 90 while
   * dropping a load-bearing construct; that number was itself an undercount, because the metric of
   * the day could only see three classes of construct.
   *
   * **Read the counterfactual precisely.** What this test measures is the **scorer deleted
   * outright** — every slide forced structured at a bare `score: 100, reasons: []` — while the
   * current walker still emits. It is the only one of the three that is asserted here, and it is
   * end-to-end: real `planSlide` → real pptxgenjs → read back from the emitted bytes.
   *
   * Rolling the scorer *back* to a historical commit gives smaller numbers over the original 18
   * slides, because a rolled-back scorer still deducts for the constructs it did know about and
   * `chooseTier` routes those slides to raster, where `constructsLost` is empty by definition. But
   * a scorer-only rollback is a pipeline that never shipped: **the walker was different too**.
   * `NodeStyle.rotate` — the standalone `rotate:` property — arrived at `b42085a` (r2), so at
   * `c20ce96` and `d7c37c7` an element authored with `rotate: 20deg` shipped upright and unscaled.
   * Under the actual pre-M4.8a pipeline, walker and scorer together, the honest historical figures
   * are therefore **4 at `c20ce96` and 6 at `d7c37c7`** — review r3's numbers, not this builder's
   * earlier 3 and 5, which held the walker at HEAD while naming the result by a historical commit.
   * `x10-rotate-property` is the whole of the disagreement, and the two cases below settle it
   * mechanically rather than in prose: x10 IS a silent lie under that walker, and `07-rotated` and
   * `x3-rotations` are NOT, which is what falsifies the earlier diagnosis that blamed the oracle's
   * bounds-vs-layout signature — it would have added all three, and no list contains 07 or x3.
   *
   * `x14-visibility-collapse` is absent for a different reason worth stating: its fix is in the
   * *emission*, not the score. The collapsed banner never becomes a node at all now, so even a
   * scorer-free exporter invents nothing. The old walker's losses are pinned by mutation instead,
   * one fix at a time (see the module docstring).
   */
  it('the retroactive figure: with the scorer deleted, 14 of 26 slides are silent lies', () => {
    const lying = asOldExporter.filter((a) => a.silentLie).map((a) => a.file)
    expect(lying).toEqual([
      '01-title-body.html',
      'x1-ghost-opacity.html',
      'x2-gradient-panel.html',
      'x5-scale-skew-flip.html',
      'x6-vertical-br.html',
      'x7-masked-panel.html',
      'x8-hollow-type.html',
      'x9-clipped-text.html',
      'x11-body-filter.html',
      'x12-important-mask.html',
      'x13-contain-paint.html',
      'x15-content-url.html',
      'x16-gradient-hero.html',
      'x18-view-transition-name.html',
    ])
    // …and the shipped pipeline, over the same corpus, lies about none.
    expect(summary.silentLies).toEqual([])
  })

  it('x10 IS a silent lie under the pre-M4.8a walker: `rotate:` had no support to lose', async () => {
    const x10 = await assessPreR2Walker('x10-rotate-property.html')
    expect(x10.rotationLost).toHaveLength(2)
    expect(x10.rotationLost[0]).toContain('ships upright at its bounds')
    // The standalone `scale:` is lost with it: 46px × 1.6 × 0.75 = 55.2pt, shipped as 34.5pt.
    expect(x10.sizeWrong.join(' ')).toContain('34.5pt')
    expect(x10.rotationsOk).toBe(0)
    expect(x10.silentLie).toBe(true)
  })

  it('07 and x3 are NOT: their rotations come from `transform`, which that walker read', async () => {
    // This is what falsifies blaming the count on `rotatedBoundsSignature` without `shippedUpright`:
    // that diagnosis predicts these two join x10, and they are in nobody's list under either walker.
    for (const file of ['07-rotated.html', 'x3-rotations.html']) {
      // oxlint-disable-next-line no-await-in-loop -- two small decks, in order
      const a = await assessPreR2Walker(file)
      expect(a.rotationLost, file).toEqual([])
      expect(a.rotationsOk, `${file}: ${a.rotationDetails.join('\n')}`).toBe(a.rotationsExpected)
      expect(a.silentLie, file).toBe(false)
    }
  })

  /**
   * The two review-r3 blockers that were **export** defects rather than metric defects: the file
   * carried things the slide never showed. A deduction alone would not have been a fix — in
   * `editable` the shapes still ship — so both are asserted against the emitted `.pptx`.
   */
  it('never emits a visibility: collapse banner, which Chromium paints nowhere', async () => {
    const x14 = recorded.find((r) => r.file === 'x14-visibility-collapse.html')!
    const banner = 'COLLAPSED BANNER'
    expect(x14.measure.nodes.some((n) => n.text.includes(banner))).toBe(false)
    expect(x14.truth.texts.some((t) => t.text.includes(banner))).toBe(false)
    // `editable` forces shapes, so this is the case a score could not have saved.
    const emitted = await readbackOf('x14-visibility-collapse.html', 'editable')
    expect(emitted.shapes.some((sh) => sh.text.includes(banner))).toBe(false)
    // The slide is not vacuous: what the reader DOES see still arrives.
    expect(emitted.shapes.some((sh) => sh.text.includes('What the reader actually sees'))).toBe(
      true,
    )
  })

  it('never emits the text a content: url() replaced, and rasterizes instead', async () => {
    const x15 = recorded.find((r) => r.file === 'x15-content-url.html')!
    const phantom = 'PHANTOM TEXT'
    expect(x15.measure.nodes.some((n) => n.text.includes(phantom))).toBe(false)
    expect(x15.truth.texts.some((t) => t.text.includes(phantom))).toBe(false)
    const emitted = await readbackOf('x15-content-url.html', 'editable')
    expect(emitted.shapes.some((sh) => sh.text.includes(phantom))).toBe(false)
    // The replacement image cannot be emitted either, so the census names `content` and auto rasters.
    const replaced = auto.find((a) => a.file === 'x15-content-url.html')!
    expect(replaced.tier).toBe('raster')
    expect(replaced.unmodelledProperties).toContain('content')
  })

  /**
   * The three r3 blockers the census mechanism itself could not see: two constructs outside its
   * quantifier (paint on a root element; a baseline the author's own `!important` could rewrite)
   * and one exempted by a written claim about CSS that was false.
   */
  it('scores paint on <body>/<html>, which querySelectorAll cannot reach', () => {
    const filtered = auto.find((a) => a.file === 'x11-body-filter.html')!
    expect(filtered.tier).toBe('raster')
    expect(filtered.reasons.some((r) => r.includes('recolours the whole slide'))).toBe(true)
    // The oracle names it independently, from its own recording rather than from the census.
    const forced = editable.find((a) => a.file === 'x11-body-filter.html')!
    expect(forced.rootPaintOps).toEqual(['body filter: invert(1)'])
    expect(forced.constructsLost.some((c) => c.startsWith('root paint'))).toBe(true)
  })

  it('sees through an author !important that used to rewrite the census baseline', () => {
    const masked = auto.find((a) => a.file === 'x12-important-mask.html')!
    expect(masked.tier).toBe('raster')
    expect(masked.unmodelledProperties).toEqual(
      expect.arrayContaining(['font-variant-caps', 'word-spacing']),
    )
  })

  it('sees contain: paint clipping, which leaves computed overflow at visible', () => {
    const contained = auto.find((a) => a.file === 'x13-contain-paint.html')!
    expect(contained.tier).toBe('raster')
    expect(contained.unmodelledProperties).toContain('contain')
    // Not only censused: the clip signal itself fires, so the loss is named rather than guessed at.
    const escaping = contained.reasons.some((r) =>
      r.includes('clipped by overflow would spill out'),
    )
    expect(escaping).toBe(true)
  })

  /**
   * Review r4's blocker: `view-transition-name` was exempted in `LAYOUT_RESOLVED_PROPERTIES` on the
   * written claim that outside an active transition it "has no rendering effect at all". It creates
   * a stacking context. The pair below is the smallest thing that shows it — two files differing in
   * exactly one declaration — and the reason it is a *pair* is that neither slide alone proves
   * anything: the emitted shapes are identical, in identical order, and only which one paints on
   * top differs. The census is the only signal that can tell them apart, and it could not while the
   * property was exempted.
   *
   * Restoring the exemption reds the x18 case (structured at 100, `unmodelledProperties` empty).
   */
  describe('the r4 paint-order pair', () => {
    const find = (file: string) => auto.find((a) => a.file === file)!

    it('differs in exactly one declaration, so the census is the only thing that can react', () => {
      const control = declarationsOf('x17-paint-order.html')
      const defect = declarationsOf('x18-view-transition-name.html')
      expect(defect.filter((line) => !control.includes(line))).toEqual([
        'view-transition-name: hero;',
      ])
      expect(control.filter((line) => !defect.includes(line))).toEqual([])
    })

    it('x17, the control, stays a clean structured 100', () => {
      const control = find('x17-paint-order.html')
      expect(control.tier).toBe('structured')
      expect(control.score).toBe(100)
      expect(control.unmodelledProperties).toEqual([])
      expect(control.constructsLost).toEqual([])
      expect(control.silentLie).toBe(false)
    })

    it('x18 censuses `view-transition-name` and routes to raster', () => {
      const defect = find('x18-view-transition-name.html')
      expect(defect.unmodelledProperties).toEqual(['view-transition-name'])
      expect(defect.tier).toBe('raster')
      // The loss is named in the forced tier too, not merely rasterized away.
      const forced = editable.find((a) => a.file === 'x18-view-transition-name.html')!
      expect(forced.constructsLost).toEqual(['un-modelled CSS: view-transition-name'])
    })

    it('both slides emit the same shapes in the same order — only paint order differs', async () => {
      // Why no shape-level check could ever have caught this, stated as an assertion rather than a
      // claim: the surplus check, the painted-box pairing and the text pairing all see one file.
      const shapesOf = async (file: string): Promise<string> =>
        (await readbackOf(file, 'editable')).shapes
          .map((sh) => `${String(sh.fill)}@${sh.x.toFixed(0)},${sh.y.toFixed(0)}`)
          .join(' ')
      expect(await shapesOf('x18-view-transition-name.html')).toBe(
        await shapesOf('x17-paint-order.html'),
      )
    })

    it('the UA value on <html> is exempted, so no slide rasterizes for `root`', () => {
      // Chromium gives the document element `view-transition-name: root`, and the census baseline —
      // a detached <html> two shadow roots deep — computes `none`. Without the value-scoped
      // exemption every one of the 26 slides would report it.
      const others = [...auto, ...editable].filter(
        (a) => a.file !== 'x18-view-transition-name.html',
      )
      expect(others).toHaveLength(2 * CORPUS.length - 2)
      for (const a of others)
        expect(a.unmodelledProperties, a.file).not.toContain('view-transition-name')
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
