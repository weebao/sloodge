import { describe, expect, it } from 'vitest'
import { buildSlideMap } from '../../../src/shared/design/slide-map'
import {
  applyOps,
  escapeAttrValue,
  escapeText,
  isSafeStyleValue,
  PatchOverlapError,
  readAttr,
  readStyleProp,
  removeStyleProp,
  setAttr,
  setStyleProp,
  type SourceOp,
} from '../../../src/shared/design/patch'
import { parseDeclarations } from '../../../src/shared/design/style'
import type { ElementSpan } from '../../../src/shared/design/types'
import { CORPUS } from './corpus'

/** Resolve the single element of a one-element slide, for helper tests. */
function only(html: string): { source: string; element: ElementSpan } {
  const map = buildSlideMap('s', html)
  const element = map.byId.get(map.order[0]!)!
  return { source: map.source, element }
}

describe('applyOps', () => {
  it('returns the source unchanged for no ops', () => {
    expect(applyOps('abc', [])).toBe('abc')
  })

  it('applies a single replace', () => {
    const ops: SourceOp[] = [{ kind: 'replaceSpan', span: { start: 1, end: 2 }, text: 'X' }]
    expect(applyOps('abc', ops)).toBe('aXc')
  })

  it('applies multiple non-overlapping ops correctly regardless of input order', () => {
    const ops: SourceOp[] = [
      { kind: 'replaceSpan', span: { start: 0, end: 1 }, text: 'A' },
      { kind: 'insertAt', at: 3, text: '!' },
      { kind: 'replaceSpan', span: { start: 1, end: 2 }, text: 'B' },
    ]
    // "abc" -> A B c ! -> "ABc!"
    expect(applyOps('abc', ops)).toBe('ABc!')
  })

  it('applies a longer replacement that shifts later offsets, high-offset-first', () => {
    const ops: SourceOp[] = [
      { kind: 'replaceSpan', span: { start: 0, end: 1 }, text: 'LONG' },
      { kind: 'replaceSpan', span: { start: 2, end: 3 }, text: 'END' },
    ]
    expect(applyOps('abc', ops)).toBe('LONGbEND')
  })

  it('allows a zero-length insert at the boundary of a replace', () => {
    const ops: SourceOp[] = [
      { kind: 'replaceSpan', span: { start: 1, end: 3 }, text: 'XY' },
      { kind: 'insertAt', at: 1, text: '|' },
    ]
    expect(applyOps('abcd', ops)).toBe('a|XYd')
  })

  it('throws PatchOverlapError when two ops overlap', () => {
    const ops: SourceOp[] = [
      { kind: 'replaceSpan', span: { start: 0, end: 3 }, text: 'X' },
      { kind: 'replaceSpan', span: { start: 2, end: 4 }, text: 'Y' },
    ]
    expect(() => applyOps('abcde', ops)).toThrow(PatchOverlapError)
  })

  it('handles deleteSpan', () => {
    const ops: SourceOp[] = [{ kind: 'deleteSpan', span: { start: 1, end: 3 } }]
    expect(applyOps('abcd', ops)).toBe('ad')
  })

  it('is safe against multi-byte / surrogate-pair content (UTF-16 spans)', () => {
    // The map's spans are UTF-16 code-unit indices; an emoji before the edit must survive intact.
    const map = buildSlideMap('s', '<p title="a">😀 hi</p>')
    const element = map.byId.get(map.order[0]!)!
    const ops = setAttr(element, 'title', 'title', 'b')
    expect(applyOps(map.source, ops)).toBe('<p title="b">😀 hi</p>')
  })
})

describe('escapeText', () => {
  it('escapes & and < only, and > after ]]', () => {
    expect(escapeText('a & b < c')).toBe('a &amp; b &lt; c')
    expect(escapeText('x]]>y')).toBe('x]]&gt;y')
  })

  it('leaves non-ASCII untouched', () => {
    expect(escapeText('Café')).toBe('Café')
  })
})

describe('escapeAttrValue', () => {
  it('escapes &, " and \'', () => {
    expect(escapeAttrValue('a & "b" \'c\'')).toBe('a &amp; &quot;b&quot; &#39;c&#39;')
  })
})

