/**
 * Budget evaluation and report diffing.
 *
 * This is the half of M8.1 that M8.7 will run in CI. M8.7's job is explicitly *not* to launch the
 * app — it compares committed numbers — so everything here is pure: no clock, no filesystem, no
 * Electron. The harness produces a `PerfReport`; this module answers the only two questions anyone
 * asks of one: "does it meet the budgets?" and "did it get worse than the committed baseline?"
 *
 * The budgets are quoted from 80-roadmap.md and are enforced, not aspirational. Note that the RAM
 * budget is a **median**, which is why `PerfMetrics` carries `medianRssMb` rather than a peak: a
 * harness that reported only the peak could not evaluate the budget it was built to evaluate.
 */

import type { Summary } from './stats'

/** Which memory series a report treats as *the* RAM number. See `perf/README.md` §"What RAM means". */
export type RamBasis = 'app-metrics-working-set-sum' | 'proc-pss-sum' | 'proc-rss-sum'

export type PerfMetrics = {
  /** Process spawn → the shell is interactive in the renderer. */
  readonly coldStartMs: number
  /** Deck adopted → every rail frame has settled. */
  readonly deckOpenMs: number
  /** Per-switch latency distribution, click → the canvas frame's `load`. */
  readonly slideSwitchMs: Summary
  /** Total memory across every Electron process, sampled through the whole session. */
  readonly ramMb: Summary
  /** Which series `ramMb` was computed from. */
  readonly ramBasis: RamBasis
  /** Frame intervals recorded in the renderer while the active slide animates. */
  readonly frameIntervalMs: Summary
  /**
   * Frames missed against a 60 Hz ideal over the animation dwell — see `missedFrames` in stats.ts
   * for why this replaced a count of over-long intervals (that count is not monotonic once the
   * frame stream collapses, and it scored a 1.9 fps run *better* than a 7 fps one).
   */
  readonly droppedFrames: number
  /** Achieved shell frame rate during the dwell. Reported, never a budget: higher is better. */
  readonly frameRateFps: number
  /** Over-long intervals, kept as a secondary signal alongside the budget number. */
  readonly longFrameIntervals: number
  /** Median RAM with the app idle on its starter deck, before the stress deck is pushed. */
  readonly idleRamMb: number
  /** Renderer JS heap, sampled with the same cadence as `ramMb`. */
  readonly rendererHeapMb: Summary
}

export type PerfReport = {
  readonly schema: 1
  readonly commit: string
  readonly generatedAt: string
  readonly deck: {
    readonly slideCount: number
    readonly seed: number
    readonly totalSlideBytes: number
    readonly archetypeCounts: Readonly<Record<string, number>>
  }
  readonly environment: {
    readonly platform: string
    readonly release: string
    readonly cpuModel: string
    readonly cpuCount: number
    readonly totalMemMb: number
    readonly electron: string
    readonly node: string
    readonly display: string
  }
  readonly runs: number
  readonly metrics: PerfMetrics
  /**
   * Every memory basis, so the headline number can be re-derived under a different definition
   * without re-running the suite. On this app the three disagree by an order of magnitude, because
   * one renderer process per slide makes a working-set sum double-count shared pages ~100x over.
   */
  readonly ramBases: Readonly<Record<string, Summary | null>>
  /** Electron process count over the session — the driver behind the memory numbers. */
  readonly processCount: Summary | null
  /**
   * What else the host was doing while these numbers were taken. This box also runs other agents'
   * test suites, so a baseline that omits its own contention cannot be diffed honestly later.
   */
  readonly hostContention: {
    readonly loadAvg1: Summary | null
    readonly memAvailableMb: Summary | null
    /** Set when contention was high enough that the numbers should be treated as inflated. */
    readonly contended: boolean
  }
  /** Per-run headline numbers, so a reader can judge run-to-run variance directly. */
  readonly perRun: readonly {
    readonly coldStartMs: number
    readonly deckOpenMs: number
    readonly medianRamMb: number
    readonly medianSlideSwitchMs: number
  }[]
  readonly notes: readonly string[]
}

export type Budget = {
  readonly key: string
  readonly label: string
  readonly limit: number
  readonly unit: string
  /** Roadmap wording: "< 3s", "< 100ms", "< 200 MB" — strict, so equality fails. */
  readonly strict: boolean
}

