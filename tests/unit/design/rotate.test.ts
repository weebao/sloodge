/**
 * The pure rotation-gesture geometry (angle from centre, drag → rotation, snapping). Scale-free
 * arithmetic, so the whole gesture's correctness reduces to these functions.
 */

import { describe, expect, it } from 'vitest'
import {
  normalizeDeg,
  pointerAngleDeg,
  rotationFromDrag,
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
  const fine = { shift: true, alt: false }
  const none = { shift: false, alt: true }

  it('default snaps to the 45° grid (0/45/90/…)', () => {
    expect(snapRotation(4, free)).toBe(0)
    expect(snapRotation(40, free)).toBe(45)
    expect(snapRotation(88, free)).toBe(90)
    expect(snapRotation(200, free)).toBe(180)
  })

  it('snap threshold is the midpoint (22.5° for the 45° grid)', () => {
    expect(snapRotation(22, free)).toBe(0)
    expect(snapRotation(23, free)).toBe(45)
  })

  it('Shift snaps to the finer 15° grid', () => {
    expect(snapRotation(20, fine)).toBe(15)
    expect(snapRotation(23, fine)).toBe(30)
  })

  it('Alt is free (whole degrees), overriding Shift', () => {
    expect(snapRotation(37, none)).toBe(37)
    expect(snapRotation(37, { shift: true, alt: true })).toBe(37)
  })

  it('folds the snapped result into [0, 360)', () => {
    expect(snapRotation(-1, free)).toBe(0)
    expect(snapRotation(358, free)).toBe(0) // rounds to 360 → 0
    expect(snapRotation(-40, free)).toBe(315)
  })
})
