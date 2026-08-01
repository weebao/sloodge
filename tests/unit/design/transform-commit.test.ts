/**
 * `buildRotatePatch` / `buildFlipPatch` — the pure "gesture → new bytes" seam for rotate and flip,
 * reusing the byte-span patch layer. Pure, so tested here without a DOM; the one-command undo
 * integration is covered by the overlay/panel component suites.
 */

import { describe, expect, it } from 'vitest'
import { buildFlipPatch, buildRotatePatch } from '../../../src/shared/design/transform-commit'
import { buildSlideMap } from '../../../src/shared/design/slide-map'
import { readStyleProp } from '../../../src/shared/design/patch'
import { SLIDE_ID } from './corpus'

function transformOf(source: string, slId: string): string | null {
  const map = buildSlideMap(SLIDE_ID, source)
  return readStyleProp(source, map.byId.get(slId)!, 'transform')
}

function firstId(source: string): string {
  return buildSlideMap(SLIDE_ID, source).order[0]!
}

describe('buildRotatePatch', () => {
  it('writes rotate into an element with no style', () => {
    const source = '<div>x</div>'
    const id = firstId(source)
    const next = buildRotatePatch(SLIDE_ID, source, id, 45)
    expect(transformOf(next, id)).toBe('rotate(45deg)')
  })

  it('composes with an existing translate without clobbering it', () => {
    const source = '<div style="transform: translate(10px, 20px)">x</div>'
    const id = firstId(source)
    const next = buildRotatePatch(SLIDE_ID, source, id, 90)
    expect(transformOf(next, id)).toBe('translate(10px, 20px) rotate(90deg)')
    // Mutation guard: clobbering the translate reds here.
    expect(next).toContain('translate(10px, 20px)')
  })

  it('rotating to 0° removes the transform declaration cleanly', () => {
    const source = '<div style="transform: rotate(45deg)">x</div>'
    const id = firstId(source)
    const next = buildRotatePatch(SLIDE_ID, source, id, 0)
    // The whole declaration (and empty style attribute) is gone, not left as `transform:`.
    expect(next).not.toContain('transform')
    expect(next).toBe('<div>x</div>')
  })

  it('preserves other declarations when removing transform', () => {
    const source = '<div style="color: red; transform: rotate(45deg)">x</div>'
    const id = firstId(source)
    const next = buildRotatePatch(SLIDE_ID, source, id, 0)
    expect(next).toContain('color: red')
    expect(next).not.toContain('transform')
  })

  it('no-ops for an unknown slId', () => {
    const source = '<div>x</div>'
    expect(buildRotatePatch(SLIDE_ID, source, `${SLIDE_ID}:999`, 45)).toBe(source)
  })
})

describe('buildFlipPatch', () => {
  it('flip H introduces scale(-1, 1)', () => {
    const source = '<div>x</div>'
    const id = firstId(source)
    expect(transformOf(buildFlipPatch(SLIDE_ID, source, id, 'x'), id)).toBe('scale(-1, 1)')
  })

  it('flip then flip returns the source byte-exact (declaration removed)', () => {
    const source = '<div>x</div>'
    const id = firstId(source)
    const once = buildFlipPatch(SLIDE_ID, source, id, 'x')
    const twice = buildFlipPatch(SLIDE_ID, once, firstId(once), 'x')
    expect(twice).toBe(source)
  })

  it('composes with translate + rotate without clobbering them', () => {
    const source = '<div style="transform: translate(5px, 5px) rotate(30deg)">x</div>'
    const id = firstId(source)
    const next = buildFlipPatch(SLIDE_ID, source, id, 'y')
    expect(transformOf(next, id)).toBe('translate(5px, 5px) rotate(30deg) scale(1, -1)')
  })
})
