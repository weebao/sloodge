/**
 * The element context bundle builder (§6.2, M3.4) — pure, so exercised here with no React, no iframe,
 * no bridge. The load-bearing property is §2.2 re-derivation: the bundle's authoritative field, the
 * element's source HTML, is sliced from the parent-owned `SlideMap`, never taken from a frame hint —
 * which is what makes a forged bridge message unable to inject bytes into the model's context. That is
 * mutation-verified below (a forged computed-styles hint cannot change the HTML; a different map does).
 */

import { describe, expect, it } from 'vitest'
import { buildSlideMap } from '../../../src/shared/design/slide-map'
import {
  buildElementContextBundle,
  composeAgentMessage,
  COMPUTED_STYLE_WHITELIST,
  elementContextLabel,
  MAX_COMPUTED_STYLE_PROPS,
  MAX_STYLE_VALUE_LEN,
  selectComputedStyleSubset,
  type ElementContextBundle,
} from '../../../src/shared/design/element-context'
import type { SlideMap } from '../../../src/shared/design/types'

const HTML =
  '<section class="slide">' +
  '<div class="card">' +
  '<h3 class="card-title" id="t1">Q3 Revenue</h3>' +
  '</div>' +
  '</section>'

const H3_OUTER = '<h3 class="card-title" id="t1">Q3 Revenue</h3>'

/** The sl-id of the first element with the given tag, located from the map (not hardcoded indices). */
function slIdOf(map: SlideMap, tag: string): string {
  for (const [slId, span] of map.byId) {
    if (span.tagName === tag) return slId
  }
  throw new Error(`no <${tag}> in map`)
}

function build(
  map: SlideMap,
  slId: string,
  extra: Partial<Parameters<typeof buildElementContextBundle>[0]> = {},
): ElementContextBundle | null {
  return buildElementContextBundle({
    map,
    slId,
    slide: { index: 3, title: 'Q3 Revenue' },
    ...extra,
  })
}

describe('buildElementContextBundle — §2.2 re-derivation from the parent map', () => {
  const map = buildSlideMap('s04', HTML)
  const h3 = slIdOf(map, 'h3')

  it('slices outerHtml from the map source, byte-for-byte (formatting preserved)', () => {
    const bundle = build(map, h3)
    expect(bundle?.element.outerHtml).toBe(H3_OUTER)
    // And it really is the map's own bytes, not a re-serialization.
    const span = map.byId.get(h3)!.outer
    expect(bundle?.element.outerHtml).toBe(map.source.slice(span.start, span.end))
  })

  it('MUTATION-VERIFY: a forged frame hint cannot change the authoritative HTML', () => {
    // Simulate a co-resident hostile slide feeding a bogus computed-styles payload that tries to
    // smuggle HTML and colours in. The builder has no HTML input at all, and the whitelist drops the
    // smuggled key — so outerHtml stays the map slice and only the whitelisted 'color' survives.
    const forged = { outerHTML: '<script>evil()</script>', color: 'red', bogus: 'x' }
    const bundle = build(map, h3, { computedStyles: forged })
    expect(bundle?.element.outerHtml).toBe(H3_OUTER)
    expect(bundle?.element.computedStyles).toEqual({ color: 'red' })
    expect(Object.keys(bundle?.element.computedStyles ?? {})).not.toContain('outerHTML')
  })

  it('MUTATION-VERIFY: the HTML follows the parent map, proving it is derived from it', () => {
    // A different map (edited source bytes) must yield different outerHtml for the same logical
    // element — impossible if the builder trusted an external HTML source instead of the map.
    const edited = HTML.replace('Q3 Revenue', 'Q4 Revenue')
    const map2 = buildSlideMap('s04', edited)
    const bundle = build(map2, slIdOf(map2, 'h3'))
    expect(bundle?.element.outerHtml).toBe('<h3 class="card-title" id="t1">Q4 Revenue</h3>')
    expect(bundle?.element.outerHtml).not.toBe(H3_OUTER)
  })

  it('returns null for a stale/missing slId (no bundle)', () => {
    expect(build(map, 's04:9999')).toBeNull()
    expect(build(map, 'nonsense')).toBeNull()
  })

  it('derives tag/id/classes/ns and the root-first ancestor path from the map', () => {
    const bundle = build(map, h3)
    expect(bundle?.element.tag).toBe('h3')
    expect(bundle?.element.id).toBe('t1')
    expect(bundle?.element.classes).toEqual(['card-title'])
    expect(bundle?.element.ns).toBe('html')
    expect(bundle?.element.ancestorPath).toBe('section.slide > div.card > h3#t1')
  })

  it('carries slide identity and the map source fingerprint', () => {
    const bundle = build(map, h3)
    expect(bundle?.slide).toEqual({
      id: 's04',
      index: 3,
      title: 'Q3 Revenue',
      sourceHash: map.sourceHash,
    })
    expect(bundle?.kind).toBe('sloodge.element-selection')
  })

  it('attaches the rect as a hint and defers the screenshot crop (rect + pad, pixels null)', () => {
    const rect = { x: 10, y: 20, width: 320, height: 84 }
    const bundle = build(map, h3, { rect, cropPad: 24 })
    expect(bundle?.element.rect).toEqual(rect)
    expect(bundle?.element.crop).toEqual({ rect, pad: 24, dataUri: null })
  })

  it('omits the crop when no rect hint is available', () => {
    const bundle = build(map, h3)
    expect(bundle?.element.rect).toBeNull()
    expect(bundle?.element.crop).toBeNull()
  })
})

