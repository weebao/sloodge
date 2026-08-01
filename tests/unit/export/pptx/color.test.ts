import { describe, expect, it } from 'vitest'
import { alphaToTransparency, parseCssColor } from '../../../../src/shared/export/pptx/color'

/** Colour parsing (§3.3) — the forms the measurement pass and author values actually produce. */
describe('parseCssColor', () => {
  it('parses rgb() and rgba() (the getComputedStyle forms)', () => {
    expect(parseCssColor('rgb(255, 0, 0)')).toEqual({ hex: 'FF0000', alpha: 1 })
    expect(parseCssColor('rgb(0, 128, 255)')).toEqual({ hex: '0080FF', alpha: 1 })
    expect(parseCssColor('rgba(16, 32, 48, 0.5)')).toEqual({ hex: '102030', alpha: 0.5 })
  })

  it('parses #rgb, #rgba, #rrggbb and #rrggbbaa', () => {
    expect(parseCssColor('#f00')).toEqual({ hex: 'FF0000', alpha: 1 })
    expect(parseCssColor('#00ff00')).toEqual({ hex: '00FF00', alpha: 1 })
    expect(parseCssColor('#0000ff80')).toEqual({ hex: '0000FF', alpha: 128 / 255 })
    expect(parseCssColor('#abcd')?.hex).toBe('AABBCC')
  })

  it('parses hsl()', () => {
    expect(parseCssColor('hsl(0, 100%, 50%)')).toEqual({ hex: 'FF0000', alpha: 1 })
    expect(parseCssColor('hsl(120, 100%, 50%)')).toEqual({ hex: '00FF00', alpha: 1 })
    expect(parseCssColor('hsl(240, 100%, 50%)')).toEqual({ hex: '0000FF', alpha: 1 })
  })

  it('parses named colours', () => {
    expect(parseCssColor('white')).toEqual({ hex: 'FFFFFF', alpha: 1 })
    expect(parseCssColor('BLACK')).toEqual({ hex: '000000', alpha: 1 })
    expect(parseCssColor('teal')).toEqual({ hex: '008080', alpha: 1 })
  })

  it('returns null for transparent / none / empty / garbage (the "do not paint" signal)', () => {
    expect(parseCssColor('transparent')).toBeNull()
    expect(parseCssColor('rgba(0, 0, 0, 0)')).toEqual({ hex: '000000', alpha: 0 })
    expect(parseCssColor('none')).toBeNull()
    expect(parseCssColor('')).toBeNull()
    expect(parseCssColor(null)).toBeNull()
    expect(parseCssColor('not-a-color')).toBeNull()
  })

  it('converts alpha to pptxgenjs transparency (0 = opaque, 100 = invisible)', () => {
    expect(alphaToTransparency(1)).toBe(0)
    expect(alphaToTransparency(0)).toBe(100)
    expect(alphaToTransparency(0.5)).toBe(50)
  })
})
