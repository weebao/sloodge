/**
 * The committed `perf/deck-hashes.json` is the proof that M8.2–M8.7 measured the same workload.
 * These pin the two ways a routine `perf:generate` used to destroy it: rewriting the file with only
 * the requested tiers, and recording a different seed under the same key.
 */

import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SEED,
  DEFAULT_SIZES,
  mergeDeckHashes,
  seedConflicts,
  type DeckHashes,
  type GeneratedDeck,
} from '../../../perf/cli/generate'
import committed from '../../../perf/deck-hashes.json'

function generated(slideCount: number, seed: number): GeneratedDeck {
  return {
    slideCount,
    seed,
    sloodgePath: '',
    payloadPath: '',
    archiveBytes: 1,
    totalSlideBytes: 2,
    contentSha256: `sha-${String(slideCount)}-${String(seed)}`,
    archetypeCounts: {},
  }
}

const existing: DeckHashes = {
  'stress-100': {
    seed: 20260801,
    slideCount: 100,
    contentSha256: 'a',
    archiveBytes: 1,
    totalSlideBytes: 1,
    archetypeCounts: {},
  },
  'stress-500': {
    seed: 20260801,
    slideCount: 500,
    contentSha256: 'b',
    archiveBytes: 1,
    totalSlideBytes: 1,
    archetypeCounts: {},
  },
}

describe('mergeDeckHashes', () => {
  it('keeps tiers that were not regenerated and orders the file by slide count', () => {
    const merged = mergeDeckHashes(existing, [generated(25, 20260801), generated(100, 20260801)])
    expect(Object.keys(merged)).toStrictEqual(['stress-25', 'stress-100', 'stress-500'])
    expect(merged['stress-500']?.contentSha256).toBe('b')
    expect(merged['stress-100']?.contentSha256).toBe('sha-100-20260801')
  })
})

describe('seedConflicts', () => {
  it('names a tier whose committed seed differs from the requested one', () => {
    expect(seedConflicts(existing, [100, 500], 1)).toStrictEqual([
      'stress-100 is recorded with seed 20260801, requested 1',
      'stress-500 is recorded with seed 20260801, requested 1',
    ])
  })

  it('is silent for the recorded seed and for tiers not yet recorded', () => {
    expect(seedConflicts(existing, [100, 1000], 20260801)).toStrictEqual([])
    expect(seedConflicts(existing, [1000], 1)).toStrictEqual([])
  })
})

describe('defaults', () => {
  it('cover every committed tier with the committed seed', () => {
    // A plain `pnpm perf:generate` used to write 3 of the 7 committed tiers.
    const record = committed as DeckHashes
    expect([...DEFAULT_SIZES].toSorted((a, b) => a - b)).toStrictEqual(
      Object.values(record)
        .map((e) => e.slideCount)
        .toSorted((a, b) => a - b),
    )
    for (const entry of Object.values(record)) expect(entry.seed).toBe(DEFAULT_SEED)
  })
})
