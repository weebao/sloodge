import { describe, expect, it } from 'vitest'
import { parse } from 'parse5'

import { buildSlideMap, SL_ID_ATTR, sourceFingerprint } from '../../../src/shared/design/slide-map'
import type { ElementSpan, SlideMap, Span } from '../../../src/shared/design/types'
import { CORPUS, SLIDE_ID } from './corpus'

function build(html: string, slideId = SLIDE_ID): SlideMap {
  return buildSlideMap(slideId, html)
}

function spans(map: SlideMap): ElementSpan[] {
  return map.order.map((slId) => {
    const span = map.byId.get(slId)
    if (!span) throw new Error(`order referenced a missing id: ${slId}`)
    return span
  })
}

function slice(map: SlideMap, span: Span): string {
  return map.source.slice(span.start, span.end)
}

function byTag(map: SlideMap, tagName: string): ElementSpan[] {
  return spans(map).filter((span) => span.tagName === tagName)
}

function one(map: SlideMap, tagName: string): ElementSpan {
  const found = byTag(map, tagName)
  expect(found).toHaveLength(1)
  return found[0]!
}

/**
 * Count *source* elements the way the map should, via an independent traversal: distinct start-tag
 * offsets among located elements. Distinct offsets rather than element count, because the adoption
 * agency clones mis-nested formatting elements and parse5 copies one location onto every clone —
 * counting tree elements would count a clone as a second addressable element.
 *
 * Includes `<template>` content, which the parser stores outside `childNodes`.
 */
function countSourceElements(html: string): number {
  const startTags = new Set<number>()
  const visit = (node: unknown): void => {
    const record = node as {
      tagName?: string
      sourceCodeLocation?: { startTag?: { startOffset: number } } | null
      childNodes?: unknown[]
      content?: unknown
    }
    const startTag = record.sourceCodeLocation?.startTag
    if (record.tagName !== undefined && startTag) startTags.add(startTag.startOffset)
    for (const child of record.childNodes ?? []) visit(child)
    if (record.content) visit(record.content)
  }
  visit(parse(html, { sourceCodeLocationInfo: true }))
  return startTags.size
}

/** Total tree elements carrying a source location, clones included. */
function countTreeElements(html: string): number {
  let count = 0
  const visit = (node: unknown): void => {
    const record = node as {
      tagName?: string
      sourceCodeLocation?: { startTag?: unknown } | null
      childNodes?: unknown[]
      content?: unknown
    }
    if (record.tagName !== undefined && record.sourceCodeLocation?.startTag) count += 1
    for (const child of record.childNodes ?? []) visit(child)
    if (record.content) visit(record.content)
  }
  visit(parse(html, { sourceCodeLocationInfo: true }))
  return count
}

