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

import { z } from 'zod'
import type { Summary } from './stats'
import type { ProcessTypeBreakdown } from '../harness/sampler'

/** Which memory series a report treats as *the* RAM number. See `perf/README.md` §"What RAM means". */
export const RAM_BASES = ['app-metrics-working-set-sum', 'proc-pss-sum', 'proc-rss-sum'] as const
export type RamBasis = (typeof RAM_BASES)[number]

/**
 * Parse a `--ram-basis` argument.
 *
 * @throws RangeError on an unknown basis. A cast here instead would accept `--ram-basis=pss`
 *   silently and then summarize an empty series, reporting the wrong memory number rather than
 *   failing — the exact class of quiet error this milestone exists to avoid.
 */
export function parseRamBasis(value: string): RamBasis {
  const found = RAM_BASES.find((basis) => basis === value)
  if (found === undefined) {
    throw new RangeError(`Unknown --ram-basis "${value}"; expected one of ${RAM_BASES.join(', ')}`)
  }
  return found
}

export type PerfMetrics = {
  /** Process spawn → the shell is interactive in the renderer. */
  readonly coldStartMs: number
  /** Deck adopted → every rail frame has settled. */
  readonly deckOpenMs: number
  /** Per-switch latency distribution, click → the canvas frame's `load`. Measured switches only. */
  readonly slideSwitchMs: Summary
  /**
   * Switches whose `load` never landed inside the harness's wait bound. They are censored, not
   * dropped: `slideSwitchMs.count + unmeasuredSwitches` is the number of clicks issued, so a series
   * that is short is short *visibly*. Expected to be 0 on a healthy run, which is why `diffReports`
   * treats any non-zero value in a candidate as a slide-switch regression: it is a slow-switch
   * signal the median alone would not show.
   */
  readonly unmeasuredSwitches: number
  /** Total memory across every Electron process, sampled through the whole session. */
  readonly ramMb: Summary
  /** Which series `ramMb` was computed from. */
  readonly ramBasis: RamBasis
  /**
   * Frame intervals recorded in the renderer while the active slide animates. Null when the dwell
   * recorded no frames at all (an occluded window under WSLg does this); not a budget, so an empty
   * series is reported as absent rather than failing the run.
   */
  readonly frameIntervalMs: Summary | null
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
  /**
   * Median RAM with the app idle on its starter deck, before the stress deck is pushed. Null when
   * the idle window had no samples (`--idle-dwell=0`); the run is still written, but not as a baseline.
   */
  readonly idleRamMb: number | null
  /** Renderer JS heap, sampled with the same cadence as `ramMb`. Null if no read succeeded. */
  readonly rendererHeapMb: Summary | null
}

/**
 * The version of each budgeted metric's *definition*, as this harness computes it. A metric absent
 * here is at version 1, and a report that carries no `metricDefinitions` at all predates the field
 * and is version 1 throughout.
 *
 * `deckOpenMs` is at 2: through M8.1 it waited for a rail frame per slide; since M8.2 the rail mounts
 * a frame only for the cards in its scroll window, so it waits for every *mounted* frame instead — a
 * different quantity, not a faster one. `perf:diff` refuses to score a metric whose definition
 * differs between the two reports, so a redefinition can never be read as an improvement.
 */
export const METRIC_DEFINITIONS: Readonly<Record<string, number>> = { deckOpenMs: 2 }

export type PerfReport = {
  readonly schema: 1
  readonly commit: string
  /** See `METRIC_DEFINITIONS`. Absent in reports written before M8.2 round 1: version 1 throughout. */
  readonly metricDefinitions?: Readonly<Record<string, number>>
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
   * Memory and process count by Chromium process type, on `metrics.ramBasis`, for the whole session
   * and for the idle window alone. This is how a reader tells "the app grew" from "the GPU process
   * happened to be alive this time" without opening the trace.
   */
  readonly processTypes: {
    readonly session: Readonly<Record<string, ProcessTypeBreakdown>>
    readonly idle: Readonly<Record<string, ProcessTypeBreakdown>>
  }
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
  /**
   * Per-run headline numbers, so a reader can judge run-to-run variance directly. A median is null
   * when that run had no samples for it — written as `null`, never as a `NaN` the file cannot hold.
   */
  readonly perRun: readonly {
    readonly coldStartMs: number
    readonly deckOpenMs: number
    readonly medianRamMb: number | null
    readonly medianSlideSwitchMs: number | null
    readonly unmeasuredSwitches: number
  }[]
  readonly notes: readonly string[]
}

