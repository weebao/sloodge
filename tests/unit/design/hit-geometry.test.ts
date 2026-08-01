/**
 * The shared hit-geometry helpers (M3.7): `boxOf` prefers the unrotated box, `shiftHit` translates
 * both rects and preserves every other field. Extracted from the overlay and arrange actions so
 * there is one definition.
 */

import { describe, expect, it } from 'vitest'
import type { SlHit } from '../../../src/shared/design/bridge-protocol'
import { boxOf, shiftHit } from '../../../src/shared/design/hit-geometry'

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
