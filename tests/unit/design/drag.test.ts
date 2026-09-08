/**
 * The pure drag/resize geometry (`drag.ts`) — the math the whole gesture rests on, tested with no
 * DOM. Each handle's anchor, the min-size floor, the Shift/Alt modifiers, and the delta arithmetic
 * that decides whether a gesture committed anything at all (§5.5, §7.2 of 40-design-mode.md).
 */

import { describe, expect, it } from 'vitest'
import {
  applyDrag,
  geometryDelta,
  isZeroDelta,
  MIN_SIZE,
  type DragHandle,
  type DragModifiers,
  type ResizeHandle,
} from '../../../src/shared/design/drag'
import type { SlRect } from '../../../src/shared/design/bridge-protocol'

const START: SlRect = { x: 100, y: 50, width: 200, height: 80 }
const NO_MODS = { shift: false, alt: false } as const

describe('applyDrag — move', () => {
  it('translates the whole box, size unchanged', () => {
    expect(applyDrag(START, 'move', { x: 30, y: 20 }, NO_MODS)).toEqual({
      x: 130,
      y: 70,
      width: 200,
      height: 80,
    })
  })

  it('allows off-frame movement (no clamp)', () => {
    expect(applyDrag(START, 'move', { x: -500, y: -500 }, NO_MODS)).toEqual({
      x: -400,
      y: -450,
      width: 200,
      height: 80,
    })
  })

  it('Shift locks to the dominant axis', () => {
    expect(applyDrag(START, 'move', { x: 40, y: 10 }, { shift: true, alt: false })).toEqual({
      x: 140,
      y: 50,
      width: 200,
      height: 80,
    })
    expect(applyDrag(START, 'move', { x: 5, y: 60 }, { shift: true, alt: false })).toEqual({
      x: 100,
      y: 110,
      width: 200,
      height: 80,
    })
  })
})

describe('applyDrag — edge resize anchors the opposite edge', () => {
  it('east grows width, left fixed', () => {
    expect(applyDrag(START, 'e', { x: 20, y: 0 }, NO_MODS)).toEqual({
      x: 100,
      y: 50,
      width: 220,
      height: 80,
    })
  })

  it('west moves left and shrinks width, right fixed', () => {
    expect(applyDrag(START, 'w', { x: 20, y: 0 }, NO_MODS)).toEqual({
      x: 120,
      y: 50,
      width: 180,
      height: 80,
    })
  })

  it('north moves top and shrinks height, bottom fixed', () => {
    expect(applyDrag(START, 'n', { x: 0, y: 15 }, NO_MODS)).toEqual({
      x: 100,
      y: 65,
      width: 200,
      height: 65,
    })
  })

  it('south grows height, top fixed', () => {
    expect(applyDrag(START, 's', { x: 0, y: 15 }, NO_MODS)).toEqual({
      x: 100,
      y: 50,
      width: 200,
      height: 95,
    })
  })
})

describe('applyDrag — corner resize anchors the opposite corner', () => {
  it('se grows both, nw corner fixed', () => {
    expect(applyDrag(START, 'se', { x: 10, y: 10 }, NO_MODS)).toEqual({
      x: 100,
      y: 50,
      width: 210,
      height: 90,
    })
  })

  it('nw moves origin and shrinks both, se corner fixed', () => {
    expect(applyDrag(START, 'nw', { x: 10, y: 10 }, NO_MODS)).toEqual({
      x: 110,
      y: 60,
      width: 190,
      height: 70,
    })
  })

  it('ne grows width, moves top, sw corner fixed', () => {
    expect(applyDrag(START, 'ne', { x: 10, y: -10 }, NO_MODS)).toEqual({
      x: 100,
      y: 40,
      width: 210,
      height: 90,
    })
  })

  it('sw moves left, grows height, ne corner fixed', () => {
    expect(applyDrag(START, 'sw', { x: -10, y: 10 }, NO_MODS)).toEqual({
      x: 90,
      y: 50,
      width: 210,
      height: 90,
    })
  })
})

describe('applyDrag — min-size floor', () => {
  it('east collapse floors width, left fixed', () => {
    const r = applyDrag(START, 'e', { x: -500, y: 0 }, NO_MODS)
    expect(r.width).toBe(MIN_SIZE)
    expect(r.x).toBe(100)
  })

  it('west over-drag floors width and stops left at right - MIN', () => {
    const r = applyDrag(START, 'w', { x: 500, y: 0 }, NO_MODS)
    expect(r.width).toBe(MIN_SIZE)
    expect(r.x).toBe(START.x + START.width - MIN_SIZE)
  })

  it('north over-drag floors height and stops top at bottom - MIN', () => {
    const r = applyDrag(START, 'n', { x: 0, y: 500 }, NO_MODS)
    expect(r.height).toBe(MIN_SIZE)
    expect(r.y).toBe(START.y + START.height - MIN_SIZE)
  })
})

