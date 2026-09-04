/**
 * The shared hit-geometry helpers (M3.7): `boxOf` prefers the unrotated box, `shiftHit` translates
 * both rects and preserves every other field. Extracted from the overlay and arrange actions so
 * there is one definition.
 */

import { describe, expect, it } from 'vitest'
import type { SlHit } from '../../../src/shared/design/bridge-protocol'
import {
  boxOf,
  rectContainsPoint,
  rotatedRectContainsPoint,
  shiftHit,
} from '../../../src/shared/design/hit-geometry'

const base: SlHit = {
  slId: 's:1',
  tag: 'div',
  id: null,
  classes: ['a'],
  rect: { x: 10, y: 20, width: 100, height: 40 },
  ancestors: [],
}

describe('boxOf', () => {
  it('prefers the unrotated box when present', () => {
    const hit: SlHit = { ...base, box: { x: 5, y: 5, width: 90, height: 30 } }
    expect(boxOf(hit)).toEqual({ x: 5, y: 5, width: 90, height: 30 })
  })

  it('falls back to the rendered rect when no box was measured', () => {
    expect(boxOf(base)).toEqual(base.rect)
  })
})

describe('shiftHit', () => {
  it('translates the rect and preserves other fields', () => {
    const out = shiftHit(base, 7, -3)
    expect(out.rect).toEqual({ x: 17, y: 17, width: 100, height: 40 })
    expect(out.slId).toBe('s:1')
    expect(out.classes).toEqual(['a'])
    expect(out.box).toBeUndefined()
  })

  it('translates the box too when present', () => {
    const hit: SlHit = { ...base, box: { x: 5, y: 5, width: 90, height: 30 } }
    const out = shiftHit(hit, 10, 10)
    expect(out.box).toEqual({ x: 15, y: 15, width: 90, height: 30 })
    expect(out.rect).toEqual({ x: 20, y: 30, width: 100, height: 40 })
  })

  it('does not mutate its input', () => {
    const snapshot = JSON.parse(JSON.stringify(base)) as SlHit
    shiftHit(base, 5, 5)
    expect(base).toEqual(snapshot)
  })
})

describe('rectContainsPoint', () => {
  const rect = { x: 10, y: 20, width: 100, height: 50 }

  it.each([
    ['the centre', { x: 60, y: 45 }, true],
    ['the top-left corner', { x: 10, y: 20 }, true],
    ['the bottom-right corner', { x: 110, y: 70 }, true],
    ['just left', { x: 9.9, y: 45 }, false],
    ['just right', { x: 110.1, y: 45 }, false],
    ['just above', { x: 60, y: 19.9 }, false],
    ['just below', { x: 60, y: 70.1 }, false],
  ])('%s', (_label, point, expected) => {
    expect(rectContainsPoint(rect, point)).toBe(expected)
  })

  it('a zero-area rect contains only its own corner', () => {
    const point = { x: 5, y: 5 }
    expect(rectContainsPoint({ x: 5, y: 5, width: 0, height: 0 }, point)).toBe(true)
    expect(rectContainsPoint({ x: 5, y: 5, width: 0, height: 0 }, { x: 5.1, y: 5 })).toBe(false)
  })
})

describe('rotatedRectContainsPoint', () => {
  // 200×60 centred on (900, 330) — the shape the round-5 group-gap repro used.
  const rect = { x: 800, y: 300, width: 200, height: 60 }

  it('is exactly rectContainsPoint at zero degrees', () => {
    for (const point of [
      { x: 900, y: 330 },
      { x: 800, y: 300 },
      { x: 799, y: 330 },
      { x: 810, y: 310 },
    ]) {
      expect(rotatedRectContainsPoint(rect, 0, point)).toBe(rectContainsPoint(rect, point))
    }
  })

  it('follows the element round: a visible corner outside the layout box is inside the hull', () => {
    // The unrotated (810, 350) lands here once CSS turns the element 45° clockwise.
    const point = { x: 822, y: 281 }
    expect(rectContainsPoint(rect, point)).toBe(false)
    expect(rotatedRectContainsPoint(rect, 45, point)).toBe(true)
  })

  it('and empty space inside the layout box is outside the hull', () => {
    const point = { x: 810, y: 310 }
    expect(rectContainsPoint(rect, point)).toBe(true)
    expect(rotatedRectContainsPoint(rect, 45, point)).toBe(false)
  })

  it('the centre is inside at every angle, being the pivot', () => {
    for (const angle of [0, 30, 45, 90, 180, 270, -45, 725]) {
      expect(rotatedRectContainsPoint(rect, angle, { x: 900, y: 330 })).toBe(true)
    }
  })

  it('turns clockwise on screen, as CSS does in y-down coordinates', () => {
    // Where the unrotated (990, 350) — inside, near the far end — ends up under `rotate(45deg)`.
    // The whole test is the sign: un-rotating the wrong way sends it to (880, 420), outside.
    const point = { x: 949.5, y: 407.8 }
    expect(rectContainsPoint(rect, point)).toBe(false)
    expect(rotatedRectContainsPoint(rect, 45, point)).toBe(true)
  })

  it('a quarter turn swaps the extents', () => {
    expect(rotatedRectContainsPoint(rect, 90, { x: 900, y: 420 })).toBe(true)
    expect(rotatedRectContainsPoint(rect, 90, { x: 990, y: 330 })).toBe(false)
  })

  it('a full turn is the same region as none', () => {
    for (const point of [
      { x: 810, y: 310 },
      { x: 822, y: 281 },
      { x: 1200, y: 330 },
    ]) {
      expect(rotatedRectContainsPoint(rect, 360, point)).toBe(rectContainsPoint(rect, point))
    }
  })
})
