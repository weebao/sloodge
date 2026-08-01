import { describe, expect, it } from 'vitest'
import {
  EMU_PER_CSS_PX,
  EMU_PER_INCH,
  boxToInches,
  pxToEmu,
  pxToInches,
  pxToPoints,
} from '../../../../src/shared/export/pptx/geometry'
import { SLIDE_HEIGHT_INCHES, SLIDE_WIDTH_INCHES } from '../../../../src/shared/export/types'

/**
 * The one coordinate mapping the whole structured walk rests on (60-export.md §3.7). These assertions
 * are exact on purpose — a mutation to any conversion factor mis-places every shape on every slide, so
 * each of these reds under such a mutation.
 */
describe('pptx geometry', () => {
  it('maps the 1280×720 slide onto the exact 16:9 PPTX box', () => {
    expect(pxToInches(1280)).toBeCloseTo(13.333333, 5)
    expect(pxToInches(720)).toBe(7.5)
    expect(pxToInches(1280)).toBe(SLIDE_WIDTH_INCHES)
    expect(pxToInches(720)).toBe(SLIDE_HEIGHT_INCHES)
  })

  it('converts px→EMU with the integer-exact 9525 factor (no rounding)', () => {
    expect(EMU_PER_INCH).toBe(914400)
    expect(EMU_PER_CSS_PX).toBe(9525)
    // Mutation target: a wrong factor here shifts every position.
    expect(pxToEmu(1280)).toBe(12_192_000)
    expect(pxToEmu(720)).toBe(6_858_000)
    expect(pxToEmu(1)).toBe(9525)
  })

  it('converts px→pt for font sizes as px * 0.75', () => {
    expect(pxToPoints(16)).toBe(12)
    expect(pxToPoints(1280)).toBe(960)
    expect(pxToPoints(720)).toBe(540)
  })

  it('maps a measured px box into an inch box', () => {
    expect(boxToInches({ x: 96, y: 48, w: 192, h: 96 })).toEqual({ x: 1, y: 0.5, w: 2, h: 1 })
  })
})