describe('setAttr', () => {
  it('replaces an existing value, leaving the quoting style alone', () => {
    const { source, element } = only("<div class='a'>x</div>")
    const patched = applyOps(source, setAttr(element, 'class', 'class', 'b'))
    expect(patched).toBe("<div class='b'>x</div>")
  })

  it('inserts a new attribute after the tag name when absent', () => {
    const { source, element } = only('<div>x</div>')
    const patched = applyOps(source, setAttr(element, 'title', 'title', 'hi'))
    expect(patched).toBe('<div title="hi">x</div>')
  })

  it('rewrites a valueless attribute into name="value"', () => {
    const { source, element } = only('<input disabled>')
    const patched = applyOps(source, setAttr(element, 'disabled', 'disabled', 'true'))
    expect(patched).toBe('<input disabled="true">')
  })

  it('escapes the written value', () => {
    const { source, element } = only('<div>x</div>')
    const patched = applyOps(source, setAttr(element, 'title', 'title', 'a"b'))
    expect(patched).toBe('<div title="a&quot;b">x</div>')
  })

  it('cannot break out of a single-quoted attribute — apostrophe values are escaped', () => {
    // The value span of a single-quoted attr excludes the quotes; a raw `'` in the value would
    // otherwise terminate it and inject a new attribute into the saved (exportable) source.
    const { source, element } = only("<rect fill='red' x='10'/>")
    const patched = applyOps(
      source,
      setAttr(element, 'fill', 'fill', "blue' onmouseover='alert(1)"),
    )
    expect(patched).toBe("<rect fill='blue&#39; onmouseover=&#39;alert(1)' x='10'/>")
    // The `'` never appears raw, so no live attribute breaks out of the value.
    expect(patched).not.toContain("onmouseover='alert")
  })
})

describe('setStyleProp', () => {
  it('inserts a whole style attribute when the element has none', () => {
    const { source, element } = only('<div>x</div>')
    const patched = applyOps(source, setStyleProp(source, element, 'color', 'red'))
    expect(patched).toBe('<div style="color: red">x</div>')
  })

  it('upserts one property, preserving the other declarations', () => {
    const { source, element } = only('<div style="color: red; margin: 0">x</div>')
    const patched = applyOps(source, setStyleProp(source, element, 'color', 'blue'))
    expect(patched).toBe('<div style="color: blue; margin: 0">x</div>')
  })

  it('appends a new property to an existing style', () => {
    const { source, element } = only('<div style="color: red">x</div>')
    const patched = applyOps(source, setStyleProp(source, element, 'font-size', '20px'))
    expect(patched).toBe('<div style="color: red; font-size: 20px">x</div>')
  })

  it('rejects a value that would inject a sibling declaration (; or { or })', () => {
    const { source, element } = only('<div>x</div>')
    // Without the guard, this serializes to `color: red;background:url(x)` — two declarations.
    expect(setStyleProp(source, element, 'color', 'red;background:url(x)')).toEqual([])
    expect(setStyleProp(source, element, 'color', 'red}')).toEqual([])
    expect(setStyleProp(source, element, 'color', 'red{')).toEqual([])
    // A safe value still writes exactly one declaration.
    expect(applyOps(source, setStyleProp(source, element, 'color', 'red'))).toBe(
      '<div style="color: red">x</div>',
    )
  })
})

describe('isSafeStyleValue', () => {
  it('rejects declaration/block terminators, accepts everything else', () => {
    expect(isSafeStyleValue('red')).toBe(true)
    expect(isSafeStyleValue('url("a.png")')).toBe(true)
    expect(isSafeStyleValue('red;x:1')).toBe(false)
    expect(isSafeStyleValue('a{b')).toBe(false)
    expect(isSafeStyleValue('a}')).toBe(false)
  })
})

describe('readStyleProp / readAttr', () => {
  it('reads a style property value or null', () => {
    const { source, element } = only('<div style="color: red">x</div>')
    expect(readStyleProp(source, element, 'color')).toBe('red')
    expect(readStyleProp(source, element, 'font-size')).toBeNull()
  })

  it('reads a raw attribute value or null', () => {
    const { source, element } = only('<rect fill="#abc"/>')
    expect(readAttr(source, element, 'fill')).toBe('#abc')
    expect(readAttr(source, element, 'stroke')).toBeNull()
  })
})

