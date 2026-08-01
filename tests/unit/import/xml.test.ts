/**
 * The XML reader (M4.5). Every part of a `.pptx` is attacker-controlled, so the refusals matter at
 * least as much as the parsing: the prolog attacks (entity expansion, XXE) are rejected wholesale
 * and the quantitative hazards are capped.
 */

import { describe, expect, it } from 'vitest'
import {
  attribute,
  childrenNamed,
  decodeXmlEntities,
  deepText,
  descendantsNamed,
  firstChildNamed,
  parseXml,
  pathNamed,
  XmlParseError,
} from '../../../src/shared/import/xml'

describe('parseXml — structure', () => {
  it('parses elements, attributes and character data', () => {
    const root = parseXml('<a:root xmlns:a="urn:x" id="1"><a:kid n="2">hello</a:kid></a:root>')
    expect(root.name).toBe('a:root')
    expect(root.local).toBe('root')
    expect(root.prefix).toBe('a')
    expect(attribute(root, 'id')).toBe('1')
    const kid = firstChildNamed(root, 'kid')
    expect(kid?.text).toBe('hello')
    expect(attribute(kid!, 'n')).toBe('2')
  })

  it('handles self-closing elements, at the root and nested', () => {
    expect(parseXml('<solo/>').local).toBe('solo')
    const root = parseXml('<r><a/><b/><a/></r>')
    expect(childrenNamed(root, 'a')).toHaveLength(2)
  })

  it('keeps element children and direct text separately', () => {
    const root = parseXml('<p>lead<r>run</r>tail</p>')
    expect(root.text).toBe('leadtail')
    expect(deepText(root)).toBe('leadtailrun')
    expect(root.children).toHaveLength(1)
  })

  it('skips comments, processing instructions and the XML declaration', () => {
    const root = parseXml('<?xml version="1.0"?><!-- note --><r><?pi data?><k>v</k></r>')
    expect(root.local).toBe('r')
    expect(childrenNamed(root, 'k')).toHaveLength(1)
  })

  it('treats CDATA as literal text, without entity decoding', () => {
    const root = parseXml('<t><![CDATA[a & b <c>]]></t>')
    expect(root.text).toBe('a & b <c>')
  })

  it('accepts both quote styles and whitespace around `=`', () => {
    const root = parseXml(`<r a = "1" b='2'/>`)
    expect(attribute(root, 'a')).toBe('1')
    expect(attribute(root, 'b')).toBe('2')
  })

  it('does not end a tag on a `>` inside an attribute value', () => {
    const root = parseXml('<r title="a > b"><k/></r>')
    expect(attribute(root, 'title')).toBe('a > b')
    expect(childrenNamed(root, 'k')).toHaveLength(1)
  })

  it('rejects mismatched, unclosed and multi-root documents', () => {
    expect(() => parseXml('<a></b>')).toThrow(XmlParseError)
    expect(() => parseXml('<a><b></a>')).toThrow(XmlParseError)
    expect(() => parseXml('<a/><b/>')).toThrow(XmlParseError)
    expect(() => parseXml('   ')).toThrow(XmlParseError)
    expect(() => parseXml('<a x=1/>')).toThrow(/unquoted/)
    expect(() => parseXml('<a x/>')).toThrow(/no value/)
    expect(() => parseXml('<a x="never closed')).toThrow(/unterminated/)
  })
})

