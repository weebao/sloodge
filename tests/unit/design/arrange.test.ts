/**
 * Align & distribute geometry (M3.7) — pure rectangle maths over the slide's frame space, so every
 * case is asserted with no DOM. The alignment targets are read off the selection's combined bounds
 * (PowerPoint's default); distribution equalises centre spacing. Mutation-guard comments mark the
 * assertions that red if the target maths is broken.
 */

import { describe, expect, it } from 'vitest'
import type { SlRect } from '../../../src/shared/design/bridge-protocol'
import {
  alignRects,
  distributeRects,
  isHorizontalAlign,
  MIN_ALIGN,
  MIN_DISTRIBUTE,
  type AlignEdge,
} from '../../../src/shared/design/arrange'

const r = (x: number, y: number, width: number, height: number): SlRect => ({ x, y, width, height })

describe('alignRects', () => {
  // Three boxes at different x/y with different sizes; combined bounds span x[10..260], y[0..150].
  const rects: SlRect[] = [r(10, 0, 100, 40), r(60, 50, 80, 30), r(200, 100, 60, 50)]

  it('align left moves every left edge to the bounds left, and never touches y', () => {
    const out = alignRects(rects, 'left')
    expect(out.map((rect) => rect.x)).toEqual([10, 10, 10]) // bounds.x === 10
    // Mutation guard: y is preserved exactly.
    expect(out.map((rect) => rect.y)).toEqual([0, 50, 100])
  })

  it('align right moves every right edge to the bounds right', () => {
    const out = alignRects(rects, 'right')
    // bounds right = 260; x = 260 - width.
    expect(out.map((rect) => rect.x)).toEqual([160, 180, 200])
    expect(out.map((rect) => rect.x + rect.width)).toEqual([260, 260, 260])
  })

  it('align center centres every box on the bounds horizontal centre', () => {
    const out = alignRects(rects, 'hcenter')
    const centreX = 10 + 250 / 2 // bounds.x + bounds.width/2 = 135
    for (const rect of out) expect(rect.x + rect.width / 2).toBeCloseTo(centreX)
  })

  it('align top / middle / bottom move y and never touch x', () => {
    const top = alignRects(rects, 'top')
    expect(top.map((rect) => rect.y)).toEqual([0, 0, 0])
    expect(top.map((rect) => rect.x)).toEqual([10, 60, 200]) // x untouched

    const bottom = alignRects(rects, 'bottom')
    expect(bottom.map((rect) => rect.y + rect.height)).toEqual([150, 150, 150])

    const middle = alignRects(rects, 'vcenter')
    const centreY = 0 + 150 / 2 // 75
    for (const rect of middle) expect(rect.y + rect.height / 2).toBeCloseTo(centreY)
  })

  it('is a no-op below MIN_ALIGN elements', () => {
    expect(MIN_ALIGN).toBe(2)
    const one = [r(5, 5, 10, 10)]
    expect(alignRects(one, 'left')).toEqual(one)
    expect(alignRects([], 'left')).toEqual([])
  })

  it('does not mutate its input', () => {
    const input = [r(10, 0, 100, 40), r(60, 50, 80, 30)]
    const snapshot = JSON.parse(JSON.stringify(input)) as SlRect[]
    alignRects(input, 'right')
    expect(input).toEqual(snapshot)
  })
})

describe('isHorizontalAlign', () => {
  it('classifies the three horizontal edges', () => {
    const horizontal: AlignEdge[] = ['left', 'hcenter', 'right']
    const vertical: AlignEdge[] = ['top', 'vcenter', 'bottom']
    expect(horizontal.every(isHorizontalAlign)).toBe(true)
    expect(vertical.some(isHorizontalAlign)).toBe(false)
  })
})

describe('distributeRects', () => {
  it('evenly spaces three centres, pinning the extremes', () => {
    // Centres at x = 10, 100, 210 (unequal spacing) → should become evenly spaced.
    const rects = [r(0, 0, 20, 20), r(90, 0, 20, 20), r(200, 0, 20, 20)]
    const out = distributeRects(rects, 'horizontal')
    const centres = out.map((rect) => rect.x + rect.width / 2)
    expect(centres[0]).toBeCloseTo(10) // extreme pinned
    expect(centres[2]).toBeCloseTo(210) // extreme pinned
    expect(centres[1]).toBeCloseTo(110) // midpoint of 10 and 210
    // Mutation guard: even spacing means equal gaps between adjacent centres.
    expect(centres[1]! - centres[0]!).toBeCloseTo(centres[2]! - centres[1]!)
  })

  it('distributes four centres with equal gaps', () => {
    const rects = [r(0, 0, 10, 10), r(5, 0, 10, 10), r(40, 0, 10, 10), r(300, 0, 10, 10)]
    const out = distributeRects(rects, 'horizontal')
    const centres = out.map((rect) => rect.x + rect.width / 2).toSorted((a, b) => a - b)
    const gaps = [centres[1]! - centres[0]!, centres[2]! - centres[1]!, centres[3]! - centres[2]!]
    expect(gaps[0]).toBeCloseTo(gaps[1]!)
    expect(gaps[1]).toBeCloseTo(gaps[2]!)
  })

  it('distributes five centres vertically and preserves x', () => {
    const rects = [
      r(3, 0, 10, 10),
      r(7, 25, 10, 10),
      r(1, 60, 10, 10),
      r(9, 61, 10, 10),
      r(2, 200, 10, 10),
    ]
    const out = distributeRects(rects, 'vertical')
    expect(out.map((rect) => rect.x)).toEqual([3, 7, 1, 9, 2]) // x untouched on a vertical distribute
    const centres = out.map((rect) => rect.y + rect.height / 2)
    expect(Math.min(...centres)).toBeCloseTo(5) // first centre pinned
    expect(Math.max(...centres)).toBeCloseTo(205) // last centre pinned
  })

  it('returns elements in their ORIGINAL order even when centres are out of order', () => {
    const rects = [r(200, 0, 20, 20), r(0, 0, 20, 20), r(100, 0, 20, 20)]
    const out = distributeRects(rects, 'horizontal')
    // widths unchanged, order unchanged; the rightmost input stays index 0.
    expect(out.length).toBe(3)
    expect(out[0]!.x + out[0]!.width / 2).toBeCloseTo(210) // was the rightmost, stays pinned high
    expect(out[1]!.x + out[1]!.width / 2).toBeCloseTo(10) // was the leftmost, stays pinned low
  })

  it('handles overlapping elements without inverting (centre-based, so gaps may be negative edges)', () => {
    const rects = [r(0, 0, 100, 20), r(10, 0, 100, 20), r(20, 0, 100, 20)]
    const out = distributeRects(rects, 'horizontal')
    const centres = out.map((rect) => rect.x + rect.width / 2)
    expect(centres[1]! - centres[0]!).toBeCloseTo(centres[2]! - centres[1]!)
  })

  it('is a no-op below MIN_DISTRIBUTE elements', () => {
    expect(MIN_DISTRIBUTE).toBe(3)
    const two = [r(0, 0, 10, 10), r(100, 0, 10, 10)]
    expect(distributeRects(two, 'horizontal')).toEqual(two)
  })
})
