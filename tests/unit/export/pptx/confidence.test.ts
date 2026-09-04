import { describe, expect, it } from 'vitest'
import {
  DROPPED_CONSTRUCT_FLOOR,
  MATRIX_TOLERANCE,
  DROPPED_CONSTRUCT_WEIGHTS,
  PPTX_HIGH_CONFIDENCE,
  PPTX_TIER_THRESHOLD,
  SCORE_WEIGHTS,
  WRONG_CONSTRUCT_FLOOR,
  WRONG_CONSTRUCT_WEIGHTS,
  chooseTier,
  decomposeTransform,
  firstFontFamily,
  isSystemFont,
  paintsImage,
  scoreSlide,
} from '../../../../src/shared/export/pptx/confidence'
import { makeMeasure, makeNode } from './_fixtures'

/**
 * The confidence scorer (§3.4) — table-driven. Each signal asserts its exact deduction and cap, the
 * hard blockers force raster, and the boundary cases land on the intended side of the threshold. A
 * mutation to the threshold or any weight reds a case here.
 */
describe('scoreSlide deductions', () => {
  it('a plain text slide scores 100', () => {
    const nodes = [makeNode({ isLeaf: true, text: 'Hello', tag: 'h1' })]
    expect(scoreSlide(makeMeasure(nodes)).score).toBe(100)
  })

  it('deducts for an element gradient/image background: no shape is emitted for it', () => {
    const one = [makeNode({ style: { backgroundImage: 'linear-gradient(red, blue)' } })]
    expect(scoreSlide(makeMeasure(one)).score).toBe(100 - SCORE_WEIGHTS.elementImageBackground)
    // One occurrence is enough to route `auto` to an honest raster (review r1: a full-bleed gradient
    // wrapper scored 88 and shipped its pale text on a white slide).
    expect(scoreSlide(makeMeasure(one)).score).toBeLessThan(PPTX_TIER_THRESHOLD)
    const many = Array.from({ length: 5 }, () =>
      makeNode({ style: { backgroundImage: 'url("a.png")' } }),
    )
    expect(scoreSlide(makeMeasure(many)).score).toBe(100 - SCORE_WEIGHTS.elementImageBackground)
  })

  it('deducts for filter/blend/clip-path', () => {
    expect(scoreSlide(makeMeasure([makeNode({ style: { filter: 'blur(4px)' } })])).score).toBe(
      100 - SCORE_WEIGHTS.filter,
    )
    expect(scoreSlide(makeMeasure([makeNode({ style: { mixBlendMode: 'multiply' } })])).score).toBe(
      100 - SCORE_WEIGHTS.mixBlend,
    )
    expect(scoreSlide(makeMeasure([makeNode({ style: { clipPath: 'circle(50%)' } })])).score).toBe(
      100 - SCORE_WEIGHTS.clipPath,
    )
  })

  it('deducts for multi-primitive SVG (forced rasterization), capped', () => {
    const svg = makeNode({ tag: 'svg', isLeaf: false, svgPrimitiveCount: 12 })
    expect(scoreSlide(makeMeasure([svg])).score).toBe(100 - SCORE_WEIGHTS.svgEach)
    const many = Array.from({ length: 4 }, () =>
      makeNode({ tag: 'svg', isLeaf: false, svgPrimitiveCount: 5 }),
    )
    expect(scoreSlide(makeMeasure(many)).score).toBe(100 - SCORE_WEIGHTS.svgCap)
  })

  it('deducts for images (not structurally embeddable) and canvas', () => {
    expect(scoreSlide(makeMeasure([makeNode({ tag: 'img', src: 'x.png' })])).score).toBe(
      100 - SCORE_WEIGHTS.imageEach,
    )
    expect(scoreSlide(makeMeasure([makeNode({ tag: 'canvas', isLeaf: false })])).score).toBe(
      100 - SCORE_WEIGHTS.canvas,
    )
  })

  it('deducts for a non-system font on text', () => {
    const node = makeNode({ isLeaf: true, text: 'Hi', style: { fontFamily: 'Inter, sans-serif' } })
    expect(scoreSlide(makeMeasure([node])).score).toBe(100 - SCORE_WEIGHTS.nonSystemFont)
  })

  it('deducts for overlapping text boxes', () => {
    const a = makeNode({ isLeaf: true, text: 'A', x: 0, y: 0, w: 100, h: 100 })
    const b = makeNode({ isLeaf: true, text: 'B', x: 10, y: 10, w: 100, h: 100 })
    expect(scoreSlide(makeMeasure([a, b])).score).toBe(100 - SCORE_WEIGHTS.overlapEach)
  })
})

