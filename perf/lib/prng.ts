/**
 * Seeded pseudo-randomness for the stress-deck generator.
 *
 * The generator must be *reproducible*: a 500-slide deck built on this machine today and on another
 * machine next month has to be byte-identical, or M8.2–M8.7's before/after numbers compare two
 * different workloads and mean nothing. `Math.random()` is therefore banned in `perf/` — every
 * varying value comes from a `Rng` threaded down from a single integer seed.
 *
 * mulberry32 is the choice because it is 5 lines, has no state beyond one uint32, and is exactly
 * reproducible across engines: every operation is `Math.imul`/shift/xor on 32-bit integers, so there
 * is no float-rounding drift between V8 versions. Statistical quality is irrelevant here — we need
 * *arbitrary but fixed* content, not cryptographic or simulation-grade randomness.
 */

/** A deterministic source of floats in `[0, 1)`. */
export type Rng = () => number

/**
 * Build an `Rng` from a 32-bit seed. Two calls with the same seed yield identical sequences.
 *
 * @throws TypeError when `seed` is not a finite integer — a `NaN` seed silently degrades to a
 *   constant stream, which would make "deterministic" true but useless.
 */
export function mulberry32(seed: number): Rng {
  if (!Number.isInteger(seed)) {
    throw new TypeError(`Seed must be an integer, got ${String(seed)}`)
  }
  let state = seed | 0
  return () => {
    state = (state + 0x6d2b79f5) | 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296
  }
}

/** Integer in `[min, max]`, inclusive at both ends. */
export function intBetween(rng: Rng, min: number, max: number): number {
  if (!Number.isInteger(min) || !Number.isInteger(max)) {
    throw new TypeError(`Bounds must be integers, got ${String(min)}..${String(max)}`)
  }
  if (max < min) {
    throw new RangeError(`Empty range ${String(min)}..${String(max)}`)
  }
  return min + Math.floor(rng() * (max - min + 1))
}

/**
 * Pick one element of a non-empty array.
 *
 * @throws RangeError on an empty array — returning `undefined` would let a missing archetype slip
 *   into generated HTML as the string "undefined" instead of failing the build.
 */
export function pick<T>(rng: Rng, items: readonly T[]): T {
  if (items.length === 0) {
    throw new RangeError('Cannot pick from an empty array')
  }
  const item = items[intBetween(rng, 0, items.length - 1)]
  if (item === undefined) {
    throw new RangeError('Array contains a hole or an explicit undefined')
  }
  return item
}
