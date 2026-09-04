/**
 * Distribution summaries for sampled perf series.
 *
 * The RAM budget in 80-roadmap.md is a **median**, not a peak and not a mean, so the harness records
 * the whole sample series and reduces it here. Recording only a peak would make the headline number
 * unreportable; recording only a mean would let one 900 MB export spike hide a healthy steady state
 * (or vice versa). Every series therefore ships min/median/p95/max *and* its sample count, so a
 * reader can tell "median 180 MB over 240 samples" from "median 180 MB over 3 samples".
 *
 * Pure and dependency-free: this is the half of the harness that CI is allowed to run (M8.7 diffs
 * committed numbers), so it must never touch a clock, a socket, or Electron.
 */

/** A reduced view of one sampled series. All quantiles are in the series' own units. */
export type Summary = {
  readonly count: number
  readonly min: number
  readonly p25: number
  readonly median: number
  readonly p75: number
  readonly p95: number
  readonly max: number
  readonly mean: number
  /** Population standard deviation (divides by N, not N-1) — we sample the whole run, not a subset. */
  readonly stdDev: number
}

/**
 * Linear-interpolation quantile (the "R type 7" / NumPy default definition) over an
 * **already-sorted ascending** array.
 *
 * @throws RangeError on an empty array or a `q` outside `[0, 1]`.
 */
export function quantile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) {
    throw new RangeError('Cannot take a quantile of an empty series')
  }
  if (!(q >= 0 && q <= 1)) {
    throw new RangeError(`Quantile must be within [0, 1], got ${String(q)}`)
  }
  const position = (sorted.length - 1) * q
  const lowIndex = Math.floor(position)
  const highIndex = Math.ceil(position)
  const low = sorted[lowIndex]
  const high = sorted[highIndex]
  if (low === undefined || high === undefined) {
    throw new RangeError('Series contains a hole')
  }
  if (lowIndex === highIndex) return low
  return low + (high - low) * (position - lowIndex)
}

/**
 * Reduce a sample series. The input is not mutated (it is copied before sorting) because callers
 * hold the raw series for the trace file and a silent in-place sort would scramble its time order.
 *
 * @throws RangeError on an empty series; TypeError if any sample is not finite — a `NaN` from a
 *   failed metric read must fail the run loudly, not poison the median into `NaN` silently.
 */
export function summarize(values: readonly number[]): Summary {
  if (values.length === 0) {
    throw new RangeError('Cannot summarize an empty series')
  }
  for (const value of values) {
    if (!Number.isFinite(value)) {
      throw new TypeError(`Series contains a non-finite sample: ${String(value)}`)
    }
  }
  const sorted = values.toSorted((a, b) => a - b)
  const total = values.reduce((sum, value) => sum + value, 0)
  const mean = total / values.length
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length
  const min = sorted[0]
  const max = sorted[sorted.length - 1]
  if (min === undefined || max === undefined) {
    throw new RangeError('Series contains a hole')
  }
  return {
    count: values.length,
    min,
    p25: quantile(sorted, 0.25),
    median: quantile(sorted, 0.5),
    p75: quantile(sorted, 0.75),
    p95: quantile(sorted, 0.95),
    max,
    mean,
    stdDev: Math.sqrt(variance),
  }
}

/**
 * Count frame intervals that overran a refresh budget.
 *
 * "No dropped-frame animation on the active slide" needs a definition to be testable. Ours: an
 * interval longer than `budgetMs * tolerance` dropped at least one frame. Default tolerance 1.5 —
 * i.e. at 60 Hz (16.67 ms) anything over 25 ms is a drop. The slack matters because a harness
 * sampling through CDP cannot distinguish a genuine 17.1 ms frame from scheduler jitter, and a
 * zero-tolerance count would report hundreds of "drops" on an idle app.
 */
export function countDroppedFrames(
  intervalsMs: readonly number[],
  budgetMs = 1000 / 60,
  tolerance = 1.5,
): number {
  if (budgetMs <= 0) throw new RangeError('Frame budget must be positive')
  if (tolerance < 1) throw new RangeError('Tolerance must be >= 1')
  const threshold = budgetMs * tolerance
  return intervalsMs.filter((interval) => interval > threshold).length
}

/**
 * Frames the user did **not** get over an observation window, against a target refresh rate.
 *
 * This exists because counting long *intervals* — `countDroppedFrames` — is not monotonic once the
 * frame stream collapses, and that made the instrument understate the worst case. Measured on this
 * app: a 100-slide deck produced 34 frames in 4.8 s and 27 over-long intervals, while a 200-slide
 * deck produced only 9 frames in the same window and therefore just 4 over-long intervals. The
 * 200-slide case is far worse for the user and scored better. Counting against the ideal frame
 * count instead is monotonic: 100 slides misses ~254 frames, 200 slides misses ~279.
 *
 * Lower is better, which keeps it consistent with every other budget in `report.ts`.
 */
export function missedFrames(actualFrames: number, windowMs: number, targetHz = 60): number {
  if (windowMs <= 0) throw new RangeError('Observation window must be positive')
  if (targetHz <= 0) throw new RangeError('Target refresh rate must be positive')
  if (actualFrames < 0) throw new RangeError('Frame count cannot be negative')
  const expected = Math.round((windowMs / 1000) * targetHz)
  return Math.max(0, expected - actualFrames)
}

/** Achieved frame rate over an observation window. Higher is better; reported, never a budget. */
export function frameRateFps(actualFrames: number, windowMs: number): number {
  if (windowMs <= 0) throw new RangeError('Observation window must be positive')
  return actualFrames / (windowMs / 1000)
}

/** Convert a monotonically increasing timestamp series into the gaps between consecutive entries. */
export function toIntervals(timestampsMs: readonly number[]): number[] {
  const intervals: number[] = []
  for (let index = 1; index < timestampsMs.length; index += 1) {
    const previous = timestampsMs[index - 1]
    const current = timestampsMs[index]
    if (previous === undefined || current === undefined) continue
    intervals.push(current - previous)
  }
  return intervals
}