describe('parseXml — refusals and caps', () => {
  it('refuses a DOCTYPE outright, which is the entity-expansion and XXE surface', () => {
    const laughs = `<!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;">]><lolz>&lol2;</lolz>`
    expect(() => parseXml(laughs)).toThrow(/DOCTYPE and ENTITY declarations are forbidden/)
    expect(() => parseXml('<!ENTITY x "y"><r/>')).toThrow(/forbidden/)
    // The classic XXE shape is refused by the same gate, before any name is even read.
    const xxe = `<!DOCTYPE r [<!ENTITY e SYSTEM "file:///etc/passwd">]><r>&e;</r>`
    expect(() => parseXml(xxe)).toThrow(/forbidden/)
  })

  it('caps input length, nesting depth, element count and attribute count', () => {
    expect(() => parseXml('<r/>', { maxLength: 3 })).toThrow(/over the 3 limit/)
    expect(() => parseXml('<a><b><c>x</c></b></a>', { maxDepth: 2 })).toThrow(/nests deeper than 2/)
    // A self-closing element never pushes onto the stack, so it costs no depth — the cap bounds
    // the allocation, and there is none to bound.
    expect(() => parseXml('<a><b><c/></b></a>', { maxDepth: 2 })).not.toThrow()
    expect(() => parseXml('<r><a/><b/><c/></r>', { maxNodes: 3 })).toThrow(/over 3 elements/)
    expect(() => parseXml('<r a="1" b="2" c="3"/>', { maxAttributes: 2 })).toThrow(
      /over 2 attributes/,
    )
  })

  it('caps depth with an explicit stack, so a deep document errors rather than overflowing', () => {
    const deep = `${'<a>'.repeat(5000)}x${'</a>'.repeat(5000)}`
    expect(() => parseXml(deep)).toThrow(XmlParseError)
  })

  it('keeps attribute maps free of the prototype chain', () => {
    const root = parseXml('<r __proto__="polluted" constructor="fine"/>')
    expect(attribute(root, 'constructor')).toBe('fine')
    expect(attribute(root, '__proto__')).toBe('polluted')
    expect(Object.getPrototypeOf(root.attributes)).toBeNull()
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined()
  })
})

describe('decodeXmlEntities', () => {
  it('resolves the five predefined entities and numeric references', () => {
    expect(decodeXmlEntities('&lt;a&gt; &amp; &apos;b&apos; &quot;c&quot;')).toBe(`<a> & 'b' "c"`)
    expect(decodeXmlEntities('&#65;&#x42;')).toBe('AB')
    expect(decodeXmlEntities('&#128512;')).toBe('\u{1F600}')
  })

  it('leaves an unknown or illegal reference as literal text rather than expanding or throwing', () => {
    // Cannot expand, so cannot be an attack — and refusing would reject files PowerPoint reads.
    expect(decodeXmlEntities('&nbsp;')).toBe('&nbsp;')
    expect(decodeXmlEntities('&custom;')).toBe('&custom;')
    // Outside the XML 1.0 character range: a NUL, a surrogate half, and past Unicode.
    expect(decodeXmlEntities('&#0;')).toBe('&#0;')
    expect(decodeXmlEntities('&#xD800;')).toBe('&#xD800;')
    expect(decodeXmlEntities('&#x110000;')).toBe('&#x110000;')
  })

  it('decodes inside attribute values as well as text', () => {
    const root = parseXml('<r t="a &amp; b">x &lt; y</r>')
    expect(attribute(root, 't')).toBe('a & b')
    expect(root.text).toBe('x < y')
  })
})

describe('tree helpers', () => {
  const root = parseXml(
    '<p:sp><p:spPr><a:xfrm><a:off x="1" y="2"/></a:xfrm></p:spPr><p:txBody><a:p><a:r><a:t>hi</a:t></a:r></a:p></p:txBody></p:sp>',
  )

  it('walks a path by local name, ignoring prefixes', () => {
    const off = pathNamed(root, 'spPr', 'xfrm', 'off')
    expect(attribute(off!, 'x')).toBe('1')
    expect(pathNamed(root, 'spPr', 'nope', 'off')).toBeUndefined()
  })

  it('finds descendants in document order', () => {
    const texts = descendantsNamed(root, 't')
    expect(texts).toHaveLength(1)
    expect(texts[0]?.text).toBe('hi')
  })

  it('matches attributes by qualified name, then by local name', () => {
    const blip = parseXml('<a:blip r:embed="rId7"/>')
    expect(attribute(blip, 'r:embed')).toBe('rId7')
    expect(attribute(blip, 'embed')).toBe('rId7')
    expect(attribute(blip, 'missing')).toBeUndefined()
  })

  it('returns descendants in the same order regardless of nesting shape', () => {
    const nested = parseXml('<r><a><t>1</t><b><t>2</t></b></a><t>3</t></r>')
    expect(descendantsNamed(nested, 't').map((node) => node.text)).toEqual(['1', '2', '3'])
  })
})
