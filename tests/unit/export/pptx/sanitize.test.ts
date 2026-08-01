import { describe, expect, it } from 'vitest'
import { sanitizeXmlText } from '../../../../src/shared/export/pptx/sanitize'

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
