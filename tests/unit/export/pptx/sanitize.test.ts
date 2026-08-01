import { describe, expect, it } from 'vitest'
import {
  deepSanitizeXmlStrings,
  hasXmlIllegalChars,
  sanitizeXmlText,
} from '../../../../src/shared/export/pptx/sanitize'

const BELL = String.fromCharCode(0x07)
const SOH = String.fromCharCode(0x01)

describe('sanitizeXmlText', () => {
  it('strips C0 control characters that would corrupt the XML', () => {
    expect(sanitizeXmlText(`a${BELL}b${SOH}c`)).toBe('abc')
    expect(sanitizeXmlText(sanitizeXmlText(`x${SOH}`))).toBe('x')
  })

  it('keeps the legal whitespace (tab, LF, CR) and normal text', () => {
    expect(sanitizeXmlText('a\tb\nc\rd')).toBe('a\tb\nc\rd')
    expect(sanitizeXmlText('Quarterly Review')).toBe('Quarterly Review')
  })

  it('keeps CJK and emoji (a valid surrogate pair) but drops a lone surrogate', () => {
    expect(sanitizeXmlText('日本語')).toBe('日本語')
    expect(sanitizeXmlText('📊 chart')).toBe('📊 chart')
    // A lone high surrogate (no trailing low) is illegal and removed.
    expect(sanitizeXmlText(`x${String.fromCharCode(0xd83d)}y`)).toBe('xy')
  })

  it('drops the 0xFFFE / 0xFFFF non-characters', () => {
    expect(sanitizeXmlText(`a${String.fromCharCode(0xfffe)}${String.fromCharCode(0xffff)}b`)).toBe(
      'ab',
    )
  })
})

describe('hasXmlIllegalChars', () => {
  it('detects exactly what sanitizeXmlText strips — the shared contract', () => {
    // The detection half must not be narrower than the stripping half; a C0-only predicate is what
    // let a U+FFFE `fontFace` read as clean for a whole review round.
    for (const code of [0x00, 0x01, 0x07, 0x0b, 0x0c, 0x1f, 0xfffe, 0xffff, 0xd83d]) {
      const dirty = `a${String.fromCharCode(code)}b`
      expect(hasXmlIllegalChars(dirty), `code ${String(code)}`).toBe(true)
      expect(hasXmlIllegalChars(sanitizeXmlText(dirty)), `sanitized ${String(code)}`).toBe(false)
    }
  })

  it('accepts legal text (tab/LF/CR, CJK, emoji pairs)', () => {
    for (const clean of ['plain', 'a\tb\nc\rd', '日本語', '📊 chart', '']) {
      expect(hasXmlIllegalChars(clean), clean).toBe(false)
    }
  })
})

describe('deepSanitizeXmlStrings', () => {
  const dirty = String.fromCharCode(0x07)

  it('sanitizes strings nested in objects and arrays (a new option field is covered for free)', () => {
    const input = {
      text: `hi${dirty}`,
      options: {
        fontFace: `Inter${dirty}`,
        hyperlink: { url: `https://x.test/${dirty}` },
        size: 12,
      },
      runs: [{ text: `a${dirty}` }, { text: 'b' }],
    }
    expect(deepSanitizeXmlStrings(input)).toEqual({
      text: 'hi',
      options: { fontFace: 'Inter', hyperlink: { url: 'https://x.test/' }, size: 12 },
      runs: [{ text: 'a' }, { text: 'b' }],
    })
  })

  it('passes non-string primitives through untouched', () => {
    expect(deepSanitizeXmlStrings(42)).toBe(42)
    expect(deepSanitizeXmlStrings(true)).toBe(true)
    expect(deepSanitizeXmlStrings(null)).toBeNull()
    expect(deepSanitizeXmlStrings(undefined)).toBeUndefined()
  })

  it('sanitizes object KEYS as well as values', () => {
    expect(deepSanitizeXmlStrings({ [`k${dirty}`]: 'v' })).toEqual({ k: 'v' })
  })
})