describe('selectComputedStyleSubset — whitelist + size cap', () => {
  it('keeps only whitelisted properties, in whitelist order', () => {
    const { styles } = selectComputedStyleSubset({
      color: '#fff',
      'font-size': '44px',
      'not-a-real-prop': 'x',
      cursor: 'pointer', // real CSS, but off the design whitelist
    })
    expect(styles).toEqual({ 'font-size': '44px', color: '#fff' })
  })

  it('drops non-string values without throwing', () => {
    const { styles } = selectComputedStyleSubset({ color: 5, opacity: '1' } as Record<
      string,
      unknown
    >)
    expect(styles).toEqual({ opacity: '1' })
  })

  it('caps an over-long value and flags truncation', () => {
    const huge = 'url(data:image/png;base64,' + 'A'.repeat(1000) + ')'
    const { styles, truncated } = selectComputedStyleSubset({ 'background-image': huge })
    expect(truncated).toBe(true)
    expect(styles['background-image']?.length).toBe(MAX_STYLE_VALUE_LEN + 1) // capped chars + '…'
    expect(styles['background-image']?.endsWith('…')).toBe(true)
  })

  it('marks truncated when non-whitelisted keys were dropped', () => {
    const { truncated } = selectComputedStyleSubset({ color: '#000', cursor: 'pointer' })
    expect(truncated).toBe(true)
  })

  it('is not truncated for an all-whitelisted, short input', () => {
    const { truncated } = selectComputedStyleSubset({ color: '#000', 'font-size': '12px' })
    expect(truncated).toBe(false)
  })

  it('never emits more than the cap even if the whitelist grew (belt over the honest bound)', () => {
    // The whitelist is the honest bound; assert the emitted count is min(whitelist, cap)-safe.
    const raw: Record<string, string> = {}
    for (const prop of COMPUTED_STYLE_WHITELIST) raw[prop] = '1px'
    const { styles } = selectComputedStyleSubset(raw)
    expect(Object.keys(styles).length).toBeLessThanOrEqual(MAX_COMPUTED_STYLE_PROPS)
  })

  it('is safe on empty input', () => {
    expect(selectComputedStyleSubset({})).toEqual({ styles: {}, truncated: false })
  })
})

describe('elementContextLabel', () => {
  const map = buildSlideMap('s04', HTML)
  it('prefers #id, then .class, over the bare tag', () => {
    const withId = build(map, slIdOf(map, 'h3'))!
    expect(elementContextLabel(withId)).toBe('◇ h3#t1')
    const withClass = build(map, slIdOf(map, 'div'))!
    expect(elementContextLabel(withClass)).toBe('◇ div.card')
  })
})

describe('composeAgentMessage — carried as inert, fenced data', () => {
  const map = buildSlideMap('s04', HTML)
  const bundle = build(map, slIdOf(map, 'h3'), {
    rect: { x: 10, y: 20, width: 320, height: 84 },
    computedStyles: { color: '#0f172a', 'font-size': '44px' },
  })!

  it('is the identity when there is no attachment (the no-context turn)', () => {
    expect(composeAgentMessage('make it bigger', null)).toBe('make it bigger')
  })

  it('leads with the user text, then a delimited context block', () => {
    const out = composeAgentMessage('make this pop', bundle)
    expect(out.startsWith('make this pop\n\n')).toBe(true)
    expect(out).toContain('Selected element context (Sloodge Design Mode')
    expect(out).toContain('section.slide > div.card > h3#t1')
    expect(out).toContain('Rendered box: 320×84 px')
    // Computed styles serialize in whitelist order (font-size precedes color in the whitelist).
    expect(out).toContain('Computed styles (subset): font-size: 44px; color: #0f172a')
  })

  it('carries the source HTML verbatim inside a code fence', () => {
    const out = composeAgentMessage('x', bundle)
    expect(out).toContain('```html\n' + H3_OUTER + '\n```')
  })

  it('uses a fence longer than any backtick run in the HTML so content cannot break out', () => {
    // A slide whose text contains a triple backtick must not be able to terminate the fence early.
    const tricky = buildSlideMap('s9', '<p class="c">a ``` b</p>')
    const b = buildElementContextBundle({
      map: tricky,
      slId: slIdOf(tricky, 'p'),
      slide: { index: 0, title: '' },
    })!
    const out = composeAgentMessage('hi', b)
    // The fence around the HTML is at least four backticks (one longer than the ``` inside).
    expect(out).toContain('````html')
    expect(out).toContain('a ``` b')
  })
})
