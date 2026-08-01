/**
 * The text splice (M4.6, `patched` mode).
 *
 * The load-bearing property is that **two different parsers agree**: `convert.ts` numbers text runs
 * by walking the parsed tree, `rewrite.ts` numbers them by scanning raw source. A disagreement
 * would write an edit into the wrong span and produce a plausible-looking wrong file, so the first
 * describe block pins the two orderings against each other — including on the shapes designed to
 * desync them.
 */

import { describe, expect, it } from 'vitest'
import { unzipSync, strFromU8 } from 'fflate'
import {
  escapeXmlText,
  extractRunTexts,
  isPatchable,
  rewriteSlideText,
  scanTextSpans,
} from '../../../src/shared/import/pptx/rewrite'
import { descendantsNamed, parseXml } from '../../../src/shared/import/xml'
import { PPTX_FIXTURES, readFixture } from './fixtures'

/** The tree-walk ordering `convert.ts` uses to assign `data-sl-run` indices. */
function treeTexts(xml: string): string[] {
  return descendantsNamed(parseXml(xml), 't').map((node) => node.text)
}

describe('scanTextSpans agrees with the tree walk', () => {
  const cases: Readonly<Record<string, string>> = {
    'simple runs': '<p><a:r><a:t>one</a:t></a:r><a:r><a:t>two</a:t></a:r></p>',
    'self-closing empty run': '<p><a:t/><a:t>after</a:t></p>',
    'a `t` inside a comment must not be counted':
      '<p><a:t>real</a:t><!-- <a:t>fake</a:t> --><a:t>also real</a:t></p>',
    'a `t` inside CDATA must not be counted':
      '<p><a:t>real</a:t><x><![CDATA[<a:t>fake</a:t>]]></x></p>',
    'a `t` inside a processing instruction must not be counted':
      '<p><a:t>real</a:t><?pi <a:t>fake</a:t> ?></p>',
    'elements whose local name merely starts with t':
      '<p><a:tab/><a:tableStyle/><a:t>only</a:t></p>',
    'any namespace prefix, and none': '<p><m:t>math</m:t><t>bare</t><a:t>drawing</a:t></p>',
    'attributes containing angle brackets': '<p><a:t title="a > b">x</a:t><a:t>y</a:t></p>',
    'xml:space preserve attribute': '<p><a:t xml:space="preserve">  padded  </a:t></p>',
  }

  for (const [name, xml] of Object.entries(cases)) {
    it(name, () => {
      const spans = scanTextSpans(xml)
      const tree = treeTexts(xml)
      expect(spans).toHaveLength(tree.length)
      // Compare the decoded content too, not merely the count: equal lengths with a one-off shift
      // is exactly the failure this is guarding against.
      expect(spans.map((span) => span.raw)).toEqual(tree)
    })
  }

  it('agrees on every slide part of both committed fixtures', async () => {
    const archives = await Promise.all(PPTX_FIXTURES.map((fixture) => readFixture(fixture.name)))
    for (const archive of archives) {
      const parts = unzipSync(archive)
      const slideParts = Object.keys(parts).filter((name) =>
        /^ppt\/slides\/slide\d+\.xml$/.test(name),
      )
      expect(slideParts.length).toBeGreaterThan(0)
      for (const part of slideParts) {
        const xml = strFromU8(parts[part]!)
        expect(scanTextSpans(xml).map((span) => span.raw)).toEqual(treeTexts(xml))
      }
    }
  })
})

describe('extractRunTexts', () => {
  it('reads the provenance markers back out of slide HTML', () => {
    const html = `<div><span data-sl-run="1">second</span><span data-sl-run="0">first</span></div>`
    const runs = extractRunTexts(html)!
    expect(runs.get(0)).toBe('first')
    expect(runs.get(1)).toBe('second')
    expect(runs.size).toBe(2)
  })

  it('collects text from nested markup inside a marked element', () => {
    const runs = extractRunTexts('<p><span data-sl-run="0">a<b>b</b>c</span></p>')!
    expect(runs.get(0)).toBe('abc')
  })

  it('refuses ambiguous markers rather than guessing', () => {
    expect(
      extractRunTexts('<p><span data-sl-run="0">a</span><span data-sl-run="0">b</span></p>'),
    ).toBeNull()
    expect(extractRunTexts('<p><span data-sl-run="x">a</span></p>')).toBeNull()
    expect(extractRunTexts('<p><span data-sl-run="-1">a</span></p>')).toBeNull()
  })

  it('returns an empty map when there are no markers at all', () => {
    expect(extractRunTexts('<p>plain</p>')?.size).toBe(0)
  })
})