describe('buildSlideMap — span accuracy', () => {
  /**
   * The load-bearing invariant of the whole module: a span is a promise that slicing the original
   * source by it yields exactly the thing the span claims to describe. Everything downstream —
   * `applyOps`, the AI context bundle's `sourceSpan`, the diff gate — is only as true as this.
   */
  it.each(CORPUS)('slicing by a span yields what the span claims ($name)', ({ html }) => {
    const map = build(html)
    expect(map.order.length).toBeGreaterThan(0)

    for (const span of spans(map)) {
      const outer = slice(map, span.outer)
      expect(outer.startsWith('<')).toBe(true)

      // `outer` starts at the start tag, and `attrInsert` is the offset just past the tag name.
      const startTagHead = map.source.slice(span.outer.start, span.attrInsert)
      expect(startTagHead.startsWith('<')).toBe(true)
      expect(startTagHead.slice(1).toLowerCase()).toBe(span.tagName.toLowerCase())

      // `inner` sits strictly inside `outer` and is the element's content.
      if (span.inner) {
        expect(span.inner.start).toBeGreaterThanOrEqual(span.outer.start)
        expect(span.inner.end).toBeLessThanOrEqual(span.outer.end)
        expect(span.inner.start).toBeLessThanOrEqual(span.inner.end)
        expect(outer).toContain(slice(map, span.inner))
      }

      // Every attribute span is inside the start tag and names itself.
      for (const [key, attr] of Object.entries(span.attrs)) {
        expect(attr.whole.start).toBeGreaterThan(span.outer.start)
        expect(slice(map, attr.name)).toBe(attr.sourceName)
        expect(attr.sourceName.toLowerCase()).toBe(key)
        expect(slice(map, attr.whole).startsWith(attr.sourceName)).toBe(true)
        if (attr.value) {
          expect(attr.value.start).toBeGreaterThanOrEqual(attr.name.end)
          expect(attr.value.end).toBeLessThanOrEqual(attr.whole.end)
        }
      }
    }
  })

  it('maps every source element once, and no invented ones', () => {
    for (const { html } of CORPUS) {
      expect(build(html).order).toHaveLength(countSourceElements(html))
    }
  })

  /**
   * Two elements must never claim the same bytes. This is the invariant the adoption-agency
   * blocker violated: a clone and its original carried different `outer` spans over one start
   * tag, so a patch aimed at one would have rewritten the other's source.
   */
  it.each(CORPUS)('never gives two ids the same start tag ($name)', ({ html }) => {
    const map = build(html)
    const starts = spans(map).map((span) => span.outer.start)
    expect(new Set(starts).size).toBe(starts.length)

    const inserts = spans(map).map((span) => span.attrInsert)
    expect(new Set(inserts).size).toBe(inserts.length)
  })

  /**
   * A child never begins before its parent. Full containment (`child.end <= parent.end`) is
   * deliberately *not* asserted: parse5 truncates the `outer` span of some implicitly-closed
   * elements, so its own data violates it — see the quirk pinned below.
   */
  it.each(CORPUS)('never starts a child before its parent starts ($name)', ({ html }) => {
    const map = build(html)
    for (const span of spans(map)) {
      if (span.parentSlId === null) continue
      expect(span.outer.start).toBeGreaterThanOrEqual(map.byId.get(span.parentSlId)!.outer.start)
    }
  })

  /**
   * Spans of two *distinct addressable elements* can partially overlap — neither nested nor
   * disjoint. The contract for this lives on `outer` in types.ts, where a patcher author will
   * read it; these are the two measured causes, pinned.
   *
   * Cause 1: a parent implicitly closed at EOF ends short of its own children.
   */
  it('records a parent implicitly closed at EOF ending short of its children', () => {
    const map = build('<head><title>t</title>')
    const head = one(map, 'head')
    const title = one(map, 'title')

    expect(slice(map, head.outer)).toBe('<head><title>t')
    expect(slice(map, title.outer)).toBe('<title>t</title>')
    // `title` is a child of `head` and escapes both its parent's outer and its inner.
    expect(title.parentSlId).toBe(head.slId)
    expect(title.outer.end).toBeGreaterThan(head.outer.end)
    expect(title.outer.end).toBeGreaterThan(head.inner!.end)

    const body = build('<body><p>x</p>')
    expect(slice(body, one(body, 'body').outer)).toBe('<body>')
    expect(slice(body, one(body, 'p').outer)).toBe('<p>x</p>')
  })

  /**
   * Cause 2, and the common one: mis-nested formatting whose furthest block is a block element,
   * in a **fully closed** document with nothing EOF-implied. Here the two elements are siblings,
   * so this is not a containment failure at all — their spans simply run into each other, which
   * is why the contract is stated as "may partially overlap" rather than "a child may escape its
   * parent".
   */
  it('records mis-nested formatting giving two siblings overlapping spans', () => {
    const map = build('<b><p>x</b>y</p>')
    const bold = one(map, 'b')
    const paragraph = one(map, 'p')

    expect(slice(map, bold.outer)).toBe('<b><p>x</b>')
    expect(slice(map, paragraph.outer)).toBe('<p>x</b>y</p>')

    // Siblings — neither is the other's parent.
    expect(bold.parentSlId).toBeNull()
    expect(paragraph.parentSlId).toBeNull()

    // Partial overlap: each starts inside the other's span and ends outside it.
    expect(paragraph.outer.start).toBeGreaterThan(bold.outer.start)
    expect(paragraph.outer.start).toBeLessThan(bold.outer.end)
    expect(paragraph.outer.end).toBeGreaterThan(bold.outer.end)
  })

  it('slices an element, its content and its attribute values exactly', () => {
    const html = '<div class="title" hidden>Q3 <b>Revenue</b></div>'
    const map = build(html)
    const div = one(map, 'div')

    expect(slice(map, div.outer)).toBe('<div class="title" hidden>Q3 <b>Revenue</b></div>')
    expect(slice(map, div.inner!)).toBe('Q3 <b>Revenue</b>')
    expect(slice(map, div.attrs['class']!.whole)).toBe('class="title"')
    expect(slice(map, div.attrs['class']!.value!)).toBe('title')
    expect(slice(map, div.attrs['hidden']!.whole)).toBe('hidden')
    expect(div.attrs['hidden']!.value).toBeNull()
    expect(slice(map, one(map, 'b').inner!)).toBe('Revenue')
  })

  it('excludes quotes from a value span but keeps the value they contain', () => {
    const map = build(`<div a="x" b='y"z' c=bare d = "spaced">t</div>`)
    const div = one(map, 'div')
    expect(slice(map, div.attrs['a']!.value!)).toBe('x')
    expect(slice(map, div.attrs['b']!.value!)).toBe('y"z')
    expect(slice(map, div.attrs['c']!.value!)).toBe('bare')
    expect(slice(map, div.attrs['d']!.value!)).toBe('spaced')
  })

  it('reports an empty value span, not null, for an empty quoted value', () => {
    const div = one(build('<div class="">t</div>'), 'div')
    expect(div.attrs['class']!.value).toEqual({ start: 12, end: 12 })
  })
})

