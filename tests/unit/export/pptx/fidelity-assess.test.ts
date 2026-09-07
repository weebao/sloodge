import { describe, expect, it } from 'vitest'
import {
  BOX_TOLERANCE_PCT,
  UNIFORM_SCALE_TOLERANCE,
  assessSlide,
  type SlideAssessment,
} from '../../../fidelity/lib/assess'
import type { CorpusSlide } from '../../../fidelity/lib/corpus'
import type { ReadbackShape, ReadbackSlide } from '../../../fidelity/lib/readback'
import type {
  GroundTruth,
  TruthBlock,
  TruthBox,
  TruthRootPaint,
  TruthText,
} from '../../../fidelity/lib/truth'
import { SLIDE_WIDTH_PX } from '../../../../src/shared/export/types'
import { makeMeasure } from './_fixtures'

/**
 * The assessor's own constants, pinned against **computed** deviations rather than against
 * themselves (M4.8a, review r2).
 *
 * `BOX_TOLERANCE_PCT` is the milestone's headline box-fidelity target, but the only assertion over
 * it was `expect(summary.boxWorstPct).toBeLessThanOrEqual(BOX_TOLERANCE_PCT)` — a comparison of the
 * constant with itself. The reviewer widened it 80×, from 0.5 to 40, and the entire 2768-test suite
 * stayed green. `confidence.ts` avoids exactly this for the raster threshold, pinning it with two
 * fixtures whose computed scores straddle it; the same discipline is applied here.
 *
 * The two cases below straddle 0.5 % of the slide width (6.4 px): one shape 5 px off its painted box
 * must still pair, one 10 px off must not. Widening the constant reds the second; tightening it reds
 * the first.
 */

const CORPUS: CorpusSlide = { file: 'synthetic.html', rotations: [], bodyImage: false }

const NO_ROOT_PAINT: TruthRootPaint = {
  filter: 'none',
  backdropFilter: 'none',
  mixBlendMode: 'normal',
  clipPath: 'none',
}

function truthBox(overrides: Partial<TruthBox> = {}): TruthBox {
  return {
    tag: 'div',
    x: 100,
    y: 100,
    w: 200,
    h: 100,
    bg: 'FF0000',
    bgAlpha: 1,
    hasGradient: false,
    borderPx: 0,
    borderColor: null,
    transform: 'none',
    rotate: 'none',
    scale: 'none',
    translate: 'none',
    layoutW: 200,
    layoutH: 100,
    opacity: 1,
    ...overrides,
  }
}

function shape(overrides: Partial<ReadbackShape> = {}): ReadbackShape {
  return {
    kind: 'sp',
    geom: 'rect',
    x: 100,
    y: 100,
    w: 200,
    h: 100,
    rot: 0,
    runs: [],
    text: '',
    lines: [],
    insetLeft: 0,
    insetTop: 0,
    anchor: 't',
    wrap: 'square',
    autofit: false,
    lineSpacings: [null],
    fill: 'FF0000',
    fillOpacity: 1,
    line: null,
    hasOuterShadow: false,
    bullets: 0,
    ...overrides,
  }
}

function truthText(text: string, overrides: Partial<TruthText> = {}): TruthText {
  return {
    text,
    inSvg: false,
    parentTag: 'p',
    x: 100,
    y: 100,
    w: 200,
    h: 40,
    color: '000000',
    colorAlpha: 1,
    fontSizePx: 20,
    fontWeight: '400',
    fontStyle: 'normal',
    textTransform: 'none',
    textAlign: 'left',
    transform: 'none',
    rotate: 'none',
    scale: 'none',
    translate: 'none',
    transformed: false,
    hostW: 200,
    hostH: 40,
    hostLayoutW: 200,
    hostLayoutH: 40,
    clipped: false,
    bulleted: false,
    opacity: 1,
    renderedScale: 1,
    ...overrides,
  }
}

function assess(
  boxes: TruthBox[],
  shapes: ReadbackShape[],
  texts: TruthText[] = [],
  blocks: TruthBlock[] = [],
): SlideAssessment {
  const truth: GroundTruth = {
    texts,
    boxes,
    blocks,
    pseudos: [],
    bodyBg: null,
    bodyBgImage: 'none',
    rootPaint: { html: NO_ROOT_PAINT, body: NO_ROOT_PAINT },
  }
  const readback: ReadbackSlide = {
    index: 1,
    background: 'none',
    shapes,
    fullBleedPictures: 0,
  }
  return assessSlide({
    corpus: CORPUS,
    truth,
    measure: makeMeasure([]),
    readback,
    tier: 'structured',
    score: 100,
    reasons: [],
  })
}

/** A deviation as a percentage of the slide width, so the fixtures state their own arithmetic. */
const pctOfWidth = (px: number): number => (100 * px) / SLIDE_WIDTH_PX

