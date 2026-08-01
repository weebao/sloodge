/**
 * The shared cost-fold rule (M2.5, 50-agent-integration.md §10) — the arithmetic both main and the
 * renderer run. See `cost-agreement.test.ts` for the proof that they actually run *this* and land on
 * the same number.
 */

import { describe, expect, it } from 'vitest'
import {
  beginTurn,
  foldTurnCost,
  formatCostUsd,
  INITIAL_COST_STATE,
} from '../../../src/shared/agent/cost'

describe('cost accumulation', () => {
  it('folds one turn-end per opened turn', () => {
    let state = beginTurn(INITIAL_COST_STATE)
    state = foldTurnCost(state, 0.02)
    expect(state.totalUsd).toBeCloseTo(0.02)
    expect(state.folded).toBe(true)
  })

  it('accumulates across turns', () => {
    let state = foldTurnCost(beginTurn(INITIAL_COST_STATE), 0.1)
    state = foldTurnCost(beginTurn(state), 0.25)
    expect(state.totalUsd).toBeCloseTo(0.35)
  })

  it('refuses a second turn-end for the same turn (a duplicate `result` must not double-count)', () => {
    const once = foldTurnCost(beginTurn(INITIAL_COST_STATE), 0.05)
    const twice = foldTurnCost(once, 0.05)
    expect(twice.totalUsd).toBeCloseTo(0.05)
    // Reference-preserving, so a reducer can use identity to skip a state update.
    expect(twice).toBe(once)
  })

  it('ignores a turn-end that no turn opened', () => {
    // The initial state is "no turn open". A stray `result` before anything was sent is not ours to
    // attribute, so it contributes nothing rather than opening the total.
    expect(foldTurnCost(INITIAL_COST_STATE, 5).totalUsd).toBe(0)
  })

  it('beginTurn is idempotent within an open turn', () => {
    const open = beginTurn(INITIAL_COST_STATE)
    expect(beginTurn(open)).toBe(open)
  })

  it('an error turn still costs — the fold is not gated on success', () => {
    // §10: "a `result` message is emitted on failure too, so the accumulator must not be gated on
    // subtype === 'success'". Nothing here inspects a subtype, which is the point.
    const state = foldTurnCost(beginTurn(INITIAL_COST_STATE), 0.03)
    expect(state.totalUsd).toBeCloseTo(0.03)
  })

  it('treats a malformed cost as zero rather than poisoning the total', () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
      const state = foldTurnCost(beginTurn(INITIAL_COST_STATE), bad)
      expect(state.totalUsd).toBe(0)
      // Still marked folded: the turn did end, so the next stray result must not fold in its place.
      expect(state.folded).toBe(true)
    }
  })
})

describe('formatCostUsd', () => {
  it('renders whole cents to two places', () => {
    expect(formatCostUsd(0.42)).toBe('$0.42')
    expect(formatCostUsd(12.3)).toBe('$12.30')
  })

  it('renders an untouched session as exactly zero', () => {
    expect(formatCostUsd(0)).toBe('$0.00')
  })

  it('renders real-but-sub-cent spend as "< $0.01", never as free', () => {
    // A meter that reads $0.00 after five real turns teaches the user it is decorative.
    expect(formatCostUsd(0.004)).toBe('< $0.01')
    expect(formatCostUsd(0.000001)).toBe('< $0.01')
  })

  it('rounds at the half-cent boundary rather than falling into the sub-cent branch', () => {
    expect(formatCostUsd(0.005)).toBe('$0.01')
  })

  it('degrades a malformed number to zero instead of "$NaN"', () => {
    expect(formatCostUsd(Number.NaN)).toBe('$0.00')
    expect(formatCostUsd(-3)).toBe('$0.00')
  })
})
