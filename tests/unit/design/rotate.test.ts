/**
 * The pure rotation-gesture geometry (angle from centre, drag → rotation, snapping). Scale-free
 * arithmetic, so the whole gesture's correctness reduces to these functions.
 */

import { describe, expect, it } from 'vitest'
import {
  normalizeDeg,
  pointerAngleDeg,
  rotationFromDrag,
  SNAP_MAGNET_TOLERANCE_DEG,
  snapRotation,
} from '../../../src/shared/design/rotate'

const CENTRE = { x: 100, y: 100 }

describe('pointerAngleDeg', () => {
  it('measures screen-convention angles about the centre (y down)', () => {
    expect(pointerAngleDeg(CENTRE, { x: 200, y: 100 })).toBeCloseTo(0) // east
    expect(pointerAngleDeg(CENTRE, { x: 100, y: 200 })).toBeCloseTo(90) // south (y grows down)
    expect(pointerAngleDeg(CENTRE, { x: 100, y: 0 })).toBeCloseTo(-90) // north
    expect(pointerAngleDeg(CENTRE, { x: 0, y: 100 })).toBeCloseTo(180) // west
  })
})

describe('normalizeDeg', () => {
  it('folds any angle into [0, 360)', () => {
    expect(normalizeDeg(-90)).toBe(270)
    expect(normalizeDeg(360)).toBe(0)
    expect(normalizeDeg(450)).toBe(90)
    expect(normalizeDeg(-450)).toBe(270)
  })
})

describe('rotationFromDrag', () => {
  it('adds the swept angle to the start rotation, grab-point agnostic', () => {
    // Pointer sweeps from east (0°) to south (90°): +90° regardless of start rotation.
    expect(rotationFromDrag(0, CENTRE, { x: 200, y: 100 }, { x: 100, y: 200 })).toBeCloseTo(90)
    expect(rotationFromDrag(30, CENTRE, { x: 200, y: 100 }, { x: 100, y: 200 })).toBeCloseTo(120)
  })

  it('a sweep back the other way subtracts', () => {
    expect(rotationFromDrag(0, CENTRE, { x: 100, y: 200 }, { x: 200, y: 100 })).toBeCloseTo(-90)
  })
})

describe('snapRotation', () => {
  const free = { shift: false, alt: false }
  const forced = { shift: true, alt: false }
  const bypass = { shift: false, alt: true }

  it('an unmodified drag is free, in whole degrees', () => {
    // Mutation guard: the first cut's always-45° grid turns 30 into 45 here.
    expect(snapRotation(30, free)).toBe(30)
    expect(snapRotation(37.4, free)).toBe(37)
    expect(snapRotation(200, free)).toBe(200)
  })

  it('…but magnetic at 0/45/90 within the tolerance', () => {
    expect(snapRotation(43, free)).toBe(45)
    expect(snapRotation(92.5, free)).toBe(90)
    expect(snapRotation(178, free)).toBe(180)
    expect(snapRotation(2, free)).toBe(0)
  })

  it('the magnet lets go exactly past the tolerance', () => {
    expect(snapRotation(45 + SNAP_MAGNET_TOLERANCE_DEG, free)).toBe(45)
    expect(snapRotation(45 + SNAP_MAGNET_TOLERANCE_DEG + 0.5, free)).toBe(50)
    expect(snapRotation(40, free)).toBe(40)
  })

  it('Shift forces the 15° grid (PowerPoint), which contains 0/45/90', () => {
    expect(snapRotation(37, forced)).toBe(30)
    expect(snapRotation(38, forced)).toBe(45)
    expect(snapRotation(20, forced)).toBe(15)
    expect(snapRotation(88, forced)).toBe(90)
  })

  it('Alt bypasses the magnet: 44 stays 44, and Alt wins over Shift', () => {
    expect(snapRotation(44, bypass)).toBe(44)
    expect(snapRotation(44, free)).toBe(45)
    expect(snapRotation(37, { shift: true, alt: true })).toBe(37)
  })

  it('folds the snapped result into [0, 360)', () => {
    expect(snapRotation(-1, free)).toBe(0)
    expect(snapRotation(358, free)).toBe(0) // magnet to 360 → 0
    expect(snapRotation(-40, free)).toBe(320)
    expect(snapRotation(359.6, bypass)).toBe(0)
  })

  it('repeated gestures do not drift: each starts from the committed whole degree', () => {
    // Thirty-six sweeps of 10.3° measured at the pointer. Committing the whole degree each time and
    // starting the next sweep from it lands on exactly 0 after a full turn; accumulating the raw
    // float instead (the mutation) would end at 10.8 → 11.
    let committed = 0
    for (let i = 0; i < 36; i += 1) committed = snapRotation(committed + 10.3, bypass)
    expect(committed).toBe(0)
    let accumulated = 0
    for (let i = 0; i < 36; i += 1) accumulated += 10.3
    expect(snapRotation(accumulated, bypass)).toBe(11)
  })
})