describe('rewriteSlideText', () => {
  const xml = '<p:sld><a:t>Hello</a:t><a:t>World</a:t></p:sld>'
  const html = '<div><span data-sl-run="0">Hello</span><span data-sl-run="1">World</span></div>'

  it('is a no-op when nothing changed', () => {
    const result = rewriteSlideText(xml, html)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.xml).toBe(xml)
    expect(result.changedRuns).toEqual([])
  })

  it('substitutes only the changed span and leaves every other byte alone', () => {
    const edited = html.replace('World', 'Everyone')
    const result = rewriteSlideText(xml, edited)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.xml).toBe('<p:sld><a:t>Hello</a:t><a:t>Everyone</a:t></p:sld>')
    expect(result.changedRuns).toEqual([1])
  })

  it('escapes XML metacharacters in the substituted text', () => {
    const edited = html.replace('World', '&lt;b&gt; &amp; &quot;c&quot;')
    const result = rewriteSlideText(xml, edited)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    // parse5 decoded the entities; the writer must re-encode them, and `>` too so `]]>` is impossible.
    expect(result.xml).toContain('<a:t>&lt;b&gt; &amp; "c"</a:t>')
    expect(result.xml).not.toContain('<a:t><b>')
  })

  it('treats a difference in escaping alone as no change', () => {
    // `&#39;` and `'` are the same text. Rewriting the part for that would dirty it for nothing.
    const source = "<p:sld><a:t>it's</a:t></p:sld>"
    const marked = `<div><span data-sl-run="0">it&#39;s</span></div>`
    const result = rewriteSlideText(source, marked)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.changedRuns).toEqual([])
    expect(result.xml).toBe(source)
  })

  it('re-opens a self-closing text element when it gains content', () => {
    const source = '<p:sld><a:t/></p:sld>'
    const marked = '<div><span data-sl-run="0">now has text</span></div>'
    const result = rewriteSlideText(source, marked)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.xml).toBe('<p:sld><a:t>now has text</a:t></p:sld>')
  })

  it('preserves the attributes of a self-closing text element it re-opens', () => {
    const source = '<p:sld><a:t xml:space="preserve"/></p:sld>'
    const result = rewriteSlideText(source, '<div><span data-sl-run="0">x</span></div>')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.xml).toBe('<p:sld><a:t xml:space="preserve">x</a:t></p:sld>')
  })

  it('refuses when the marker count does not match the span count', () => {
    const tooFew = '<div><span data-sl-run="0">Hello</span></div>'
    const result = rewriteSlideText(xml, tooFew)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toContain('1 run markers but the original part has 2 text spans')
  })

  it('refuses when a marker index is out of range', () => {
    const outOfRange = '<div><span data-sl-run="0">a</span><span data-sl-run="9">b</span></div>'
    const result = rewriteSlideText(xml, outOfRange)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toContain('no matching text span')
  })

  it('refuses when the markers are ambiguous', () => {
    const ambiguous = '<div><span data-sl-run="0">a</span><span data-sl-run="0">b</span></div>'
    expect(rewriteSlideText(xml, ambiguous).ok).toBe(false)
  })

  it('isPatchable mirrors the refusals', () => {
    expect(isPatchable(xml, html)).toBe(true)
    expect(isPatchable(xml, '<div>no markers</div>')).toBe(false)
  })
})

describe('escapeXmlText', () => {
  it('escapes the three characters that can end a text node', () => {
    expect(escapeXmlText('a & b < c > d')).toBe('a &amp; b &lt; c &gt; d')
    // `>` is escaped so a `]]>` sequence cannot appear in output.
    expect(escapeXmlText(']]>')).toBe(']]&gt;')
  })
})
