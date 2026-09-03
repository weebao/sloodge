import { describe, expect, it } from 'vitest'
import {
  ANIMATION_NOTE,
  BACKGROUND_FROM_FULL_CAPTURE_REASON,
  BACKGROUND_LOST_REASON,
  CAPTURE_FAILED_REASON,
  planSlide,
} from '../../../../src/shared/export/pptx/plan'
import { makeMeasure, makeNode } from './_fixtures'

const PNG = 'data:image/png;base64,AAAA'
const BG = 'data:image/png;base64,BBBB'

const gradientBody = {
  backgroundColor: 'rgba(0, 0, 0, 0)',
  backgroundImage: 'linear-gradient(135deg, rgb(76, 29, 149) 0%, rgb(30, 58, 138) 100%)',
}

describe('planSlide body gradient/image background (M4.8a)', () => {
  const measure = (): ReturnType<typeof makeMeasure> =>
    makeMeasure([makeNode({ tag: 'h1', isLeaf: true, text: 'Pillars' })], { body: gradientBody })

  it('emits the background-only capture as a full-bleed picture and stays structured', () => {
    const plan = planSlide({
      measure: measure(),
      fidelity: 'auto',
      rasterDataUrl: PNG,
      backgroundDataUrl: BG,
    })
    expect(plan.tier).toBe('structured')
    expect(plan.background).toEqual({ dataUrl: BG })
    expect(plan.reasons).not.toContain(BACKGROUND_FROM_FULL_CAPTURE_REASON)
  })

  it('falls back to the full capture, and says so, when the background-only capture is missing', () => {
    const plan = planSlide({
      measure: measure(),
      fidelity: 'auto',
      rasterDataUrl: PNG,
      backgroundDataUrl: null,
    })
    expect(plan.background).toEqual({ dataUrl: PNG })
    expect(plan.reasons).toContain(BACKGROUND_FROM_FULL_CAPTURE_REASON)
  })

  it('with no capture at all, auto prefers raster — which becomes the capture-failed downgrade, never a white slide at 100', () => {
    const plan = planSlide({
      measure: measure(),
      fidelity: 'auto',
      rasterDataUrl: null,
      backgroundDataUrl: null,
    })
    expect(plan.reasons).toContain(BACKGROUND_LOST_REASON)
    expect(plan.downgrade).toEqual({ kind: 'capture-failed' })
    expect(plan.background).toBeUndefined()
    expect(plan.confidence).toBeLessThan(100)
  })

  it('editable keeps the structured shapes but still records the lost background', () => {
    const plan = planSlide({
      measure: measure(),
      fidelity: 'editable',
      rasterDataUrl: null,
      backgroundDataUrl: null,
    })
    expect(plan.tier).toBe('structured')
    expect(plan.downgrade).toBeUndefined()
    expect(plan.reasons).toContain(BACKGROUND_LOST_REASON)
  })
})

describe('planSlide', () => {
  it('plans a plain slide as structured with editable shapes', () => {
    const measure = makeMeasure([makeNode({ tag: 'h1', isLeaf: true, text: 'Hello' })])
    const plan = planSlide({
      measure,
      fidelity: 'auto',
      rasterDataUrl: PNG,
      backgroundDataUrl: null,
    })
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
    const plan = planSlide({
      measure,
      fidelity: 'auto',
      rasterDataUrl: PNG,
      backgroundDataUrl: null,
    })
    expect(plan.tier).toBe('raster')
    expect(plan.rasterDataUrl).toBe(PNG)
    expect(plan.shapes).toHaveLength(0)
  })

  it('force-raster rasters even a plain slide; force-editable keeps a hard slide structured', () => {
    const plain = makeMeasure([makeNode({ isLeaf: true, text: 'Hi' })])
    expect(
      planSlide({ measure: plain, fidelity: 'raster', rasterDataUrl: PNG, backgroundDataUrl: null })
        .tier,
    ).toBe('raster')

    const hard = makeMeasure([makeNode({ tag: 'svg', isLeaf: false, svgPrimitiveCount: 30 })])
    expect(
      planSlide({
        measure: hard,
        fidelity: 'editable',
        rasterDataUrl: PNG,
        backgroundDataUrl: null,
      }).tier,
    ).toBe('structured')
  })

  it('routes to raster in auto when structured coverage is too low (image-heavy slide)', () => {
    const measure = makeMeasure([
      makeNode({ isLeaf: true, text: 'x', w: 50, h: 50 }),
      makeNode({ tag: 'img', src: 'big.png', w: 1280, h: 720 }),
    ])
    const plan = planSlide({
      measure,
      fidelity: 'auto',
      rasterDataUrl: PNG,
      backgroundDataUrl: null,
    })
    expect(plan.tier).toBe('raster')
    expect(plan.reasons.some((r) => r.includes('representable'))).toBe(true)
  })

  it('keeps structured shapes rather than shipping an empty slide when a raster capture is unavailable', () => {
    const hard = makeMeasure([makeNode({ tag: 'svg', isLeaf: false, svgPrimitiveCount: 30 })])
    const plan = planSlide({
      measure: hard,
      fidelity: 'raster',
      rasterDataUrl: null,
      backgroundDataUrl: null,
    })
    expect(plan.tier).toBe('structured')
    // The machine-readable contract consumers branch on.
    expect(plan.downgrade).toEqual({ kind: 'capture-failed' })
    // The prose is carried too, but only as presentation — asserted via the exported constant so
    // rewording it is a one-line change here and cannot silently break a consumer.
    expect(plan.reasons).toContain(CAPTURE_FAILED_REASON)
  })

  it('sets no downgrade on the ordinary paths', () => {
    const plain = makeMeasure([makeNode({ tag: 'h1', isLeaf: true, text: 'Hello' })])
    expect(
      planSlide({ measure: plain, fidelity: 'auto', rasterDataUrl: PNG, backgroundDataUrl: null })
        .downgrade,
    ).toBeUndefined()
    const hard = makeMeasure([makeNode({ tag: 'svg', isLeaf: false, svgPrimitiveCount: 30 })])
    expect(
      planSlide({ measure: hard, fidelity: 'auto', rasterDataUrl: PNG, backgroundDataUrl: null })
        .downgrade,
    ).toBeUndefined()
  })

  it('writes a [Slide text] accessibility layer and the animation note into speaker notes', () => {
    const measure = makeMeasure([makeNode({ isLeaf: true, text: 'Agenda' })], {
      hasAnimation: true,
    })
    const plan = planSlide({
      measure,
      fidelity: 'auto',
      rasterDataUrl: PNG,
      backgroundDataUrl: null,
    })
    expect(plan.notes).toContain('[Slide text]')
    expect(plan.notes).toContain('Agenda')
    expect(plan.notes).toContain(ANIMATION_NOTE)
  })
})