describe('applyDrag — Alt resizes about the centre', () => {
  it('east+alt moves both horizontal edges, centre fixed', () => {
    const r = applyDrag(START, 'e', { x: 20, y: 0 }, { shift: false, alt: true })
    expect(r).toEqual({ x: 80, y: 50, width: 240, height: 80 })
    expect(r.x + r.width / 2).toBe(START.x + START.width / 2)
  })

  it('east+alt collapse floors width about the centre', () => {
    const r = applyDrag(START, 'e', { x: -500, y: 0 }, { shift: false, alt: true })
    expect(r.width).toBe(MIN_SIZE)
    expect(r.x + r.width / 2).toBe(START.x + START.width / 2)
  })
})

describe('applyDrag — Shift aspect-locks a corner resize', () => {
  it('width drives when the horizontal change dominates', () => {
    // start 200×80 (ratio 2.5). dx 50, dy 0 → newWidth 250, newHeight 250/2.5 = 100.
    expect(applyDrag(START, 'se', { x: 50, y: 0 }, { shift: true, alt: false })).toEqual({
      x: 100,
      y: 50,
      width: 250,
      height: 100,
    })
  })

  it('height drives when the vertical change dominates', () => {
    // dy 40, dx 0 → newHeight 120, newWidth 120*2.5 = 300.
    expect(applyDrag(START, 'se', { x: 0, y: 40 }, { shift: true, alt: false })).toEqual({
      x: 100,
      y: 50,
      width: 300,
      height: 120,
    })
  })

  it('holds the ratio while moving the nw origin', () => {
    const r = applyDrag(START, 'nw', { x: 20, y: 0 }, { shift: true, alt: false })
    expect(r.width / r.height).toBeCloseTo(START.width / START.height)
  })
})

describe('geometryDelta / isZeroDelta', () => {
  it('reports the whole-pixel change per component', () => {
    expect(geometryDelta(START, { x: 130, y: 70, width: 200, height: 80 })).toEqual({
      dx: 30,
      dy: 20,
      dw: 0,
      dh: 0,
    })
  })

  it('an unmoved box is a zero delta — the commit-nothing signal', () => {
    expect(isZeroDelta(geometryDelta(START, START))).toBe(true)
  })

  it('sub-pixel jitter rounds to a zero delta', () => {
    expect(isZeroDelta(geometryDelta(START, { ...START, x: START.x + 0.3 }))).toBe(true)
  })

  it('any component change is non-zero', () => {
    expect(isZeroDelta(geometryDelta(START, { ...START, width: 201 }))).toBe(false)
  })
})

describe('applyDrag — every handle is a pure function of its inputs', () => {
  const handles: DragHandle[] = ['move', 'n', 's', 'e', 'w', 'nw', 'ne', 'sw', 'se']
  it('never inverts a box and never returns NaN', () => {
    for (const handle of handles) {
      const r = applyDrag(START, handle, { x: -999, y: -999 }, NO_MODS)
      expect(r.width).toBeGreaterThanOrEqual(handle === 'move' ? START.width : MIN_SIZE - 0.001)
      expect(r.height).toBeGreaterThanOrEqual(handle === 'move' ? START.height : MIN_SIZE - 0.001)
      expect(Number.isNaN(r.x + r.y + r.width + r.height)).toBe(false)
    }
  })
})

/**
 * Resize under rotation (M3.6). The oracle is independent of `drag.ts`: `screenPoint` below places a
 * fractional point of a rect after rotating the rect about its centre with its own trigonometry, and
 * the hand-computed expectations were worked on paper before the code existed.
 */
/** Where the point at fractions (fx, fy) of `rect` lands on screen once the rect is turned `deg`. */
function screenPoint(rect: SlRect, deg: number, fx: number, fy: number): { x: number; y: number } {
  const cx = rect.x + rect.width / 2
  const cy = rect.y + rect.height / 2
  const lx = (fx - 0.5) * rect.width
  const ly = (fy - 0.5) * rect.height
  const r = (deg * Math.PI) / 180
  return {
    x: cx + lx * Math.cos(r) - ly * Math.sin(r),
    y: cy + lx * Math.sin(r) + ly * Math.cos(r),
  }
}

/** The fractional point each handle leaves fixed: the opposite edge midpoint or corner. */
const ANCHOR: Readonly<Record<ResizeHandle, readonly [number, number]>> = {
  e: [0, 0.5],
  w: [1, 0.5],
  n: [0.5, 1],
  s: [0.5, 0],
  nw: [1, 1],
  ne: [0, 1],
  sw: [1, 0],
  se: [0, 0],
}
const RESIZE_HANDLES = Object.keys(ANCHOR) as ResizeHandle[]
const BOX: SlRect = { x: 100, y: 100, width: 200, height: 100 }

