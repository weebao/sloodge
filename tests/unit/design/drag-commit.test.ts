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

/**
 * The transform lock, enforced where the bytes are made (M3.6 round 3). Every caller that produces
 * a move through `buildDragPatch` — single drag, group drag, align/distribute, a gesture whose
 * element turned opaque mid-drag — inherits it.
 */
describe('buildDragPatch — the transform lock', () => {
  const IN_FLOW_OPAQUE =
    '<div style="width:200px;height:100px;transform: rotate(90deg) translate(10px, 0)">x</div>'
  const POSITIONED_OPAQUE =
    '<div style="position:absolute;left:100px;top:50px;width:200px;height:80px;transform: translateZ(0)">x</div>'
  const BOX: SlRect = { x: 0, y: 0, width: 200, height: 100 }

  it('refuses a move that would be written through an opaque transform (unchanged by identity)', () => {
    const slId = slIdOf('s', IN_FLOW_OPAQUE, 'div')
    // Mutation guard: without the refusal this writes `rotate(90deg) translate(50px, 0)` — 40px
    // down the element's tilt for a 40px drag right.
    expect(buildDragPatch('s', IN_FLOW_OPAQUE, slId, BOX, { ...BOX, x: 40 })).toBe(IN_FLOW_OPAQUE)
  })

  it('refuses a purely VERTICAL move through an opaque transform too (round-4 minor 1)', () => {
    // Both axes, one refusal. Mutation guard: a guard reading `delta.dx !== 0` alone survives every
    // other fixture in this file — they all drag horizontally — and writes
    // `rotate(90deg) translate(10px, 40px)` here, moving the element 40px LEFT for a 40px drag DOWN.
    const slId = slIdOf('s', IN_FLOW_OPAQUE, 'div')
    expect(buildDragPatch('s', IN_FLOW_OPAQUE, slId, BOX, { ...BOX, y: 40 })).toBe(IN_FLOW_OPAQUE)
  })

  it('still moves a left/top-positioned element under an opaque transform, transform byte-identical', () => {
    const slId = slIdOf('s', POSITIONED_OPAQUE, 'div')
    const patched = buildDragPatch('s', POSITIONED_OPAQUE, slId, START, { ...START, x: 140, y: 70 })
    expect(patched).toContain('left: 140px')
    expect(patched).toContain('top: 70px')
    expect(patched).toContain('transform: translateZ(0)')
  })

  it('the size half still applies to an opaque element — width never touches the transform', () => {
    const slId = slIdOf('s', IN_FLOW_OPAQUE, 'div')
    const patched = buildDragPatch('s', IN_FLOW_OPAQUE, slId, BOX, { ...BOX, x: 10, width: 190 })
    expect(patched).toContain('width: 190px')
    expect(patched).toContain('transform: rotate(90deg) translate(10px, 0)')
    expect(patched).not.toContain('translate(20px')
  })

  it('an untransformed SVG element moves by its x/y attributes', () => {
    const html = '<svg><rect x="5" y="5" width="20" height="20"/></svg>'
    const map = buildSlideMap('s', html)
    const slId = [...map.byId.values()].find((span) => span.tagName === 'rect')!.slId
    const rect: SlRect = { x: 5, y: 5, width: 20, height: 20 }
    expect(buildDragPatch('s', html, slId, rect, { ...rect, x: 45 })).toContain(
      '<rect x="45" y="5"',
    )
  })

  it('a ROTATED SVG element moves by a parent-space translate, so it follows the pointer', () => {
    // Round-5 major: `x` is geometry inside the rect's own user space, so a +40 screen drag written
    // to `x` travels along the rect's 30° axis (~34.6 right, ~20 down). Mutation guard: an
    // unconditional `attr` arm writes `x="45"` here and the rect leaves the pointer behind.
    const html =
      '<svg><rect x="5" y="5" width="20" height="20" style="transform: rotate(30deg)"/></svg>'
    const map = buildSlideMap('s', html)
    const slId = [...map.byId.values()].find((span) => span.tagName === 'rect')!.slId
    const rect: SlRect = { x: 5, y: 5, width: 20, height: 20 }
    const patched = buildDragPatch('s', html, slId, rect, { ...rect, x: 45 })
    expect(patched).toContain('transform: translate(40px, 0) rotate(30deg)')
    expect(patched).toContain('<rect x="5" y="5"')
  })

  it('a drag on an SVG shape with no x/y geometry moves it, and writes no junk attribute (round-6 major)', () => {
    // A `<circle>` positions by `cx`/`cy`, a `<path>` by `d`, a `<g>` by its own transform — so a
    // drag written to `x`/`y` adds an attribute the renderer ignores: the shape stays put while the
    // gesture spends an undo entry and the overlay advances its stored box, and the picture and the
    // document disagree. The parent-space translate moves all three. Mutation guard: dropping the
    // `SVG_XY_TAGS` conjunct writes `<circle x="40" …>` here and the circle never leaves the origin.
    for (const [tag, html] of [
      ['circle', '<svg><circle cx="10" cy="10" r="10"/></svg>'],
      ['path', '<svg><path d="M0 0 L20 20"/></svg>'],
      ['g', '<svg><g><rect x="0" y="0" width="20" height="20"/></g></svg>'],
    ] as const) {
      const slId = slIdOf('s', html, tag)
      const rect: SlRect = { x: 0, y: 0, width: 20, height: 20 }
      const patched = buildDragPatch('s', html, slId, rect, { ...rect, x: 40, y: 25 })
      expect(patched).toContain('transform: translate(40px, 25px)')
      expect(patched).not.toContain('x="40"')
      expect(patched).not.toContain('y="25"')
    }
  })

  it('a drag on the OUTERMOST <svg> writes a translate, not the x/y attributes it ignores (round-7 major)', () => {
    // The ordinary click-and-drag of a whole inline icon: `<svg>` is addressable, is not in
    // `NEVER_SELECTABLE`, has a real box, so a plain click resolves to it. `x`/`y` are inert on an
    // outermost `<svg>` — it is a replaced element in the CSS box model — so routing it to the
    // attribute channel froze it while the gesture still spent an undo entry. Mutation guard:
    // adding `'svg',` to `SVG_XY_TAGS` emits `<svg y="25" x="40" style="position: absolute; …">`.
    const html =
      '<svg style="position: absolute; left: 100px; top: 60px" width="300" height="200"><rect x="1"/></svg>'
    const slId = slIdOf('s', html, 'svg')
    const rect: SlRect = { x: 100, y: 60, width: 300, height: 200 }
    const patched = buildDragPatch('s', html, slId, rect, { ...rect, x: 140, y: 85 })
    expect(patched).toContain('transform: translate(40px, 25px)')
    expect(patched).not.toContain('x="40"')
    expect(patched).not.toContain('y="25"')
  })

  it('a drag on a <tspan> writes its x/y attributes — a transform on one is inert (round-7 major)', () => {
    // Reachable through the shipped alt-click path (`SelectionOverlay` passes `event.altKey` into
    // `requestHit`; `grabbable.ts`'s header documents alt as the way to reach a `<tspan>`).
    // Chromium parses a `transform` on a `<tspan>` and declines to apply it, so the translate arm
    // freezes the fragment. Mutation guard: deleting `'tspan',` from `SVG_XY_TAGS` emits
    // `<tspan style="transform: translate(40px, 0)" x="10" y="20">` and the text never moves.
    const html = '<svg><text x="5" y="20"><tspan x="10" y="20">frag</tspan></text></svg>'
    const slId = slIdOf('s', html, 'tspan')
    const rect: SlRect = { x: 10, y: 6, width: 34, height: 19 }
    const patched = buildDragPatch('s', html, slId, rect, { ...rect, x: 50 })
    expect(patched).toContain('<tspan x="50" y="20">')
    expect(patched).not.toContain('transform')
  })

  it('an SVG element under an OPAQUE transform is refused like any other', () => {
    // A matrix we never decomposed could be a doubling one, under which `x` +40 lands 80px out.
    const html =
      '<svg><rect x="5" y="5" width="20" height="20" style="transform: matrix(2, 0, 0, 2, 0, 0)"/></svg>'
    const map = buildSlideMap('s', html)
    const slId = [...map.byId.values()].find((span) => span.tagName === 'rect')!.slId
    const rect: SlRect = { x: 5, y: 5, width: 20, height: 20 }
    expect(buildDragPatch('s', html, slId, rect, { ...rect, x: 45 })).toBe(html)
  })

  it('a left-only element is positioned by offsets: +40 lands at left: 140px (round-3 minor 2)', () => {
    // Mutation guard: a reader deciding the channel by `top` alone reads x as null and writes
    // `left: 40px` — a 60px jump backwards.
    const html = '<div style="position:absolute;left:100px;width:10px;height:10px">x</div>'
    const slId = slIdOf('s', html, 'div')
    const rect: SlRect = { x: 100, y: 0, width: 10, height: 10 }
    const patched = buildDragPatch('s', html, slId, rect, { ...rect, x: 140 })
    expect(patched).toContain('left: 140px')
    expect(patched).not.toContain('translate')
  })
})
