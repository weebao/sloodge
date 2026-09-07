import { describe, expect, it } from 'vitest'
import {
  CLIPPED_TEXT_MIN_PX,
  DROPPED_CONSTRUCT_FLOOR,
  MATRIX_TOLERANCE,
  decomposeTransformSpec,
  elementImageDeduction,
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
import { SLIDE_HEIGHT_PX, SLIDE_WIDTH_PX } from '../../../../src/shared/export/types'
import { ancestorMatrix, makeMeasure, makeNode, makeRootPaint, textItem } from './_fixtures'

/**
 * The confidence scorer (§3.4) — table-driven. Each signal asserts its exact deduction and cap, the
 * hard blockers force raster, and the boundary cases land on the intended side of the threshold. A
 * mutation to the threshold or any weight reds a case here.
 */
describe('scoreSlide deductions', () => {
  it('a plain text slide scores 100', () => {
    const nodes = [makeNode({ text: 'Hello', tag: 'h1' })]
    expect(scoreSlide(makeMeasure(nodes)).score).toBe(100)
  })

  /**
   * The deduction is **area-scaled**, not flat (review r2). Flat, it could not tell "the gradient IS
   * the slide" from "the gradient is a 120×40 badge": a 0.52 %-area decorative pill rasterized a
   * slide whose title and three paragraphs were perfectly editable, while `coveredFraction` already
   * knew 97.5 % of it was representable.
   */
  it('deducts for an element gradient/image background, scaled by the area it covers', () => {
    const fullBleed = [
      makeNode({ w: 1280, h: 720, style: { backgroundImage: 'linear-gradient(red, blue)' } }),
    ]
    expect(scoreSlide(makeMeasure(fullBleed)).score).toBe(
      100 - SCORE_WEIGHTS.elementImageBackground,
    )
    // A full-bleed gradient wrapper still routes `auto` to an honest raster — research §1.3(a).
    expect(scoreSlide(makeMeasure(fullBleed)).score).toBeLessThan(PPTX_TIER_THRESHOLD)

    // A 120×40 decorative pill is 0.52 % of the slide. It must leave the high-confidence band (the
    // paint really is missing) without taking the whole slide's editable text down with it.
    const pill = [
      makeNode({ w: 120, h: 40, style: { backgroundImage: 'linear-gradient(red, blue)' } }),
    ]
    const pillScore = scoreSlide(makeMeasure(pill)).score
    expect(pillScore).toBeGreaterThanOrEqual(PPTX_TIER_THRESHOLD)
    expect(pillScore).toBeLessThan(PPTX_HIGH_CONFIDENCE)

    // Flattening the deduction back to a constant reds this: area has to change the answer.
    expect(pillScore).toBeGreaterThan(scoreSlide(makeMeasure(fullBleed)).score)
    expect(elementImageDeduction(0)).toBe(0)
    expect(elementImageDeduction(20 * 20)).toBe(DROPPED_CONSTRUCT_FLOOR)
  })

  it('a gradient panel large enough to carry text crosses the raster threshold on its own', () => {
    // ~8.3 % of the slide is where the area-scaled deduction reaches WRONG_CONSTRUCT_FLOOR.
    const panel = [
      makeNode({ w: 400, h: 240, style: { backgroundImage: 'linear-gradient(red, blue)' } }),
    ]
    expect(scoreSlide(makeMeasure(panel)).score).toBeLessThan(PPTX_TIER_THRESHOLD)
  })

  /**
   * Area is the wrong question below that crossover, and review r3 built the counter-example: a
   * 360×200 metric card — 7.8 % of the slide, so a deduction of 30 and a score of 70 — carrying
   * `$4.2M` in **white**. It shipped structured, the gradient was not emitted, and both white runs
   * landed on the white slide background. Invisible text is wrong output, not plainer output, so
   * the scaling is floored at `WRONG_CONSTRUCT_FLOOR` whenever a run sits inside the gradient's box.
   */
  it('floors the gradient deduction at the wrong-class floor when text sits on the gradient', () => {
    const card = makeNode({
      x: 64,
      y: 200,
      w: 360,
      h: 200,
      style: { backgroundImage: 'linear-gradient(135deg, #4f46e5, #0ea5e9)' },
    })
    const value = makeNode({
      x: 96,
      y: 232,
      w: 200,
      h: 60,
      text: '$4.2M',
      style: { color: 'rgb(255, 255, 255)' },
    })
    // Area alone charges less than the floor here — this is the constant the old invariant test
    // asserted while the code path applied something smaller.
    expect(elementImageDeduction(360 * 200)).toBeLessThan(WRONG_CONSTRUCT_FLOOR)
    const withText = scoreSlide(makeMeasure([card, value]))
    expect(100 - withText.score).toBeGreaterThanOrEqual(WRONG_CONSTRUCT_FLOOR)
    expect(chooseTier(withText.score, 'auto', withText.hardBlocker)).toBe('raster')
    expect(withText.reasons.some((r) => r.includes('text sitting on it'))).toBe(true)

    // The same card with the text moved off it keeps the cheap, area-scaled deduction, so the
    // decorative-pill case r2 fixed is not undone.
    const beside = makeNode({ ...value, x: 600, y: 600 })
    const withoutText = scoreSlide(makeMeasure([card, beside]))
    expect(100 - withoutText.score).toBe(elementImageDeduction(360 * 200))
    expect(chooseTier(withoutText.score, 'auto', withoutText.hardBlocker)).toBe('structured')
  })

  /**
   * `<body>`/`<html>` paint (review r3). `body.querySelectorAll('*')` yields neither element, so a
   * `filter` on either was censused by nothing and scored by nothing: `body { filter: invert(1) }`
   * scored 100 with an empty reasons list while every colour in the emitted deck was the exact
   * complement of the rendered one. It is a WRONG-class weight rather than the dropped-class
   * `filter` weight because nothing is missing — everything is the wrong colour.
   */
  it('scores a filter/blend/clip on a root element as recolouring the whole slide', () => {
    const text = [makeNode({ text: 'Hi', tag: 'h1' })]
    for (const paint of [
      makeRootPaint({ filter: 'invert(1)' }),
      makeRootPaint({ backdropFilter: 'blur(4px)' }),
      makeRootPaint({ mixBlendMode: 'multiply' }),
      makeRootPaint({ clipPath: 'circle(40%)' }),
    ]) {
      for (const measure of [
        makeMeasure(text, { body: paint }),
        makeMeasure(text, { root: paint }),
      ]) {
        const { score, reasons } = scoreSlide(measure)
        expect(score).toBe(100 - SCORE_WEIGHTS.rootPaint)
        expect(chooseTier(score, 'auto', null)).toBe('raster')
        expect(reasons.some((r) => r.includes('recolours the whole slide'))).toBe(true)
      }
    }
  })

  it("censuses the root elements too, not only body's descendants", () => {
    const text = [makeNode({ text: 'Hi', tag: 'h1' })]
    for (const key of ['body', 'root'] as const) {
      const { score, reasons } = scoreSlide(
        makeMeasure(text, { [key]: makeRootPaint({ unmodelledProperties: ['zoom'] }) }),
      )
      expect(score).toBe(100 - SCORE_WEIGHTS.unmodelledProperty)
      expect(reasons.some((r) => r.includes('un-modelled CSS: zoom'))).toBe(true)
    }
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
    const svg = makeNode({ tag: 'svg', svgPrimitiveCount: 12 })
    expect(scoreSlide(makeMeasure([svg])).score).toBe(100 - SCORE_WEIGHTS.svgEach)
    const many = Array.from({ length: 4 }, () => makeNode({ tag: 'svg', svgPrimitiveCount: 5 }))
    expect(scoreSlide(makeMeasure(many)).score).toBe(100 - SCORE_WEIGHTS.svgCap)
  })

  it('deducts for images (not structurally embeddable) and canvas', () => {
    expect(scoreSlide(makeMeasure([makeNode({ tag: 'img', src: 'x.png' })])).score).toBe(
      100 - SCORE_WEIGHTS.imageEach,
    )
    expect(scoreSlide(makeMeasure([makeNode({ tag: 'canvas' })])).score).toBe(
      100 - SCORE_WEIGHTS.canvas,
    )
  })

  it('deducts for a non-system font on text', () => {
    const node = makeNode({ text: 'Hi', style: { fontFamily: 'Inter, sans-serif' } })
    expect(scoreSlide(makeMeasure([node])).score).toBe(100 - SCORE_WEIGHTS.nonSystemFont)
  })

  it('deducts for overlapping text boxes', () => {
    const a = makeNode({ text: 'A', x: 0, y: 0, w: 100, h: 100 })
    const b = makeNode({ text: 'B', x: 10, y: 10, w: 100, h: 100 })
    expect(scoreSlide(makeMeasure([a, b])).score).toBe(100 - SCORE_WEIGHTS.overlapEach)
  })
})

describe('scoreSlide sees the body, and text flow (M4.8a, M4.8b)', () => {
  it('deducts for a gradient/image body background — the signal that used to be a 1 px² no-op', () => {
    const measure = makeMeasure([makeNode({ text: 'Hi', tag: 'h1' })], {
      body: makeRootPaint({ backgroundImage: 'linear-gradient(red, blue)' }),
    })
    const { score, reasons } = scoreSlide(measure)
    expect(score).toBe(100 - SCORE_WEIGHTS.bodyImageBackground)
    expect(reasons.some((r) => r.includes('body gradient'))).toBe(true)
    expect(paintsImage('url("x.png")')).toBe(true)
    expect(paintsImage('none')).toBe(false)
  })

  it('no longer deducts for text beside inline elements: the run-level walk carries it (M4.8b)', () => {
    // `<p>a <strong>b</strong> c</p>` measures as one block root with three text items.
    const p = makeNode({
      tag: 'p',
      inlineContent: [
        textItem('Growth was driven by '),
        textItem('enterprise expansion', { fontWeight: '700' }),
        textItem(' than forecast.'),
      ],
    })
    const strong = makeNode({ tag: 'strong', inlineOf: p.domIndex })
    expect(scoreSlide(makeMeasure([p, strong])).score).toBe(100)
  })

  it('deducts, below the auto threshold, for text that flows around an object PowerPoint cannot (M4.8b)', () => {
    // `<p>Rate: <span class="pill">24%</span> up</p>`: the pill is its own box, and PowerPoint lays
    // " up" out right after "Rate: " — on top of the pill.
    const around = makeNode({
      tag: 'p',
      inlineContent: [textItem('Rate: '), { kind: 'box' }, textItem(' up')],
    })
    const { score, reasons } = scoreSlide(makeMeasure([around]))
    expect(score).toBe(100 - SCORE_WEIGHTS.interruptedFlow)
    expect(score).toBeLessThan(PPTX_TIER_THRESHOLD)
    expect(reasons.some((r) => r.includes('flow around an inline object'))).toBe(true)
    // Mixed content is the same defect vertically: text after a nested block lands under the
    // previous paragraph, not under the block.
    const mixed = makeNode({
      tag: 'div',
      inlineContent: [textItem('Intro'), { kind: 'block' }, textItem('Footer')],
    })
    expect(scoreSlide(makeMeasure([mixed])).score).toBe(100 - SCORE_WEIGHTS.interruptedFlow)
    // An object AFTER all of the block's own text shifts nothing.
    const trailing = makeNode({
      tag: 'p',
      inlineContent: [textItem('Status: '), { kind: 'box' }, textItem('  ')],
    })
    expect(scoreSlide(makeMeasure([trailing])).score).toBe(100)
  })

  it('deducts for a visible inline inside a hidden block, whose text no box carries (M4.8b)', () => {
    const orphan = makeNode({ tag: 'span', orphanText: true })
    const { score, reasons } = scoreSlide(makeMeasure([orphan]))
    expect(score).toBe(100 - SCORE_WEIGHTS.orphanText)
    expect(reasons.some((r) => r.includes('hidden block'))).toBe(true)
  })

  it('classifies an inherited skew as `other` (a rotated ancestor as a similarity)', () => {
    const skewChild = makeNode({
      ancestorTransforms: [ancestorMatrix('matrix(1, 0.5, 0, 1, 0, 0)')],
    })
    expect(scoreSlide(makeMeasure([skewChild])).score).toBe(100 - SCORE_WEIGHTS.transformOther)
    const rotChild = makeNode({ ancestorTransforms: [ancestorMatrix('matrix(0, 1, -1, 0, 0, 0)')] })
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
      text: 'Ghost',
      style: { textShadow: 'rgba(0,0,0,.6) 0px 4px 12px' },
    })
    expect(scoreSlide(makeMeasure([node])).score).toBe(100 - SCORE_WEIGHTS.textShadow)
  })
})

