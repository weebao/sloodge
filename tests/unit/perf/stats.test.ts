/**
 * Stats math for the perf harness.
 *
 * Deliberately contains **no wall-clock assertions** — timing lives in the local harness, never in
 * vitest (70-testing-ci.md; timing assertions are a known flake source in this repo). Everything
 * here is a pure function over a fixed array.
 */

import { describe, expect, it } from 'vitest'
import {
  countDroppedFrames,
  frameRateFps,
  missedFrames,
  quantile,
  summarize,
  toIntervals,
} from '../../../perf/lib/stats'

describe('quantile', () => {
  it('returns the exact element at an integral position', () => {
    expect(quantile([10, 20, 30, 40, 50], 0)).toBe(10)
    expect(quantile([10, 20, 30, 40, 50], 0.5)).toBe(30)
    expect(quantile([10, 20, 30, 40, 50], 1)).toBe(50)
  })

  it('interpolates linearly between neighbours', () => {
    // position = (4-1)*0.5 = 1.5 -> halfway between 20 and 30
    expect(quantile([10, 20, 30, 40], 0.5)).toBe(25)
    // position = (4-1)*0.95 = 2.85 -> 85% of the way from 30 to 40
    expect(quantile([10, 20, 30, 40], 0.95)).toBeCloseTo(38.5, 10)
  })

  it('rejects an empty series and out-of-range quantiles', () => {
    expect(() => quantile([], 0.5)).toThrow(RangeError)
    expect(() => quantile([1, 2], 1.5)).toThrow(RangeError)
    expect(() => quantile([1, 2], -0.1)).toThrow(RangeError)
  })
})

describe('summarize', () => {
  it('computes the median of an even-length series as the midpoint of the two central values', () => {
    // The RAM budget is a median, so this specific case is load-bearing: with an even number of
    // samples the answer must be 25, not 20 (lower-middle) and not 30 (upper-middle).
    const summary = summarize([40, 10, 30, 20])
    expect(summary.median).toBe(25)
    expect(summary.min).toBe(10)
    expect(summary.max).toBe(40)
    expect(summary.count).toBe(4)
    expect(summary.mean).toBe(25)
  })

  it('computes the population standard deviation', () => {
    // mean 4; deviations -2,-1,0,1,2 -> variance (4+1+0+1+4)/5 = 2
    expect(summarize([2, 3, 4, 5, 6]).stdDev).toBeCloseTo(Math.sqrt(2), 12)
  })

  it('does not mutate the caller series', () => {
    // The harness keeps the raw series for the trace file; an in-place sort would scramble the
    // time order it was recorded in.
    const values = [3, 1, 2]
    summarize(values)
    expect(values).toStrictEqual([3, 1, 2])
  })

  it('rejects an empty series', () => {
    expect(() => summarize([])).toThrow(RangeError)
  })

  it('rejects a non-finite sample rather than reporting NaN', () => {
    // A failed metric read must fail the run loudly; a NaN median would look like a number.
    expect(() => summarize([1, Number.NaN, 3])).toThrow(TypeError)
    expect(() => summarize([1, Number.POSITIVE_INFINITY])).toThrow(TypeError)
  })
})

describe('toIntervals', () => {
  it('turns timestamps into gaps', () => {
    expect(toIntervals([0, 16, 33, 50])).toStrictEqual([16, 17, 17])
  })

  it('returns nothing for fewer than two timestamps', () => {
    expect(toIntervals([])).toStrictEqual([])
    expect(toIntervals([5])).toStrictEqual([])
  })
})

describe('countDroppedFrames', () => {
  it('counts only intervals beyond the tolerance', () => {
    // 60 Hz budget 16.67 ms, tolerance 1.5 -> threshold 25 ms.
    expect(countDroppedFrames([16.7, 16.6, 24.9, 25.1, 40])).toBe(2)
  })

  it('reports zero for a clean 60 Hz series', () => {
    expect(countDroppedFrames(Array.from({ length: 100 }, () => 16.7))).toBe(0)
  })

  it('honours an explicit budget and tolerance', () => {
    expect(countDroppedFrames([20, 30], 10, 2)).toBe(1)
  })

  it('rejects a non-positive budget or a tolerance below 1', () => {
    expect(() => countDroppedFrames([16], 0)).toThrow(RangeError)
    expect(() => countDroppedFrames([16], 16, 0.5)).toThrow(RangeError)
  })
})

describe('missedFrames', () => {
  it('counts frames the user did not get against a 60 Hz ideal', () => {
    // 4800 ms at 60 Hz ideally serves 288 frames.
    expect(missedFrames(288, 4800)).toBe(0)
    expect(missedFrames(34, 4800)).toBe(254)
    expect(missedFrames(9, 4800)).toBe(279)
  })

  it('is monotonic where the interval count is not — the reason it exists', () => {
    // Measured on this app: a 100-slide deck served 34 frames in 4.8 s with 27 over-long intervals;
    // a 200-slide deck served 9 frames with only 4 over-long intervals. The 200-slide run is worse
    // for the user, so the budget metric must score it worse.
    const hundredSlides = missedFrames(34, 4800)
    const twoHundredSlides = missedFrames(9, 4800)
    expect(twoHundredSlides).toBeGreaterThan(hundredSlides)
    expect(countDroppedFrames(Array.from({ length: 27 }, () => 40))).toBeGreaterThan(
      countDroppedFrames(Array.from({ length: 4 }, () => 40)),
    )
  })

  it('never returns a negative count when more frames arrive than the ideal', () => {
    expect(missedFrames(400, 1000)).toBe(0)
  })

  it('honours a custom target rate', () => {
    expect(missedFrames(0, 1000, 30)).toBe(30)
  })

  it('rejects a non-positive window, rate, or negative frame count', () => {
    expect(() => missedFrames(10, 0)).toThrow(RangeError)
    expect(() => missedFrames(10, 1000, 0)).toThrow(RangeError)
    expect(() => missedFrames(-1, 1000)).toThrow(RangeError)
  })
})

describe('frameRateFps', () => {
  it('converts a frame count and window into a rate', () => {
    expect(frameRateFps(60, 1000)).toBe(60)
    expect(frameRateFps(9, 4800)).toBeCloseTo(1.875, 6)
  })

  it('rejects a non-positive window', () => {
    expect(() => frameRateFps(1, 0)).toThrow(RangeError)
  })
})
