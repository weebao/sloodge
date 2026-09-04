/**
 * `pnpm perf:run` — launch the app, replay the scripted session, emit a report.
 *
 * Runs the whole session N times (default 3) and reports both the pooled distribution and the
 * per-run headline numbers, because run-to-run variance on a developer machine is large enough that
 * a single run is not evidence. Every raw sample and every frame interval is written alongside the
 * report so a later reader can re-derive the summary rather than trust it.
 */

import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { cpus, platform, release, tmpdir, totalmem } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { launchApp } from '../harness/app'
import {
  runSession,
  SWITCH_LOAD_WAIT_MS,
  SWITCH_SETTLE_MS,
  type SessionResult,
  type SwitchRecord,
} from '../harness/session'
import { Sampler, kbToMb, processTypeBreakdown, type Sample } from '../harness/sampler'
import {
  countDroppedFrames,
  frameRateFps,
  missedFrames,
  summarize,
  type Summary,
} from '../lib/stats'
import {
  budgetTable,
  checkBudgets,
  parseRamBasis,
  reportProblems,
  type PerfMetrics,
  type PerfReport,
  type RamBasis,
} from '../lib/report'
import { deckContentHash, type DeckContent } from '../lib/deck'
import type { DeckHashEntry, DeckHashes } from './generate'
import { readDeck, writeDeck, type DeckBundle } from '../../src/main/document/store'

const CDP_PORT_BASE = 9500
const INSPECT_PORT_BASE = 9600

type RunOptions = {
  readonly repoRoot: string
  readonly slideCount: number
  /** The committed `deck-hashes.json` entry the run is labelled with — and checked against. */
  readonly deck: DeckHashEntry
  readonly runs: number
  readonly display: string
  readonly ramBasis: RamBasis
  readonly switchCount: number
  readonly animationDwellMs: number
  readonly idleDwellMs: number
  readonly runExport: boolean
  readonly outFile: string
}

type SingleRun = {
  readonly session: SessionResult
  readonly samples: readonly Sample[]
  readonly marks: readonly { name: string; t: number }[]
  readonly deckReadMs: number
  readonly deckWriteMs: number
}

function ramSeriesMb(samples: readonly Sample[], basis: RamBasis): number[] {
  const values: number[] = []
  for (const sample of samples) {
    const kb =
      basis === 'app-metrics-working-set-sum'
        ? sample.appMetricsWorkingSetKb
        : basis === 'proc-pss-sum'
          ? sample.procPssKb
          : sample.procRssKb
    if (kb === null || kb === undefined) continue
    values.push(kbToMb(kb))
  }
  return values
}

/**
 * Read the stress deck about to be measured and prove it is the one `deck-hashes.json` describes.
 * The record is provenance only if the run checks it: a `perf/decks/` left behind by an older
 * generator, or a `--force --seed=1` regeneration, would otherwise be reported under the committed
 * seed and hash while measuring a different workload.
 *
 * The hash is taken over the `.deck-update.json` payload because that is what the session pushes to
 * the app, and it round-trips `JSON.stringify` byte for byte. The `.sloodge` cannot be hashed the
 * same way — `readDeck` returns its manifest through zod, which normalises it — so its slides are
 * compared against the payload's instead, which proves the same thing transitively.
 */
export async function loadStressDeck(
  deckDir: string,
  expected: DeckHashEntry,
): Promise<{ bundle: DeckBundle; payloadPath: string; deckReadMs: number }> {
  const name = `stress-${String(expected.slideCount)}`
  const payloadPath = join(deckDir, `${name}.deck-update.json`)
  const regenerate = `perf/decks/${name} does not match perf/deck-hashes.json — run pnpm perf:generate`

  const raw = await readFile(payloadPath, 'utf8').catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`${regenerate} (no generated deck on disk).`)
    }
    throw error
  })
  const payload = JSON.parse(raw) as DeckContent
  const hash = deckContentHash(payload)
  if (hash !== expected.contentSha256) {
    throw new Error(
      `${regenerate} (payload content ${hash.slice(0, 12)}, recorded ${expected.contentSha256.slice(0, 12)}).`,
    )
  }

  // The unzip half of a real File ▸ Open, measured with the shipped reader. `File ▸ Open` is not
  // wired to anything yet, so this cost is reported separately rather than folded into deckOpenMs.
  const readStart = Date.now()
  const read = await readDeck(join(deckDir, `${name}.sloodge`))
  if (!read.ok)
    throw new Error(`readDeck failed for the stress deck: ${JSON.stringify(read.error)}`)
  const deckReadMs = Date.now() - readStart

  const order = read.bundle.manifest.slideOrder
  const payloadOrder = payload.manifest.slideOrder
  const sameSlides =
    order.length === payloadOrder.length &&
    order.every((id, i) => id === payloadOrder[i] && read.bundle.slides[id] === payload.slides[id])
  if (!sameSlides) {
    throw new Error(`${regenerate} (the .sloodge's slides differ from the payload's).`)
  }
  return { bundle: read.bundle, payloadPath, deckReadMs }
}

