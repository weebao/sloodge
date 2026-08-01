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

describe('buildDuplicatePatch — hostile corpus', () => {
  for (const entry of CORPUS) {
    it(`duplicates the first element and keeps ids unique + prior source intact: ${entry.name}`, () => {
      const map = buildSlideMap(SLIDE_ID, entry.html)
      const firstId = map.order[0]
      if (firstId === undefined) return // some fragments map nothing addressable
      const element = map.byId.get(firstId)!
      const before = entry.html.slice(0, element.outer.end)

      const result = buildDuplicatePatch(SLIDE_ID, entry.html, firstId, OFFSET)
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
