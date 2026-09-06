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

/**
 * Every element of a parsed document, in tree order — **with no filter on source location**.
 *
 * The location filter this helper used to carry (to skip the implied `<html>/<head>/<body>`)
 * silently skipped adoption-agency clones too, because those are exactly the nodes parse5 leaves
 * unlocated. That gave the test the same blind spot as the code it was checking: the corpus-wide
 * "the DOM agrees with the map" assertion passed on `<b><p>x</b>y</p>` while the real DOM had one
 * more `<b>` than the map predicted.
 *
 * Implied elements are excluded by the assertions instead, via `data-sl-id` — which is what the
 * bridge will actually query, and which no clone can hide from since it inherits the attribute.
 */
function parsedElements(html: string): ParsedElement[] {
  const found: ParsedElement[] = []
  const visit = (node: unknown): void => {
    const record = node as {
      tagName?: string
      attrs?: { name: string; value: string }[]
      childNodes?: unknown[]
      content?: unknown
    }
    if (record.tagName !== undefined) {
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

/** The only elements the tree builder invents, and so the only ones allowed to carry no id. */
const IMPLIED_TAGS = ['html', 'head', 'body', 'tbody', 'colgroup']

/** First element with this tag in the instrumented DOM. Indexes shift once implied tags are in. */
function firstOfTag(instrumented: string, tagName: string): ParsedElement {
  const found = parsedElements(instrumented).find((element) => element.tagName === tagName)
  if (!found) throw new Error(`No <${tagName}> in the instrumented document`)
  return found
}

/**
 * Ground truth: how many nodes in the rendered DOM carry each `slId`.
 *
 * Derived from a fresh parse of the instrumented output, so it has no dependence on source
 * locations and cannot share a blind spot with the map.
 */
function domNodesById(instrumented: string): Map<string, number> {
  const counts = new Map<string, number>()
  for (const element of parsedElements(instrumented)) {
    const slId = slIdOf(element)
    if (slId === undefined) continue
    counts.set(slId, (counts.get(slId) ?? 0) + 1)
  }
  return counts
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
   * The assertion the aliasing blocker needed. An id that is in the map but absent from the DOM
   * is an element the bridge can never find, and Design Mode surfaces that as an element that is
   * silently unselectable rather than as an error. Before the fix, `<p><b>x</p><p>y</b></p>` put
   * two `data-sl-id` attributes into one start tag and the tokenizer dropped the second.
   */
  it.each(CORPUS)('makes every id in the map reachable in the DOM ($name)', ({ html }) => {
    const map = build(html)
    const counts = domNodesById(instrument(map))
    for (const slId of map.order) expect(counts.get(slId) ?? 0).toBeGreaterThanOrEqual(1)
  })

  /**
   * The map and the rendered DOM must describe the same set of elements. Ground truth is a fresh
   * parse of the instrumented output counted by `data-sl-id`, with no filter on source location —
   * the earlier version of this test filtered on `sourceCodeLocation`, which is precisely the
   * property adoption-agency clones lack, so it shared the map's blind spot and passed on the
   * corpus's own `<b><p>x</b>y</p>` while the DOM had an extra `<b>`.
   */
  it.each(CORPUS)('agrees with the rendered DOM about every id ($name)', ({ html }) => {
    const map = build(html)
    const instrumented = instrument(map)
    const counts = domNodesById(instrumented)

    // Exactly the same id set, in both directions.
    expect([...counts.keys()].toSorted()).toEqual([...map.order].toSorted())

    // Every element in the instrumented DOM carries an id — no addressable element is missed and
    // no implied element is instrumented.
    const withoutId = parsedElements(instrumented).filter(
      (element) => slIdOf(element) === undefined,
    )
    expect(withoutId.map((element) => element.tagName).toSorted()).toEqual(
      IMPLIED_TAGS.filter((tag) => withoutId.some((element) => element.tagName === tag)).toSorted(),
    )

    // `minDomNodeCount` is a bound, so it must never exceed what the DOM really renders.
    for (const slId of map.order) {
      expect(map.byId.get(slId)!.minDomNodeCount).toBeLessThanOrEqual(counts.get(slId)!)
    }

    // First occurrence of each id, in DOM order, reproduces the map's order.
    const firstOccurrences = parsedElements(instrumented)
      .map(slIdOf)
      .filter((slId) => slId !== undefined)
      .filter((slId, index, all) => all.indexOf(slId) === index)
    expect(firstOccurrences).toEqual(map.order)
  })

  /**
   * The exact ground-truth counts for the family where parse5 leaves the clone unlocated, so the
   * gap between `minDomNodeCount` and reality is pinned rather than incidental. These are the
   * shapes that pass silently under a location-filtered view of the DOM.
   */
  it.each([
    ['<b><p>x</b>y</p>', 'b', 2, 1],
    ['<b><div>x</b>y</div>', 'b', 2, 1],
    ['<a href="#"><p>x</a>y</p>', 'a', 2, 1],
    ['<em><h1>t</em>rest</h1>', 'em', 2, 1],
    // Located clones: the bound is exact here.
    ['<p><b>x</p><p>y</b></p>', 'b', 2, 2],
    ['<p><b>x</p><p>y</p><p>z</b></p>', 'b', 3, 3],
  ])('pins DOM nodes vs the bound for %s', (html, tagName, domNodes, bound) => {
    const map = build(html, 's_deck')
    const span = [...map.byId.values()].find((candidate) => candidate.tagName === tagName)!
    const counts = domNodesById(instrument(map))

    expect(counts.get(span.slId)).toBe(domNodes)
    expect(span.minDomNodeCount).toBe(bound)
    expect(span.minDomNodeCount).toBeLessThanOrEqual(domNodes)
  })

  it('gives a cloned formatting element the same id as its source original', () => {
    const map = build('<p><b>x</p><p>y</b></p>', 's_deck')
    const instrumented = instrument(map)

    // One insertion, into the one physical start tag; the parser copies it onto the clone.
    expect(instrumented).toBe(
      '<p data-sl-id="s_deck:0"><b data-sl-id="s_deck:1">x</p><p data-sl-id="s_deck:2">y</b></p>',
    )

    const bolds = parsedElements(instrumented).filter((element) => element.tagName === 'b')
    expect(bolds).toHaveLength(2)
    expect(bolds.map(slIdOf)).toEqual(['s_deck:1', 's_deck:1'])
    expect(map.byId.get('s_deck:1')!.minDomNodeCount).toBe(2)
  })

  /**
   * Insertion points are not in id order when foster parenting moves an element, so the assembly
   * has to order by offset rather than by `map.order`. A pass that trusted id order would splice
   * at stale offsets and corrupt the document.
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

  /**
   * The fixpoint used to be false for mis-nested formatting: each generation added one more
   * `data-sl-id` to the cloned element's start tag, measured growing 111 -> 221 characters over
   * five round-trips. Length is asserted directly because that is the shape the growth took.
   */
  it.each([
    '<p><b>x</p><p>y</b></p>',
    '<p><b>bold<i>both</p><p>italic</i></p>',
    '<div class="slide"><p><strong>Q3 <em>revenue</em></p><p>rose</strong></em></p></div>',
    '<p><b><i><u>x</p><p>y</u></i></b></p>',
  ])('does not grow a mis-nested document over repeated round-trips (%s)', (html) => {
    let current = instrument(build(html))
    const first = current
    for (let generation = 0; generation < 5; generation += 1) {
      current = instrument(build(current))
      expect(current).toBe(first)
    }
    expect(current.length).toBe(first.length)
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
    expect(slIdOf(firstOfTag(instrumented, 'div'))).toBe('s_deck:0')
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
    expect(slIdOf(firstOfTag(instrumented, 'div'))).toBe('s_deck:0')
  })

  it('handles a valueless data-sl-id', () => {
    const instrumented = instrument(build('<div data-sl-id>x</div>', 's_deck'))
    expect(instrumented).toBe('<div data-sl-id="s_deck:0" data-sl-id>x</div>')
    expect(slIdOf(firstOfTag(instrumented, 'div'))).toBe('s_deck:0')
  })
})

/** A slide with `rows` table rows, ~5 elements each — the shape the reviewer measured against. */
function generateLargeSlide(rows: number): string {
  const parts = ['<!doctype html><html><body><div class="slide"><table>']
  for (let row = 0; row < rows; row += 1) {
    parts.push(
      `<tr class="r${String(row)}"><td class="a"><span>cell ${String(row)}</span></td>` +
        `<td class="b"><span>value ${String(row)}</span></td></tr>`,
    )
  }
  parts.push('</table></div></body></html>')
  return parts.join('')
}

/** Samples per measurement in the scaling test; see its docblock for why best-of-N is used. */
const BEST_OF = 5

describe('instrument — performance', () => {
  /**
   * Rebuilding the whole document once per insertion is O(elements x length). Measured on this
   * generator before the chunked rewrite: 5k elements / 86KB = 461ms, 20k / 349KB = 10.2s,
   * 30k / 525KB = 20.4s. The bound below is deliberately generous so it does not flake on shared
   * CI hardware while still being ~40x tighter than the old behaviour at this size.
   */
  it('instruments a 500KB, 30k-element slide in single-digit-to-tens of milliseconds', () => {
    const html = generateLargeSlide(6000)
    expect(html.length).toBeGreaterThan(500_000)

    const map = buildSlideMap(SLIDE_ID, html)
    expect(map.order.length).toBeGreaterThan(30_000)

    const started = performance.now()
    const instrumented = instrument(map)
    const elapsed = performance.now() - started

    expect(elapsed).toBeLessThan(500)
    // Still correct, not just fast.
    expect(stripInjections(instrumented, SLIDE_ID)).toBe(html)
  })

  /**
   * Entering Design Mode costs the **pair**, so that is what the M8 stress goal (a 500KB slide
   * well under 100ms) is really about. Timing only `instrument` would report ~12ms and imply the
   * budget is met; it is not. The parse and walk in `buildSlideMap` dominate, and the honest
   * position is that M3.1 removed a 1700x outlier and left a ~1.5-2.5x gap for M8.5's parse
   * caching to close.
   *
   * The assertions are a loose regression fence, not the budget. Last measured on this machine:
   * 618KB / 30,004 elements -> buildSlideMap 199.4ms, instrument 14.4ms, pair 213.8ms.
   */
  it('keeps instrument the small half of the entry cost for a 500KB slide', () => {
    const html = generateLargeSlide(6000)

    const startedBuild = performance.now()
    const map = buildSlideMap(SLIDE_ID, html)
    const buildMs = performance.now() - startedBuild

    const startedInstrument = performance.now()
    instrument(map)
    const instrumentMs = performance.now() - startedInstrument

    // instrument must stay the small half of the pair — that is the property the rewrite bought.
    expect(instrumentMs).toBeLessThan(buildMs)
    expect(buildMs + instrumentMs).toBeLessThan(2000)
  })

  /**
   * A single wall-clock sample of a ~5ms operation cannot tell linear from quadratic on a loaded
   * machine. Measured here over 8 repetitions while other work ran: the 1000-row sample alone
   * ranged 1.83ms - 85.91ms, a 47x spread, and the resulting ratio reached 35.7 and 31.45 against
   * this 30 ceiling in two separate CI-style runs. The noise had grown into the band the assertion
   * exists to detect, so the test was failing for reasons unrelated to complexity.
   *
   * Best-of-N fixes it because scheduler noise, GC and CPU contention can only ever *add* time:
   * the minimum of several samples is the least-contaminated estimate of the true cost, and taking
   * it on both sides removes the fast-denominator/slow-numerator pairing that produced the spikes.
   * Re-measured with best-of-5: max ratio 10.58 across 8 repetitions (median 8.83), against a
   * quadratic that runs ~44x in practice. The 30 ceiling now sits well clear of both.
   */
  it('scales roughly linearly rather than quadratically', () => {
    const time = (rows: number): number => {
      const map = buildSlideMap(SLIDE_ID, generateLargeSlide(rows))
      const started = performance.now()
      instrument(map)
      return performance.now() - started
    }
    const best = (rows: number): number => {
      let fastest = Infinity
      for (let attempt = 0; attempt < BEST_OF; attempt += 1) fastest = Math.min(fastest, time(rows))
      return fastest
    }

    // Warm up so the first measurement does not pay JIT costs the second avoids.
    time(500)
    const small = Math.max(best(1000), 0.5)
    const large = best(8000)

    // 8x the input. Linear would be ~8x; the quadratic version was ~64x (and 44x in practice).
    expect(large / small).toBeLessThan(30)
  })
})

describe('instrument — refuses to inject two ids into one start tag', () => {
  /**
   * `buildSlideMap` mints at most one id per start-tag offset, so this guard is unreachable
   * through the public path — which is why it needs a hand-built map to pin it. Without a test,
   * mutating the `throw` to a no-op leaves the whole suite green, and a later refactor could drop
   * the one thing standing between an aliasing regression and a silently duplicated attribute
   * (the tokenizer keeps the first and drops the rest, so the second element becomes invisible to
   * the bridge rather than raising anything).
   */
  it('throws when two spans share an attrInsert', () => {
    const source = '<div><p>x</p></div>'
    const map = build(source, 's_deck')
    const [first, second] = [...map.byId.values()]

    // Force the aliasing shape the map is built to prevent.
    const aliased: SlideMap = {
      ...map,
      byId: new Map([
        [first!.slId, first!],
        [second!.slId, { ...second!, attrInsert: first!.attrInsert }],
      ]),
    }

    expect(() => instrument(aliased)).toThrow(/Two data-sl-id insertions at offset 4/)
  })

  it('does not throw for the same map with distinct insert points', () => {
    expect(() => instrument(build('<div><p>x</p></div>', 's_deck'))).not.toThrow()
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