describe('applyDrag — resize under rotation', () => {
  it('90°: the east handle points down, so a downward drag stretches the width (hand-computed)', () => {
    // Centre (200, 150). The west edge midpoint sits at screen (200, 50) and must stay there; width
    // grows 200 → 240, so the centre moves 20 along the local +x axis, which on screen is +y:
    // centre (200, 170), unrotated box x = 200 − 120 = 80, y = 170 − 50 = 120.
    const next = applyDrag(BOX, 'e', { x: 0, y: 40 }, NO_MODS, 90)
    expect(next.x).toBeCloseTo(80)
    expect(next.y).toBeCloseTo(120)
    expect(next.width).toBeCloseTo(240)
    expect(next.height).toBeCloseTo(100)
  })

  it("30°: a drag along the east handle's own direction stretches only the width (hand-computed)", () => {
    // 40px along the 30° axis is (40·cos30°, 40·sin30°) = (34.641, 20) on screen. Locally that is
    // (40, 0): width 200 → 240, height unchanged. The centre moves 20 along the tilted x axis, to
    // (200 + 17.321, 150 + 10); box x = 217.321 − 120 = 97.321, y = 160 − 50 = 110.
    const next = applyDrag(BOX, 'e', { x: 34.641016, y: 20 }, NO_MODS, 30)
    expect(next.width).toBeCloseTo(240, 3)
    expect(next.height).toBeCloseTo(100, 3)
    expect(next.x).toBeCloseTo(97.321, 3)
    expect(next.y).toBeCloseTo(110, 3)
  })

  it('every handle keeps its anchor fixed ON SCREEN at every angle', () => {
    // Mutation guard: applying the screen delta to the unrotated rect (ignoring `angleDeg`) moves the
    // anchor for every non-zero angle here.
    for (const angle of [30, 90, -45, 200]) {
      for (const handle of RESIZE_HANDLES) {
        const [fx, fy] = ANCHOR[handle]
        const before = screenPoint(BOX, angle, fx, fy)
        const next = applyDrag(BOX, handle, { x: 23, y: -17 }, NO_MODS, angle)
        const after = screenPoint(next, angle, fx, fy)
        expect(after.x, `${handle} @ ${String(angle)}° x`).toBeCloseTo(before.x, 6)
        expect(after.y, `${handle} @ ${String(angle)}° y`).toBeCloseTo(before.y, 6)
      }
    }
  })

  it("the dragged edge follows the pointer along the element's own axis", () => {
    // For each edge handle, a pointer travel of `d` along the handle's direction grows that dimension
    // by exactly `d` — the projection onto the local axis, not the screen axis.
    const angle = 30
    const r = (angle * Math.PI) / 180
    const alongX = { x: 50 * Math.cos(r), y: 50 * Math.sin(r) }
    expect(applyDrag(BOX, 'e', alongX, NO_MODS, angle).width).toBeCloseTo(250)
    expect(applyDrag(BOX, 'e', alongX, NO_MODS, angle).height).toBeCloseTo(100)
    const alongY = { x: -50 * Math.sin(r), y: 50 * Math.cos(r) }
    expect(applyDrag(BOX, 's', alongY, NO_MODS, angle).height).toBeCloseTo(150)
    expect(applyDrag(BOX, 's', alongY, NO_MODS, angle).width).toBeCloseTo(200)
  })

  it('Alt resizes about the centre under rotation: the centre never moves', () => {
    const alt: DragModifiers = { shift: false, alt: true }
    const next = applyDrag(BOX, 'se', { x: 30, y: 10 }, alt, 60)
    expect(next.x + next.width / 2).toBeCloseTo(BOX.x + BOX.width / 2)
    expect(next.y + next.height / 2).toBeCloseTo(BOX.y + BOX.height / 2)
    expect(next.width).toBeGreaterThan(BOX.width)
  })

  it("the min-size floor still holds in the element's own axes", () => {
    const next = applyDrag(BOX, 'w', { x: 0, y: 900 }, NO_MODS, 90)
    expect(next.width).toBeCloseTo(MIN_SIZE)
    expect(next.height).toBeCloseTo(100)
  })

  it('move ignores the angle: a screen delta moves a rotated box like an upright one', () => {
    expect(applyDrag(BOX, 'move', { x: 30, y: 20 }, NO_MODS, 45)).toEqual(
      applyDrag(BOX, 'move', { x: 30, y: 20 }, NO_MODS),
    )
  })
})