const SummarySchema = z.object({
  count: z.number(),
  min: z.number(),
  p25: z.number(),
  median: z.number(),
  p75: z.number(),
  p95: z.number(),
  max: z.number(),
  mean: z.number(),
  stdDev: z.number(),
})

const ProcessTypeBreakdownSchema = z.object({
  processes: SummarySchema,
  memoryMb: SummarySchema.nullable(),
})

/**
 * Runtime mirror of `PerfReport`, for the committed JSON `perf:diff` reads. `satisfies` keeps the
 * two from drifting: a field added to the type without a schema line fails to compile. A truncated
 * or hand-edited report is refused by name here rather than crashing inside `budgetActuals`.
 */
export const PerfReportSchema = z.object({
  schema: z.literal(1),
  commit: z.string(),
  generatedAt: z.string(),
  deck: z.object({
    slideCount: z.number(),
    seed: z.number(),
    totalSlideBytes: z.number(),
    archetypeCounts: z.record(z.string(), z.number()),
  }),
  environment: z.object({
    platform: z.string(),
    release: z.string(),
    cpuModel: z.string(),
    cpuCount: z.number(),
    totalMemMb: z.number(),
    electron: z.string(),
    node: z.string(),
    display: z.string(),
  }),
  runs: z.number(),
  metrics: z.object({
    coldStartMs: z.number(),
    deckOpenMs: z.number(),
    slideSwitchMs: SummarySchema,
    unmeasuredSwitches: z.number(),
    ramMb: SummarySchema,
    ramBasis: z.enum(RAM_BASES),
    frameIntervalMs: SummarySchema.nullable(),
    droppedFrames: z.number(),
    frameRateFps: z.number(),
    longFrameIntervals: z.number(),
    idleRamMb: z.number().nullable(),
    rendererHeapMb: SummarySchema.nullable(),
  }),
  ramBases: z.record(z.string(), SummarySchema.nullable()),
  processCount: SummarySchema.nullable(),
  processTypes: z.object({
    session: z.record(z.string(), ProcessTypeBreakdownSchema),
    idle: z.record(z.string(), ProcessTypeBreakdownSchema),
  }),
  hostContention: z.object({
    loadAvg1: SummarySchema.nullable(),
    memAvailableMb: SummarySchema.nullable(),
    contended: z.boolean(),
  }),
  perRun: z.array(
    z.object({
      coldStartMs: z.number(),
      deckOpenMs: z.number(),
      medianRamMb: z.number().nullable(),
      medianSlideSwitchMs: z.number().nullable(),
      unmeasuredSwitches: z.number(),
    }),
  ),
  notes: z.array(z.string()),
}) satisfies z.ZodType<PerfReport>

/**
 * Why a serialized report cannot serve as a baseline: it fails the schema, or a headline field holds
 * `null` where a number was expected. Run on the JSON document rather than the in-memory report,
 * because serialization is where a `NaN` turns into a `null` — the write side used to emit exactly
 * that, and `perf:diff` refused the file months later. Empty means fit.
 */