async function runOnce(options: RunOptions, index: number): Promise<SingleRun> {
  const { repoRoot, slideCount, display } = options
  const exportPath = join(
    repoRoot,
    'perf',
    'results',
    `export-${String(slideCount)}-${String(index)}.zip`,
  )
  const { bundle, payloadPath, deckReadMs } = await loadStressDeck(
    join(repoRoot, 'perf', 'decks'),
    options.deck,
  )

  // The roadmap budget is "open **and save** of a 500-slide deck < 5s". Save has no UI path either,
  // so it is timed the same way: the shipped `writeDeck` (zip + fsync + atomic rename) over the
  // bundle just read. Measured out-of-process, so it excludes IPC and any UI the eventual File ▸ Save
  // will add — a floor, not the whole cost.
  const savePath = join(tmpdir(), `sloodge-perf-save-${String(index)}.sloodge`)
  const writeStart = Date.now()
  const written = await writeDeck(savePath, bundle)
  if (!written.ok)
    throw new Error(`writeDeck failed for the stress deck: ${JSON.stringify(written.error)}`)
  const deckWriteMs = Date.now() - writeStart
  await unlink(savePath)

  const app = await launchApp({
    repoRoot,
    cdpPort: CDP_PORT_BASE + index,
    inspectPort: INSPECT_PORT_BASE + index,
    display,
  })
  const startedAtMs = app.spawnedAtMs
  const sampler = new Sampler(app.main, app.page, startedAtMs)
  sampler.start()
  try {
    const session = await runSession({
      page: app.page,
      main: app.main,
      sampler,
      spawnedAtMs: app.spawnedAtMs,
      slideCount,
      deckPayloadPath: payloadPath,
      exportPath,
      switchCount: options.switchCount,
      animationDwellMs: options.animationDwellMs,
      idleDwellMs: options.idleDwellMs,
      runExport: options.runExport,
      assertAlive: app.assertAlive,
    })
    await sampler.stop()
    return {
      session,
      samples: [...sampler.samples],
      marks: [...sampler.marks],
      deckReadMs,
      deckWriteMs,
    }
  } finally {
    await sampler.stop()
    await app.dispose()
    await sleep(1500)
  }
}

function gitSha(repoRoot: string): string {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot }).toString().trim()
  } catch {
    return 'unknown'
  }
}

function electronVersion(repoRoot: string): string {
  try {
    const nodeRequire = createRequire(`${repoRoot}/`)
    const pkg = nodeRequire('electron/package.json') as { version: string }
    return pkg.version
  } catch {
    return 'unknown'
  }
}

