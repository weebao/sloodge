/**
 * `buildDragPatch` — the gesture → patched-source seam (§5.5 + §1.4). It reuses the M3.3 byte-span
 * layer, so these tests assert the drag-specific behaviour on top of it: delta-based X/Y (correct for
 * both `left/top` and `transform: translate`), absolute W/H, the four-property corner case not
 * colliding in one patch, and the zero-move / missing-id no-ops that keep empty commands off the
 * stack.
 */

import { describe, expect, it } from 'vitest'
import { buildDragPatch } from '../../../src/shared/design/drag-commit'
import { buildSlideMap } from '../../../src/shared/design/slide-map'
import { createStarterSlideHtml } from '../../../src/shared/document/starter-slide'
import type { SlRect } from '../../../src/shared/design/bridge-protocol'
import type { SlideId } from '../../../src/shared/document/types'

const ABS = '<div style="position:absolute;left:100px;top:50px;width:200px;height:80px">a</div>'
const START: SlRect = { x: 100, y: 50, width: 200, height: 80 }

/** The sl-id of the first element whose tag matches, in a freshly parsed slide. */
function slIdOf(slideId: string, html: string, tag: string): string {
  const map = buildSlideMap(slideId, html)
  for (const [id, span] of map.byId) if (span.tagName === tag) return id
  throw new Error(`no <${tag}> in slide`)
}

describe('buildDragPatch — move (delta-based X/Y)', () => {
  it('adds the delta to left/top on an absolutely-positioned block', () => {
    const slId = slIdOf('s', ABS, 'div')
    const next: SlRect = { x: 130, y: 70, width: 200, height: 80 }
    const patched = buildDragPatch('s', ABS, slId, START, next)
    expect(patched).toContain('left: 130px')
    expect(patched).toContain('top: 70px')
    // size unchanged (the style value's interior is re-serialized, so spacing normalizes)
    expect(patched).toContain('width: 200px')
    expect(patched).toContain('height: 80px')
  })

  it('writes transform:translate for an in-flow element, delta-added', () => {
    const id = 'demo' as SlideId
    const html = createStarterSlideHtml({ id, title: 'Hi' })
    const slId = slIdOf(id, html, 'h1')
    const rect: SlRect = { x: 48, y: 48, width: 400, height: 60 }
    const next: SlRect = { x: 78, y: 68, width: 400, height: 60 }
    const patched = buildDragPatch(id, html, slId, rect, next)
    expect(patched).toContain('translate(30px, 20px)')
  })
})

describe('buildDragPatch — resize (absolute W/H)', () => {
  it('se writes the new width and height, position untouched', () => {
    const slId = slIdOf('s', ABS, 'div')
    const next: SlRect = { x: 100, y: 50, width: 260, height: 120 }
    const patched = buildDragPatch('s', ABS, slId, START, next)
    expect(patched).toContain('width: 260px')
    expect(patched).toContain('height: 120px')
    expect(patched).toContain('left: 100px')
    expect(patched).toContain('top: 50px')
  })

  it('nw writes all four properties in one patch without an overlap throw', () => {
    const slId = slIdOf('s', ABS, 'div')
    const next: SlRect = { x: 120, y: 70, width: 180, height: 60 }
    const patched = buildDragPatch('s', ABS, slId, START, next)
    expect(patched).toContain('left: 120px')
    expect(patched).toContain('top: 70px')
    expect(patched).toContain('width: 180px')
    expect(patched).toContain('height: 60px')
  })
})

describe('buildDragPatch — no-ops keep empty commands off the stack', () => {
  it('a zero-distance gesture returns the source unchanged (by identity)', () => {
    const slId = slIdOf('s', ABS, 'div')
    expect(buildDragPatch('s', ABS, slId, START, { ...START })).toBe(ABS)
  })

  it('a sub-pixel gesture rounds to nothing and returns the source unchanged', () => {
    const slId = slIdOf('s', ABS, 'div')
    const next: SlRect = {
      x: START.x + 0.4,
      y: START.y - 0.3,
      width: START.width,
      height: START.height,
    }
    expect(buildDragPatch('s', ABS, slId, START, next)).toBe(ABS)
  })

  it('an unresolved sl-id (stale/forged) returns the source unchanged', () => {
    expect(
      buildDragPatch('s', ABS, 's:999', START, { x: 130, y: 70, width: 200, height: 80 }),
    ).toBe(ABS)
  })

  it('never mutates the input source string', () => {
    const slId = slIdOf('s', ABS, 'div')
    const before = ABS
    buildDragPatch('s', ABS, slId, START, { x: 130, y: 70, width: 200, height: 80 })
    expect(ABS).toBe(before)
  })
})

describe('buildDragPatch — round-trips through the map', () => {
  it('the patched source still parses and resolves the same sl-id', () => {
    const slId = slIdOf('s', ABS, 'div')
    const patched = buildDragPatch('s', ABS, slId, START, { x: 130, y: 70, width: 200, height: 80 })
    const map = buildSlideMap('s', patched)
    expect(map.byId.get(slId)).toBeDefined()
  })
})
