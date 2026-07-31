import { describe, expect, it } from 'vitest'
import { parse } from 'parse5'

import { instrument } from '../../../src/shared/design/instrument'
import { buildSlideMap, SL_ID_ATTR } from '../../../src/shared/design/slide-map'
import type { SlideMap } from '../../../src/shared/design/types'
import { CORPUS, SLIDE_ID } from './corpus'

function build(html: string, slideId = SLIDE_ID): SlideMap {
  return buildSlideMap(slideId, html)
}

/** Every `data-sl-id` we could have injected for `slideId`, as written into a start tag. */
function injectedPattern(slideId: string): RegExp {
  return new RegExp(` ${SL_ID_ATTR}="${slideId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:\\d+"`, 'g')
}

/** The instrumented document with our injections deleted — should be the original source again. */
function stripInjections(instrumented: string, slideId: string): string {
  return instrumented.replace(injectedPattern(slideId), '')
}

interface ParsedElement {
  tagName: string
  attrs: { name: string; value: string }[]
}

/** Elements of a parsed document in tree order, so instrumented output can be inspected as a DOM. */
function parsedElements(html: string): ParsedElement[] {
  const found: ParsedElement[] = []
  const visit = (node: unknown): void => {
    const record = node as {
      tagName?: string
      attrs?: { name: string; value: string }[]
      sourceCodeLocation?: unknown
      childNodes?: unknown[]
      content?: unknown
    }
    if (record.tagName !== undefined && record.sourceCodeLocation) {
      found.push({ tagName: record.tagName, attrs: record.attrs ?? [] })
    }
    for (const child of record.childNodes ?? []) visit(child)
    if (record.content) visit(record.content)
  }
  visit(parse(html, { sourceCodeLocationInfo: true }))
  return found
}

function slIdOf(element: ParsedElement): string | undefined {
  return element.attrs.find((attr) => attr.name === SL_ID_ATTR)?.value
}

describe('instrument — byte identity outside the injected attributes', () => {
  /**
   * The whole contract, stated as a property: deleting the strings we inserted must give back the
   * source exactly. Any re-serialization — a normalized quote, a reordered attribute, a re-encoded
   * entity, a dropped comment — fails here, and would silently invalidate every span in the map,
   * because the map's offsets describe the *original* source.
   */
  it.each(CORPUS)('removing the injected ids restores the source exactly ($name)', ({ html }) => {
    const map = build(html)
    expect(stripInjections(instrument(map), SLIDE_ID)).toBe(html)
  })

  it('injects the attribute immediately after the tag name, ahead of author attributes', () => {
    const map = build('<div class="title">Q3</div>', 's_deck')
    expect(instrument(map)).toBe('<div data-sl-id="s_deck:0" class="title">Q3</div>')
  })

  it('injects into a tag with no attributes and into a self-closing foreign tag', () => {
    expect(instrument(build('<p>x</p>', 's_deck'))).toBe('<p data-sl-id="s_deck:0">x</p>')
    expect(instrument(build('<svg><rect/></svg>', 's_deck'))).toBe(
      '<svg data-sl-id="s_deck:0"><rect data-sl-id="s_deck:1"/></svg>',
    )
  })

  it('preserves the author’s quoting, casing, whitespace and comments', () => {
    const html = `<!-- keep --><DIV CLASS='a' data-x   id = "b"\n>x&amp;y</DIV>`
    const instrumented = instrument(build(html, 's_deck'))
    expect(instrumented).toBe(
      `<!-- keep --><DIV data-sl-id="s_deck:0" CLASS='a' data-x   id = "b"\n>x&amp;y</DIV>`,
    )
  })

  it('leaves raw-text content alone even when it looks like markup', () => {
    const html = '<script>var a = "<div>";</script><p>y</p>'
    const instrumented = instrument(build(html, 's_deck'))
    expect(instrumented).toContain('var a = "<div>";')
    expect(stripInjections(instrumented, 's_deck')).toBe(html)
  })

  it('does not disturb multi-byte or astral characters', () => {
    const html = '<p title="😀">Café 中 😀</p>'
    const instrumented = instrument(build(html, 's_deck'))
    expect(instrumented).toBe('<p data-sl-id="s_deck:0" title="😀">Café 中 😀</p>')
  })

  it('does not normalize CRLF', () => {
    const html = '<div>\r\n<p>a\r\nb</p>\r\n</div>'
    const instrumented = instrument(build(html, 's_deck'))
    expect(instrumented).toBe(
      '<div data-sl-id="s_deck:0">\r\n<p data-sl-id="s_deck:1">a\r\nb</p>\r\n</div>',
    )
  })
})