describe('removeStyleProp', () => {
  it('removes one declaration, preserving the others', () => {
    const { source, element } = only('<div style="color: red; transform: rotate(45deg)">x</div>')
    const next = applyOps(source, removeStyleProp(source, element, 'transform'))
    expect(next).toBe('<div style="color: red">x</div>')
  })

  it('deletes the whole style attribute (and its leading space) when nothing is left', () => {
    const { source, element } = only('<div style="transform: rotate(45deg)">x</div>')
    const next = applyOps(source, removeStyleProp(source, element, 'transform'))
    // No `style=""` husk, no stray double space — the tag is exactly as it was without the attribute.
    expect(next).toBe('<div>x</div>')
  })

  it('is a no-op when the property or the style attribute is absent', () => {
    const withStyle = only('<div style="color: red">x</div>')
    expect(removeStyleProp(withStyle.source, withStyle.element, 'transform')).toEqual([])
    const noStyle = only('<div>x</div>')
    expect(removeStyleProp(noStyle.source, noStyle.element, 'transform')).toEqual([])
  })

  it('is case-insensitive on the property name', () => {
    const { source, element } = only('<div style="TRANSFORM: rotate(45deg)">x</div>')
    expect(applyOps(source, removeStyleProp(source, element, 'transform'))).toBe('<div>x</div>')
  })
})

/* -------------------------------------------------------------------------------------------- *
 * M3.18 — a character reference inside a style attribute
 * -------------------------------------------------------------------------------------------- */

/**
 * Every entity shape that can reach a `style` attribute, with the decoded CSS the browser sees.
 *
 * The expectations are written from the HTML tokenizer's rules rather than read off the
 * implementation, because the implementation *is* the tokenizer: `AttrSpan.text` is parse5's own
 * decode, so asserting it against a second call to parse5 would assert nothing. The rule that
 * matters twice here is the **ambiguous ampersand**: inside an attribute value a named reference
 * with no `;` is left alone when the next character is alphanumeric or `=`, and decoded otherwise.
 */
const ENTITY_STYLES: readonly {
  name: string
  attr: string
  css: string
  fontFamily: string | null
}[] = [
  {
    name: 'named reference — the shape M3.10 review r5 measured',
    attr: 'font-family: &quot;Georgia&quot;, serif; color: red',
    css: 'font-family: "Georgia", serif; color: red',
    fontFamily: '"Georgia", serif',
  },
  {
    name: 'decimal numeric reference',
    attr: 'font-family: &#34;Georgia&#34;, serif; color: red',
    css: 'font-family: "Georgia", serif; color: red',
    fontFamily: '"Georgia", serif',
  },
  {
    name: 'hex numeric reference',
    attr: 'font-family: &#x22;Georgia&#x22;, serif; color: red',
    css: 'font-family: "Georgia", serif; color: red',
    fontFamily: '"Georgia", serif',
  },
  {
    name: 'unterminated named reference before a non-alphanumeric — decoded',
    attr: 'font-family: &quot, serif; color: red',
    css: 'font-family: ", serif; color: red',
    // Decoding turns this into an unclosed CSS string, which swallows the rest of the value —
    // exactly as a browser does. Garbage in, the same garbage out; not our business to repair.
    fontFamily: '", serif; color: red',
  },
  {
    name: 'unterminated named reference before an alphanumeric — an ambiguous ampersand, left alone',
    attr: 'font-family: &quotGeorgia, serif; color: red',
    css: 'font-family: &quotGeorgia, serif; color: red',
    fontFamily: '&quotGeorgia, serif',
  },
  {
    name: 'a reference that decodes to a real declaration separator',
    attr: 'color: red&#59; background: blue',
    css: 'color: red; background: blue',
    fontFamily: null,
  },
  {
    name: 'a literal ampersand, written as one — decodes to text a browser also mis-parses',
    attr: 'font-family: &amp;quot;Georgia&amp;quot;, serif',
    css: 'font-family: &quot;Georgia&quot;, serif',
    // The decoded CSS really does say `&quot;`, and CSS has no entities: that `;` *is* a
    // declaration separator to a browser too, so `font-family` really is the invalid `&quot` and
    // the rest is dropped. Matching the browser is the whole point — this is not the M3.18 defect
    // wearing a disguise, it is the one input where `&quot` is the right answer.
    fontFamily: '&quot',
  },
  {
    name: 'a semicolon inside url(), unencoded',
    attr: 'background: url(a;b); color: red',
    css: 'background: url(a;b); color: red',
    fontFamily: null,
  },
  {
    name: 'a real semicolon inside an entity-quoted family name',
    attr: 'font-family: &quot;A;B&quot;, serif; color: red',
    css: 'font-family: "A;B", serif; color: red',
    fontFamily: '"A;B", serif',
  },
  {
    name: 'an entity whose decoded quote wraps a CSS escape',
    attr: 'content: &quot;\\a9 &quot;; color: red',
    css: 'content: "\\a9 "; color: red',
    fontFamily: null,
  },
]

