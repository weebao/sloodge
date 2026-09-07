/**
 * The multi-element commit layer (M3.7): many moved rects → one patched slide source, chaining
 * `buildDragPatch` per element the way `drag-commit` chains per field. Byte-span correctness comes
 * from `patch.ts`; this asserts the chaining produces one coherent string and no-ops when nothing
 * moved.
 */

import { describe, expect, it } from 'vitest'
import { buildMultiElementPatch, type ElementMove } from '../../../src/shared/design/multi-commit'
import { buildSlideMap } from '../../../src/shared/design/slide-map'
import type { ElementSpan } from '../../../src/shared/design/types'
import type { SlRect } from '../../../src/shared/design/bridge-protocol'

const SLIDE = 's_multi'

const HTML = `<div class="slide">
  <div class="a" style="position:absolute;left:10px;top:20px;width:100px;height:40px">A</div>
  <div class="b" style="position:absolute;left:200px;top:20px;width:80px;height:40px">B</div>
  <div class="c" style="position:absolute;left:400px;top:20px;width:60px;height:40px">C</div>
</div>`

/** Resolve the sl-id of the element whose own start tag begins with `prefix` (not a container). */
function slIdContaining(source: string, prefix: string): string {
  const map = buildSlideMap(SLIDE, source)
  for (const [slId, span] of map.byId as ReadonlyMap<string, ElementSpan>) {
    if (source.slice(span.outer.start, span.outer.end).startsWith(`<${prefix}`)) return slId
  }
  throw new Error(`no element starting with ${prefix}`)
}

const rect = (x: number): SlRect => ({ x, y: 20, width: 80, height: 40 })

describe('buildMultiElementPatch', () => {
  it('applies every element move into one source string', () => {
    const a = slIdContaining(HTML, 'div class="a"')
    const b = slIdContaining(HTML, 'div class="b"')
    const c = slIdContaining(HTML, 'div class="c"')

    // Align all three left edges to x=10 (what alignRects would compute for "left").
    const edits: ElementMove[] = [
      {
        slId: a,
        startRect: { x: 10, y: 20, width: 100, height: 40 },
        nextRect: { x: 10, y: 20, width: 100, height: 40 },
      },
      { slId: b, startRect: rect(200), nextRect: rect(10) },
      {
        slId: c,
        startRect: { x: 400, y: 20, width: 60, height: 40 },
        nextRect: { x: 10, y: 20, width: 60, height: 40 },
      },
    ]
    const out = buildMultiElementPatch(SLIDE, HTML, edits).source

    // A did not move; B and C moved to left:10px. All three now declare left:10px.
    expect(out.match(/left:\s*10px/g)?.length).toBe(3)
    // The elements and their content survive (byte-span patch, not a re-serialization).
    expect(out).toContain('class="a"')
    expect(out).toContain('>B<')
    expect(out).toContain('>C<')
  })

  it('returns the source UNCHANGED when no element moved (no empty command)', () => {
    const a = slIdContaining(HTML, 'div class="a"')
    const edits: ElementMove[] = [
      {
        slId: a,
        startRect: { x: 10, y: 20, width: 100, height: 40 },
        nextRect: { x: 10, y: 20, width: 100, height: 40 },
      },
    ]
    expect(buildMultiElementPatch(SLIDE, HTML, edits).source).toBe(HTML)
  })

  it('is a no-op for an empty edit list', () => {
    expect(buildMultiElementPatch(SLIDE, HTML, []).source).toBe(HTML)
  })

  it('skips an unresolved sl-id without corrupting the others', () => {
    const b = slIdContaining(HTML, 'div class="b"')
    const edits: ElementMove[] = [
      { slId: 'nope:999', startRect: rect(0), nextRect: rect(999) },
      { slId: b, startRect: rect(200), nextRect: rect(10) },
    ]
    const out = buildMultiElementPatch(SLIDE, HTML, edits).source
    expect(out).toContain('class="b"')
    expect(out.match(/left:\s*10px/g)?.length).toBe(2) // A already at 10, B moved to 10
  })
})

describe('buildMultiElementPatch — a member the transform lock refuses keeps its bytes', () => {
  it('moves the positioned member, leaves the in-flow opaque one, and reports only the mover', () => {
    const html =
      '<div style="position:absolute;left:0;top:0;width:10px;height:10px">ok</div>' +
      '<div style="transform: rotate(90deg) translate(10px, 0)">locked</div>'
    const map = buildSlideMap(SLIDE, html)
    const [ok, locked] = map.order as [string, string]
    const edits: ElementMove[] = [
      {
        slId: ok,
        startRect: { x: 0, y: 0, width: 10, height: 10 },
        nextRect: { x: 40, y: 0, width: 10, height: 10 },
      },
      {
        slId: locked,
        startRect: { x: 0, y: 20, width: 100, height: 20 },
        nextRect: { x: 40, y: 20, width: 100, height: 20 },
      },
    ]
    const out = buildMultiElementPatch(SLIDE, html, edits)
    // Round-3 major 1/2: the exact translate used to be rewritten in place, after the rotate, so a
    // 40px drag right moved this member 40px down its tilt. Mutation guard: dropping the refusal in
    // `buildDragPatch` writes `translate(50px, 0)` here.
    expect(out.source).toContain('left: 40px')
    expect(out.source).toContain('transform: rotate(90deg) translate(10px, 0)')
    expect([...out.moved]).toEqual([ok])
  })
})