export function reportProblems(document: unknown): string[] {
  const parsed = PerfReportSchema.safeParse(document)
  if (!parsed.success) return [z.prettifyError(parsed.error)]
  const { metrics, perRun } = parsed.data
  const problems: string[] = []
  if (metrics.idleRamMb === null) {
    problems.push(
      'metrics.idleRamMb is null: no RAM sample fell inside the idle window (--idle-dwell=0?).',
    )
  }
  for (const [i, run] of perRun.entries()) {
    if (run.medianRamMb === null) {
      problems.push(`perRun[${String(i)}].medianRamMb is null: that run had no RAM samples.`)
    }
    if (run.medianSlideSwitchMs === null) {
      problems.push(
        `perRun[${String(i)}].medianSlideSwitchMs is null: none of that run's switches was measured.`,
      )
    }
  }
  return problems
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
  /** Sample count behind `actual` for series-backed budgets; null for scalar metrics. */
  readonly samples: number | null
  /** Switches the series could not include (slide switch only); null for every other budget. */
  readonly unmeasured: number | null
  /**
   * Whether the limit is exclusive. Carried onto the check so `budgetTable` can render the
   * comparison it was actually evaluated with: `droppedFrames` is the one non-strict budget, and
   * printing `< 0 frames` beside a passing 0.0 made the instrument contradict itself.
   */
  readonly strict: boolean
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
 * Sample counts behind the series-backed budgets. A budget over zero samples is a hard failure,
 * never a pass: `summarize` refuses an empty series, but a hand-edited or older report can still
 * carry a `count: 0` summary whose median is 0, and 0 MB is inside every budget.
 */
function budgetSampleCounts(metrics: PerfMetrics): Readonly<Record<string, number>> {
  return {
    slideSwitchMs: metrics.slideSwitchMs.count,
    medianRamMb: metrics.ramMb.count,
  }
}

/** Observations a series-backed budget could not include; the switch series is the only one that censors. */
function budgetUnmeasured(metrics: PerfMetrics): Readonly<Record<string, number>> {
  return { slideSwitchMs: metrics.unmeasuredSwitches }
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
  const counts = budgetSampleCounts(metrics)
  const unmeasured = budgetUnmeasured(metrics)
  return budgets.map((budget) => {
    const actual = actuals[budget.key]
    if (actual === undefined) {
      throw new RangeError(`Budget "${budget.key}" has no matching metric in the report`)
    }
    const samples = counts[budget.key] ?? null
    const within = budget.strict ? actual < budget.limit : actual <= budget.limit
    return {
      key: budget.key,
      label: budget.label,
      limit: budget.limit,
      actual,
      unit: budget.unit,
      samples,
      unmeasured: unmeasured[budget.key] ?? null,
      strict: budget.strict,
      pass: samples !== 0 && within,
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
  /**
   * True when the candidate regressed by more than the allowed tolerance, measured nothing, or left
   * any switch unmeasured — a censored switch is a slow one, and a healthy run leaves none.
   */
  readonly regressed: boolean
  /**
   * Definition versions on each side. When they differ the two numbers measure different things,
   * `regressed` is false, and the caller is expected to say so rather than print a delta.
   */
  readonly definition: { readonly baseline: number; readonly candidate: number }
}

/** The definition versions two reports carry, for `diffReports`. */
export type DefinitionPair = {
  readonly baseline: Readonly<Record<string, number>>
  readonly candidate: Readonly<Record<string, number>>
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
 *
 * `unmeasuredSwitches` is judged against zero rather than against the baseline's own count. The
 * click sequence never clicks the already-active slide, so a healthy run censors nothing; comparing
 * against a baseline that carries a count would let exactly that many too-slow-to-see switches
 * through on a strict-rise test. The five committed baselines predate that click sequence and carry
 * counts no current run can reproduce — their `notes` say so.
 */
export function diffReports(
  baseline: PerfMetrics,
  candidate: PerfMetrics,
  tolerancePct = 10,
  budgets: readonly Budget[] = BUDGETS,
  definitions: DefinitionPair = { baseline: {}, candidate: {} },
): MetricDiff[] {
  if (tolerancePct < 0) throw new RangeError('Tolerance must be non-negative')
  const before = budgetActuals(baseline)
  const after = budgetActuals(candidate)
  const candidateCounts = budgetSampleCounts(candidate)
  const unmeasuredAfter = budgetUnmeasured(candidate)
  return budgets.map((budget) => {
    const b = before[budget.key]
    const c = after[budget.key]
    if (b === undefined || c === undefined) {
      throw new RangeError(`Budget "${budget.key}" has no matching metric in both reports`)
    }
    const definition = {
      baseline: definitions.baseline[budget.key] ?? 1,
      candidate: definitions.candidate[budget.key] ?? 1,
    }
    const comparable = definition.baseline === definition.candidate
    const deltaPct = b === 0 ? 0 : ((c - b) / b) * 100
    return {
      key: budget.key,
      label: budget.label,
      baseline: b,
      candidate: c,
      deltaPct,
      unit: budget.unit,
      regressed:
        comparable &&
        (candidateCounts[budget.key] === 0 ||
          deltaPct > tolerancePct ||
          (unmeasuredAfter[budget.key] ?? 0) > 0),
      definition,
    }
  })
}

/** Render budget checks as a markdown table, for pasting into a perf PR description. */
export function budgetTable(checks: readonly BudgetCheck[]): string {
  const rows = checks.map((check) => {
    const unmeasured =
      check.unmeasured !== null && check.unmeasured > 0
        ? ` (+${String(check.unmeasured)} unmeasured)`
        : ''
    const measured =
      check.samples === 0
        ? `no samples${unmeasured}`
        : `${check.actual.toFixed(1)} ${check.unit}${unmeasured}`
    const verdict = !check.pass ? 'FAIL' : unmeasured === '' ? 'PASS' : 'WARN'
    const comparison = check.strict ? '<' : '\u2264'
    return `| ${check.label} | ${measured} | ${comparison} ${String(check.limit)} ${check.unit} | ${verdict} |`
  })
  return ['| Budget | Measured | Limit | Verdict |', '|---|---|---|---|', ...rows].join('\n')
}