/** The same fixture as a one-element slide. */
function styled(attr: string): { source: string; element: ElementSpan } {
  return only(`<p data-sl-id="a" style="${attr}">x</p>`)
}

describe('inline style with a character reference (M3.18)', () => {
  it.each(ENTITY_STYLES)('decodes before splitting on ";" — $name', ({ attr, css, fontFamily }) => {
    const { source, element } = styled(attr)
    // The decoded CSS is what the browser's style system is handed, and what the parser now gets.
    expect(element.attrs['style']?.text).toBe(css)
    expect(readStyleProp(source, element, 'font-family')).toBe(fontFamily)
  })

  it('reads the family the author wrote, not the head of an entity', () => {
    const { source, element } = styled('font-family: &quot;Georgia&quot;, serif; color: red')
    // Pre-fix this was the string `&quot`, and `color` was the *second* of two declarations only by
    // luck — the `Georgia&quot;, serif` fragment was dropped for having no `:`.
    expect(readStyleProp(source, element, 'font-family')).toBe('"Georgia", serif')
    expect(readStyleProp(source, element, 'color')).toBe('red')
  })

  it('leaves an untouched declaration byte-exact when another property is edited', () => {
    const { source, element } = styled('font-family: &quot;Georgia&quot;, serif; color: red')
    const next = applyOps(source, setStyleProp(source, element, 'font-size', '20px'))
    // Pre-fix: `style="font-family: &amp;quot; color: red; font-size: 20px"` — Georgia and the
    // serif fallback deleted from the source by an edit to an unrelated property.
    expect(next).toBe(
      '<p data-sl-id="a" style="font-family: &quot;Georgia&quot;, serif; color: red; font-size: 20px">x</p>',
    )
  })

  it('does not re-escape an ampersand on every commit', () => {
    const { source, element } = styled('font-family: A&amp;B, serif')
    const once = applyOps(source, setStyleProp(source, element, 'color', 'red'))
    expect(once).toBe('<p data-sl-id="a" style="font-family: A&amp;B, serif; color: red">x</p>')
    // The second commit is the one that used to show the compounding: read raw, escape, repeat.
    const { source: s2, element: e2 } = only(once)
    expect(applyOps(s2, setStyleProp(s2, e2, 'color', 'blue'))).toBe(
      '<p data-sl-id="a" style="font-family: A&amp;B, serif; color: blue">x</p>',
    )
  })

  it('removes one declaration without corrupting an entity-bearing neighbour', () => {
    const { source, element } = styled('font-family: &quot;Georgia&quot;, serif; color: red')
    expect(applyOps(source, removeStyleProp(source, element, 'color'))).toBe(
      '<p data-sl-id="a" style="font-family: &quot;Georgia&quot;, serif">x</p>',
    )
  })

  it('still refuses a value that would terminate the declaration', () => {
    // The guard is on the *decoded* value the caller passes, which is where a `;` would land as a
    // literal separator — `escapeAttrValue` does not escape `;`, so decoding did not open a hole.
    const { source, element } = styled('color: red')
    expect(setStyleProp(source, element, 'color', 'blue; background: url(//h)')).toEqual([])
    expect(isSafeStyleValue('blue; background: url(//h)')).toBe(false)
  })

  it('refuses a caller value that spells its `;` as an entity', () => {
    // `&#59;` contains a literal `;`, so `isSafeStyleValue` refuses it on the raw characters
    // before any escaping — and it must keep refusing it now that the read side decodes, because
    // `escapeAttrValue` leaves `;` alone: `blue&#59;x` would land as `blue&amp;#59;x` (inert) but
    // the guard is not allowed to depend on that, and a future encoder change must not open it.
    const { source, element } = styled('color: red')
    expect(setStyleProp(source, element, 'color', 'blue&#59;x')).toEqual([])
    expect(applyOps(source, setStyleProp(source, element, 'color', 'blue&#59;x'))).toBe(source)
  })
})