describe('scoreSlide sees the body and the text the leaf rule drops (M4.8a)', () => {
  it('deducts for a gradient/image body background — the signal that used to be a 1 px² no-op', () => {
    const measure = makeMeasure([makeNode({ isLeaf: true, text: 'Hi', tag: 'h1' })], {
      body: { backgroundColor: 'rgba(0, 0, 0, 0)', backgroundImage: 'linear-gradient(red, blue)' },
    })
    const { score, reasons } = scoreSlide(measure)
    expect(score).toBe(100 - SCORE_WEIGHTS.bodyImageBackground)
    expect(reasons.some((r) => r.includes('body gradient'))).toBe(true)
    expect(paintsImage('url("x.png")')).toBe(true)
    expect(paintsImage('none')).toBe(false)
  })

  it('deducts heavily for bare text beside inline elements, below the auto threshold', () => {
    const p = makeNode({ tag: 'p', isLeaf: false, bareTextCount: 3 })
    const strong = makeNode({ tag: 'strong', isLeaf: true, text: 'enterprise expansion' })
    const { score, reasons } = scoreSlide(makeMeasure([p, strong]))
    expect(score).toBe(100 - SCORE_WEIGHTS.bareText)
    expect(score).toBeLessThan(PPTX_TIER_THRESHOLD)
    expect(reasons.some((r) => r.includes('3 text fragment'))).toBe(true)
  })

  it('classifies an inherited skew as `other` (a rotated ancestor as a similarity)', () => {
    const skewChild = makeNode({ ancestorTransforms: ['matrix(1, 0.5, 0, 1, 0, 0)'] })
    expect(scoreSlide(makeMeasure([skewChild])).score).toBe(100 - SCORE_WEIGHTS.transformOther)
    const rotChild = makeNode({ ancestorTransforms: ['matrix(0, 1, -1, 0, 0, 0)'] })
    expect(scoreSlide(makeMeasure([rotChild])).score).toBe(100 - SCORE_WEIGHTS.transformSimilarity)
  })

  it('deducts for a painting ::before/::after and for descendants escaping a clip', () => {
    expect(scoreSlide(makeMeasure([makeNode({ paintedPseudoCount: 1 })])).score).toBe(
      100 - SCORE_WEIGHTS.pseudoElement,
    )
    expect(scoreSlide(makeMeasure([makeNode({ escapingDescendants: 2 })])).score).toBe(
      100 - SCORE_WEIGHTS.clippedOverflow,
    )
  })

  it('deducts for a text-shadow, which has no run-level equivalent', () => {
    const node = makeNode({
      isLeaf: true,
      text: 'Ghost',
      style: { textShadow: 'rgba(0,0,0,.6) 0px 4px 12px' },
    })
    expect(scoreSlide(makeMeasure([node])).score).toBe(100 - SCORE_WEIGHTS.textShadow)
  })
})

/**
 * The weights are not taste: review r1 found un-modelled constructs shipping at 85–92 with the
 * construct silently gone — above the raster threshold, so `auto` never fell back. Each weight
 * therefore has a floor set by what its absence does to the output (see `confidence.ts`).
 */