describe('buildSlideMap — offset semantics', () => {
  /**
   * The plan calls these byte spans; they are UTF-16 code-unit indices. An emoji is one code
   * point and *two* code units, so a map that counted code points — or UTF-8 bytes — would drift
   * by one (or by three) at the first emoji and slice garbage from there on. This is the test
   * that fails if anyone "fixes" the offsets to be bytes.
   */
  it('counts UTF-16 code units, so an astral character costs two', () => {
    const html = '<p>😀</p><b>x</b>'
    const map = build(html)
    const [p, b] = spans(map)

    expect(p!.outer).toEqual({ start: 0, end: 9 })
    expect(slice(map, p!.inner!)).toBe('😀')
    expect(p!.inner).toEqual({ start: 3, end: 5 })
    // Not 4: the emoji is a surrogate pair, so `<p>😀</p>` is 9 code units, not 8.
    expect(b!.outer.start).toBe(9)
    expect(slice(map, b!.outer)).toBe('<b>x</b>')
  })

  it('counts a multi-byte character as its code units, not its bytes', () => {
    const html = '<p>Café 中</p><b>x</b>'
    const map = build(html)
    // 'Café 中' is 6 code units but 10 UTF-8 bytes; a byte-based map would put <b> at 17.
    expect(spans(map)[1]!.outer.start).toBe(13)
    expect(slice(map, spans(map)[1]!.outer)).toBe('<b>x</b>')
  })

  it('leaves CRLF intact and inside the spans that contain it', () => {
    const html = '<p>a\r\nb</p>\r\n<b>y</b>'
    const map = build(html)
    expect(slice(map, spans(map)[0]!.inner!)).toBe('a\r\nb')
    expect(slice(map, spans(map)[1]!.outer)).toBe('<b>y</b>')
  })

  it('does not decode entities — spans cover raw source text', () => {
    const map = build('<p title="a&amp;b">x&lt;y</p>')
    const p = one(map, 'p')
    expect(slice(map, p.attrs['title']!.value!)).toBe('a&amp;b')
    expect(slice(map, p.inner!)).toBe('x&lt;y')
  })

  it('accounts for a leading byte order mark', () => {
    const map = build('﻿<p>x</p>')
    expect(one(map, 'p').outer).toEqual({ start: 1, end: 9 })
  })
})

describe('buildSlideMap — parser-inserted elements', () => {
  /**
   * 40-design-mode.md §1.2: parse5 invents `<html>/<head>/<body>` for a fragment and gives them
   * no source location. There is nothing in the source to point at, so they get no id — mapping
   * them would hand the patcher an offset that describes nothing.
   */
  it('gives no id to implied html/head/body', () => {
    const map = build('<div>hi</div>')
    expect(map.order).toHaveLength(1)
    expect(one(map, 'div').tagName).toBe('div')
    expect(byTag(map, 'html')).toHaveLength(0)
    expect(byTag(map, 'body')).toHaveLength(0)
  })

  it('does map html/head/body when the author actually wrote them', () => {
    const map = build('<!doctype html><html><head></head><body><p>x</p></body></html>')
    expect(map.order).toHaveLength(4)
    expect(slice(map, one(map, 'head').outer)).toBe('<head></head>')
    expect(slice(map, one(map, 'body').outer)).toBe('<body><p>x</p></body>')
  })

  it('treats an unmapped element as transparent when linking parents and children', () => {
    // <p> and <b> are siblings under the *implied* body, so neither has a mapped parent.
    const map = build('<p>a</p><b>c</b>')
    for (const span of spans(map)) expect(span.parentSlId).toBeNull()

    // But an authored body owns them.
    const withBody = build('<body><p>a</p><b>c</b>')
    const body = one(withBody, 'body')
    expect(body.parentSlId).toBeNull()
    expect(body.childSlIds).toEqual([one(withBody, 'p').slId, one(withBody, 'b').slId])
    expect(one(withBody, 'p').parentSlId).toBe(body.slId)
  })

  it('counts implied elements in `path` even though they carry no id', () => {
    // html(0) > body(1) > div(0) > span(0)
    const map = build('<div><span>x</span></div>')
    expect(one(map, 'div').path).toEqual([0, 1, 0])
    expect(one(map, 'span').path).toEqual([0, 1, 0, 0])
  })
})

