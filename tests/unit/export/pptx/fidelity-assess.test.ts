import { describe, expect, it } from 'vitest'
import {
  BOX_TOLERANCE_PCT,
  UNIFORM_SCALE_TOLERANCE,
  assessSlide,
  type SlideAssessment,
} from '../../../fidelity/lib/assess'
import type { CorpusSlide } from '../../../fidelity/lib/corpus'
import type { ReadbackShape, ReadbackSlide } from '../../../fidelity/lib/readback'
import type { GroundTruth, TruthBox } from '../../../fidelity/lib/truth'
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
    fill: 'FF0000',
    fillOpacity: 1,
    line: null,
    hasOuterShadow: false,
    bullets: 0,
    ...overrides,
  }
}

function assess(boxes: TruthBox[], shapes: ReadbackShape[]): SlideAssessment {
  const truth: GroundTruth = { texts: [], boxes, pseudos: [], bodyBg: null, bodyBgImage: 'none' }
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
