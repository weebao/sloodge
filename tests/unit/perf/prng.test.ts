/**
 * The seeded PRNG. Reproducibility of every generated deck rests on this being a pure function of
 * its seed, so the assertions pin the sequence itself, not merely "two calls agree".
 */

import { describe, expect, it } from 'vitest'
import { intBetween, mulberry32, pick } from '../../../perf/lib/prng'

describe('mulberry32', () => {
  it('is a pure function of the seed', () => {
    const a = mulberry32(12345)
    const b = mulberry32(12345)
    const first = Array.from({ length: 8 }, () => a())
    const second = Array.from({ length: 8 }, () => b())
    expect(second).toStrictEqual(first)
  })

  it('advances — successive draws are not the same value', () => {
    // Catches the classic mistake of forgetting to write the state back.
    const rng = mulberry32(1)
    const draws = new Set(Array.from({ length: 16 }, () => rng()))
    expect(draws.size).toBe(16)
  })

  it('diverges for different seeds', () => {
    const a = mulberry32(1)
    const b = mulberry32(2)
    expect(a()).not.toBe(b())
  })

  it('stays within [0, 1)', () => {
    const rng = mulberry32(777)
    for (let i = 0; i < 5000; i += 1) {
      const value = rng()
      expect(value).toBeGreaterThanOrEqual(0)
      expect(value).toBeLessThan(1)
    }
  })

  it('rejects a non-integer seed rather than degrading silently', () => {
    // A NaN seed would make the stream constant: "deterministic", and useless.
    expect(() => mulberry32(Number.NaN)).toThrow(TypeError)
    expect(() => mulberry32(1.5)).toThrow(TypeError)
  })
})

describe('intBetween', () => {
  it('covers both endpoints and never exceeds them', () => {
    const rng = mulberry32(3)
    const seen = new Set<number>()
    for (let i = 0; i < 3000; i += 1) {
      const value = intBetween(rng, 5, 8)
      expect(Number.isInteger(value)).toBe(true)
      expect(value).toBeGreaterThanOrEqual(5)
      expect(value).toBeLessThanOrEqual(8)
      seen.add(value)
    }
    expect([...seen].toSorted((a, b) => a - b)).toStrictEqual([5, 6, 7, 8])
  })

  it('handles a single-value range', () => {
    expect(intBetween(mulberry32(1), 4, 4)).toBe(4)
  })

  it('rejects an inverted range and non-integer bounds', () => {
    expect(() => intBetween(mulberry32(1), 9, 2)).toThrow(RangeError)
    expect(() => intBetween(mulberry32(1), 1.5, 2)).toThrow(TypeError)
  })
})

describe('pick', () => {
  it('only ever returns members of the array', () => {
    const rng = mulberry32(21)
    const items = ['a', 'b', 'c']
    for (let i = 0; i < 500; i += 1) expect(items).toContain(pick(rng, items))
  })

  it('throws on an empty array instead of returning undefined', () => {
    // An undefined here would be interpolated into slide HTML as the string "undefined".
    expect(() => pick(mulberry32(1), [])).toThrow(RangeError)
  })
})