/**
 * The closed world (review r2). The three earlier signals in this file are a deny-list — each names
 * a construct somebody thought of — and two review rounds showed that cannot converge. The census
 * inverts the default: a computed property in neither set of `properties.ts` costs a WRONG-class
 * deduction and is named in the reasons, so an unfamiliar property routes to an honest raster.
 */
describe('un-modelled CSS properties fail toward raster', () => {
  it('deducts for any property the pipeline neither emits nor scores, and names it', () => {
    const masked = makeNode({ unmodelledProperties: ['mask-image'] })
    const { score, reasons } = scoreSlide(makeMeasure([masked]))
    expect(score).toBe(100 - SCORE_WEIGHTS.unmodelledProperty)
    expect(chooseTier(score, 'auto', null)).toBe('raster')
    expect(reasons.some((r) => r.includes('un-modelled CSS: mask-image'))).toBe(true)
  })

  it('names every distinct property once, however many elements carry it', () => {
    const nodes = [
      makeNode({ unmodelledProperties: ['-webkit-text-stroke-width', '-webkit-text-fill-color'] }),
      makeNode({ unmodelledProperties: ['-webkit-text-stroke-width'] }),
    ]
    const { score, reasons } = scoreSlide(makeMeasure(nodes))
    expect(score).toBe(100 - SCORE_WEIGHTS.unmodelledProperty)
    const named = reasons.find((r) => r.startsWith('un-modelled CSS'))
    expect(named).toBe('un-modelled CSS: -webkit-text-fill-color, -webkit-text-stroke-width')
  })

  it('a slide using only modelled CSS still scores 100 — the census is not a blanket charge', () => {
    expect(scoreSlide(makeMeasure([makeNode({ text: 'Hi' })])).score).toBe(100)
  })
})