describe('buildSlideMap — element shapes', () => {
  it('reports inner as null for a void element and empty for an empty one', () => {
    const map = build('<img src="x"><br><div></div>')
    expect(one(map, 'img').inner).toBeNull()
    expect(one(map, 'br').inner).toBeNull()
    expect(one(map, 'div').inner).toEqual({ start: 22, end: 22 })
  })

  it('reports inner as null for a self-closed foreign element but not an unclosed one', () => {
    const map = build('<svg><rect/><circle></svg>')
    expect(one(map, 'rect').inner).toBeNull()
    // <circle> was never closed: it *can* hold content, and here holds none.
    expect(one(map, 'circle').inner).toEqual({ start: 20, end: 20 })
  })

  it('gives an implied-end element the content it really has', () => {
    const map = build('<ul><li>a<li>b</ul>')
    const [first, second] = byTag(map, 'li')
    expect(slice(map, first!.inner!)).toBe('a')
    expect(slice(map, second!.inner!)).toBe('b')
    expect(slice(map, first!.outer)).toBe('<li>a')
  })

  it('marks textOnly for text and empty content, but not for mixed content', () => {
    expect(one(build('<p>plain</p>'), 'p').textOnly).toBe(true)
    expect(one(build('<div></div>'), 'div').textOnly).toBe(true)
    expect(one(build('<p>Revenue <b>18%</b> Q3</p>'), 'p').textOnly).toBe(false)
    // A void element can never hold text, so it is never a setTextContent target.
    expect(one(build('<img src="x">'), 'img').textOnly).toBe(false)
    // A comment is not a text node.
    expect(one(build('<div><!-- c --></div>'), 'div').textOnly).toBe(false)
  })

  it('addresses nested identical elements separately', () => {
    const map = build('<div><div><div>a</div></div></div>')
    const divs = byTag(map, 'div')
    expect(divs).toHaveLength(3)
    expect(new Set(divs.map((span) => span.slId)).size).toBe(3)
    expect(divs.map((span) => slice(map, span.outer))).toEqual([
      '<div><div><div>a</div></div></div>',
      '<div><div>a</div></div>',
      '<div>a</div>',
    ])
    expect(divs[1]!.parentSlId).toBe(divs[0]!.slId)
    expect(divs[2]!.parentSlId).toBe(divs[1]!.slId)
  })

  it('addresses identical siblings separately and by position', () => {
    const map = build('<svg><rect x="1"/><rect x="1"/><rect x="1"/></svg>')
    const rects = byTag(map, 'rect')
    expect(rects.map((span) => span.outer.start)).toEqual([5, 18, 31])
    expect(rects.map((span) => span.path)).toEqual([
      [0, 1, 0, 0],
      [0, 1, 0, 1],
      [0, 1, 0, 2],
    ])
  })
})

describe('buildSlideMap — attributes', () => {
  /**
   * The HTML tokenizer keeps the *first* of a duplicated attribute and drops the rest, so only
   * the first is in the DOM and only the first is addressable. A map that exposed the second
   * would let a patcher edit bytes that have no effect on what the user sees.
   */
  it('exposes only the first of a duplicated attribute', () => {
    const map = build('<div a="1" a="2">x</div>')
    const div = one(map, 'div')
    expect(slice(map, div.attrs['a']!.whole)).toBe('a="1"')
    expect(Object.keys(div.attrs)).toEqual(['a'])
  })

  /**
   * `sourceCodeLocation.attrs` is keyed by the lowercased name in *every* namespace, including
   * SVG — so `viewBox` is found under `viewbox`, and the author's casing survives only on
   * `sourceName`. (40-design-mode.md §1.2 assumes the opposite; see the note on `attrs`.)
   */
  it('keys attributes by the lowercased name and preserves the source casing', () => {
    const map = build('<svg viewBox="0 0 1 1"><rect/></svg>')
    const svg = one(map, 'svg')
    expect(Object.keys(svg.attrs)).toEqual(['viewbox'])
    expect(svg.attrs['viewbox']!.sourceName).toBe('viewBox')
    expect(slice(map, svg.attrs['viewbox']!.value!)).toBe('0 0 1 1')
  })

  it('keys an uppercase HTML attribute by its lowercased name', () => {
    const div = one(build('<DIV CLASS="c">x</DIV>'), 'div')
    expect(div.attrs['class']!.sourceName).toBe('CLASS')
    expect(div.tagName).toBe('div')
  })

  it('handles whitespace around the equals sign and a multiline start tag', () => {
    const map = build('<div\n  class = "a"\n  id ="b"\n>x</div>')
    const div = one(map, 'div')
    expect(div.attrs['class']!.sourceName).toBe('class')
    expect(slice(map, div.attrs['class']!.value!)).toBe('a')
    expect(slice(map, div.attrs['id']!.value!)).toBe('b')
  })

  /**
   * `<div =a>` is an attribute *named* `=a` — the tokenizer's
   * unexpected-equals-sign-before-attribute-name path. Splitting the name at the first `=` at
   * index 0 would produce an empty name and a value that is really the name.
   */
  it('does not split an attribute name that starts with an equals sign', () => {
    const div = one(build('<div =a class="c">x</div>'), 'div')
    expect(div.attrs['=a']!.sourceName).toBe('=a')
    expect(div.attrs['=a']!.value).toBeNull()
  })

  it('puts attrInsert just after the tag name, before the author attributes', () => {
    const map = build('<div class="a">x</div>')
    expect(one(map, 'div').attrInsert).toBe(4)
    expect(map.source.slice(0, 4)).toBe('<div')

    // Source casing and a multiline tag do not move it.
    expect(one(build('<DIV CLASS="c">x</DIV>'), 'div').attrInsert).toBe(4)
    expect(one(build('<div\n  class="a">x</div>'), 'div').attrInsert).toBe(4)
    // No attributes at all: the insert point is still before the `>`.
    expect(one(build('<p>x</p>'), 'p').attrInsert).toBe(2)
    // Self-closing foreign element: before the `/`.
    expect(one(build('<svg><rect/></svg>'), 'rect').attrInsert).toBe(10)
  })
})