describe('un-modelled constructs cannot ship quietly', () => {
  it('every "dropped" weight leaves the high-confidence band', () => {
    for (const key of DROPPED_CONSTRUCT_WEIGHTS) {
      expect(SCORE_WEIGHTS[key], key).toBeGreaterThanOrEqual(DROPPED_CONSTRUCT_FLOOR)
      expect(100 - SCORE_WEIGHTS[key], key).toBeLessThan(PPTX_HIGH_CONFIDENCE)
    }
  })

  it('every "wrong" weight routes a clean slide to raster on its own', () => {
    for (const key of WRONG_CONSTRUCT_WEIGHTS) {
      expect(SCORE_WEIGHTS[key], key).toBeGreaterThanOrEqual(WRONG_CONSTRUCT_FLOOR)
      expect(chooseTier(100 - SCORE_WEIGHTS[key], 'auto', null), key).toBe('raster')
    }
  })
})

const toSixDecimals = (n: number): string => (Math.round(n * 1e6) / 1e6).toString()

/** Chromium's own serialization of `transform: rotate(Xdeg)`, to six decimals. */
function chromiumMatrix(deg: number, scale = 1): string {
  const rad = (deg * Math.PI) / 180
  const a = toSixDecimals(scale * Math.cos(rad))
  const b = toSixDecimals(scale * Math.sin(rad))
  return `matrix(${a}, ${b}, ${toSixDecimals(-scale * Math.sin(rad))}, ${a}, 0, 0)`
}

