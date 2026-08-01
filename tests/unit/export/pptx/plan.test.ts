import { describe, expect, it } from 'vitest'
import { ANIMATION_NOTE, planSlide } from '../../../../src/shared/export/pptx/plan'
import { makeMeasure, makeNode } from './_fixtures'

const PNG = 'data:image/png;base64,AAAA'

describe('planSlide', () => {
  it('plans a plain slide as structured with editable shapes', () => {
    const measure = makeMeasure([makeNode({ tag: 'h1', isLeaf: true, text: 'Hello' })])
    const plan = planSlide({ measure, fidelity: 'auto', rasterDataUrl: PNG })
    expect(plan.tier).toBe('structured')
    expect(plan.shapes.length).toBeGreaterThan(0)
    expect(plan.rasterDataUrl).toBeUndefined()
    expect(plan.confidence).toBe(100)
  })

  it('plans a hard slide as raster in auto, embedding the capture', () => {
    const measure = makeMeasure([
      makeNode({ tag: 'svg', isLeaf: false, svgPrimitiveCount: 30 }),
      makeNode({ style: { filter: 'blur(3px)' } }),
      makeNode({ style: { clipPath: 'circle(40%)' } }),
    ])
    const plan = planSlide({ measure, fidelity: 'auto', rasterDataUrl: PNG })
    expect(plan.tier).toBe('raster')
    expect(plan.rasterDataUrl).toBe(PNG)
    expect(plan.shapes).toHaveLength(0)
  })

  it('force-raster rasters even a plain slide; force-editable keeps a hard slide structured', () => {
    const plain = makeMeasure([makeNode({ isLeaf: true, text: 'Hi' })])
    expect(planSlide({ measure: plain, fidelity: 'raster', rasterDataUrl: PNG }).tier).toBe(
      'raster',
    )

    const hard = makeMeasure([makeNode({ tag: 'svg', isLeaf: false, svgPrimitiveCount: 30 })])
    expect(planSlide({ measure: hard, fidelity: 'editable', rasterDataUrl: PNG }).tier).toBe(
      'structured',
    )
  })

  it('routes to raster in auto when structured coverage is too low (image-heavy slide)', () => {
    const measure = makeMeasure([
      makeNode({ isLeaf: true, text: 'x', w: 50, h: 50 }),
      makeNode({ tag: 'img', src: 'big.png', w: 1280, h: 720 }),
    ])
    const plan = planSlide({ measure, fidelity: 'auto', rasterDataUrl: PNG })
    expect(plan.tier).toBe('raster')
    expect(plan.reasons.some((r) => r.includes('representable'))).toBe(true)
  })

  it('keeps structured shapes rather than shipping an empty slide when a raster capture is unavailable', () => {
    const hard = makeMeasure([makeNode({ tag: 'svg', isLeaf: false, svgPrimitiveCount: 30 })])
    const plan = planSlide({ measure: hard, fidelity: 'raster', rasterDataUrl: null })
    expect(plan.tier).toBe('structured')
    expect(plan.reasons.some((r) => r.includes('capture unavailable'))).toBe(true)
  })

  it('writes a [Slide text] accessibility layer and the animation note into speaker notes', () => {
    const measure = makeMeasure([makeNode({ isLeaf: true, text: 'Agenda' })], {
      hasAnimation: true,
    })
    const plan = planSlide({ measure, fidelity: 'auto', rasterDataUrl: PNG })
    expect(plan.notes).toContain('[Slide text]')
    expect(plan.notes).toContain('Agenda')
    expect(plan.notes).toContain(ANIMATION_NOTE)
  })
})