describe('buildSlideMap — namespaces and templates', () => {
  it('tracks the namespace per element, not per document', () => {
    const map = build('<svg><foreignObject><div>h</div></foreignObject></svg>')
    expect(one(map, 'svg').ns).toBe('svg')
    expect(one(map, 'foreignObject').ns).toBe('svg')
    expect(one(map, 'div').ns).toBe('html')
    expect(one(build('<math><mi>x</mi></math>'), 'mi').ns).toBe('mathml')
    expect(one(build('<p>x</p>'), 'p').ns).toBe('html')
  })

  it('handles nested svg without losing the namespace on re-entry', () => {
    const map = build('<svg><svg><rect/></svg></svg>')
    expect(spans(map).map((span) => span.ns)).toEqual(['svg', 'svg', 'svg'])
  })

  /**
   * A template's children live in a separate `content` fragment, not in `childNodes`. Walking
   * only `childNodes` would leave every element inside a template unaddressable — and a slide
   * that clones a template at runtime still needs its markup to be selectable and editable.
   */
  it('maps elements inside a template as the template’s children', () => {
    const map = build('<template><i>y</i><b>z</b></template>')
    const template = one(map, 'template')
    expect(template.childSlIds).toEqual([one(map, 'i').slId, one(map, 'b').slId])
    expect(one(map, 'i').parentSlId).toBe(template.slId)
    expect(slice(map, one(map, 'i').outer)).toBe('<i>y</i>')
  })

  it('maps elements inside a nested template', () => {
    const map = build('<template><div><template><p>deep</p></template></div></template>')
    expect(slice(map, one(map, 'p').outer)).toBe('<p>deep</p>')
    expect(one(map, 'p').path).toEqual([0, 0, 0, 0, 0, 0])
  })
})

describe('buildSlideMap — id assignment', () => {
  it('numbers ids by tree document order under the slide id', () => {
    const map = build('<div><p>a</p><b>c</b></div>', 's_deck')
    expect(map.order).toEqual(['s_deck:0', 's_deck:1', 's_deck:2'])
    expect(map.byId.get('s_deck:0')!.tagName).toBe('div')
    expect(map.byId.get('s_deck:2')!.tagName).toBe('b')
  })

  /**
   * Foster parenting is the case where tree order and source order genuinely disagree: a `<div>`
   * written inside a `<table>` is relocated *before* the table in the tree. We number by tree
   * order because that is the order the iframe's DOM exhibits and the order `path` and
   * `childSlIds` are consistent with — so `order` is not sorted by `outer.start`, deliberately.
   */
  it('numbers foster-parented content in tree order, not source order', () => {
    const map = build('<table><div>fostered</div><tr><td>c</td></tr></table>', 's_deck')
    const [first, second] = spans(map)
    expect(first!.tagName).toBe('div')
    expect(second!.tagName).toBe('table')
    expect(first!.slId).toBe('s_deck:0')
    // The div's id is lower than the table's despite its higher source offset.
    expect(first!.outer.start).toBeGreaterThan(second!.outer.start)
  })

  /**
   * §1.1's stability contract. Ids come from a positional counter over a deterministic parse, so
   * reparsing unchanged bytes reproduces them exactly, and an edit that only changes an attribute
   * value or text moves offsets without moving anyone's index.
   */
  it.each(CORPUS)('assigns the same ids when the same source is reparsed ($name)', ({ html }) => {
    const first = build(html)
    const second = build(html)
    expect(second.order).toEqual(first.order)
    for (const slId of first.order) {
      expect(second.byId.get(slId)!.outer).toEqual(first.byId.get(slId)!.outer)
      expect(second.byId.get(slId)!.path).toEqual(first.byId.get(slId)!.path)
    }
  })

  it('keeps ids stable across an attribute-value edit and shifts only the spans after it', () => {
    const before = build('<div class="a"><p>text</p></div>')
    const after = build('<div class="a-much-longer-value"><p>text</p></div>')

    expect(after.order).toEqual(before.order)
    expect(after.byId.get(after.order[1]!)!.tagName).toBe('p')
    // The paragraph moved by exactly the growth of the value it follows.
    const growth = '-much-longer-value'.length
    expect(after.byId.get(after.order[1]!)!.outer.start).toBe(
      before.byId.get(before.order[1]!)!.outer.start + growth,
    )
  })

  it('assigns every element a unique id and an order that matches byId', () => {
    for (const { html } of CORPUS) {
      const map = build(html)
      expect(new Set(map.order).size).toBe(map.order.length)
      expect(map.byId.size).toBe(map.order.length)
      for (const [slId, span] of map.byId) expect(span.slId).toBe(slId)
    }
  })

  it('keeps parent and child links mutually consistent', () => {
    for (const { html } of CORPUS) {
      const map = build(html)
      for (const span of spans(map)) {
        for (const childId of span.childSlIds) {
          expect(map.byId.get(childId)!.parentSlId).toBe(span.slId)
        }
        if (span.parentSlId !== null) {
          expect(map.byId.get(span.parentSlId)!.childSlIds).toContain(span.slId)
        }
      }
    }
  })
})

