/**
 * The pure colour parse/normalise/serialise layer behind M3.8's colour controls. Exhaustive because
 * it is the only thing standing between a model-authored colour string and a byte-span write: every
 * shape a colour takes in real slides must round-trip, alpha must never be dropped silently, and
 * anything that is not a colour must be rejected rather than written.
 */

import { describe, expect, it } from 'vitest'
import {
  applyPickedColor,
  normalizeColor,
  parseColor,
  sameColor,
  toColorInputValue,
  toHex,
  toHex6,
} from '../../../src/shared/design/color'
import { isSafeStyleValue } from '../../../src/shared/design/patch'

describe('parseColor — hex', () => {
  it('parses 3-digit hex, doubling each nibble', () => {
    expect(parseColor('#abc')).toEqual({ r: 0xaa, g: 0xbb, b: 0xcc, a: 1 })
  })

  it('parses 4-digit hex with alpha', () => {
    expect(parseColor('#abcd')).toEqual({ r: 0xaa, g: 0xbb, b: 0xcc, a: 0xdd / 255 })
  })

  it('parses 6-digit hex', () => {
    expect(parseColor('#1a2035')).toEqual({ r: 0x1a, g: 0x20, b: 0x35, a: 1 })
  })

  it('parses 8-digit hex with alpha', () => {
    expect(parseColor('#1a203580')).toEqual({ r: 0x1a, g: 0x20, b: 0x35, a: 0x80 / 255 })
  })

  it('is case-insensitive on hex digits', () => {
    expect(parseColor('#AABBCC')).toEqual(parseColor('#aabbcc'))
  })

  it('rejects malformed hex', () => {
    for (const bad of ['#', '#gg', '#12', '#12345', '#1234567', '#123456789']) {
      expect(parseColor(bad)).toBeNull()
    }
  })
})

describe('parseColor — rgb/rgba', () => {
  it('parses comma rgb', () => {
    expect(parseColor('rgb(1, 2, 3)')).toEqual({ r: 1, g: 2, b: 3, a: 1 })
  })

  it('parses comma rgba with float alpha', () => {
    expect(parseColor('rgba(10, 20, 30, 0.5)')).toEqual({ r: 10, g: 20, b: 30, a: 0.5 })
  })

  it('parses the modern slash-alpha form', () => {
    expect(parseColor('rgb(10 20 30 / 50%)')).toEqual({ r: 10, g: 20, b: 30, a: 0.5 })
  })

  it('parses percentage channels', () => {
    expect(parseColor('rgb(100%, 0%, 50%)')).toEqual({ r: 255, g: 0, b: 128, a: 1 })
  })

  it('clamps out-of-range channels and alpha', () => {
    expect(parseColor('rgba(300, -5, 3, 2)')).toEqual({ r: 255, g: 0, b: 3, a: 1 })
  })

  it('rejects the wrong channel count', () => {
    expect(parseColor('rgb(1, 2)')).toBeNull()
    expect(parseColor('rgb(1, 2, 3, 4, 5)')).toBeNull()
  })

  it('rejects non-numeric channels', () => {
    expect(parseColor('rgb(a, b, c)')).toBeNull()
  })
})

describe('parseColor — named', () => {
  it('parses named colours case-insensitively', () => {
    expect(parseColor('red')).toEqual({ r: 255, g: 0, b: 0, a: 1 })
    expect(parseColor('REBECCApurple')).toEqual({ r: 0x66, g: 0x33, b: 0x99, a: 1 })
  })

  it('maps transparent to fully transparent', () => {
    expect(parseColor('transparent')).toEqual({ r: 0, g: 0, b: 0, a: 0 })
  })

  it('rejects unknown names and non-colours', () => {
    for (const bad of ['', '   ', 'nonsense', 'var(--sl-accent)', 'inherit', 'currentColor']) {
      expect(parseColor(bad)).toBeNull()
    }
  })
})

describe('toHex / toHex6', () => {
  it('emits 6 digits when opaque, 8 when translucent', () => {
    expect(toHex({ r: 255, g: 0, b: 0, a: 1 })).toBe('#ff0000')
    expect(toHex({ r: 255, g: 0, b: 0, a: 0.5 })).toBe('#ff000080')
  })

  it('toHex6 always drops alpha', () => {
    expect(toHex6({ r: 255, g: 0, b: 0, a: 0.5 })).toBe('#ff0000')
  })
})