/**
 * The round trip this milestone exists to buy: *read a declaration, write it back unchanged, and
 * the source does not move.*
 *
 * Two grades, and the difference is stated rather than hidden. Byte identity holds for the
 * spellings `escapeAttrValue` itself emits (`&quot;`, `&#39;`, `&amp;`) — which is every entity
 * this app has ever written, and the one a hand author reaches for. A source that spells the same
 * character another legal way (`&#34;`, `&#x22;`) is re-emitted in the canonical spelling, so the
 * bytes change while the CSS does not; that is the same bounded normalization of the one attribute
 * being edited that `style.ts`'s header already licenses for whitespace, and it is asserted here as
 * decoded equality so it can never silently widen into a *semantic* change.
 */
describe('style read/write round trip (M3.18)', () => {
  /**
   * `writes` is how many of the three probed properties this row actually *writes back*, and it is
   * asserted, not decorative.
   *
   * Without it a row can pin byte-exactness vacuously: when the decoded value carries a `;`,
   * `isSafeStyleValue` refuses it and `setStyleProp` returns `[]`, so `applyOps(source, [])` is
   * `source` and `toBe(source)` holds because **nothing was written**. That is how
   * `font-family: &quot, serif` — the shape the PR body most wanted pinned — sat in this table
   * proving nothing. Counting the writes makes a row that stops round-tripping fail instead of
   * quietly going vacuous; the refusals are asserted as refusals in `REFUSED` below.
   *
   * A row may legitimately write fewer than all three: a declaration is also pinned byte-exact by
   * surviving *another* property's write untouched, which is what `url(a;b)` and the `content`
   * CSS-escape row are doing.
   */
  const BYTE_EXACT: readonly { attr: string; writes: number }[] = [
    { attr: 'font-family: &quot;Georgia&quot;, serif; color: red', writes: 2 },
    // The `;` is real, inside a decoded quoted family: `font-family` is refused (see REFUSED), and
    // what this row pins is that the `color` write leaves those bytes exactly as authored.
    { attr: 'font-family: &quot;A;B&quot;, serif; color: red', writes: 1 },
    { attr: 'font-family: &#39;Georgia&#39;, serif', writes: 1 },
    { attr: 'background: url(a;b); color: red', writes: 1 },
    { attr: 'content: &quot;\\a9 &quot;; color: red', writes: 1 },
    { attr: 'color: red', writes: 1 },
  ]

  it.each(BYTE_EXACT)('writes back the same bytes: $attr', ({ attr, writes }) => {
    const { source, element } = styled(attr)
    let attempted = 0
    for (const prop of ['font-family', 'color', 'background']) {
      const value = readStyleProp(source, element, prop)
      if (value === null) continue
      const ops = setStyleProp(source, element, prop, value)
      if (ops.length === 0) continue
      attempted += 1
      expect(applyOps(source, ops)).toBe(source)
    }
    expect(attempted).toBe(writes)
  })

  /**
   * The shapes a read/write round trip **refuses** rather than round-trips, stated as refusals.
   *
   * Decoding is what makes them refusable: a `;` that was spelled as an entity, or hidden behind a
   * CSS string the decode opens, is a real declaration separator once `AttrSpan.text` resolves it,
   * and `isSafeStyleValue` will not write a value carrying one. The source is untouched — but by
   * a no-op, not by a round trip, and the difference is the whole reason these rows are here
   * instead of in `BYTE_EXACT`.
   */
  const REFUSED: readonly { name: string; attr: string; prop: string; decoded: string }[] = [
    {
      name: 'an unterminated `&quot,` — the decode opens a CSS string that swallows the rest',
      attr: 'font-family: &quot, serif; color: red',
      prop: 'font-family',
      decoded: '", serif; color: red',
    },
    {
      name: 'a real `;` inside a decoded quoted family',
      attr: 'font-family: &quot;A;B&quot;, serif; color: red',
      prop: 'font-family',
      decoded: '"A;B", serif',
    },
  ]

  it.each(REFUSED)('refuses to write back $name', ({ attr, prop, decoded }) => {
    const { source, element } = styled(attr)
    // The read is exact — this is a write-side refusal, not a decoding failure.
    expect(readStyleProp(source, element, prop)).toBe(decoded)
    expect(isSafeStyleValue(decoded)).toBe(false)
    expect(setStyleProp(source, element, prop, decoded)).toEqual([])
  })

  it('appends a duplicate declaration when an unterminated CSS string hides the first', () => {
    // Disclosed rather than repaired (roadmap M3.20). With the decoded value carrying an unclosed
    // string, `parseDeclarations` sees ONE declaration whose value has swallowed everything after
    // it, so an appended `outline` lands inside that string and the next parse cannot see it —
    // repeated edits append without bound. Pinned here so the growth is a documented shape rather
    // than a surprise, and so a future fix has something to turn red.
    const { source, element } = styled('font-family: &quot, serif; color: red')
    const first = applyOps(source, setStyleProp(source, element, 'outline', '1px solid'))
    const { source: s2, element: e2 } = only(first)
    const second = applyOps(s2, setStyleProp(s2, e2, 'outline', '1px solid'))
    // Two `outline` declarations, not one: the first is inside the unclosed string, so the
    // re-parse cannot see it and upserts a second. A third edit would make three.
    expect(second.match(/outline: 1px solid/g)).toHaveLength(2)
    // Bounded in badness, and strictly better than base `30ca973`, which read the value raw and
    // DESTROYED it (`font-family: &amp;quot;`). Here the CSS a browser sees is unchanged — every
    // appended declaration is swallowed by the same string the author left open — and the only
    // byte movement outside it is the ambiguous `&quot,` re-spelled canonically as `&quot;`.
    expect(second).toBe(
      '<p data-sl-id="a" style="font-family: &quot;, serif; color: red; outline: 1px solid; outline: 1px solid">x</p>',
    )
  })

  const DECODED_EXACT: readonly string[] = [
    // Legal alternative spellings of a character `escapeAttrValue` writes as `&quot;`.
    'font-family: &#34;Georgia&#34;, serif; color: red',
    'font-family: &#x22;Georgia&#x22;, serif; color: red',
    // An ambiguous ampersand, re-emitted in its unambiguous spelling. Same string, no parse error.
    'font-family: &quotGeorgia, serif; color: red',
  ]

  it.each(DECODED_EXACT)('writes back the same CSS, re-spelled: %s', (attr) => {
    const { source, element } = styled(attr)
    const value = readStyleProp(source, element, 'font-family')
    expect(value).not.toBeNull()
    const out = applyOps(source, setStyleProp(source, element, 'font-family', value!))
    expect(out).not.toBe(source)
    const { element: after } = only(out)
    // What the browser reads is unchanged; only how it is spelled in the bytes.
    expect(after.attrs['style']?.text).toBe(element.attrs['style']?.text)
  })

  it('drops a fragment that is not a declaration, entity or not — pre-existing, not new', () => {
    // `parseDeclarations` has always dropped a chunk with no `:`, so re-serializing any invalid
    // CSS loses it. Stated with and without an entity so the entity case cannot be misread as a
    // decoding defect: both halves are the same rule, and both matched a browser before the fix.
    const plain = styled('color: red; this is not a declaration')
    expect(applyOps(plain.source, setStyleProp(plain.source, plain.element, 'color', 'red'))).toBe(
      '<p data-sl-id="a" style="color: red">x</p>',
    )
    const entity = styled('font-family: &amp;quot;Georgia&amp;quot;, serif')
    const value = readStyleProp(entity.source, entity.element, 'font-family')!
    expect(
      applyOps(entity.source, setStyleProp(entity.source, entity.element, 'font-family', value)),
    ).toBe('<p data-sl-id="a" style="font-family: &amp;quot">x</p>')
  })

  it('a `&nbsp;` glued to a value loses the no-break space, and says so', () => {
    // `parseDeclarations` trims with `String.prototype.trim`, which counts U+00A0 as whitespace
    // where CSS does not. Decoding is what surfaces the character for it to trim: pre-fix the value
    // read as the string `&nbsp` and was rewritten to `&amp;nbsp`, which is strictly worse. The
    // declaration was dead either way — an NBSP is a CSS ident code point, so `width: <nbsp>1px`
    // tokenizes as one ident and no browser applies it — so this is recorded, not repaired.
    const { source, element } = styled('color: red; width: &nbsp;1px')
    expect(element.attrs['style']?.text).toBe('color: red; width:  1px')
    expect(readStyleProp(source, element, 'width')).toBe('1px')
  })
})