describe('decomposeTransform', () => {
  it('reads the angle out of a pure rotation and treats none/translate as identity', () => {
    const r = decomposeTransform('matrix(0.970296, -0.241922, 0.241922, 0.970296, 0, 0)')
    expect(r.kind).toBe('similarity')
    if (r.kind === 'similarity') expect(r.deg).toBeCloseTo(-14, 3)
    expect(decomposeTransform('matrix(0, 1, -1, 0, 0, 0)')).toMatchObject({ deg: 90, scale: 1 })
    expect(decomposeTransform('none').kind).toBe('identity')
    expect(decomposeTransform('matrix(1, 0, 0, 1, 40, 10)').kind).toBe('identity')
  })

  it('rejects skew, flip and 3D', () => {
    expect(decomposeTransform('matrix(1, 0.5, 0, 1, 0, 0)').kind).toBe('other')
    expect(decomposeTransform('matrix(-1, 0, 0, 1, 0, 0)').kind).toBe('other')
    expect(decomposeTransform('matrix(2, 0, 0, 1, 0, 0)').kind).toBe('other')
    expect(decomposeTransform('matrix3d(1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1)').kind).toBe('other')
  })

  it('decomposes a uniform scale, alone and composed with a rotation', () => {
    expect(decomposeTransform('matrix(1.4, 0, 0, 1.4, 0, 0)')).toMatchObject({
      kind: 'similarity',
      scale: 1.4,
    })
    const both = decomposeTransform(chromiumMatrix(28, 1.4))
    expect(both.kind).toBe('similarity')
    if (both.kind === 'similarity') {
      expect(both.deg).toBeCloseTo(28, 3)
      expect(both.scale).toBeCloseTo(1.4, 3)
    }
  })

  /**
   * Review r1's blocker-adjacent major: a 1e-6 orthonormality tolerance is tighter than Chromium's
   * 6-decimal serialization, so `rotate(28deg)` (a² + b² = 1.0000011) classified as `other` and the
   * element shipped upright in an axis-aligned box with the reason "skew/scale/3D".
   */
  it('accepts the REAL matrices Chromium emits for 28° and 62°', () => {
    const at28 = decomposeTransform('matrix(0.882948, 0.469472, -0.469472, 0.882948, 0, 0)')
    expect(at28.kind).toBe('similarity')
    if (at28.kind === 'similarity') expect(at28.deg).toBeCloseTo(28, 3)
    const at62 = decomposeTransform('matrix(0.469472, 0.882948, -0.882948, 0.469472, 0, 0)')
    expect(at62.kind).toBe('similarity')
    if (at62.kind === 'similarity') expect(at62.deg).toBeCloseTo(62, 3)
  })

  /**
   * The mechanism, pinned directly. The old classifier required `|a² + b² − 1| < 1e-6`; at 28° the
   * serialized matrix gives 1.1e-6 and it fell to `other`. Modelling the scale removes that test
   * altogether — a matrix is a similarity because `a = d` and `b = −c`, whatever its magnitude — so
   * re-introducing an orthonormality check in any form reds this.
   */
  it('does not require an orthonormal matrix: the magnitude is the scale, not a defect', () => {
    for (const [a, b] of [
      [0.882948, 0.469472], // rotate(28deg): a² + b² = 1.0000011
      [0.469472, 0.882948], // rotate(62deg)
      [1.5, 0], // scale(1.5)
      [0.05, 0.05], // a tiny rotated scale
    ] as const) {
      const d = decomposeTransform(`matrix(${a}, ${b}, ${-b}, ${a}, 0, 0)`)
      expect(d.kind, `matrix(${a}, ${b}, …)`).toBe('similarity')
      if (d.kind === 'similarity') expect(d.scale).toBeCloseTo(Math.hypot(a, b), 6)
    }
  })

  /**
   * What `MATRIX_TOLERANCE` itself is for. Chromium writes `a` and `d` from the same cosine, so they
   * agree exactly; a hand-authored `matrix()` need not. 1e-4 admits the near-rotation an author
   * typed and still rejects any real skew (the smallest here is 100× the slack).
   */
  it('admits a hand-authored near-rotation within the tolerance, and rejects beyond it', () => {
    expect(MATRIX_TOLERANCE).toBe(1e-4)
    expect(decomposeTransform('matrix(0.882947, 0.469473, -0.469471, 0.882949, 0, 0)').kind).toBe(
      'similarity',
    )
    expect(decomposeTransform('matrix(0.8829, 0.4694, -0.4694, 0.8849, 0, 0)').kind).toBe('other')
  })

  it('classifies every 0.1° step of a full turn as a rotation, within 0.001°', () => {
    const misclassified: number[] = []
    const inaccurate: number[] = []
    for (let i = 0; i < 3601; i += 1) {
      const deg = i / 10
      const d = decomposeTransform(chromiumMatrix(deg))
      if (d.kind !== 'similarity') {
        // 0° and 360° both serialize to the identity matrix, which is `identity`, not a rotation.
        if (!((deg === 0 || deg === 360) && d.kind === 'identity')) misclassified.push(deg)
        continue
      }
      const want = deg > 180 ? deg - 360 : deg
      if (Math.abs(d.deg - want) > 0.001) inaccurate.push(deg)
    }
    expect(misclassified).toEqual([])
    expect(inaccurate).toEqual([])
  })
})

describe('scoreSlide hard blockers', () => {
  it('flags vertical writing-mode and position: sticky', () => {
    expect(
      scoreSlide(makeMeasure([makeNode({ style: { writingMode: 'vertical-rl' } })])).hardBlocker,
    ).toBe('vertical writing-mode')
    expect(scoreSlide(makeMeasure([makeNode({ style: { position: 'sticky' } })])).hardBlocker).toBe(
      'position: sticky',
    )
    expect(scoreSlide(makeMeasure([makeNode({})])).hardBlocker).toBeNull()
  })
})

