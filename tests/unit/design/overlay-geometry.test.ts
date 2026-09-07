/**
 * The overlay coordinate transforms (§3.4) and the clone-safe rect union. Pure arithmetic, tested
 * without a layout engine — happy-dom reports every box as 0×0, so geometry can only be trusted if
 * it is provable this way.
 */

import { describe, expect, it } from 'vitest'
import {
  clientDeltaToFrame,
  clientPointToFrame,
  frameRectCentreClient,
  frameRectToOverlay,
  rotatedOverlayStyle,
  unionRects,
  resizeCursor,
} from '../../../src/shared/design/overlay-geometry'

describe('clientPointToFrame', () => {
  it('subtracts the box origin and divides by scale', () => {
    // Frame painted at 0.5x, its box top-left at (100, 50). A client point at (300, 250) is
    // (200,200) inside the painted box, which is (400,400) in the 1280×720 frame.
    expect(clientPointToFrame({ x: 300, y: 250 }, { left: 100, top: 50 }, 0.5)).toEqual({
      x: 400,
      y: 400,
    })
  })

  it('is identity at scale 1 with a zero origin', () => {
    expect(clientPointToFrame({ x: 640, y: 360 }, { left: 0, top: 0 }, 1)).toEqual({
      x: 640,
      y: 360,
    })
  })

  it('collapses a non-usable scale to the frame origin rather than NaN/Infinity', () => {
    expect(clientPointToFrame({ x: 5, y: 5 }, { left: 0, top: 0 }, 0)).toEqual({ x: 0, y: 0 })
    expect(clientPointToFrame({ x: 5, y: 5 }, { left: 0, top: 0 }, Number.NaN)).toEqual({
      x: 0,
      y: 0,
    })
  })
})

describe('clientDeltaToFrame — scale-correct drag delta', () => {
  it('divides the client delta by scale (the box origin cancels)', () => {
    // A 100px client drag on a frame painted at 0.5x is a 200px move in frame space.
    expect(clientDeltaToFrame({ x: 100, y: 50 }, 0.5)).toEqual({ x: 200, y: 100 })
  })

  it('is the identity at 1:1', () => {
    expect(clientDeltaToFrame({ x: 30, y: -20 }, 1)).toEqual({ x: 30, y: -20 })
  })

  it('a non-usable scale yields no movement rather than NaN/Infinity', () => {
    expect(clientDeltaToFrame({ x: 40, y: 40 }, 0)).toEqual({ x: 0, y: 0 })
    expect(clientDeltaToFrame({ x: 40, y: 40 }, Number.NaN)).toEqual({ x: 0, y: 0 })
  })
})

describe('frameRectToOverlay', () => {
  it('multiplies a frame rect by scale', () => {
    expect(frameRectToOverlay({ x: 100, y: 200, width: 300, height: 80 }, 0.5)).toEqual({
      x: 50,
      y: 100,
      width: 150,
      height: 40,
    })
  })

  it('round-trips with clientPointToFrame at the same scale', () => {
    const scale = 0.375
    const framePoint = clientPointToFrame({ x: 500, y: 300 }, { left: 0, top: 0 }, scale)
    const back = frameRectToOverlay({ ...framePoint, width: 0, height: 0 }, scale)
    expect(back.x).toBeCloseTo(500)
    expect(back.y).toBeCloseTo(300)
  })

  it('collapses a non-usable scale to a zero box', () => {
    expect(frameRectToOverlay({ x: 1, y: 2, width: 3, height: 4 }, 0)).toEqual({
      x: 0,
      y: 0,
      width: 0,
      height: 0,
    })
  })
})

describe('unionRects', () => {
  it('returns null for an empty list', () => {
    expect(unionRects([])).toBeNull()
  })

  it('returns a single rect unchanged', () => {
    const only = { x: 10, y: 20, width: 30, height: 40 }
    expect(unionRects([only])).toEqual(only)
  })

  it('spans every rect — the adoption-agency clone case', () => {
    // Two nodes of one source element, side by side; the union must cover both.
    const a = { x: 0, y: 0, width: 100, height: 50 }
    const b = { x: 200, y: 20, width: 100, height: 80 }
    expect(unionRects([a, b])).toEqual({ x: 0, y: 0, width: 300, height: 100 })
  })
})

describe('frameRectCentreClient', () => {
  it('places the rect centre in client pixels through the frame box + scale', () => {
    // Frame painted at 0.5x with its box at (100, 50). A 200×100 rect at (40, 20) has its centre at
    // frame (140, 70) → client (100 + 140*0.5, 50 + 70*0.5) = (170, 85).
    const rect = { x: 40, y: 20, width: 200, height: 100 }
    expect(frameRectCentreClient(rect, { left: 100, top: 50 }, 0.5)).toEqual({ x: 170, y: 85 })
  })

  it('falls back to the box origin for a non-usable scale', () => {
    expect(
      frameRectCentreClient({ x: 1, y: 2, width: 3, height: 4 }, { left: 9, top: 8 }, 0),
    ).toEqual({ x: 9, y: 8 })
  })
})

describe('rotatedOverlayStyle', () => {
  it('scales the box and emits a rotate transform', () => {
    const box = rotatedOverlayStyle({ x: 100, y: 200, width: 320, height: 84 }, 0.5, 45)
    expect(box).toEqual({ left: 50, top: 100, width: 160, height: 42, transform: 'rotate(45deg)' })
  })

  it('emits transform: none when upright (no compositor layer for an unrotated box)', () => {
    const box = rotatedOverlayStyle({ x: 0, y: 0, width: 10, height: 10 }, 1, 0)
    expect(box.transform).toBe('none')
  })
})

describe('resizeCursor', () => {
  it('upright: the eight grips get their usual cursors', () => {
    expect(resizeCursor('e', 0)).toBe('ew-resize')
    expect(resizeCursor('w', 0)).toBe('ew-resize')
    expect(resizeCursor('n', 0)).toBe('ns-resize')
    expect(resizeCursor('s', 0)).toBe('ns-resize')
    expect(resizeCursor('nw', 0)).toBe('nwse-resize')
    expect(resizeCursor('se', 0)).toBe('nwse-resize')
    expect(resizeCursor('ne', 0)).toBe('nesw-resize')
    expect(resizeCursor('sw', 0)).toBe('nesw-resize')
  })

  it('turns with the box: at 90° the east grip points down and wants ns-resize', () => {
    // Mutation guard: ignoring the angle leaves this ew-resize.
    expect(resizeCursor('e', 90)).toBe('ns-resize')
    expect(resizeCursor('n', 90)).toBe('ew-resize')
    expect(resizeCursor('se', 90)).toBe('nesw-resize')
  })

  it('rounds to the nearest 45° and folds a negative or full-turn angle', () => {
    expect(resizeCursor('e', 20)).toBe('ew-resize')
    expect(resizeCursor('e', 30)).toBe('nwse-resize')
    expect(resizeCursor('e', -90)).toBe('ns-resize')
    expect(resizeCursor('e', 360)).toBe('ew-resize')
  })
})