describe('buildSlideMap — adoption agency clones', () => {
  /**
   * `<p><b>x</p><p>y</b></p>`: the parser clones the `<b>` into the second paragraph and parse5
   * copies the original's location onto the clone, so the tree holds two `<b>` elements both
   * claiming to start at offset 3. Only the source-original is addressable.
   */
  it('mints one id for a formatting element the parser cloned', () => {
    const html = '<p><b>x</p><p>y</b></p>'
    const map = build(html, 's_deck')

    // Four tree elements, three source elements.
    expect(countTreeElements(html)).toBe(4)
    expect(map.order).toEqual(['s_deck:0', 's_deck:1', 's_deck:2'])
    expect(byTag(map, 'b')).toHaveLength(1)
  })

  it('keeps the tight span, not the clone’s boundary-crossing one', () => {
    const map = build('<p><b>x</p><p>y</b></p>')
    const bold = one(map, 'b')
    // The clone's outer was [3,19) — `<b>x</p><p>y</b>`, covering bytes of both paragraphs.
    expect(slice(map, bold.outer)).toBe('<b>x')
    expect(slice(map, bold.inner!)).toBe('x')
  })

  it('records how many DOM nodes the one source element produces', () => {
    const map = build('<p><b>x</p><p>y</b></p>')
    expect(one(map, 'b').minDomNodeCount).toBe(2)
    for (const span of byTag(map, 'p')) expect(span.minDomNodeCount).toBe(1)
    // The ordinary case is always 1.
    expect(one(build('<p>plain</p>'), 'p').minDomNodeCount).toBe(1)
  })

  it('collapses clones at every depth of a nested mis-nesting', () => {
    const map = build('<p><b><i><u>x</p><p>y</u></i></b></p>')
    expect(byTag(map, 'b')).toHaveLength(1)
    expect(byTag(map, 'i')).toHaveLength(1)
    expect(byTag(map, 'u')).toHaveLength(1)
    expect(slice(map, one(map, 'b').outer)).toBe('<b><i><u>x')
    expect(slice(map, one(map, 'u').outer)).toBe('<u>x')
    for (const tag of ['b', 'i', 'u']) expect(one(map, tag).minDomNodeCount).toBe(2)
  })

  it('keeps the clone’s attributes addressable exactly once', () => {
    const map = build('<p><a href="#">x</p><p>y</a></p>')
    const anchor = one(map, 'a')
    expect(slice(map, anchor.attrs['href']!.value!)).toBe('#')
    expect(anchor.minDomNodeCount).toBe(2)
  })

  /**
   * The adoption agency can move a genuinely new element inside the clone. It is not itself a
   * clone, so it stays addressable and simply attaches to the nearest mapped ancestor.
   */
  it('still maps a fresh element that the parser moved inside a clone', () => {
    const map = build('<p><b>x</p><p>y<span>s</span></b></p>')
    const span = one(map, 'span')
    expect(slice(map, span.outer)).toBe('<span>s</span>')
    expect(span.minDomNodeCount).toBe(1)
    // Its parent is the clone, which is transparent — so it attaches to the second <p>.
    expect(map.byId.get(span.parentSlId!)!.tagName).toBe('p')
  })

  /**
   * When the adoption agency's furthest block is a block element, parse5 gives the clone no
   * `sourceCodeLocation` at all — so it is unaddressable (correct) *and* invisible to the clone
   * accounting, which is why `minDomNodeCount` is contracted as a lower bound. The DOM really has
   * two `<b>` nodes here; the bound says 1. Pinned so the gap is deliberate rather than
   * incidental — the exact DOM counts live in instrument.test.ts, against a reparse.
   */
  it('treats a clone the parser gave no location as unaddressable, and under-counts it', () => {
    const map = build('<b><p>x</b>y</p>')
    expect(byTag(map, 'b')).toHaveLength(1)
    expect(slice(map, one(map, 'b').outer)).toBe('<b><p>x</b>')
    expect(one(map, 'b').minDomNodeCount).toBe(1)
  })

  it('never claims more DOM nodes than a source element really renders', () => {
    // The bound must hold for the located family too, where it happens to be exact.
    expect(one(build('<p><b>x</p><p>y</b></p>'), 'b').minDomNodeCount).toBe(2)
    expect(one(build('<p><b>x</p><p>y</p><p>z</b></p>'), 'b').minDomNodeCount).toBe(3)
    for (const { html } of CORPUS) {
      for (const span of spans(build(html))) {
        expect(span.minDomNodeCount).toBeGreaterThanOrEqual(1)
      }
    }
  })
})