describe('BOX_TOLERANCE_PCT is pinned to computed deviations, not to itself', () => {
  it('computes the straddling deviations exactly', () => {
    expect(BOX_TOLERANCE_PCT).toBe(0.5)
    expect(pctOfWidth(5)).toBeLessThan(BOX_TOLERANCE_PCT)
    expect(pctOfWidth(10)).toBeGreaterThan(BOX_TOLERANCE_PCT)
  })

  it('a shape 5 px from its painted box still carries it', () => {
    const a = assess([truthBox()], [shape({ x: 105 })])
    expect(a.paintedTotal).toBe(1)
    expect(a.paintedKept).toBe(1)
    expect(a.paintedLost).toEqual([])
  })

  it('a shape 10 px from its painted box does not — widening the tolerance reds this', () => {
    const a = assess([truthBox()], [shape({ x: 110 })])
    expect(a.paintedTotal).toBe(1)
    expect(a.paintedKept).toBe(0)
    expect(a.paintedLost).toEqual(['box: div #FF0000 200×100'])
  })

  it('position alone is not enough: the fill hex must match too', () => {
    const a = assess([truthBox()], [shape({ fill: '00FF00' })])
    expect(a.paintedKept).toBe(0)
  })
})

describe('the painted-box pairing is a bijection', () => {
  it('one emitted shape cannot carry two painted boxes', () => {
    // A card and a full-bleed inner overlay, both #FFFFFF at the same rect. Without a `used` set
    // carried across the loop, both paired against the single surviving shape and dropping one of
    // them left no trace at all (review r2).
    const a = assess([truthBox(), truthBox()], [shape()])
    expect(a.paintedTotal).toBe(2)
    expect(a.paintedKept).toBe(1)
    expect(a.paintedLost).toHaveLength(1)
  })

  it('two shapes carry two boxes', () => {
    const a = assess([truthBox(), truthBox()], [shape(), shape()])
    expect(a.paintedKept).toBe(2)
    expect(a.paintedLost).toEqual([])
  })
})

/**
 * The geometry-only rotation oracle. It asks whether an element's axis-aligned bounds can be
 * explained by a uniform scale of its layout box; if not, the element is rotated, and shipping it at
 * those bounds with `rot = 0` is research §1.3(b)'s signature — whatever CSS produced the angle.
 */
describe('rotationLost is derived from geometry, not from a declared angle', () => {
  const rotated = truthBox({ w: 307, h: 172, layoutW: 299, layoutH: 74 })

  it('flags a rotated box shipped upright at its bounding box', () => {
    const a = assess([rotated], [shape({ x: 100, y: 100, w: 307, h: 172, rot: 0 })])
    expect(a.rotationLost).toHaveLength(1)
    expect(a.rotationLost[0]).toContain('299×74 renders as 307×172')
    expect(a.constructsLost.some((c) => c.startsWith('rotation wrong'))).toBe(true)
  })

  it('accepts the same box shipped as its layout box plus a rot', () => {
    const a = assess([rotated], [shape({ w: 299, h: 74, rot: 20 })])
    expect(a.rotationLost).toEqual([])
  })

  it('does not flag a uniform scale, whose bounds ARE the scaled box and whose rot is 0', () => {
    // 110×54 at `scale: 1.6` renders 176×86. The walker emits exactly that, upright, correctly.
    const scaled = truthBox({ w: 176, h: 86, layoutW: 110, layoutH: 54 })
    const a = assess([scaled], [shape({ w: 176, h: 86, rot: 0 })])
    expect(Math.abs(176 / 110 - 86 / 54) / (176 / 110)).toBeLessThan(UNIFORM_SCALE_TOLERANCE)
    expect(a.rotationLost).toEqual([])
  })

  it('does not flag an untransformed box', () => {
    expect(assess([truthBox()], [shape()]).rotationLost).toEqual([])
  })
})

/**
 * The one check that runs **file → truth**. Every other check here asks "did the emitted file keep
 * what the reader sees", which by construction costs an INVENTED shape nothing: review r3 found two
 * fabrications — a `visibility: collapse` banner and a sentence a `content: url()` had replaced —
 * and each was caught only by a test naming its own literal string, which is the fitted-to-the-
 * fixture pattern r1 and r2 flagged. Not one case below names a string the checker could match on.
 *
 * What it does NOT close is compositing. The corpus pair x17/x18 emits the same shapes in the same
 * order and differs only in which paints on top, so no shape comparison in either direction can see
 * it; that is the pixel step's job, and it is stated as an open limitation in tests/fidelity/README.
 */
