/**
 * `buildDuplicatePatch` — clone an element's subtree with fresh author ids, inserted after the
 * original, keeping every other span valid. Run against the shared hostile corpus, because a
 * duplicate is a source transform and the corpus is where offset-based transforms go wrong.
 */

import { describe, expect, it } from 'vitest'
import { buildDuplicatePatch } from '../../../src/shared/design/duplicate'
import { buildSlideMap } from '../../../src/shared/design/slide-map'
import type { SlideMap } from '../../../src/shared/design/types'
import { CORPUS, SLIDE_ID } from './corpus'

const OFFSET = { dx: 16, dy: 16 }

/** The first addressable element's sl-id in a slide source. */
function firstId(source: string): string {
  return buildSlideMap(SLIDE_ID, source).order[0]!
}

/** Every author `id` value in a map, in document order — for collision assertions. */
function authorIds(map: SlideMap): string[] {
  const out: string[] = []
  for (const element of map.byId.values()) {
    const attr = element.attrs['id']
    if (attr !== undefined && attr.value !== null) {
      out.push(map.source.slice(attr.value.start, attr.value.end))
    }
  }
  return out
}

describe('buildDuplicatePatch — basics', () => {
  it('inserts the clone right after the original and reports where it starts', () => {
    const source = '<section><h1>Title</h1></section>'
    const map = buildSlideMap(SLIDE_ID, source)
    const h1 = [...map.byId.values()].find((s) => s.tagName === 'h1')!

    const result = buildDuplicatePatch(SLIDE_ID, source, h1.slId, OFFSET)!
    expect(result).not.toBeNull()
    // Original h1 is untouched; a second h1 now follows it.
    expect(result.source.match(/<h1/g)?.length).toBe(2)
    // The clone starts exactly at the original's outer end.
    expect(result.cloneStart).toBe(h1.outer.end)
    const newMap = buildSlideMap(SLIDE_ID, result.source)
    expect([...newMap.byId.values()].some((s) => s.outer.start === result.cloneStart)).toBe(true)
  })

  it('nudges the clone by the offset (translate), leaving the original in place', () => {
    const source = '<div style="left: 10px">x</div>'
    const map = buildSlideMap(SLIDE_ID, source)
    const div = map.byId.get(map.order[0]!)!

    const result = buildDuplicatePatch(SLIDE_ID, source, div.slId, OFFSET)!
    expect(result.source).toContain('translate(16px, 16px)')
    // Original's declaration is untouched.
    expect(result.source).toContain('<div style="left: 10px">x</div>')
  })

  it('returns null for an unknown slId', () => {
    const source = '<p>x</p>'
    expect(buildDuplicatePatch(SLIDE_ID, source, `${SLIDE_ID}:999`, OFFSET)).toBeNull()
  })
})