describe('normalizeColor', () => {
  it('normalises every accepted form to canonical hex, preserving alpha', () => {
    expect(normalizeColor('red')).toBe('#ff0000')
    expect(normalizeColor('#abc')).toBe('#aabbcc')
    expect(normalizeColor('#abcd')).toBe('#aabbccdd')
    expect(normalizeColor('rgb(1,2,3)')).toBe('#010203')
    expect(normalizeColor('rgba(0,0,0,0.5)')).toBe('#00000080')
    expect(normalizeColor('transparent')).toBe('#00000000')
  })

  it('returns null for a non-colour', () => {
    expect(normalizeColor('var(--sl-accent)')).toBeNull()
    expect(normalizeColor('')).toBeNull()
  })
})

describe('toColorInputValue', () => {
  it('produces a 6-digit value a native colour input accepts', () => {
    expect(toColorInputValue('red')).toBe('#ff0000')
    expect(toColorInputValue('rgba(10,20,30,0.5)')).toBe('#0a141e')
  })

  it('falls back to #000000 for null or unrepresentable values', () => {
    expect(toColorInputValue(null)).toBe('#000000')
    expect(toColorInputValue('var(--sl-accent)')).toBe('#000000')
    expect(toColorInputValue('inherit')).toBe('#000000')
  })
})

describe('applyPickedColor — alpha preservation', () => {
  it('keeps the picked hue but the source alpha', () => {
    expect(applyPickedColor('rgba(0,0,0,0.5)', '#ff0000')).toBe('#ff000080')
    expect(applyPickedColor('#00ff0080', '#ff0000')).toBe('#ff000080')
  })

  it('writes a plain 6-digit hex when the source is opaque or absent', () => {
    expect(applyPickedColor('#00ff00', '#ff0000')).toBe('#ff0000')
    expect(applyPickedColor(null, '#ff0000')).toBe('#ff0000')
  })

  it('writes 6-digit hex when the source is a non-colour (no alpha to preserve)', () => {
    expect(applyPickedColor('var(--sl-accent)', '#ff0000')).toBe('#ff0000')
  })

  it('passes an unparseable pick through verbatim (caller already validated it)', () => {
    expect(applyPickedColor('red', 'not-a-color')).toBe('not-a-color')
  })
})

describe('sameColor', () => {
  it('recognises the same colour across notations', () => {
    expect(sameColor('red', '#ff0000')).toBe(true)
    expect(sameColor('#f00', '#ff0000')).toBe(true)
    expect(sameColor('#FF0000', 'rgb(255, 0, 0)')).toBe(true)
    expect(sameColor('rgba(0,0,0,0.5)', '#00000080')).toBe(true)
  })

  it('distinguishes different colours, including alpha-only differences', () => {
    expect(sameColor('red', '#ff0001')).toBe(false)
    expect(sameColor('#00000080', '#000000')).toBe(false)
  })

  it('is false when either side is absent or not a parseable colour', () => {
    expect(sameColor(null, '#ff0000')).toBe(false)
    expect(sameColor('#ff0000', null)).toBe(false)
    expect(sameColor('var(--sl-accent)', 'var(--sl-accent)')).toBe(false)
    expect(sameColor('inherit', '#000000')).toBe(false)
  })
})

describe('the isSafeStyleValue guard holds for every emitted colour', () => {
  it('never emits a value that could terminate a declaration', () => {
    const inputs = [
      'red',
      '#abc',
      '#abcd',
      '#1a2035',
      '#1a203580',
      'rgb(1,2,3)',
      'rgba(1,2,3,0.5)',
      'rgb(10 20 30 / 50%)',
      'transparent',
    ]
    for (const input of inputs) {
      const normalized = normalizeColor(input)
      expect(normalized).not.toBeNull()
      expect(isSafeStyleValue(normalized!)).toBe(true)
      expect(isSafeStyleValue(applyPickedColor(input, '#123456'))).toBe(true)
    }
  })
})
