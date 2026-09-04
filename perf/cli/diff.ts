/**
 * `pnpm perf:diff <baseline.json> <candidate.json>` — compare two reports.
 *
 * This is the whole of what M8.7's CI job needs to do. It launches nothing, reads no deck and spawns
 * no Electron: it loads two committed JSON reports and applies the pure rules in `perf/lib/report.ts`.
 * That is what makes a perf gate affordable on GitHub minutes when the suite that produced the
 * numbers is forbidden to run there.
 *
 * Exit codes: `0` clean, `1` a budget failed or a metric regressed beyond tolerance, `2` bad usage.
 */

import { readFile } from 'node:fs/promises'
import { z } from 'zod'
import {
  budgetTable,
  checkBudgets,
  diffReports,
  PerfReportSchema,
  type PerfReport,
} from '../lib/report'

async function loadReport(path: string): Promise<PerfReport> {
  const parsed = PerfReportSchema.safeParse(JSON.parse(await readFile(path, 'utf8')))
  if (!parsed.success) {
    throw new Error(`${path}: not a valid perf report\n${z.prettifyError(parsed.error)}`)
  }
  return parsed.data
}

const mb = (value: number | null): string => (value === null ? 'n/a' : `${value.toFixed(1)} MB`)

/**
 * Idle RAM is reported, never budgeted, so it is never a regression — but a side that is `null` is a
 * run that took no sample inside its idle window, and the row has to say so rather than quietly
 * print a delta against a number that was never measured.
 */
function idleRamRow(baseline: number | null, candidate: number | null): string {
  const verdict =
    baseline === null || candidate === null || baseline === 0
      ? '— | NOT COMPARED |'
      : `${candidate >= baseline ? '+' : ''}${(((candidate - baseline) / baseline) * 100).toFixed(1)}% | info |`
  return `| Idle RAM (starter deck) | ${mb(baseline)} | ${mb(candidate)} | ${verdict}`
}

export async function main(argv: readonly string[]): Promise<void> {
  const positional = argv.filter((a) => !a.startsWith('--'))
  const [baselinePath, candidatePath] = positional
  if (baselinePath === undefined || candidatePath === undefined) {
    console.error('usage: pnpm perf:diff <baseline.json> <candidate.json> [--tolerance=10]')
    process.exitCode = 2
    return
  }
  const toleranceArg = argv.find((a) => a.startsWith('--tolerance='))
  const tolerance =
    toleranceArg === undefined ? 10 : Number(toleranceArg.slice('--tolerance='.length))

  const [baseline, candidate] = await Promise.all([
    loadReport(baselinePath),
    loadReport(candidatePath),
  ])

  if (baseline.deck.slideCount !== candidate.deck.slideCount) {
    console.error(
      `Refusing to diff: baseline ran ${String(baseline.deck.slideCount)} slides, candidate ran ` +
        `${String(candidate.deck.slideCount)}. Compare like with like.`,
    )
    process.exitCode = 2
    return
  }
  if (baseline.metrics.ramBasis !== candidate.metrics.ramBasis) {
    console.error(
      `Refusing to diff: RAM basis differs (${baseline.metrics.ramBasis} vs ${candidate.metrics.ramBasis}).`,
    )
    process.exitCode = 2
    return
  }

  console.log(`baseline  ${baseline.commit.slice(0, 12)}  ${baseline.generatedAt}`)
  console.log(`candidate ${candidate.commit.slice(0, 12)}  ${candidate.generatedAt}`)
  for (const report of [baseline, candidate]) {
    if (report.hostContention.contended) {
      console.log(
        `WARNING: ${report.commit.slice(0, 12)} was measured on a contended machine; timing deltas ` +
          `from it are unreliable.`,
      )
    }
  }

  console.log(`\n${budgetTable(checkBudgets(candidate.metrics))}`)

  const diffs = diffReports(baseline.metrics, candidate.metrics, tolerance)
  console.log('\n| Metric | Baseline | Candidate | Delta | |')
  console.log('|---|---|---|---|---|')
  for (const d of diffs) {
    const sign = d.deltaPct >= 0 ? '+' : ''
    console.log(
      `| ${d.label} | ${d.baseline.toFixed(1)} ${d.unit} | ${d.candidate.toFixed(1)} ${d.unit} | ` +
        `${sign}${d.deltaPct.toFixed(1)}% | ${d.regressed ? 'REGRESSED' : 'ok'} |`,
    )
  }
  console.log(idleRamRow(baseline.metrics.idleRamMb, candidate.metrics.idleRamMb))

  const unmeasured = {
    baseline: baseline.metrics.unmeasuredSwitches,
    candidate: candidate.metrics.unmeasuredSwitches,
  }
  if (unmeasured.baseline > 0 || unmeasured.candidate > 0) {
    console.log(
      `\nUnmeasured switches (no canvas load within the wait bound): baseline ` +
        `${String(unmeasured.baseline)}, candidate ${String(unmeasured.candidate)}` +
        (unmeasured.candidate > 0
          ? ' — a candidate that leaves any switch unmeasured counts as a slide-switch regression.'
          : '.'),
    )
  }

  const budgetFailures = checkBudgets(candidate.metrics).filter((c) => !c.pass)
  const regressions = diffs.filter((d) => d.regressed)
  if (budgetFailures.length > 0 || regressions.length > 0) {
    console.error(
      `\n${String(budgetFailures.length)} budget failure(s), ${String(regressions.length)} regression(s).`,
    )
    process.exitCode = 1
    return
  }
  console.log('\nAll budgets met, no regression beyond tolerance.')
}