describe('buildDuplicatePatch — fresh ids (no collision)', () => {
  it('freshens the clone root AND descendant author ids; originals keep theirs', () => {
    const source = '<div id="box" class="a"><p id="inner">x</p></div>'
    const map = buildSlideMap(SLIDE_ID, source)
    const div = map.byId.get(map.order[0]!)!

    const result = buildDuplicatePatch(SLIDE_ID, source, div.slId, OFFSET)!
    const ids = authorIds(buildSlideMap(SLIDE_ID, result.source))

    // Originals survive; clone gets distinct ids. Mutating uniquify to reuse ids reds here.
    expect(ids).toContain('box')
    expect(ids).toContain('inner')
    expect(ids).toContain('box-2')
    expect(ids).toContain('inner-2')
    // No duplicates anywhere.
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('avoids an id that is already taken elsewhere in the slide', () => {
    // `box-2` already exists, so the clone must skip to `box-3`.
    const source = '<div id="box">x</div><div id="box-2">y</div>'
    const map = buildSlideMap(SLIDE_ID, source)
    const first = map.byId.get(map.order[0]!)!

    const result = buildDuplicatePatch(SLIDE_ID, source, first.slId, OFFSET)!
    const ids = authorIds(buildSlideMap(SLIDE_ID, result.source))
    expect(ids).toContain('box-3')
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('freshens an authored data-sl-id too', () => {
    const source = '<div data-sl-id="e_0f3">x</div>'
    const map = buildSlideMap(SLIDE_ID, source)
    const div = map.byId.get(map.order[0]!)!
    const result = buildDuplicatePatch(SLIDE_ID, source, div.slId, OFFSET)!
    // The clone's authored data-sl-id is a fresh value, not the original's.
    expect(result.source.match(/data-sl-id="e_0f3"/g)?.length).toBe(1)
    expect(result.source).toContain('data-sl-id="e_0f3-2"')
  })
})

describe('buildDuplicatePatch — reference rewriting (refs follow the fresh ids)', () => {
  /** Split the patched source into [before-original-end, clone] at the reported clone start. */
  function parts(source: string, slId = firstId(source)): { original: string; clone: string } {
    const result = buildDuplicatePatch(SLIDE_ID, source, slId, OFFSET)!
    return {
      original: result.source.slice(0, result.cloneStart),
      clone: result.source.slice(result.cloneStart),
    }
  }

  it('rewrites url(#id) in a presentation attribute to the fresh gradient id', () => {
    const source = '<svg><linearGradient id="grad"></linearGradient><rect fill="url(#grad)"/></svg>'
    const { original, clone } = parts(source)
    expect(original).toContain('id="grad"')
    expect(original).toContain('fill="url(#grad)"')
    // Clone's fill points at the FRESH gradient, not back at the original. Skipping the rewrite reds.
    expect(clone).toContain('id="grad-2"')
    expect(clone).toContain('fill="url(#grad-2)"')
    expect(clone).not.toContain('url(#grad)"')
  })

  it('rewrites url(#id) embedded in a style attribute', () => {
    const source =
      '<svg><linearGradient id="g"></linearGradient><rect style="fill: url(#g)"/></svg>'
    const { clone } = parts(source)
    expect(clone).toContain('id="g-2"')
    expect(clone).toContain('url(#g-2)')
  })

  it('rewrites SVG href="#id" (use → its cloned target)', () => {
    const source = '<svg><rect id="r"></rect><use href="#r"></use></svg>'
    const { clone } = parts(source)
    expect(clone).toContain('id="r-2"')
    expect(clone).toContain('href="#r-2"')
  })

  it('rewrites label for="id" → the cloned input', () => {
    const source = '<div><label for="fld">L</label><input id="fld"></div>'
    const { clone } = parts(source)
    // Mutation guard: skipping reference rewrite leaves for="fld" (points at the original) and reds.
    expect(clone).toContain('for="fld-2"')
    expect(clone).toContain('id="fld-2"')
  })

  it('rewrites in-clone ids inside a space-separated aria-labelledby, leaving external tokens', () => {
    const source = '<div><h2 id="t">T</h2><section aria-labelledby="t external">x</section></div>'
    const { clone } = parts(source)
    // `t` is defined in the clone → freshened; `external` is not → untouched.
    expect(clone).toContain('aria-labelledby="t-2 external"')
    expect(clone).toContain('id="t-2"')
  })

  it('leaves a reference that resolves OUTSIDE the clone untouched', () => {
    // Duplicate only the <svg>; `#ext` is defined by the sibling <rect>, outside the clone.
    const source = '<svg id="s1"><use href="#ext"></use></svg><rect id="ext"></rect>'
    const { clone } = parts(source, buildSlideMap(SLIDE_ID, source).order[0]!)
    expect(clone).toContain('id="s1-2"')
    // The external reference still points outside — it must NOT be rewritten.
    expect(clone).toContain('href="#ext"')
    expect(clone).not.toContain('href="#ext-2"')
  })

  it('keeps every id globally unique after a reference-carrying clone', () => {
    const source = '<svg><linearGradient id="grad"></linearGradient><rect fill="url(#grad)"/></svg>'
    const result = buildDuplicatePatch(SLIDE_ID, source, firstId(source), OFFSET)!
    const ids = authorIds(buildSlideMap(SLIDE_ID, result.source))
    expect(new Set(ids).size).toBe(ids.length)
  })
})

describe('buildDuplicatePatch — hostile corpus', () => {
  for (const entry of CORPUS) {
    it(`duplicates the first element and keeps ids unique + prior source intact: ${entry.name}`, () => {
      const map = buildSlideMap(SLIDE_ID, entry.html)
      const firstSlId = map.order[0]
      if (firstSlId === undefined) return // some fragments map nothing addressable
      const element = map.byId.get(firstSlId)!
      const before = entry.html.slice(0, element.outer.end)

      const result = buildDuplicatePatch(SLIDE_ID, entry.html, firstSlId, OFFSET)
      if (result === null) return
      // Everything up to and including the original's subtree is byte-identical (pure insertion).
      expect(result.source.slice(0, element.outer.end)).toBe(before)

      const newMap = buildSlideMap(SLIDE_ID, result.source)
      // Positional slIds are always unique by construction — the map must never mint a collision.
      expect(new Set(newMap.order).size).toBe(newMap.order.length)
      // And no author id is duplicated by the clone.
      const ids = authorIds(newMap)
      expect(new Set(ids).size).toBe(ids.length)
    })
  }
})

describe('buildDuplicatePatch — the nudge follows inspectTransform (loud, not lossy)', () => {
  it('folds the offset into a px translate and keeps the rotation', () => {
    const source = '<div style="transform: translate(10px, 20px) rotate(30deg)">x</div>'
    const result = buildDuplicatePatch(SLIDE_ID, source, firstId(source), OFFSET)!
    expect(result.nudged).toBe(true)
    expect(result.source).toContain('translate(26px, 36px) rotate(30deg)')
  })

  it('prepends a parent-space translate to an opaque transform, leaving the matrix intact', () => {
    const source = '<div style="transform: matrix(1, 0, 0, 1, 5, 5)">x</div>'
    const result = buildDuplicatePatch(SLIDE_ID, source, firstId(source), OFFSET)!
    expect(result.nudged).toBe(true)
    // Leading, so it is applied last — a screen shift whatever the matrix does. Mutation guard:
    // appending it (inside the matrix's frame) or dropping the matrix reds here.
    expect(result.source.slice(result.cloneStart)).toContain(
      'transform: translate(16px, 16px) matrix(1, 0, 0, 1, 5, 5)',
    )
    // The original is byte-identical.
    expect(result.source.slice(0, result.cloneStart)).toBe(source)
  })

  it('leaves a percentage-translated clone in place and says so, rather than writing -34px', () => {
    const source = '<div style="transform: translate(-50%, -50%)">x</div>'
    const result = buildDuplicatePatch(SLIDE_ID, source, firstId(source), OFFSET)!
    expect(result.nudged).toBe(false)
    expect(result.source).toBe(source + source)
    expect(result.source).not.toContain('px')
  })
})
