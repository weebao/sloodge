/**
 * The pure transform-string algebra M3.6's rotate + flip are built on. Every property here is
 * source-string in / source-string out, so the merge math — the thing that must never clobber an
 * existing `translate` — is pinned without a DOM. Mutation targets are called out inline.
 */

import { describe, expect, it } from 'vitest'
import {
  addTranslateOffset,
  readRotation,
  readScale,
  setRotation,
  toggleFlip,
} from '../../../src/shared/design/transform'

describe('setRotation', () => {
  it('writes rotate into an empty transform', () => {
    expect(setRotation(null, 45)).toBe('rotate(45deg)')
    expect(setRotation('', 90)).toBe('rotate(90deg)')
  })

  it('composes rotate WITHOUT clobbering an existing translate (canonical order)', () => {
    // Mutation guard: dropping the translate on the floor reds here.
    expect(setRotation('translate(10px, 20px)', 30)).toBe('translate(10px, 20px) rotate(30deg)')
  })

  it('replaces an existing rotate in place, keeping translate and scale', () => {
    expect(setRotation('translate(10px, 20px) rotate(15deg) scale(2)', 60)).toBe(
      'translate(10px, 20px) rotate(60deg) scale(2)',
    )
  })

  it('reorders to canonical translate → rotate → scale', () => {
    expect(setRotation('scale(2) translate(1px, 2px)', 45)).toBe(
      'translate(1px, 2px) rotate(45deg) scale(2)',
    )
  })

  it('preserves an unrecognised function after the ones we own', () => {
    expect(setRotation('skewX(10deg)', 45)).toBe('rotate(45deg) skewX(10deg)')
  })

  it('rotating back to 0° removes the rotate function entirely', () => {
    expect(setRotation('translate(10px, 20px) rotate(45deg)', 0)).toBe('translate(10px, 20px)')
    expect(setRotation('rotate(45deg)', 0)).toBe('')
  })

  it('accepts negative angles', () => {
    expect(setRotation(null, -90)).toBe('rotate(-90deg)')
  })

  it('collapses repeated instances of the edited function to a single one', () => {
    // Upserting a function that appears more than once normalizes it to ONE instance (the edited
    // value), rather than leaving a duplicate that would double the net transform.
    expect(setRotation('rotate(10deg) rotate(20deg)', 45)).toBe('rotate(45deg)')
  })

  it('leaves repeats of a DIFFERENT function alone (only the edited one collapses)', () => {
    // setRotation touches `rotate`, so two author translates are preserved verbatim (canonicalized).
    expect(setRotation('translate(10px, 0) translate(5px, 0)', 45)).toBe(
      'translate(10px, 0) translate(5px, 0) rotate(45deg)',
    )
  })
})

describe('readRotation', () => {
  it('reads the current rotate, 0 when absent', () => {
    expect(readRotation('translate(1px, 2px) rotate(45deg)')).toBe(45)
    expect(readRotation('rotate(-30deg)')).toBe(-30)
    expect(readRotation('translate(1px, 2px)')).toBe(0)
    expect(readRotation(null)).toBe(0)
  })
})

describe('readScale', () => {
  it('defaults each axis to 1', () => {
    expect(readScale(null)).toEqual({ sx: 1, sy: 1 })
    expect(readScale('rotate(10deg)')).toEqual({ sx: 1, sy: 1 })
  })

  it('reads uniform and 2-axis scale', () => {
    expect(readScale('scale(2)')).toEqual({ sx: 2, sy: 2 })
    expect(readScale('scale(-1, 1)')).toEqual({ sx: -1, sy: 1 })
  })
})

describe('toggleFlip', () => {
  it('flip H introduces scale(-1, 1); flip V introduces scale(1, -1)', () => {
    expect(toggleFlip(null, 'x')).toBe('scale(-1, 1)')
    expect(toggleFlip(null, 'y')).toBe('scale(1, -1)')
  })

  it('composes into scale WITHOUT clobbering translate/rotate', () => {
    // Mutation guard: clobbering translate/rotate reds here.
    expect(toggleFlip('translate(10px, 20px) rotate(30deg)', 'x')).toBe(
      'translate(10px, 20px) rotate(30deg) scale(-1, 1)',
    )
  })

  it('flip then flip on the same axis returns to the ORIGINAL transform', () => {
    // These starts are already in the module's canonical form, so the round-trip is exact.
    for (const start of ['', 'translate(5px, 5px)', 'rotate(45deg) scale(2)', 'scale(3)']) {
      // A flip must be its own inverse; an off-by-one in the scale math reds here.
      expect(toggleFlip(toggleFlip(start, 'x'), 'x')).toBe(start)
      expect(toggleFlip(toggleFlip(start, 'y'), 'y')).toBe(start)
    }
  })

  it('flipping both axes composes to scale(-1, -1) and back to identity', () => {
    const both = toggleFlip(toggleFlip(null, 'x'), 'y')
    expect(both).toBe('scale(-1)')
    expect(toggleFlip(toggleFlip(both, 'x'), 'y')).toBe('')
  })

  it('flipping a uniform scale keeps the short form after undoing', () => {
    expect(toggleFlip('scale(2)', 'x')).toBe('scale(-2, 2)')
    expect(toggleFlip('scale(-2, 2)', 'x')).toBe('scale(2)')
  })
})

describe('addTranslateOffset', () => {
  it('adds to an absent translate', () => {
    expect(addTranslateOffset(null, 16, 16)).toBe('translate(16px, 16px)')
  })

  it('adds to an existing translate without clobbering rotate', () => {
    expect(addTranslateOffset('translate(10px, 20px) rotate(45deg)', 16, 16)).toBe(
      'translate(26px, 36px) rotate(45deg)',
    )
  })
})
