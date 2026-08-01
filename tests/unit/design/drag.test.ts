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