export async function main(argv: readonly string[]): Promise<void> {
  const repoRoot = process.cwd()
  const arg = (name: string, fallback: string): string => {
    const found = argv.find((a) => a.startsWith(`--${name}=`))
    return found === undefined ? fallback : found.slice(name.length + 3)
  }

  const slideCount = Number(arg('slides', '100'))
  const runs = Number(arg('runs', '3'))
  const deckMeta = JSON.parse(
    await readFile(join(repoRoot, 'perf', 'deck-hashes.json'), 'utf8'),
  ) as DeckHashes
  const meta = deckMeta[`stress-${String(slideCount)}`]
  if (meta === undefined) {
    throw new Error(
      `No generated deck for ${String(slideCount)} slides — run pnpm perf:generate first.`,
    )
  }
  const options: RunOptions = {
    repoRoot,
    slideCount,
    deck: meta,
    runs,
    display: arg('display', ':0'),
    ramBasis: parseRamBasis(arg('ram-basis', 'app-metrics-working-set-sum')),
    switchCount: Number(arg('switches', '20')),
    animationDwellMs: Number(arg('dwell', '5000')),
    idleDwellMs: Number(arg('idle-dwell', '3000')),
    runExport: !argv.includes('--no-export'),
    outFile: arg('out', join(repoRoot, 'perf', 'results', `run-${String(slideCount)}.json`)),
  }

  await mkdir(join(repoRoot, 'perf', 'results'), { recursive: true })

  const collected: SingleRun[] = []
  for (let index = 0; index < options.runs; index += 1) {
    console.log(
      `\n--- run ${String(index + 1)}/${String(options.runs)} (${String(slideCount)} slides) ---`,
    )
    const result = await runOnce(options, index)
    collected.push(result)
    const ram = ramSeriesMb(result.samples, options.ramBasis)
    console.log(
      `cold start ${result.session.coldStartMs.toFixed(0)} ms | ` +
        `deck render ${result.session.deckRenderMs.toFixed(0)} ms | ` +
        `median RAM ${ram.length > 0 ? summarize(ram).median.toFixed(1) : 'n/a'} MB | ` +
        `samples ${String(result.samples.length)}`,
    )
    for (const warning of result.session.warnings) console.log(`  ! ${warning}`)
  }

  // Pool every run's samples for the distribution; keep per-run headlines for variance.
  const allRam = collected.flatMap((run) => ramSeriesMb(run.samples, options.ramBasis))
  const allSwitches = collected.flatMap((run) => measuredLatencies(run.session.switches))
  const allFrames = collected.flatMap((run) => [...run.session.activeSlideFrameIntervalsMs])
  const allHeap = collected.flatMap((run) =>
    run.samples
      .map((s) => s.rendererHeapUsedKb)
      .filter((v): v is number => v !== null)
      .map(kbToMb),
  )

  const trace = collected.map((run, i) => ({
    run: i,
    marks: run.marks,
    samples: run.samples,
    switches: run.session.switches,
    frameIntervalsMs: run.session.activeSlideFrameIntervalsMs,
  }))

  const unusable = await abortUnusableRun({
    allRam,
    allSwitches,
    ramBasis: options.ramBasis,
    trace,
    outFile: options.outFile,
  })
  if (unusable.length > 0) return

  const metrics: PerfMetrics = {
    coldStartMs: median(collected.map((r) => r.session.coldStartMs)),
    deckOpenMs: median(collected.map((r) => r.session.deckRenderMs)),
    slideSwitchMs: summarize(allSwitches),
    unmeasuredSwitches: collected.reduce(
      (sum, run) => sum + run.session.switches.filter((s) => s.censored).length,
      0,
    ),
    ramMb: summarize(allRam),
    ramBasis: options.ramBasis,
    frameIntervalMs: summarizeOrNull(allFrames),
    droppedFrames: median(
      collected.map((r) =>
        missedFrames(r.session.animationFrameCount, r.session.animationWindowMs),
      ),
    ),
    frameRateFps: median(
      collected.map((r) =>
        frameRateFps(r.session.animationFrameCount, r.session.animationWindowMs),
      ),
    ),
    longFrameIntervals: countDroppedFrames(allFrames),
    idleRamMb:
      summarizeOrNull(
        collected.flatMap((r) => {
          const idle = ramSeriesMb(idleSamples(r), options.ramBasis)
          return idle.length > 0 ? [summarize(idle).median] : []
        }),
      )?.median ?? null,
    rendererHeapMb: summarizeOrNull(allHeap),
  }

  // "Contended" is a coarse flag, not a science: a median 1-minute load above one core's worth of
  // queue per 4 cores, or under 512 MB free, means something else was competing hard enough to
  // inflate these numbers.
  const contentionLoad = summarizeOrNull(
    collected.flatMap((r) => r.samples.map((s) => s.hostLoadAvg1)),
  )
  const contentionFree = summarizeOrNull(
    collected.flatMap((r) => r.samples.map((s) => s.hostMemAvailableMb)),
  )
  const hostContention = {
    loadAvg1: contentionLoad,
    memAvailableMb: contentionFree,
    contended:
      (contentionLoad !== null && contentionLoad.median > cpus().length / 4) ||
      (contentionFree !== null && contentionFree.median < 512),
  }

  const firstCpu = cpus()[0]
  const report: PerfReport = {
    schema: 1,
    commit: gitSha(repoRoot),
    generatedAt: new Date().toISOString(),
    deck: {
      slideCount,
      seed: meta.seed,
      totalSlideBytes: meta.totalSlideBytes,
      archetypeCounts: meta.archetypeCounts,
    },
    environment: {
      platform: platform(),
      release: release(),
      cpuModel: firstCpu?.model ?? 'unknown',
      cpuCount: cpus().length,
      totalMemMb: Math.round(totalmem() / 1_048_576),
      electron: electronVersion(repoRoot),
      node: process.version,
      display: options.display,
    },
    runs: options.runs,
    metrics,
    ramBases: {
      'app-metrics-working-set-sum': summarizeOrNull(
        collected.flatMap((r) => ramSeriesMb(r.samples, 'app-metrics-working-set-sum')),
      ),
      'proc-pss-sum': summarizeOrNull(
        collected.flatMap((r) => ramSeriesMb(r.samples, 'proc-pss-sum')),
      ),
      'proc-rss-sum': summarizeOrNull(
        collected.flatMap((r) => ramSeriesMb(r.samples, 'proc-rss-sum')),
      ),
    },
    processCount: summarizeOrNull(
      collected.flatMap((r) => r.samples.map((s) => s.processes.length)),
    ),
    processTypes: {
      session: processTypeBreakdown(
        collected.flatMap((r) => r.samples),
        options.ramBasis,
      ),
      idle: processTypeBreakdown(collected.flatMap(idleSamples), options.ramBasis),
    },
    hostContention,
    perRun: collected.map((run) => {
      const ram = ramSeriesMb(run.samples, options.ramBasis)
      const switches = measuredLatencies(run.session.switches)
      return {
        coldStartMs: run.session.coldStartMs,
        deckOpenMs: run.session.deckRenderMs,
        medianRamMb: summarizeOrNull(ram)?.median ?? null,
        medianSlideSwitchMs: summarizeOrNull(switches)?.median ?? null,
        unmeasuredSwitches: run.session.switches.filter((s) => s.censored).length,
      }
    }),
    notes: [
      `RAM basis for the headline number: ${options.ramBasis}. See perf/README.md for what each basis means.`,
      `Cold start is a bracket; documentLoadedMs (lower bound, navigation loadEventEnd) per run: ${collected.map((r) => r.session.documentLoadedMs.toFixed(0)).join(', ')}.`,
      `deckReadMs (unzip only, shipped readDeck, per run): ${collected.map((r) => String(r.deckReadMs)).join(', ')}.`,
      `deckWriteMs (zip + fsync + rename, shipped writeDeck, per run): ${collected.map((r) => String(r.deckWriteMs)).join(', ')}.`,
      `deckPublishMs (deck:updated -> every rail frame has a slide:// src): ${collected.map((r) => String(r.session.deckPublishMs)).join(', ')}.`,
      `HTML export ms: ${collected.map((r) => String(r.session.exportHtmlMs ?? -1)).join(', ')}.`,
      `Present phase ms: ${collected.map((r) => String(r.session.presentMs)).join(', ')}.`,
      `Rail scroll ms (summed round-trip of 25 scrollTop steps, settle sleeps excluded): ${collected.map((r) => String(r.session.railScrollMs)).join(', ')}.`,
      `Long-task total ms during the dwell: ${collected.map((r) => r.session.longTaskTotalMs.toFixed(0)).join(', ')}.`,
      `Peak Electron process count: ${collected.map((r) => String(r.session.processCountPeak)).join(', ')}.`,
      `Long tasks during the animation dwell: ${collected.map((r) => String(r.session.longTaskCount)).join(', ')}.`,
      `Shell frame rate during the dwell (fps, per run): ${collected.map((r) => frameRateFps(r.session.animationFrameCount, r.session.animationWindowMs).toFixed(1)).join(', ')}.`,
      `Idle RAM (starter deck, before the stress deck): ${metrics.idleRamMb === null ? 'not sampled' : `${metrics.idleRamMb.toFixed(0)} MB`} on the ${options.ramBasis} basis.`,
      ...(hostContention.contended
        ? [
            'CONTENDED: other processes were competing for this machine while these numbers were ' +
              'taken. Memory figures survive contention well; timing figures (cold start, slide ' +
              'switch, deck open) inflate. Re-baseline on a quiet machine before diffing against this.',
            'frameRateFps and droppedFrames are unreliable under contention: rAF delivery is ' +
              'exactly what a loaded host disrupts, so the frame numbers above are not evidence.',
          ]
        : []),
      ...collected.flatMap((r, i) => r.session.warnings.map((w) => `run ${String(i + 1)}: ${w}`)),
    ],
  }

  const { tracePath, problems } = await writeRunArtifacts(report, trace, options.outFile)

  console.log(`\n${budgetTable(checkBudgets(metrics))}`)
  console.log(`\nReport: ${options.outFile}`)
  console.log(`Trace:  ${tracePath}`)
  if (problems.length > 0) {
    // The run is on disk either way; what the operator must not do is discover months later, at
    // `perf:diff` time, that the file M8.7 gates against was never loadable.
    console.error(
      `\nThe report was written but cannot serve as a baseline:\n  ${problems.join('\n  ')}`,
    )
    process.exitCode = 1
  }
}