describe('chooseTier', () => {
  it('auto uses the threshold', () => {
    expect(chooseTier(PPTX_TIER_THRESHOLD, 'auto', null)).toBe('structured')
    expect(chooseTier(PPTX_TIER_THRESHOLD - 1, 'auto', null)).toBe('raster')
  })

  it('raster always rasters; editable forces structured; a hard blocker overrides both', () => {
    expect(chooseTier(100, 'raster', null)).toBe('raster')
    expect(chooseTier(10, 'editable', null)).toBe('structured')
    expect(chooseTier(100, 'editable', 'vertical writing-mode')).toBe('raster')
    expect(chooseTier(100, 'auto', 'position: sticky')).toBe('raster')
  })

  it('a hard slide (animated SVG scene) routes to raster in auto; a plain slide stays structured', () => {
    const hard = [
      makeNode({ tag: 'svg', isLeaf: false, svgPrimitiveCount: 20 }),
      makeNode({ style: { filter: 'blur(2px)' } }),
      makeNode({ style: { backgroundImage: 'radial-gradient(red, blue)' } }),
    ]
    const hardScore = scoreSlide(makeMeasure(hard))
    expect(hardScore.score).toBeLessThan(PPTX_TIER_THRESHOLD)
    expect(chooseTier(hardScore.score, 'auto', hardScore.hardBlocker)).toBe('raster')

    const plain = [makeNode({ isLeaf: true, text: 'Title', tag: 'h1' })]
    const plainScore = scoreSlide(makeMeasure(plain))
    expect(plainScore.score).toBeGreaterThanOrEqual(PPTX_TIER_THRESHOLD)
    expect(chooseTier(plainScore.score, 'auto', plainScore.hardBlocker)).toBe('structured')
  })
})

describe('the raster threshold is pinned to concrete scores (not the constant)', () => {
  // A slide computed at 71 — just ABOVE 70 — must stay structured. Mutating the threshold to 90
  // reds this (71 < 90 → raster). Score = 100 − 24 (2 inset shadows, capped) − 5 (rotation) = 71.
  const justAbove = [
    makeNode({ tag: 'h1', isLeaf: true, text: 'Title' }),
    makeNode({ isLeaf: false, style: { boxShadow: 'inset 0 0 4px rgb(0, 0, 0)' } }),
    makeNode({ isLeaf: false, style: { boxShadow: 'inset 0 0 8px rgb(0, 0, 0)' } }),
    makeNode({ isLeaf: false, style: { transform: 'matrix(0, 1, -1, 0, 0, 0)' } }),
  ]

  // A slide computed at 68 — just BELOW 70 — must route to raster. Mutating the threshold to 60
  // reds this (68 ≥ 60 → structured). Score = 100 − 20 (clip-path) − 12 (inset shadow) = 68.
  const justBelow = [
    makeNode({ tag: 'h1', isLeaf: true, text: 'Title' }),
    makeNode({ isLeaf: false, style: { clipPath: 'circle(40%)' } }),
    makeNode({ isLeaf: false, style: { boxShadow: 'inset 0 0 4px rgb(0, 0, 0)' } }),
  ]

  it('computes the straddling scores exactly (pins the scorer weights)', () => {
    expect(scoreSlide(makeMeasure(justAbove)).score).toBe(71)
    expect(scoreSlide(makeMeasure(justBelow)).score).toBe(68)
  })

  it('a 71-score slide stays structured; moving the threshold to 90 would wrongly raster it', () => {
    const { score, hardBlocker } = scoreSlide(makeMeasure(justAbove))
    expect(chooseTier(score, 'auto', hardBlocker)).toBe('structured')
  })

  it('a 68-score slide routes to raster; moving the threshold to 60 would wrongly keep it structured', () => {
    const { score, hardBlocker } = scoreSlide(makeMeasure(justBelow))
    expect(chooseTier(score, 'auto', hardBlocker)).toBe('raster')
  })
})

describe('isSystemFont', () => {
  it('recognizes safe families and flags others', () => {
    expect(isSystemFont('Arial, sans-serif')).toBe(true)
    expect(isSystemFont('"Times New Roman", serif')).toBe(true)
    expect(isSystemFont('Inter, sans-serif')).toBe(false)
    expect(firstFontFamily('"Helvetica Neue", Arial')).toBe('helvetica neue')
  })
})
