/**
 * Budget evaluation and report diffing — the logic M8.7 will run as a cheap CI job that only
 * compares committed numbers. It never launches the app, so it belongs in the vitest suite.
 */

import { describe, expect, it } from 'vitest'
import {
  BUDGETS,
  parseRamBasis,
  PerfReportSchema,
  RAM_BASES,
  budgetActuals,
  budgetTable,
  checkBudgets,
  diffReports,
  reportProblems,
  METRIC_DEFINITIONS,
  type PerfMetrics,
} from '../../../perf/lib/report'
import type { Summary } from '../../../perf/lib/stats'
import baseline from '../../../perf/results/baseline-main.json'

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

const EMPTY: Summary = {
  count: 0,
  min: 0,
  p25: 0,
  median: 0,
  p75: 0,
  p95: 0,
  max: 0,
  mean: 0,
  stdDev: 0,
}

function metrics(overrides: Partial<PerfMetrics> = {}): PerfMetrics {
  return {
    coldStartMs: 1500,
    deckOpenMs: 2000,
    slideSwitchMs: summary(50),
    unmeasuredSwitches: 0,
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

  it('fails a budget whose series has no samples, even though its median is under the limit', () => {
    // A run with no RAM samples (proc-pss-sum off Linux) or no switch latencies (the canvas
    // selector stopped matching) used to report "0.0 MB PASS". Zero data is a failed measurement.
    const checks = checkBudgets(metrics({ ramMb: EMPTY, slideSwitchMs: EMPTY }))
    expect(checks.find((c) => c.key === 'medianRamMb')?.pass).toBe(false)
    expect(checks.find((c) => c.key === 'slideSwitchMs')?.pass).toBe(false)
    expect(checks.find((c) => c.key === 'medianRamMb')?.samples).toBe(0)
    expect(checks.find((c) => c.key === 'coldStartMs')?.samples).toBeNull()
  })

  it('carries the unmeasured switch count on the slide-switch row and nowhere else', () => {
    const checks = checkBudgets(metrics({ unmeasuredSwitches: 2 }))
    expect(checks.find((c) => c.key === 'slideSwitchMs')?.unmeasured).toBe(2)
    expect(checks.find((c) => c.key === 'slideSwitchMs')?.pass).toBe(true)
    expect(checks.find((c) => c.key === 'medianRamMb')?.unmeasured).toBeNull()
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

  it('marks an empty candidate series as regressed instead of a -100% improvement', () => {
    const diff = diffReports(metrics(), metrics({ ramMb: EMPTY }))
    expect(diff.find((d) => d.key === 'medianRamMb')?.regressed).toBe(true)
    expect(diff.find((d) => d.key === 'coldStartMs')?.regressed).toBe(false)
  })

  it('flags any unmeasured switch in the candidate as a regression even when the median improved', () => {
    // A switch too slow for the instrument to see is a slow switch. Before the harness waited for
    // each load, such switches simply left the series and a bimodal regression passed the median.
    const base = metrics({ unmeasuredSwitches: 0 })
    const slower = diffReports(base, metrics({ slideSwitchMs: summary(40), unmeasuredSwitches: 1 }))
    expect(slower.find((d) => d.key === 'slideSwitchMs')?.regressed).toBe(true)
    expect(slower.find((d) => d.key === 'coldStartMs')?.regressed).toBe(false)
    // Judged against 0, not against the baseline's own count: a baseline that censored switches
    // must not buy a candidate that many too-slow-to-see switches for free.
    const same = diffReports(metrics({ unmeasuredSwitches: 3 }), metrics({ unmeasuredSwitches: 3 }))
    expect(same.find((d) => d.key === 'slideSwitchMs')?.regressed).toBe(true)
    const fewer = diffReports(
      metrics({ unmeasuredSwitches: 3 }),
      metrics({ unmeasuredSwitches: 1 }),
    )
    expect(fewer.find((d) => d.key === 'slideSwitchMs')?.regressed).toBe(true)
    const clean = diffReports(
      metrics({ unmeasuredSwitches: 3 }),
      metrics({ unmeasuredSwitches: 0 }),
    )
    expect(clean.find((d) => d.key === 'slideSwitchMs')?.regressed).toBe(false)
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

  /**
   * A metric whose *definition* changed between the two reports is not compared: M8.2 redefined
   * `deckOpenMs` from "a frame per slide" to "every mounted frame", and a diff that scored the
   * 1943 → 500 ms drop as an improvement would be scoring the redefinition. A report without the
   * field predates it and is version 1 throughout.
   */
  it('does not score a metric whose definition version differs, and says which versions', () => {
    const diff = diffReports(
      metrics({ deckOpenMs: 4000 }),
      metrics({ deckOpenMs: 100 }),
      10,
      BUDGETS,
      {
        baseline: {},
        candidate: METRIC_DEFINITIONS,
      },
    ).find((d) => d.key === 'deckOpenMs')
    expect(diff?.definition).toEqual({ baseline: 1, candidate: 2 })
    expect(diff?.regressed).toBe(false)

    const worse = diffReports(
      metrics({ deckOpenMs: 100 }),
      metrics({ deckOpenMs: 4000 }),
      10,
      BUDGETS,
      {
        baseline: {},
        candidate: METRIC_DEFINITIONS,
      },
    ).find((d) => d.key === 'deckOpenMs')
    expect(worse?.regressed).toBe(false)
  })

  it('scores a metric normally when both reports carry the same definition version', () => {
    const same = { baseline: METRIC_DEFINITIONS, candidate: METRIC_DEFINITIONS }
    const diff = diffReports(
      metrics({ deckOpenMs: 100 }),
      metrics({ deckOpenMs: 4000 }),
      10,
      BUDGETS,
      same,
    )
    expect(diff.find((d) => d.key === 'deckOpenMs')?.regressed).toBe(true)
    expect(diff.every((d) => d.definition.baseline === d.definition.candidate)).toBe(true)
  })

  it('pins deckOpenMs at definition version 2 since M8.2', () => {
    expect(METRIC_DEFINITIONS['deckOpenMs']).toBe(2)
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

  it('renders the comparison each budget was actually evaluated with', () => {
    // `droppedFrames` is the one `strict: false` budget (limit 0), so it passes at exactly 0 —
    // and printing `< 0 frames` beside a passing 0.0 made the instrument contradict itself in the
    // table six perf PRs are read against. Every other row stays exclusive.
    const table = budgetTable(checkBudgets(metrics()))
    expect(table).toContain('| Dropped frames on the active slide | 0.0 frames | \u2264 0 frames |')
    expect(table).toContain('\u2264 0 frames | PASS |')
    expect(table).not.toContain('< 0 frames')
    expect(table).toContain('| Median RAM during stress suite | 150.0 MB | < 200 MB | PASS |')
  })

  it('prints "no samples" rather than 0.0 for an empty series', () => {
    const table = budgetTable(checkBudgets(metrics({ slideSwitchMs: EMPTY })))
    expect(table).toContain('| Slide switch (median) | no samples | < 100 ms | FAIL |')
  })

  it('downgrades a passing slide-switch row to WARN when switches went unmeasured', () => {
    const table = budgetTable(checkBudgets(metrics({ unmeasuredSwitches: 2 })))
    expect(table).toContain('| Slide switch (median) | 50.0 ms (+2 unmeasured) | < 100 ms | WARN |')
    expect(table).toContain('| Median RAM during stress suite | 150.0 MB | < 200 MB | PASS |')
    expect(
      budgetTable(checkBudgets(metrics({ slideSwitchMs: summary(120), unmeasuredSwitches: 2 }))),
    ).toContain('| Slide switch (median) | 120.0 ms (+2 unmeasured) | < 100 ms | FAIL |')
  })
})

describe('PerfReportSchema', () => {
  it('accepts the committed baseline', () => {
    expect(PerfReportSchema.safeParse(baseline).success).toBe(true)
  })

  it('names the missing field of a truncated report instead of crashing inside budgetActuals', () => {
    const { ramMb: _dropped, ...truncated } = baseline.metrics
    const result = PerfReportSchema.safeParse({ ...baseline, metrics: truncated })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues.map((issue) => issue.path.join('.'))).toContain('metrics.ramMb')
    }
  })

  it('rejects a report of another schema version', () => {
    expect(PerfReportSchema.safeParse({ ...baseline, schema: 2 }).success).toBe(false)
  })

  it('accepts a null idle RAM and a null per-run median, as the harness writes them', () => {
    // `JSON.stringify` writes NaN as null. These fields used to be typed `number`, so a run with no
    // idle samples produced a file the schema then refused.
    const document: unknown = JSON.parse(
      JSON.stringify({
        ...baseline,
        metrics: { ...baseline.metrics, idleRamMb: Number.NaN },
        perRun: baseline.perRun.map((run, i) =>
          i === 0 ? { ...run, medianSlideSwitchMs: Number.NaN } : run,
        ),
      }),
    )
    const result = PerfReportSchema.safeParse(document)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.metrics.idleRamMb).toBeNull()
      expect(result.data.perRun[0]?.medianSlideSwitchMs).toBeNull()
    }
  })
})

describe('reportProblems', () => {
  it('finds nothing wrong with the committed baseline', () => {
    expect(reportProblems(baseline)).toStrictEqual([])
  })

  it('names a null idle RAM and a null per-run median as unfit for a baseline', () => {
    const problems = reportProblems({
      ...baseline,
      metrics: { ...baseline.metrics, idleRamMb: null },
      perRun: baseline.perRun.map((run, i) =>
        i === 1 ? { ...run, medianSlideSwitchMs: null } : run,
      ),
    })
    expect(problems).toHaveLength(2)
    expect(problems[0]).toMatch(/metrics\.idleRamMb is null/)
    expect(problems[1]).toMatch(/perRun\[1\]\.medianSlideSwitchMs is null/)
  })

  it('reports a schema failure by field', () => {
    const { ramMb: _dropped, ...truncated } = baseline.metrics
    const problems = reportProblems({ ...baseline, metrics: truncated })
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('metrics.ramMb')
  })
})

describe('parseRamBasis', () => {
  it('accepts every documented basis', () => {
    for (const basis of RAM_BASES) expect(parseRamBasis(basis)).toBe(basis)
  })

  it('rejects an unknown basis instead of silently summarizing an empty series', () => {
    // A cast here would accept `--ram-basis=pss`, then report a median over zero samples. Failing
    // loudly is the point: this milestone exists so the RAM number cannot be quietly wrong.
    expect(() => parseRamBasis('pss')).toThrow(RangeError)
    expect(() => parseRamBasis('')).toThrow(RangeError)
  })
})