/**
 * Write the report and, beside it, the raw series every summary can be re-derived from. Both land
 * on disk before the report is judged — a multi-minute run is kept whatever the verdict — and the
 * judgement is made on the serialized document, because that is what `perf:diff` will read.
 */
export async function writeRunArtifacts(
  report: PerfReport,
  trace: unknown,
  outFile: string,
): Promise<{ tracePath: string; problems: string[] }> {
  const json = `${JSON.stringify(report, null, 2)}\n`
  await writeFile(outFile, json, 'utf8')
  const tracePath = await writeTrace(trace, outFile)
  return { tracePath, problems: reportProblems(JSON.parse(json)) }
}

/** Why a run cannot be summarized at all. */
export type UnusableCause = 'no-ram-samples' | 'no-measured-switches'

/**
 * A budgeted series with no samples is a failed run, not a 0 that happens to be under budget, and
 * `summarize` refuses an empty series — so there is no honest report to write. The trace still holds
 * every sample the session did collect, so it is kept and the verdict is delivered through the same
 * channel as a schema failure: a named cause and a non-zero exit, never a lost run and never a
 * zeroed report `perf:diff` would read as a PASS.
 *
 * Returns the causes it acted on. Empty means the run is summarizable and nothing was written.
 */
export async function abortUnusableRun(options: {
  readonly allRam: readonly number[]
  readonly allSwitches: readonly number[]
  readonly ramBasis: RamBasis
  readonly trace: unknown
  readonly outFile: string
}): Promise<UnusableCause[]> {
  const causes: UnusableCause[] = []
  if (options.allRam.length === 0) causes.push('no-ram-samples')
  if (options.allSwitches.length === 0) causes.push('no-measured-switches')
  if (causes.length === 0) return causes

  const tracePath = await writeTrace(options.trace, options.outFile)
  console.log(`\nTrace:  ${tracePath}`)
  const named = causes
    .map((cause) =>
      cause === 'no-ram-samples'
        ? `No RAM samples on the ${options.ramBasis} basis (proc-* bases need Linux /proc).`
        : 'No slide switch produced a canvas `load` before the next click; every switch is unmeasured. ' +
          'The canvas iframe is not reloading on switch, the recorder is watching the wrong element, ' +
          'every switch targeted the already-active slide (a 1-slide deck), or every switch took ' +
          `longer than ${String(SWITCH_LOAD_WAIT_MS + SWITCH_SETTLE_MS)} ms.`,
    )
    .join('\n  ')
  console.error(`\nNo report was written; the trace above is the run:\n  ${named}`)
  process.exitCode = 1
  return causes
}