/** The budgets from 80-roadmap.md, Milestone 8. */
export const BUDGETS: readonly Budget[] = [
  {
    key: 'coldStartMs',
    label: 'Cold start to interactive shell',
    limit: 3000,
    unit: 'ms',
    strict: true,
  },
  { key: 'slideSwitchMs', label: 'Slide switch (median)', limit: 100, unit: 'ms', strict: true },
  {
    key: 'medianRamMb',
    label: 'Median RAM during stress suite',
    limit: 200,
    unit: 'MB',
    strict: true,
  },
  {
    key: 'droppedFrames',
    label: 'Dropped frames on the active slide',
    limit: 0,
    unit: 'frames',
    strict: false,
  },
  // The roadmap states this budget for a 500-slide deck specifically. The harness evaluates it
  // against whichever deck it ran, so a 100-slide PASS here is not evidence for the 500-slide claim;
  // the report records `deck.slideCount` so the two can never be confused.
  {
    key: 'deckOpenMs',
    label: 'Open the stress deck (roadmap budget is stated for 500 slides)',
    limit: 5000,
    unit: 'ms',
    strict: true,
  },
]

export type BudgetCheck = {
  readonly key: string
  readonly label: string
  readonly limit: number
  readonly actual: number
  readonly unit: string
  readonly pass: boolean
}

/** Project the report's metrics onto the flat keys the budgets name. */
export function budgetActuals(metrics: PerfMetrics): Readonly<Record<string, number>> {
  return {
    coldStartMs: metrics.coldStartMs,
    slideSwitchMs: metrics.slideSwitchMs.median,
    medianRamMb: metrics.ramMb.median,
    droppedFrames: metrics.droppedFrames,
    deckOpenMs: metrics.deckOpenMs,
  }
}

/**
 * Evaluate every budget against a report.
 *
 * @throws RangeError when a budget names a metric the report does not carry — a silently skipped
 *   budget is how a suite ends up green while measuring nothing.
 */
export function checkBudgets(
  metrics: PerfMetrics,
  budgets: readonly Budget[] = BUDGETS,
): BudgetCheck[] {
  const actuals = budgetActuals(metrics)
  return budgets.map((budget) => {
    const actual = actuals[budget.key]
    if (actual === undefined) {
      throw new RangeError(`Budget "${budget.key}" has no matching metric in the report`)
    }
    return {
      key: budget.key,
      label: budget.label,
      limit: budget.limit,
      actual,
      unit: budget.unit,
      pass: budget.strict ? actual < budget.limit : actual <= budget.limit,
    }
  })
}

export type MetricDiff = {
  readonly key: string
  readonly label: string
  readonly baseline: number
  readonly candidate: number
  readonly deltaPct: number
  readonly unit: string
  /** True when the candidate regressed by more than the allowed tolerance. */
  readonly regressed: boolean
}

/**
 * Compare a candidate report against a committed baseline.
 *
 * M8.7's gate, stated in 80-roadmap.md: "fails if median RAM ≥ 200 MB, startup or switch budgets
 * regress > 10 %". Lower is better for every metric here, so a positive delta is a regression.
 *
 * A baseline of 0 is treated as "no percentage is meaningful" and yields a 0 % delta rather than
 * `Infinity`; that only arises for `droppedFrames`, where the absolute budget check is the real
 * gate anyway.
 */
export function diffReports(
  baseline: PerfMetrics,
  candidate: PerfMetrics,
  tolerancePct = 10,
  budgets: readonly Budget[] = BUDGETS,
): MetricDiff[] {
  if (tolerancePct < 0) throw new RangeError('Tolerance must be non-negative')
  const before = budgetActuals(baseline)
  const after = budgetActuals(candidate)
  return budgets.map((budget) => {
    const b = before[budget.key]
    const c = after[budget.key]
    if (b === undefined || c === undefined) {
      throw new RangeError(`Budget "${budget.key}" has no matching metric in both reports`)
    }
    const deltaPct = b === 0 ? 0 : ((c - b) / b) * 100
    return {
      key: budget.key,
      label: budget.label,
      baseline: b,
      candidate: c,
      deltaPct,
      unit: budget.unit,
      regressed: deltaPct > tolerancePct,
    }
  })
}

/** Render budget checks as a markdown table, for pasting into a perf PR description. */
export function budgetTable(checks: readonly BudgetCheck[]): string {
  const rows = checks.map(
    (check) =>
      `| ${check.label} | ${check.actual.toFixed(1)} ${check.unit} | < ${String(check.limit)} ${check.unit} | ${check.pass ? 'PASS' : 'FAIL'} |`,
  )
  return ['| Budget | Measured | Limit | Verdict |', '|---|---|---|---|', ...rows].join('\n')
}
