/**
 * The shared cost-fold rule (M2.5, 50-agent-integration.md §10) — the arithmetic both main and the
 * renderer run. See `cost-agreement.test.ts` for the proof that they actually run *this* and land on
 * the same number, and `sdk-cost-contract.test.ts` for the pin on the CLI whose semantics this models.
 */

import { describe, expect, it } from 'vitest'
import {
  abandonTurn,
  beginTurn,
  foldTurnCost,
  formatCostUsd,
  INITIAL_COST_STATE,
  type CostState,
} from '../../../src/shared/agent/cost'

const at = (generation: number, snapshotUsd: number) => ({ generation, snapshotUsd })

/** Open `n` turns then fold each snapshot in order, all on one generation. */
function fold(snapshots: readonly number[], generation = 0, from = INITIAL_COST_STATE): CostState {
  let state = from
  for (let i = 0; i < snapshots.length; i += 1) state = beginTurn(state)
  for (const snapshot of snapshots) state = foldTurnCost(state, at(generation, snapshot))
  return state
}

describe('cost accumulation — total_cost_usd is a running total, folded as a maximum', () => {
  it('reads 0.10 / 0.35 / 1.35 as a $1.35 session, not $1.80', () => {
    // The round-4 blocker. Real turns costing 0.10, 0.25 and 1.00 arrive as the subprocess's
    // cumulative total; adding the snapshots over-counted from the second turn of every session.
    let state = fold([0.1])
    state = fold([0.35], 0, state)
    state = fold([1.35], 0, state)
    expect(state.totalUsd).toBeCloseTo(1.35, 10)
    expect(state.openTurns).toBe(0)
  })

  it('folds one turn-end per opened turn', () => {
    const state = fold([0.02])
    expect(state.totalUsd).toBeCloseTo(0.02)
    expect(state.openTurns).toBe(0)
  })

  it('counts overlapping turns separately — the second result carries the larger total', () => {
    // Stop -> retype -> Send opens a second turn while the first is still unfolded. The two results
    // are the process total at each moment, in emission order; the maximum is the session's spend.
    let state = beginTurn(beginTurn(INITIAL_COST_STATE))
    expect(state.openTurns).toBe(2)
    state = foldTurnCost(state, at(0, 0.5))
    state = foldTurnCost(state, at(0, 0.8))
    expect(state.totalUsd).toBeCloseTo(0.8)
    expect(state.openTurns).toBe(0)
  })

  it('is order-independent for overlapping results: the maximum wins either way', () => {
    expect(fold([0.5, 0.8]).totalUsd).toBeCloseTo(fold([0.8, 0.5]).totalUsd)
  })

  it('folds no more results than turns were opened', () => {
    const state = fold([0.5, 0.8])
    // A third result belongs to no open turn — not even one reporting a larger total.
    const settled = foldTurnCost(state, at(0, 9.99))
    expect(settled).toBe(state)
    expect(settled.totalUsd).toBeCloseTo(0.8)
  })

  it('a duplicated snapshot cannot move the number, only consume a turn', () => {
    // `max` is idempotent, so a repeated `result` is harmless to the money. It still consumes an
    // open turn, which is why `event-mapping.ts` dedups by uuid: the turn count settles the composer.
    const once = fold([0.05])
    const twice = foldTurnCost(once, at(0, 0.05))
    expect(twice).toBe(once)
    expect(twice.totalUsd).toBeCloseTo(0.05)
  })

  it('banks a finished generation when the next one reports: totals add across queries', () => {
    // A re-armed query is a new subprocess with a fresh tracker (the CLI's resume restore never
    // fires on the SDK path — cost.ts). Its first snapshot is what tells the fold the old
    // generation's last total is final.
    let state = fold([0.1, 0.35])
    state = fold([0.5], 1, state)
    expect(state.closedUsd).toBeCloseTo(0.35)
    expect(state.liveUsd).toBeCloseTo(0.5)
    expect(state.totalUsd).toBeCloseTo(0.85)
    expect(state.generation).toBe(1)
  })

  it('a zero-cost close from the dead generation does not disturb its banked total', () => {
    // `closeOpenTurns` folds `0` for the dead query's turns before the replacement opens; `max`
    // ignores it and the generation stays put until the replacement actually reports.
    let state = fold([0.35])
    state = beginTurn(state)
    state = foldTurnCost(state, at(0, 0))
    expect(state.totalUsd).toBeCloseTo(0.35)
    expect(state.generation).toBe(0)
  })

  it('a stray turn-end never advances the generation', () => {
    const state = fold([0.35])
    expect(foldTurnCost(state, at(3, 1))).toBe(state)
  })

  it('ignores a turn-end that no turn opened', () => {
    expect(foldTurnCost(INITIAL_COST_STATE, at(0, 5)).totalUsd).toBe(0)
  })

  it('beginTurn opens an additional turn every time it is called', () => {
    // Deliberately NOT idempotent: two sends mean two results are owed, and collapsing them is
    // precisely how a turn's cost used to disappear.
    const open = beginTurn(INITIAL_COST_STATE)
    expect(beginTurn(open).openTurns).toBe(2)
  })

  it('an error turn still costs — the fold is not gated on success', () => {
    // §10: a `result` is emitted on failure too, carrying the same running total. Nothing here
    // inspects a subtype, which is the point.
    expect(fold([0.03]).totalUsd).toBeCloseTo(0.03)
  })

  it('treats a malformed snapshot as zero rather than poisoning the total', () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
      const state = fold([bad])
      expect(state.totalUsd).toBe(0)
      // The turn is still consumed: it did end, so the next stray result must not fold in its place.
      expect(state.openTurns).toBe(0)
    }
  })

  it('abandonTurn releases a turn main never opened without touching the money', () => {
    const state = abandonTurn(beginTurn(fold([0.35])))
    expect(state.openTurns).toBe(0)
    expect(state.totalUsd).toBeCloseTo(0.35)
    expect(abandonTurn(INITIAL_COST_STATE)).toBe(INITIAL_COST_STATE)
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
