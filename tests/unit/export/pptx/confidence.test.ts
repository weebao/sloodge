import { describe, expect, it } from 'vitest'
import {
  PPTX_TIER_THRESHOLD,
  SCORE_WEIGHTS,
  chooseTier,
  classifyTransform,
  firstFontFamily,
  isSystemFont,
  scoreSlide,
} from '../../../../src/shared/export/pptx/confidence'
import { makeNode } from './_fixtures'

/**
 * The confidence scorer (§3.4) — table-driven. Each signal asserts its exact deduction and cap, the
 * hard blockers force raster, and the boundary cases land on the intended side of the threshold. A
 * mutation to the threshold or any weight reds a case here.
 */
describe('scoreSlide deductions', () => {
  it('a plain text slide scores 100', () => {
    const nodes = [makeNode({ isLeaf: true, text: 'Hello', tag: 'h1' })]
    expect(scoreSlide(nodes).score).toBe(100)
  })

  it('deducts for gradients, capped', () => {
    const one = [makeNode({ style: { backgroundImage: 'linear-gradient(red, blue)' } })]
    expect(scoreSlide(one).score).toBe(100 - SCORE_WEIGHTS.gradientEach)
    const many = Array.from({ length: 5 }, () =>
      makeNode({ style: { backgroundImage: 'linear-gradient(red, blue)' } }),
    )
    expect(scoreSlide(many).score).toBe(100 - SCORE_WEIGHTS.gradientCap)
  })

  it('deducts for filter/blend/clip-path', () => {
    expect(scoreSlide([makeNode({ style: { filter: 'blur(4px)' } })]).score).toBe(
      100 - SCORE_WEIGHTS.filter,
    )
    expect(scoreSlide([makeNode({ style: { mixBlendMode: 'multiply' } })]).score).toBe(
      100 - SCORE_WEIGHTS.mixBlend,
    )
    expect(scoreSlide([makeNode({ style: { clipPath: 'circle(50%)' } })]).score).toBe(
      100 - SCORE_WEIGHTS.clipPath,
    )
  })

  it('deducts for multi-primitive SVG (forced rasterization), capped', () => {
    const svg = makeNode({ tag: 'svg', isLeaf: false, svgPrimitiveCount: 12 })
    expect(scoreSlide([svg]).score).toBe(100 - SCORE_WEIGHTS.svgEach)
    const many = Array.from({ length: 4 }, () =>
      makeNode({ tag: 'svg', isLeaf: false, svgPrimitiveCount: 5 }),
    )
    expect(scoreSlide(many).score).toBe(100 - SCORE_WEIGHTS.svgCap)
  })

  it('deducts for images (not structurally embeddable) and canvas', () => {
    expect(scoreSlide([makeNode({ tag: 'img', src: 'x.png' })]).score).toBe(
      100 - SCORE_WEIGHTS.imageEach,
    )
    expect(scoreSlide([makeNode({ tag: 'canvas', isLeaf: false })]).score).toBe(
      100 - SCORE_WEIGHTS.canvas,
    )
  })

  it('deducts for a non-system font on text', () => {
    const node = makeNode({ isLeaf: true, text: 'Hi', style: { fontFamily: 'Inter, sans-serif' } })
    expect(scoreSlide([node]).score).toBe(100 - SCORE_WEIGHTS.nonSystemFont)
  })

  it('deducts for overlapping text boxes', () => {
    const a = makeNode({ isLeaf: true, text: 'A', x: 0, y: 0, w: 100, h: 100 })
    const b = makeNode({ isLeaf: true, text: 'B', x: 10, y: 10, w: 100, h: 100 })
    expect(scoreSlide([a, b]).score).toBe(100 - SCORE_WEIGHTS.overlapEach)
  })
})

describe('scoreSlide hard blockers', () => {
  it('flags vertical writing-mode and position: sticky', () => {
    expect(scoreSlide([makeNode({ style: { writingMode: 'vertical-rl' } })]).hardBlocker).toBe(
      'vertical writing-mode',
    )
    expect(scoreSlide([makeNode({ style: { position: 'sticky' } })]).hardBlocker).toBe(
      'position: sticky',
    )
    expect(scoreSlide([makeNode({})]).hardBlocker).toBeNull()
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
    const hardScore = scoreSlide(hard)
    expect(hardScore.score).toBeLessThan(PPTX_TIER_THRESHOLD)
    expect(chooseTier(hardScore.score, 'auto', hardScore.hardBlocker)).toBe('raster')

    const plain = [makeNode({ isLeaf: true, text: 'Title', tag: 'h1' })]
    const plainScore = scoreSlide(plain)
    expect(plainScore.score).toBeGreaterThanOrEqual(PPTX_TIER_THRESHOLD)
    expect(chooseTier(plainScore.score, 'auto', plainScore.hardBlocker)).toBe('structured')
  })
})

describe('the raster threshold is pinned to concrete scores (not the constant)', () => {
  // A slide computed at 72 — just ABOVE 70 — must stay structured. Mutating the threshold to 90
  // reds this (72 < 90 → raster). Score = 100 − 12 (gradient) − 16 (2 inset shadows) = 72.
  const justAbove = [
    makeNode({ tag: 'h1', isLeaf: true, text: 'Title' }),
    makeNode({ isLeaf: false, style: { backgroundImage: 'linear-gradient(red, blue)' } }),
    makeNode({ isLeaf: false, style: { boxShadow: 'inset 0 0 4px rgb(0, 0, 0)' } }),
    makeNode({ isLeaf: false, style: { boxShadow: 'inset 0 0 8px rgb(0, 0, 0)' } }),
  ]

  // A slide computed at 63 — just BELOW 70 — must route to raster. Mutating the threshold to 60
  // reds this (63 ≥ 60 → structured). Score = 100 − 25 (filter) − 12 (gradient) = 63.
  const justBelow = [
    makeNode({ tag: 'h1', isLeaf: true, text: 'Title' }),
    makeNode({ isLeaf: false, style: { filter: 'blur(2px)' } }),
    makeNode({ isLeaf: false, style: { backgroundImage: 'linear-gradient(red, blue)' } }),
  ]

  it('computes the straddling scores exactly (pins the scorer weights)', () => {
    expect(scoreSlide(justAbove).score).toBe(72)
    expect(scoreSlide(justBelow).score).toBe(63)
  })

  it('a 72-score slide stays structured; moving the threshold to 90 would wrongly raster it', () => {
    const { score, hardBlocker } = scoreSlide(justAbove)
    expect(chooseTier(score, 'auto', hardBlocker)).toBe('structured')
  })

  it('a 63-score slide routes to raster; moving the threshold to 60 would wrongly keep it structured', () => {
    const { score, hardBlocker } = scoreSlide(justBelow)
    expect(chooseTier(score, 'auto', hardBlocker)).toBe('raster')
  })
})

describe('classifyTransform', () => {
  it('classifies none/translate/rotate/other', () => {
    expect(classifyTransform('none')).toBe('none')
    expect(classifyTransform('matrix(1, 0, 0, 1, 40, 10)')).toBe('translate')
    // 90° rotation.
    expect(classifyTransform('matrix(0, 1, -1, 0, 0, 0)')).toBe('rotate')
    // skew / scale.
    expect(classifyTransform('matrix(1, 0.5, 0, 1, 0, 0)')).toBe('other')
    expect(classifyTransform('matrix3d(1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1)')).toBe('other')
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
