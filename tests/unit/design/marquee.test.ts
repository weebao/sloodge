/**
 * Marquee (rubber-band) intersection maths (M3.7) — pure rectangle overlap plus ancestor suppression
 * so a sweep grabs the deepest shapes, not their containers. Asserted with no DOM.
 */

import { describe, expect, it } from 'vitest'
import type { SlRect } from '../../../src/shared/design/bridge-protocol'
import {
  elementsInMarquee,
  rectsIntersect,
  type MarqueeCandidate,
} from '../../../src/shared/design/marquee'

const r = (x: number, y: number, width: number, height: number): SlRect => ({ x, y, width, height })

const cand = (slId: string, rect: SlRect, ancestorSlIds: string[] = []): MarqueeCandidate => ({
  slId,
  rect,
  ancestorSlIds,
})

describe('rectsIntersect', () => {
  it('is true for overlapping rects', () => {
    expect(rectsIntersect(r(0, 0, 10, 10), r(5, 5, 10, 10))).toBe(true)
  })

  it('is false for disjoint rects', () => {
    expect(rectsIntersect(r(0, 0, 10, 10), r(20, 0, 10, 10))).toBe(false)
  })

  it('does not count edge-touching as intersection (strict)', () => {
    // b starts exactly where a ends.
    expect(rectsIntersect(r(0, 0, 10, 10), r(10, 0, 10, 10))).toBe(false)
  })

  it('a zero-size rect on a border does not intersect (strict), so a click on an edge misses', () => {
    // A click is turned into a marquee only past the gesture threshold; this predicate itself is a
    // plain strict-AABB test, so an edge-aligned zero rect reads as "no overlap".
    expect(rectsIntersect(r(0, 5, 0, 0), r(0, 0, 10, 10))).toBe(false)
    expect(rectsIntersect(r(10, 5, 0, 0), r(0, 0, 10, 10))).toBe(false)
  })

  it('is true when one rect fully contains the other', () => {
    expect(rectsIntersect(r(0, 0, 100, 100), r(40, 40, 10, 10))).toBe(true)
  })
})

describe('elementsInMarquee', () => {
  it('returns the ids of every intersecting flat candidate, in input order', () => {
    const marquee = r(0, 0, 200, 200)
    const candidates = [
      cand('a', r(10, 10, 20, 20)),
      cand('b', r(300, 10, 20, 20)), // outside
      cand('c', r(150, 150, 20, 20)),
    ]
    expect(elementsInMarquee(marquee, candidates)).toEqual(['a', 'c'])
  })

  it('suppresses a container when a deeper intersecting child is also captured', () => {
    const marquee = r(0, 0, 500, 500)
    const candidates = [
      cand('root', r(0, 0, 400, 400)), // container
      cand('shape1', r(10, 10, 50, 50), ['root']),
      cand('shape2', r(100, 100, 50, 50), ['root']),
    ]
    // The root is dropped because shape1/shape2 name it as an ancestor; the shapes are kept.
    expect(elementsInMarquee(marquee, candidates)).toEqual(['shape1', 'shape2'])
  })

  it('keeps a container when its children are NOT in the marquee', () => {
    const marquee = r(0, 0, 30, 30) // only overlaps the container corner, not the children
    const candidates = [
      cand('root', r(0, 0, 400, 400)),
      cand('shape1', r(100, 100, 50, 50), ['root']),
    ]
    expect(elementsInMarquee(marquee, candidates)).toEqual(['root'])
  })

  it('suppresses across multiple ancestor levels', () => {
    const marquee = r(0, 0, 500, 500)
    const candidates = [
      cand('root', r(0, 0, 400, 400)),
      cand('group', r(5, 5, 300, 300), ['root']),
      cand('leaf', r(10, 10, 20, 20), ['group', 'root']),
    ]
    expect(elementsInMarquee(marquee, candidates)).toEqual(['leaf'])
  })

  it('returns nothing for an empty candidate set or a miss', () => {
    expect(elementsInMarquee(r(0, 0, 10, 10), [])).toEqual([])
    expect(elementsInMarquee(r(900, 900, 10, 10), [cand('a', r(0, 0, 10, 10))])).toEqual([])
  })
})