describe('text a leaf clips itself is not shipped whole', () => {
  it('deducts for a truncated leaf, and ignores sub-pixel line-box rounding', () => {
    const clipped = makeNode({ text: 'Consolidated quarterly…', clippedTextPx: 400 })
    expect(scoreSlide(makeMeasure([clipped])).score).toBe(100 - SCORE_WEIGHTS.clippedText)
    const rounding = makeNode({
      text: 'Fits',
      clippedTextPx: CLIPPED_TEXT_MIN_PX - 1,
    })
    expect(scoreSlide(makeMeasure([rounding])).score).toBe(100)
  })
})

/**
 * CSS Transforms Level 2's standalone properties. They do NOT fold into the computed `transform`, so
 * an element carrying `rotate: 20deg` was measured as `transform: 'none'` and shipped upright at
 * `rot = 0` in a box twice as tall as its text — research §1.3(b) through the modern syntax.
 */
describe('decomposeTransformSpec', () => {
  it('reads the standalone rotate property, including its axis forms', () => {
    expect(decomposeTransformSpec(spec({ rotate: '20deg' }))).toMatchObject({ deg: 20, scale: 1 })
    expect(decomposeTransformSpec(spec({ rotate: 'z 20deg' }))).toMatchObject({ deg: 20 })
    expect(decomposeTransformSpec(spec({ rotate: '0 0 1 20deg' }))).toMatchObject({ deg: 20 })
    // An x/y axis is a 3D rotation with no `rot` equivalent.
    expect(decomposeTransformSpec(spec({ rotate: 'x 20deg' })).kind).toBe('other')
  })

  it('reads the standalone scale property, uniform only', () => {
    expect(decomposeTransformSpec(spec({ scale: '1.6' }))).toMatchObject({ scale: 1.6, deg: 0 })
    expect(decomposeTransformSpec(spec({ scale: '1.6 1.6' }))).toMatchObject({ scale: 1.6 })
    expect(decomposeTransformSpec(spec({ scale: '160%' }))).toMatchObject({ scale: 1.6 })
    expect(decomposeTransformSpec(spec({ scale: '2 1' })).kind).toBe('other')
    expect(decomposeTransformSpec(spec({ scale: '-1' })).kind).toBe('other')
  })

  it('treats translate as identity: the measured rect is already post-transform', () => {
    expect(decomposeTransformSpec(spec({ translate: '120px 20px' })).kind).toBe('identity')
    expect(decomposeTransformSpec(spec({})).kind).toBe('identity')
  })

  it('composes the properties with the transform matrix: angles add, scales multiply', () => {
    const composed = decomposeTransformSpec(
      spec({ rotate: '20deg', scale: '2', transform: 'matrix(0, 1.5, -1.5, 0, 0, 0)' }),
    )
    expect(composed.kind).toBe('similarity')
    if (composed.kind === 'similarity') {
      expect(composed.deg).toBeCloseTo(110, 6)
      expect(composed.scale).toBeCloseTo(3, 6)
    }
    // One un-decomposable component poisons the whole composition.
    expect(decomposeTransformSpec(spec({ rotate: '20deg', scale: '2 1' })).kind).toBe('other')
  })

  it('scores a standalone rotate as a modelled transform, not as nothing at all', () => {
    const rotated = makeNode({ style: { rotate: '20deg' } })
    expect(scoreSlide(makeMeasure([rotated])).score).toBe(100 - SCORE_WEIGHTS.transformSimilarity)
    const skewed = makeNode({ style: { scale: '2 1' } })
    expect(scoreSlide(makeMeasure([skewed])).score).toBe(100 - SCORE_WEIGHTS.transformOther)
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

  /**
   * The loop above asserts the **constants**, and for one signal the constant is not what is
   * charged: `elementImageBackground` is the ceiling of `elementImageDeduction(area)`, which
   * returns `DROPPED_CONSTRUCT_FLOOR` at small areas and only reaches the ceiling at 10 % coverage.
   * So the loop passed while the invariant it names was violated on every gradient under ~8.3 % of
   * the slide (review r3). The floor is real, but it is enforced by the text-on-gradient rule in
   * `scoreSlide`, not by the constant — which is what this case pins.
   */
  it('the one area-scaled weight charges less than its ceiling, and says so', () => {
    expect(WRONG_CONSTRUCT_WEIGHTS).toContain('elementImageBackground')
    expect(elementImageDeduction(120 * 40)).toBeLessThan(SCORE_WEIGHTS.elementImageBackground)
    expect(elementImageDeduction(120 * 40)).toBeLessThan(WRONG_CONSTRUCT_FLOOR)
    // Saturated, it is the ceiling the loop above asserts.
    expect(elementImageDeduction(SLIDE_WIDTH_PX * SLIDE_HEIGHT_PX)).toBe(
      SCORE_WEIGHTS.elementImageBackground,
    )
  })
})

/** A `TransformSpec` with only the properties a case exercises set. */
const spec = (
  o: Partial<{ transform: string; rotate: string; scale: string; translate: string }>,
): { transform: string; rotate: string; scale: string; translate: string } => ({
  transform: 'none',
  rotate: 'none',
  scale: 'none',
  translate: 'none',
  ...o,
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
      makeNode({ tag: 'svg', svgPrimitiveCount: 20 }),
      makeNode({ style: { filter: 'blur(2px)' } }),
      makeNode({ style: { backgroundImage: 'radial-gradient(red, blue)' } }),
    ]
    const hardScore = scoreSlide(makeMeasure(hard))
    expect(hardScore.score).toBeLessThan(PPTX_TIER_THRESHOLD)
    expect(chooseTier(hardScore.score, 'auto', hardScore.hardBlocker)).toBe('raster')

    const plain = [makeNode({ text: 'Title', tag: 'h1' })]
    const plainScore = scoreSlide(makeMeasure(plain))
    expect(plainScore.score).toBeGreaterThanOrEqual(PPTX_TIER_THRESHOLD)
    expect(chooseTier(plainScore.score, 'auto', plainScore.hardBlocker)).toBe('structured')
  })
})

describe('the raster threshold is pinned to concrete scores (not the constant)', () => {
  // A slide computed at 71 — just ABOVE 70 — must stay structured. Mutating the threshold to 90
  // reds this (71 < 90 → raster). Score = 100 − 24 (2 inset shadows, capped) − 5 (rotation) = 71.
  const justAbove = [
    makeNode({ tag: 'h1', text: 'Title' }),
    makeNode({ style: { boxShadow: 'inset 0 0 4px rgb(0, 0, 0)' } }),
    makeNode({ style: { boxShadow: 'inset 0 0 8px rgb(0, 0, 0)' } }),
    makeNode({ style: { transform: 'matrix(0, 1, -1, 0, 0, 0)' } }),
  ]

  // A slide computed at 68 — just BELOW 70 — must route to raster. Mutating the threshold to 60
  // reds this (68 ≥ 60 → structured). Score = 100 − 20 (mix-blend) − 12 (text-shadow) = 68.
  const justBelow = [
    makeNode({
      tag: 'h1',
      text: 'Title',
      style: { textShadow: '0 2px 4px rgb(0, 0, 0)' },
    }),
    makeNode({ style: { mixBlendMode: 'multiply' } }),
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