/**
 * The raw series, beside the report and named after it. Written even when no report can be.
 *
 * The name is built by appending; a `.json` tail is dropped only so the result reads as one
 * extension rather than two. That keeps it strictly longer than `outFile` for every `--out` a
 * caller can spell, so it can never *be* `outFile`. Substituting the suffix instead left the two
 * paths equal whenever the pattern missed (`--out=mine`, `mine.JSON`, `a.json.bak`), and the trace
 * then overwrote the report it was meant to sit beside.
 */
async function writeTrace(trace: unknown, outFile: string): Promise<string> {
  const tracePath = `${outFile.replace(/\.json$/i, '')}.trace.json`
  await writeFile(tracePath, `${JSON.stringify(trace, null, 2)}\n`, 'utf8')
  return tracePath
}

function measuredLatencies(switches: readonly SwitchRecord[]): number[] {
  return switches.filter((s) => !s.censored).map((s) => s.latencyMs)
}

/** Samples taken while the app sat idle on its starter deck, before the stress deck was pushed. */
function idleSamples(run: SingleRun): Sample[] {
  const start = run.marks.find((m) => m.name === 'idle:start')
  const end = run.marks.find((m) => m.name === 'idle:end')
  if (start === undefined || end === undefined) return []
  return run.samples.filter((s) => s.t >= start.t && s.t <= end.t)
}

function summarizeOrNull(values: readonly number[]): Summary | null {
  return values.length === 0 ? null : summarize(values)
}

function median(values: readonly number[]): number {
  return summarize(values).median
}