describe('surplusShapes catches fabrication without being told what was fabricated', () => {
  it('flags emitted text that no recorded text accounts for', () => {
    const a = assess([], [shape({ text: 'COLLAPSED BANNER' })], [truthText('What the reader sees')])
    expect(a.surplusShapes).toEqual(['text no reader sees: "COLLAPSED BANNER"'])
    expect(a.constructsLost).toContain('surplus shape: text no reader sees: "COLLAPSED BANNER"')
    expect(a.silentLie).toBe(true)
  })

  it('does not flag text the reader sees, SVG text the §5.2 metric excludes included', () => {
    const a = assess(
      [],
      [shape({ text: 'Visible heading' }), shape({ text: 'EMEA' })],
      [truthText('Visible heading'), truthText('EMEA', { inSvg: true })],
    )
    expect(a.surplusShapes).toEqual([])
  })

  it('is case-sensitive except for `capitalize`, whose casing the rendered-line check judges (r1)', () => {
    const run = { color: '000000', sizePt: 15, bold: false, underline: false, opacity: 1 }
    const shouted = shape({ runs: [{ ...run, text: 'QUIET WORDS' }], text: 'QUIET WORDS' })
    // `text-transform: none` and a run in the wrong case: the node is lost, not matched loosely.
    expect(assess([], [shouted], [truthText('quiet words')]).lostText).toEqual(['quiet words'])
    // `capitalize` matches case-insensitively here; the exact casing is `textLinesWrong`'s.
    const titled = shape({ runs: [{ ...run, text: 'Quiet Words' }], text: 'Quiet Words' })
    expect(
      assess([], [titled], [truthText('quiet words', { textTransform: 'capitalize' })]).lostText,
    ).toEqual([])
    // Mutation: widen `fold()` to every transform → the first assertion passes 'QUIET WORDS' as kept.
  })

  it('matches an uppercased run against its untransformed source text', () => {
    const a = assess(
      [],
      [shape({ text: 'SHOUTING' })],
      [truthText('Shouting', { textTransform: 'uppercase' })],
    )
    expect(a.surplusShapes).toEqual([])
  })

  it('flags a painted shape at a rect no painted box occupies', () => {
    const a = assess([truthBox()], [shape(), shape({ x: 700, y: 500, fill: '00FF00' })])
    expect(a.surplusShapes).toEqual(['paint no reader sees: #00FF00 200×100 at 700,500'])
  })

  it('does not flag the edge rects of one border, which sit inside the box they draw', () => {
    // `carrierOf`'s pairing is a bijection, so only the first of four edge rects claims the box.
    // Sitting inside a box the reader does see is what keeps the other three honest.
    const bordered = truthBox({ bg: null, bgAlpha: 0, borderPx: 4, borderColor: '3B82F6' })
    const edges = [0, 1, 2, 3].map((i) =>
      shape({ x: 100 + i, y: 100 + i, w: 4, h: 100, fill: '3B82F6' }),
    )
    const a = assess([bordered], edges)
    expect(a.paintedKept).toBe(1)
    expect(a.surplusShapes).toEqual([])
  })

  it('ignores the raster picture, which is a whole slide rather than a shape', () => {
    const a = assess([], [shape({ kind: 'pic', fill: null, w: 1280, h: 720, x: 0, y: 0 })])
    expect(a.surplusShapes).toEqual([])
  })

  it('ignores a shape that paints nothing at all', () => {
    const a = assess([], [shape({ fill: null, line: null })])
    expect(a.surplusShapes).toEqual([])
  })
})

describe('the line-spacing pairing picks the most specific block at the rect (M4.8b r2)', () => {
  it('pairs an `inset: 0` overlay to its own block, not to the ancestor whose innerText contains it', () => {
    // An `inset: 0` overlay with its own text shares its parent's rect, and the parent's innerText
    // contains the overlay's line. First-match paired the overlay's box to the parent and reported
    // a correct 2.5 as ≠ 1.50 — a silent lie the oracle manufactured.
    const rect = { x: 72, y: 150, w: 600, h: 120 }
    const parent: TruthBlock = {
      tag: 'div',
      ...rect,
      lines: ['Outer text on the card', 'Inner text on the overlay'],
      lineHeight: '30px',
      fontSizePx: 20,
    }
    const overlay: TruthBlock = {
      tag: 'div',
      ...rect,
      lines: ['Inner text on the overlay'],
      lineHeight: '50px',
      fontSizePx: 20,
    }
    const run = { color: '000000', sizePt: 15, bold: false, underline: false, opacity: 1 }
    const outerBox = shape({
      ...rect,
      fill: null,
      runs: [{ ...run, text: 'Outer text on the card' }],
      text: 'Outer text on the card',
      lines: ['Outer text on the card'],
      lineSpacings: [1.5],
    })
    const innerBox = shape({
      ...rect,
      fill: null,
      runs: [{ ...run, text: 'Inner text on the overlay' }],
      text: 'Inner text on the overlay',
      lines: ['Inner text on the overlay'],
      lineSpacings: [2.5],
    })
    const correct = assess([], [outerBox, innerBox], [], [parent, overlay])
    expect(correct.lineSpacingChecks).toBe(2)
    expect(correct.lineSpacingWrong).toEqual([])
    // The check still fires on a genuinely wrong overlay — and on a later paragraph (r2, MY1).
    const wrong = assess(
      [],
      [outerBox, { ...innerBox, lineSpacings: [1.5] }],
      [],
      [parent, overlay],
    )
    expect(wrong.lineSpacingWrong).toEqual(['"Inner text on the overlay": line spacing 1.5 ≠ 2.50'])
    const later = assess([], [{ ...outerBox, lineSpacings: [1.5, null] }], [], [parent])
    expect(later.lineSpacingWrong).toEqual(['"Outer text on the card": line spacing null ≠ 1.50'])
    // Mutation: pair to the first matching block → `correct.lineSpacingWrong` gains the 2.5 ≠ 1.50 entry.
  })
})