describe('buildSlideMap — self-closing versus a solidus in an attribute value', () => {
  /**
   * In the attribute-value-unquoted state `/` is an ordinary value character, so the `/` in
   * `<image href=a/>` belongs to the value `a/` and closes nothing. Reading it as a self-closing
   * solidus marked a foreign element that can hold content as `inner: null`, which a patcher
   * reads as "refuse content edits".
   */
  it('does not mistake an unquoted value’s trailing slash for a self-closing tag', () => {
    const map = build('<svg><image href=a/></svg>')
    const image = one(map, 'image')
    expect(slice(map, image.attrs['href']!.value!)).toBe('a/')
    expect(image.inner).not.toBeNull()
    expect(image.inner).toEqual({ start: 20, end: 20 })
  })

  it('still recognises a real self-closing tag after a quoted value ending in a slash', () => {
    const map = build('<svg><image href="a/"/></svg>')
    const image = one(map, 'image')
    expect(slice(map, image.attrs['href']!.value!)).toBe('a/')
    expect(image.inner).toBeNull()
  })

  it('recognises a self-closing tag with no attributes and an unclosed one', () => {
    const map = build('<svg><rect/><circle></svg>')
    expect(one(map, 'rect').inner).toBeNull()
    expect(one(map, 'circle').inner).not.toBeNull()
  })

  it('is unaffected by an unquoted value with no slash', () => {
    expect(one(build('<svg><image href=a></svg>'), 'image').inner).not.toBeNull()
  })

  /**
   * An element declared contentless must really hold nothing. This is the class-level guard
   * behind the solidus repro: misreading a start tag as self-closing on an element that actually
   * has children would both hide those children's container and tell a patcher to refuse edits.
   */
  it.each(CORPUS)('gives a contentless element no content and no children ($name)', ({ html }) => {
    const map = build(html)
    for (const span of spans(map)) {
      if (span.inner !== null) continue
      expect(span.childSlIds).toEqual([])
      expect(span.textOnly).toBe(false)
      // Its whole source extent is the start tag: there is no content region at all.
      expect(slice(map, span.outer).endsWith('>')).toBe(true)
    }
  })
})

describe('buildSlideMap — authored data-sl-id', () => {
  /**
   * 40-design-mode.md makes `data-sl-id` injection-only; 30-slide-format.md §3.3 has it persisted
   * in saved source. The map's own id is always ours, and whatever the source said is recorded
   * beside it so the 30-format lint can be built on the same parse.
   */
  it('records an authored id without adopting it', () => {
    const map = build('<div data-sl-id="e_0f3"><p>x</p></div>', 's_deck')
    expect(one(map, 'div').slId).toBe('s_deck:0')
    expect(one(map, 'div').authoredSlId).toBe('e_0f3')
    expect(one(map, 'p').authoredSlId).toBeNull()
  })

  it('finds an authored id written in uppercase', () => {
    expect(one(build('<div DATA-SL-ID="e_0f3">x</div>'), 'div').authoredSlId).toBe('e_0f3')
  })

  it('reports no authored id for a valueless data-sl-id', () => {
    const div = one(build('<div data-sl-id>x</div>'), 'div')
    expect(div.authoredSlId).toBeNull()
    expect(div.attrs[SL_ID_ATTR]!.value).toBeNull()
  })
})

