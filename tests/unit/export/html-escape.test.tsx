/**
 * @vitest-environment happy-dom
 *
 * Escaping for the HTML export's generated shell (M4.4).
 *
 * The deck title is untrusted text that lands in three contexts inside a file the user will open
 * *outside* our sandbox, where none of our CSP applies. These tests are the record that each context
 * is closed — and each one is written as an attempted breakout, not as a spelling check, so a
 * mutation that drops a single `.replace` reddens on "the payload escaped", not on cosmetics.
 */

import { describe, expect, it } from 'vitest'
import {
  encodeJsonForScriptBlock,
  escapeHtmlAttribute,
  escapeHtmlText,
} from '../../../src/shared/export/html-escape'

describe('escapeHtmlText', () => {
  it('escapes the five characters that change context', () => {
    expect(escapeHtmlText('&<>"\'')).toBe('&amp;&lt;&gt;&quot;&#39;')
  })

  it('escapes the ampersand first, so nothing is double-escaped', () => {
    // `<` → `&lt;` must not then have its own `&` rewritten into `&amp;lt;`.
    expect(escapeHtmlText('<')).toBe('&lt;')
    expect(escapeHtmlText('&lt;')).toBe('&amp;lt;')
  })

  it('neutralizes a script tag in text context', () => {
    const escaped = escapeHtmlText('<script>alert(1)</script>')
    expect(escaped).not.toContain('<script')
    expect(escaped).not.toContain('</script')
    expect(escaped).toBe('&lt;script&gt;alert(1)&lt;/script&gt;')
  })

  it('preserves the characters rather than stripping them (unlike the XML sanitizer)', () => {
    // A legitimate title must survive readable. Round-tripping through the browser's own entity
    // decoder is the proof that no information was lost.
    const title = 'Q1 & Q2: "growth" <10%'
    const decoded = new DOMParser().parseFromString(
      `<span>${escapeHtmlText(title)}</span>`,
      'text/html',
    ).body.textContent
    expect(decoded).toBe(title)
  })

  it('leaves ordinary text untouched', () => {
    expect(escapeHtmlText('Résumé 2026 — 日本語')).toBe('Résumé 2026 — 日本語')
    expect(escapeHtmlText('')).toBe('')
  })
})

describe('escapeHtmlAttribute', () => {
  it('escapes both quote characters, closing the attribute breakout', () => {
    const payload = '" onload="alert(1)'
    const html = `<div title="${escapeHtmlAttribute(payload)}"></div>`
    const el = new DOMParser().parseFromString(html, 'text/html').body.firstElementChild
    // The payload landed entirely inside `title`; no `onload` attribute was created.
    expect(el?.getAttribute('title')).toBe(payload)
    expect(el?.hasAttribute('onload')).toBe(false)
  })

  it('closes the single-quoted variant too', () => {
    const payload = "' onload='alert(1)"
    const html = `<div title='${escapeHtmlAttribute(payload)}'></div>`
    const el = new DOMParser().parseFromString(html, 'text/html').body.firstElementChild
    expect(el?.getAttribute('title')).toBe(payload)
    expect(el?.hasAttribute('onload')).toBe(false)
  })
})

describe('encodeJsonForScriptBlock', () => {
  it('escapes `<` so no payload can terminate the script block', () => {
    const encoded = encodeJsonForScriptBlock({ title: '</script><script>alert(1)</script>' })
    expect(encoded).not.toContain('</script')
    expect(encoded).not.toContain('<')
  })

  it('stays valid JSON that parses back to the identical value', () => {
    const value = { title: 'A & B </script> <!-- -->', slides: [{ file: 'slides/001-a.html' }] }
    expect(JSON.parse(encodeJsonForScriptBlock(value))).toEqual(value)
  })

  it('survives the parser: the payload stays data, not markup', () => {
    const value = { title: '</script><img src=x onerror=alert(1)>' }
    const doc = new DOMParser().parseFromString(
      `<script type="application/json" id="m">${encodeJsonForScriptBlock(value)}</script>`,
      'text/html',
    )
    // The block was not terminated early, so the whole payload is still inside it...
    expect(JSON.parse(doc.getElementById('m')?.textContent ?? '')).toEqual(value)
    // ...and no element escaped into the document.
    expect(doc.querySelector('img')).toBeNull()
  })

  it('reports a cyclic value as a diagnosable error, not a TypeError from a regex', () => {
    // Narrowing to `JsonValue` rules out `undefined`/function/symbol/bigint at compile time, but it
    // cannot express acyclicity — so the one runtime failure left must name its own cause rather
    // than surfacing as "Cannot read properties of undefined" from inside an escaper.
    const cyclic: Record<string, unknown> = { title: 'Deck' }
    cyclic['self'] = cyclic
    expect(() => encodeJsonForScriptBlock(cyclic as never)).toThrow(/non-serializable/)
  })

  it('escapes the JavaScript line terminators U+2028 / U+2029', () => {
    const value = { t: 'a\u2028b\u2029c' }
    const encoded = encodeJsonForScriptBlock(value)
    expect(encoded).not.toContain('\u2028')
    expect(encoded).not.toContain('\u2029')
    expect(JSON.parse(encoded)).toEqual(value)
  })
})
