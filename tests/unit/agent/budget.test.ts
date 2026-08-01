/**
 * The budget guard's state machine (M2.5, 50-agent-integration.md §10): accumulate → warn → cap
 * reached → refuse. Pure, so the whole progression is asserted here rather than clicked through.
 */

import { describe, expect, it } from 'vitest'
import {
  budgetRefusalMessage,
  BUDGET_WARN_FRACTION,
  canStartTurn,
  DEFAULT_BUDGET_CAP_USD,
  evaluateBudget,
  isBudgetCap,
  isBudgetSetRequest,
  MAX_BUDGET_CAP_USD,
  parseBudgetCap,
  remainingBudgetUsd,
} from '../../../src/shared/agent/budget'

describe('evaluateBudget — the warn/block progression', () => {
  it('walks ok → warn → blocked as the session spends', () => {
    const cap = 2
    expect(evaluateBudget(0, cap).level).toBe('ok')
    expect(evaluateBudget(1.0, cap).level).toBe('ok')
    // §10: amber at 80%.
    expect(evaluateBudget(1.6, cap).level).toBe('warn')
    expect(evaluateBudget(1.99, cap).level).toBe('warn')
    expect(evaluateBudget(2.0, cap).level).toBe('blocked')
    expect(evaluateBudget(3.5, cap).level).toBe('blocked')
  })

  it('puts the warn boundary exactly at the documented fraction', () => {
    const cap = 10
    const boundary = cap * BUDGET_WARN_FRACTION
    expect(evaluateBudget(boundary - 0.001, cap).level).toBe('ok')
    expect(evaluateBudget(boundary, cap).level).toBe('warn')
  })

  it('reports remaining budget, floored at zero on an overshoot', () => {
    expect(evaluateBudget(0.5, 2).remainingUsd).toBeCloseTo(1.5)
    // A turn that crossed the cap cannot be un-spent; remaining is zero, never negative.
    expect(evaluateBudget(2.6, 2).remainingUsd).toBe(0)
  })

  it('clamps the progress fraction to [0, 1] so an overshoot cannot overflow the bar', () => {
    expect(evaluateBudget(1, 2).fraction).toBeCloseTo(0.5)
    expect(evaluateBudget(9, 2).fraction).toBe(1)
  })

  it('is "off" with no cap — the meter still runs, nothing is refused', () => {
    const status = evaluateBudget(500, null)
    expect(status.level).toBe('off')
    expect(status.remainingUsd).toBeNull()
    expect(canStartTurn(status)).toBe(true)
  })

  it('falls back to the default cap on a malformed one — fail-safe, not fail-open', () => {
    // A malformed cap is not a choice anyone made, so reading it as "uncapped" would switch a spend
    // control off exactly when its state is untrustworthy. It degrades to the documented default
    // instead: capped, but never locked out of the chat box.
    for (const bad of [Number.NaN as unknown as number, 0, -5, Number.POSITIVE_INFINITY]) {
      const status = evaluateBudget(1, bad)
      expect(status.level).not.toBe('off')
      expect(status.capUsd).toBe(DEFAULT_BUDGET_CAP_USD)
    }
    // Explicit `null` is the user's own choice and is still honoured.
    expect(evaluateBudget(1, null).level).toBe('off')
  })

  it('degrades a malformed SPEND to zero rather than declaring the user over budget', () => {
    // The total is ours to compute, so a NaN in it is our bug — it must not refuse turns.
    expect(evaluateBudget(Number.NaN, 2).spentUsd).toBe(0)
    expect(evaluateBudget(Number.NaN, 2).level).toBe('ok')
  })
})

describe('canStartTurn — the turn-admission decision', () => {
  it('admits every level except blocked', () => {
    expect(canStartTurn(evaluateBudget(0, 2))).toBe(true)
    expect(canStartTurn(evaluateBudget(1.9, 2))).toBe(true) // warn still sends
    expect(canStartTurn(evaluateBudget(2, 2))).toBe(false)
    expect(canStartTurn(evaluateBudget(999, null))).toBe(true)
  })
})

describe('remainingBudgetUsd — what main hands the SDK as maxBudgetUsd', () => {
  it('is the whole cap for a fresh session', () => {
    expect(remainingBudgetUsd(0, 2)).toBe(2)
  })

  it('shrinks as the session spends', () => {
    expect(remainingBudgetUsd(0.75, 2)).toBeCloseTo(1.25)
  })

  it('is undefined when uncapped, so the option is omitted rather than sent as a sentinel', () => {
    expect(remainingBudgetUsd(1, null)).toBeUndefined()
  })

  it('passes a remaining of zero through — an immediately-ending query is the correct outcome', () => {
    expect(remainingBudgetUsd(5, 2)).toBe(0)
  })
})

describe('parseBudgetCap — the Settings field', () => {
  it('accepts plain money, with or without a dollar sign or padding', () => {
    expect(parseBudgetCap('2')).toBe(2)
    expect(parseBudgetCap('2.50')).toBe(2.5)
    expect(parseBudgetCap('$5.00')).toBe(5)
    expect(parseBudgetCap('  10  ')).toBe(10)
  })

  it('rounds to cents so the cap renders as the number it blocks at', () => {
    expect(parseBudgetCap('1.005')).toBe(1.01)
    expect(parseBudgetCap('1.004')).toBe(1)
  })

  it('rejects zero and negatives — far more likely a typo than an intent to block everything', () => {
    expect(parseBudgetCap('0')).toBeUndefined()
    expect(parseBudgetCap('0.00')).toBeUndefined()
    expect(parseBudgetCap('-3')).toBeUndefined()
  })

  it('rejects a slipped decimal point above the validation ceiling', () => {
    expect(parseBudgetCap(String(MAX_BUDGET_CAP_USD))).toBe(MAX_BUDGET_CAP_USD)
    expect(parseBudgetCap(String(MAX_BUDGET_CAP_USD + 1))).toBeUndefined()
  })

  it('rejects the things `Number` would happily accept', () => {
    for (const input of ['', '  ', 'abc', '0x10', 'Infinity', '1e3', '1,000', '2.5.1', '$']) {
      expect(parseBudgetCap(input)).toBeUndefined()
    }
  })
})

describe('isBudgetCap / isBudgetSetRequest — the wire gates', () => {
  it('accepts a positive cap and explicit null', () => {
    expect(isBudgetCap(2)).toBe(true)
    expect(isBudgetCap(null)).toBe(true)
  })

  it('rejects anything outside the validated range or the wrong type', () => {
    for (const value of [0, -1, MAX_BUDGET_CAP_USD + 1, Number.NaN, Infinity, '2', undefined, {}]) {
      expect(isBudgetCap(value)).toBe(false)
    }
  })

  it('gates the IPC payload on the same rule', () => {
    expect(isBudgetSetRequest({ capUsd: 2 })).toBe(true)
    expect(isBudgetSetRequest({ capUsd: null })).toBe(true)
    expect(isBudgetSetRequest({ capUsd: -1 })).toBe(false)
    expect(isBudgetSetRequest({})).toBe(false)
    expect(isBudgetSetRequest(null)).toBe(false)
  })
})

describe('budgetRefusalMessage', () => {
  it('names the cap and the place to change it', () => {
    const message = budgetRefusalMessage(DEFAULT_BUDGET_CAP_USD)
    expect(message).toContain('$2.00')
    expect(message).toContain('Settings')
    expect(message).toContain('session')
  })

  it('omits an amount it does not have', () => {
    expect(budgetRefusalMessage(null)).not.toContain('$')
  })
})