describe('sourceFingerprint', () => {
  it('is stable, prefixed with its algorithm, and changes with the source', () => {
    expect(sourceFingerprint('<p>x</p>')).toBe(sourceFingerprint('<p>x</p>'))
    expect(sourceFingerprint('<p>x</p>')).toMatch(/^fnv1a32:[0-9a-f]{8}$/)
    expect(sourceFingerprint('<p>x</p>')).not.toBe(sourceFingerprint('<p>y</p>'))
    // A one-character insertion anywhere must move it.
    expect(sourceFingerprint('<p>x</p> ')).not.toBe(sourceFingerprint('<p>x</p>'))
    expect(sourceFingerprint('')).toMatch(/^fnv1a32:[0-9a-f]{8}$/)
  })

  it('distinguishes strings that differ only outside the ASCII range', () => {
    expect(sourceFingerprint('<p>Café</p>')).not.toBe(sourceFingerprint('<p>Cafe</p>'))
    expect(sourceFingerprint('<p>😀</p>')).not.toBe(sourceFingerprint('<p>😁</p>'))
  })

  it('is what the map uses unless the caller supplies a real hash', () => {
    const html = '<p>x</p>'
    expect(build(html).sourceHash).toBe(sourceFingerprint(html))
    expect(buildSlideMap(SLIDE_ID, html, { sourceHash: 'sha256:abc' }).sourceHash).toBe(
      'sha256:abc',
    )
  })
})

describe('buildSlideMap — the map describes the source it was given', () => {
  it.each(CORPUS)('keeps source untouched and every span in range ($name)', ({ html }) => {
    const map = build(html)
    expect(map.source).toBe(html)
    expect(map.slideId).toBe(SLIDE_ID)

    for (const span of spans(map)) {
      expect(span.outer.start).toBeGreaterThanOrEqual(0)
      expect(span.outer.end).toBeLessThanOrEqual(html.length)
      expect(span.outer.start).toBeLessThan(span.outer.end)
      expect(span.attrInsert).toBeGreaterThan(span.outer.start)
      expect(span.attrInsert).toBeLessThanOrEqual(span.outer.end)
    }
  })
})

/**
 * `textOnly` is a **byte-coverage** claim, not a tree-shape claim (M3.11 round-1 blocker): the text
 * nodes' source spans must tile `inner` exactly. The tree alone said "all children are text" for an
 * adoption-agency original with zero children and markup in its inner bytes.
 */
describe('buildSlideMap — textOnly requires the text nodes to cover inner exactly', () => {
  it.each([
    ['formatting element wrapping a block', '<b><p>x</b>y</p>', 'b'],
    ['inline wrapping a div', '<em><div class="note">x</em> more</div>', 'em'],
    ['text then a block inside the formatting element', '<b>x<p>y</b>z</p>', 'b'],
    ['text foster-parented out of a table', '<table>x</table>', 'table'],
    ['head the parser locates inverted', '<head>x</head>', 'head'],
  ])('%s: not textOnly, textContent null', (_label, html, tag) => {
    const element = one(build(html), tag)
    expect(element.textOnly).toBe(false)
    expect(element.textContent).toBeNull()
  })

  it.each([
    ['plain text', '<p>plain</p>', 'p', 'plain'],
    ['empty element', '<div></div>', 'div', ''],
    ['entities decoded', '<p>a&nbsp;b &mdash; &lt;c&gt; &amp;d</p>', 'p', 'a b — <c> &d'],
    ['crlf normalized', '<p>a\r\nb</p>', 'p', 'a\nb'],
    ['stray ignored end tag merged into one text node', '<p>a</b>b</p>', 'p', 'ab'],
    ['stray ignored start tag merged into one text node', '<p>a<tr>b</p>', 'p', 'ab'],
    ['pre with the leading newline the parser drops', '<pre>\nx</pre>', 'pre', 'x'],
    ['pre with a dropped CRLF', '<pre>\r\nx</pre>', 'pre', 'x'],
    ['pre holding only the dropped newline', '<pre>\n</pre>', 'pre', ''],
    ['textarea with the leading newline dropped', '<textarea>\nx</textarea>', 'textarea', 'x'],
    ['whitespace inside a table', '<table> </table>', 'table', ' '],
    ['svg text', '<svg><text>a</text></svg>', 'text', 'a'],
    ['unclosed at eof', '<p>tail', 'p', 'tail'],
    ['astral text', '<p>\u{1F600} bars</p>', 'p', '\u{1F600} bars'],
    ['formatting original whose text covers its inner', '<p><b>x</p><p>y</b></p>', 'b', 'x'],
  ])('%s: textOnly with textContent as the DOM reads it', (_label, html, tag, expected) => {
    const element = one(build(html), tag)
    expect(element.textOnly).toBe(true)
    expect(element.textContent).toBe(expected)
  })

  it('textContent is null exactly when textOnly is false, across the corpus', () => {
    for (const entry of CORPUS) {
      for (const span of spans(build(entry.html))) {
        expect(span.textContent === null, `${entry.name} ${span.slId}`).toBe(!span.textOnly)
      }
    }
  })
})
