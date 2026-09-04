import { describe, expect, it } from 'vitest'
import { packForApiScan } from '../../../src/shared/document/slide-contract'
import { escapeHtml, slideText } from '../../../src/shared/document/slide-text'

function decodeNumericReferences(html: string): string {
  return html.replace(/&#(\d+);/g, (_m, code: string) => String.fromCodePoint(Number(code)))
}

describe('slideText', () => {
  it('is escapeHtml for text with no forbidden token', () => {
    for (const text of ['plain', 'a < b & c', '"q" \'s\'', '\u017Fkript', '\u0130ndexedDB', '']) {
      expect(slideText(text)).toBe(escapeHtml(text))
    }
  })

  /** Review round 5's reproduction: `/k/i` does not match U+212A, `toLowerCase()` folds it to `k`. */
  it('defuses a token spelled with a Unicode case fold the validator flags', () => {
    const text = 'Try WebSoc\u212Aet today'
    expect(packForApiScan(text)).toContain('websocket')
    const out = slideText(text)
    expect(out).toBe('Try &#87;ebSoc\u212Aet today')
    expect(packForApiScan(out)).not.toContain('websocket')
    expect(decodeNumericReferences(out)).toBe(text)
  })

  it('escapes and defuses in one pass, so a token beside a quote cannot corrupt the entity', () => {
    expect(slideText('"fetch(x)"')).toBe('&quot;&#102;etch(x)&quot;')
    expect(slideText('a<eval(b)')).toBe('a&lt;&#101;val(b)')
  })
})