describe('instrument — what ends up in the DOM', () => {
  /**
   * The map is only useful if the ids it holds are the ids the frame will see. This parses the
   * instrumented output back and checks the DOM agrees with the map, element for element.
   */
  it.each(CORPUS)(
    'gives every mapped element its own id, in the same order ($name)',
    ({ html }) => {
      const map = build(html)
      const elements = parsedElements(instrument(map))

      expect(elements).toHaveLength(map.order.length)
      expect(elements.map(slIdOf)).toEqual(map.order)
      expect(elements.map((element) => element.tagName)).toEqual(
        map.order.map((slId) => map.byId.get(slId)!.tagName),
      )
      expect(new Set(elements.map(slIdOf)).size).toBe(elements.length)
    },
  )

  /**
   * Right-to-left splicing is what keeps offsets valid, and foster parenting is the case that
   * proves it matters: the map's insertion points are not in ascending order there, so a naive
   * left-to-right pass over `map.order` would corrupt the document.
   */
  it('splices correctly when insertion points are not in id order', () => {
    const map = build('<table><div>fostered</div><tr><td>c</td></tr></table>', 's_deck')
    // The div is id :0 but sits *after* the table's start tag in the source.
    expect(map.byId.get('s_deck:0')!.attrInsert).toBeGreaterThan(
      map.byId.get('s_deck:1')!.attrInsert,
    )

    const instrumented = instrument(map)
    expect(instrumented).toContain('<table data-sl-id="s_deck:1">')
    expect(instrumented).toContain('<div data-sl-id="s_deck:0">fostered</div>')
    expect(stripInjections(instrumented, 's_deck')).toBe(map.source)
  })

  it('instruments elements inside a template', () => {
    const instrumented = instrument(build('<template><i>y</i></template>', 's_deck'))
    expect(instrumented).toBe(
      '<template data-sl-id="s_deck:0"><i data-sl-id="s_deck:1">y</i></template>',
    )
  })

  it('does not instrument parser-implied elements', () => {
    const instrumented = instrument(build('<div>hi</div>', 's_deck'))
    expect(instrumented).toBe('<div data-sl-id="s_deck:0">hi</div>')
    expect(instrumented).not.toContain('<html')
    expect(instrumented).not.toContain('<body')
  })
})

describe('instrument — idempotence', () => {
  /**
   * The fixpoint property. Re-running the pipeline over already-instrumented output must not
   * double-inject, reshuffle ids, or drift the document — otherwise every reload after a
   * structural edit would grow the source and change what the map describes.
   */
  it.each(CORPUS)(
    'is a fixpoint: instrumenting instrumented output changes nothing ($name)',
    ({ html }) => {
      const once = instrument(build(html))
      const twice = instrument(build(once))
      expect(twice).toBe(once)

      // And a third pass is still the same document.
      expect(instrument(build(twice))).toBe(once)
    },
  )

  it.each(CORPUS)('keeps the same ids on the second pass ($name)', ({ html }) => {
    const first = build(html)
    const second = build(instrument(first))
    expect(second.order).toEqual(first.order)
  })

  it('injects nothing at all when every element already carries its canonical id', () => {
    const html = '<div data-sl-id="s_deck:0"><p data-sl-id="s_deck:1">x</p></div>'
    expect(instrument(build(html, 's_deck'))).toBe(html)
  })
})

describe('instrument — sources that already carry a data-sl-id', () => {
  /**
   * A model may emit its own ids, and 30-slide-format.md §3.3 describes a world where Sloodge
   * persists `e_<hex>` ones. We never rewrite the author's value — that would be a rewrite of
   * author bytes in the one function whose guarantee is that it does not rewrite author bytes.
   * Ours goes in front, and the tokenizer's keep-the-first rule makes it the one in the DOM.
   */
  it('inserts ours in front and lets the tokenizer drop the author’s', () => {
    const html = '<div data-sl-id="e_0f3">x</div>'
    const instrumented = instrument(build(html, 's_deck'))

    expect(instrumented).toBe('<div data-sl-id="s_deck:0" data-sl-id="e_0f3">x</div>')
    // The author's bytes survive untouched...
    expect(instrumented).toContain('data-sl-id="e_0f3"')
    // ...but the DOM sees ours, because a duplicate attribute keeps the first occurrence.
    expect(slIdOf(parsedElements(instrumented)[0]!)).toBe('s_deck:0')
  })

  it('is still a fixpoint when the author supplied a conflicting id', () => {
    const once = instrument(
      build('<div data-sl-id="e_0f3"><p data-sl-id="e_0f4">x</p></div>', 's_deck'),
    )
    expect(instrument(build(once, 's_deck'))).toBe(once)
  })

  it('handles an authored id written in uppercase', () => {
    const instrumented = instrument(build('<div DATA-SL-ID="e_0f3">x</div>', 's_deck'))
    expect(instrumented).toBe('<div data-sl-id="s_deck:0" DATA-SL-ID="e_0f3">x</div>')
    expect(slIdOf(parsedElements(instrumented)[0]!)).toBe('s_deck:0')
  })

  it('handles a valueless data-sl-id', () => {
    const instrumented = instrument(build('<div data-sl-id>x</div>', 's_deck'))
    expect(instrumented).toBe('<div data-sl-id="s_deck:0" data-sl-id>x</div>')
    expect(slIdOf(parsedElements(instrumented)[0]!)).toBe('s_deck:0')
  })
})

describe('instrument — refuses a slide id that could escape the attribute', () => {
  /**
   * `instrument` is the only place in this module that *writes* markup, and the slide id is the
   * only non-constant it writes. Real ids are Crockford base32 so this can never fire — which is
   * why it is checked rather than assumed.
   */
  it.each([
    ['a quote', 's"x'],
    ['a single quote', "s'x"],
    ['a backtick', 's`x'],
    ['a tag opener', 's<x'],
    ['a tag closer', 's>x'],
    ['an ampersand', 's&x'],
    ['a space', 's x'],
    ['a newline', 's\nx'],
    ['a tab', 's\tx'],
    ['a backslash', 's\\x'],
    ['nothing at all', ''],
  ])('throws on a slide id containing %s', (_label, slideId) => {
    expect(() => instrument(build('<p>x</p>', slideId))).toThrow(TypeError)
  })

  it('accepts the id shape the app actually mints', () => {
    expect(() => instrument(build('<p>x</p>', SLIDE_ID))).not.toThrow()
  })
})