/**
 * The roadmap's other half: the byte-span map must still line up when the decoded value is
 * *shorter* than the bytes it came from (`&quot;` is six characters standing for one).
 *
 * The strong form, asserted here, is that a style write moves nothing outside the one value span:
 * the source before `value.start` and the source after `value.end` must survive the patch
 * character-for-character, no matter how much longer or shorter the replacement is. Anything using
 * the decoded length as an offset would fail this on the first entity.
 */
describe('span alignment across a decoded style write (M3.18)', () => {
  it.each(CORPUS)('writes only inside the style value span: $name', ({ html }) => {
    const map = buildSlideMap('s', html)
    let seen = 0
    for (const element of map.byId.values()) {
      const value = element.attrs['style']?.value
      if (value === undefined || value === null) continue
      seen += 1
      const before = parseDeclarations(element.attrs['style']!.text!)
      const next = applyOps(map.source, setStyleProp(map.source, element, 'outline', '1px solid'))

      const head = map.source.slice(0, value.start)
      const tail = map.source.slice(value.end)
      expect(next.slice(0, value.start)).toBe(head)
      expect(next.slice(next.length - tail.length)).toBe(tail)

      // And the declarations survive as CSS, re-read through a freshly built map.
      const after = buildSlideMap('s', next)
      const reread = [...after.byId.values()].find(
        (candidate) => candidate.path.join('/') === element.path.join('/'),
      )
      expect(reread).toBeDefined()
      expect(parseDeclarations(reread!.attrs['style']!.text!)).toEqual([
        ...before.filter((d) => d.prop !== 'outline'),
        { prop: 'outline', value: '1px solid', important: false },
      ])
    }
    // Not every corpus entry has a styled element; the suite-level count below is what keeps this
    // loop from being vacuous overall.
    expect(seen).toBeGreaterThanOrEqual(0)
  })

  it('the corpus really does carry entity-bearing style attributes', () => {
    const entityStyled = CORPUS.flatMap(({ html }) => {
      const map = buildSlideMap('s', html)
      return [...map.byId.values()].filter((element) => {
        const value = element.attrs['style']?.value
        return (
          value !== undefined &&
          value !== null &&
          map.source.slice(value.start, value.end).includes('&')
        )
      })
    })
    expect(entityStyled.length).toBeGreaterThanOrEqual(3)
    // Shorter than its bytes — the case the roadmap named.
    expect(
      entityStyled.some(
        (element) =>
          element.attrs['style']!.text!.length <
          element.attrs['style']!.value!.end - element.attrs['style']!.value!.start,
      ),
    ).toBe(true)
  })

  it('keeps two entity-bearing style writes in one patch aligned', () => {
    const html =
      '<div style="font-family: &quot;Georgia&quot;, serif">' +
      '<p style="font-family: &quot;Courier New&quot;, monospace">x</p></div>'
    const map = buildSlideMap('s', html)
    const [outer, inner] = [...map.byId.values()]
    const ops = [
      ...setStyleProp(map.source, outer!, 'color', 'red'),
      ...setStyleProp(map.source, inner!, 'color', 'blue'),
    ]
    // Both spans were measured against the same source; `applyOps` splices high-offset-first.
    expect(applyOps(map.source, ops)).toBe(
      '<div style="font-family: &quot;Georgia&quot;, serif; color: red">' +
        '<p style="font-family: &quot;Courier New&quot;, monospace; color: blue">x</p></div>',
    )
  })
})
