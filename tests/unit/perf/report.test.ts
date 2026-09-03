/**
 * Budget evaluation and report diffing — the logic M8.7 will run as a cheap CI job that only
 * compares committed numbers. It never launches the app, so it belongs in the vitest suite.
 */

import { describe, expect, it } from 'vitest'
import {
  BUDGETS,
  budgetActuals,
  budgetTable,
  checkBudgets,
  diffReports,
  type PerfMetrics,
} from '../../../perf/lib/report'
import type { Summary } from '../../../perf/lib/stats'

function summary(median: number): Summary {
  return {
    count: 10,
    min: median,
    p25: median,
    median,
    p75: median,
    p95: median,
    max: median,
    mean: median,
    stdDev: 0,
  }
}

function metrics(overrides: Partial<PerfMetrics> = {}): PerfMetrics {
  return {
    coldStartMs: 1500,
    deckOpenMs: 2000,
    slideSwitchMs: summary(50),
    ramMb: summary(150),
    ramBasis: 'app-metrics-working-set-sum',
    frameIntervalMs: summary(16.7),
    droppedFrames: 0,
    frameRateFps: 60,
    longFrameIntervals: 0,
    idleRamMb: 190,
    rendererHeapMb: summary(40),
    ...overrides,
  }
}

describe('budgetActuals', () => {
  it('projects the median — not the peak — as the RAM number', () => {
    // The roadmap budget is a median. Projecting `max` here would be the single easiest way to make
    // every future perf PR look like a regression.
    const actuals = budgetActuals(metrics({ ramMb: { ...summary(150), max: 900, p95: 800 } }))
    expect(actuals['medianRamMb']).toBe(150)
  })

  it('projects the median slide-switch latency', () => {
    expect(
      budgetActuals(metrics({ slideSwitchMs: { ...summary(50), max: 400 } }))['slideSwitchMs'],
    ).toBe(50)
  })
})

describe('checkBudgets', () => {
  it('passes a report inside every budget', () => {
    const checks = checkBudgets(metrics())
    expect(checks.every((c) => c.pass)).toBe(true)
    expect(checks.map((c) => c.key)).toStrictEqual(BUDGETS.map((b) => b.key))
  })

  it('fails median RAM at exactly the limit, because the budget is strict', () => {
    // "median RAM < 200 MB" — 200.0 is a failure, not a pass.
    expect(
      checkBudgets(metrics({ ramMb: summary(200) })).find((c) => c.key === 'medianRamMb')?.pass,
    ).toBe(false)
    expect(
      checkBudgets(metrics({ ramMb: summary(199.9) })).find((c) => c.key === 'medianRamMb')?.pass,
    ).toBe(true)
  })

  it('fails cold start over 3s and slide switch over 100ms', () => {
    expect(
      checkBudgets(metrics({ coldStartMs: 3200 })).find((c) => c.key === 'coldStartMs')?.pass,
    ).toBe(false)
    expect(
      checkBudgets(metrics({ slideSwitchMs: summary(120) })).find((c) => c.key === 'slideSwitchMs')
        ?.pass,
    ).toBe(false)
  })

  it('treats dropped frames as a non-strict budget so zero passes', () => {
    expect(
      checkBudgets(metrics({ droppedFrames: 0 })).find((c) => c.key === 'droppedFrames')?.pass,
    ).toBe(true)
    expect(
      checkBudgets(metrics({ droppedFrames: 1 })).find((c) => c.key === 'droppedFrames')?.pass,
    ).toBe(false)
  })

  it('throws when a budget names a metric the report does not carry', () => {
    // A silently skipped budget is how a suite goes green while measuring nothing.
    expect(() =>
      checkBudgets(metrics(), [
        { key: 'notAMetric', label: 'Nonexistent', limit: 1, unit: 'ms', strict: true },
      ]),
    ).toThrow(RangeError)
  })
})

describe('diffReports', () => {
  it('flags a regression beyond the tolerance and ignores one inside it', () => {
    const base = metrics({ coldStartMs: 1000 })
    const within = diffReports(base, metrics({ coldStartMs: 1090 })).find(
      (d) => d.key === 'coldStartMs',
    )
    const beyond = diffReports(base, metrics({ coldStartMs: 1150 })).find(
      (d) => d.key === 'coldStartMs',
    )
    expect(within?.regressed).toBe(false)
    expect(within?.deltaPct).toBeCloseTo(9, 6)
    expect(beyond?.regressed).toBe(true)
    expect(beyond?.deltaPct).toBeCloseTo(15, 6)
  })

  it('does not flag an improvement', () => {
    const diff = diffReports(metrics({ ramMb: summary(180) }), metrics({ ramMb: summary(120) }))
    const ram = diff.find((d) => d.key === 'medianRamMb')
    expect(ram?.deltaPct).toBeCloseTo(-33.333, 3)
    expect(ram?.regressed).toBe(false)
  })

  it('treats a zero baseline as a 0% delta rather than Infinity', () => {
    const diff = diffReports(metrics({ droppedFrames: 0 }), metrics({ droppedFrames: 5 }))
    const dropped = diff.find((d) => d.key === 'droppedFrames')
    expect(dropped?.deltaPct).toBe(0)
    expect(Number.isFinite(dropped?.deltaPct ?? Number.NaN)).toBe(true)
  })

  it('honours a custom tolerance', () => {
    const base = metrics({ coldStartMs: 1000 })
    expect(
      diffReports(base, metrics({ coldStartMs: 1050 }), 1).find((d) => d.key === 'coldStartMs')
        ?.regressed,
    ).toBe(true)
    expect(
      diffReports(base, metrics({ coldStartMs: 1050 }), 20).find((d) => d.key === 'coldStartMs')
        ?.regressed,
    ).toBe(false)
  })

  it('rejects a negative tolerance', () => {
    expect(() => diffReports(metrics(), metrics(), -1)).toThrow(RangeError)
  })
})

describe('budgetTable', () => {
  it('renders a markdown table with a verdict per budget', () => {
    const table = budgetTable(checkBudgets(metrics({ ramMb: summary(240) })))
    expect(table).toContain('| Budget | Measured | Limit | Verdict |')
    expect(table).toContain('240.0 MB')
    expect(table).toContain('FAIL')
    expect(table.split('\n')).toHaveLength(BUDGETS.length + 2)
  })
})
