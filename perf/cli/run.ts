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
import { runSession, type SessionResult } from '../harness/session'
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
  type PerfMetrics,
  type PerfReport,
  type RamBasis,
} from '../lib/report'
import { readDeck, writeDeck } from '../../src/main/document/store'

const CDP_PORT_BASE = 9500
const INSPECT_PORT_BASE = 9600

type RunOptions = {
  readonly repoRoot: string
  readonly slideCount: number
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

async function runOnce(options: RunOptions, index: number): Promise<SingleRun> {
  const { repoRoot, slideCount, display } = options
  const deckDir = join(repoRoot, 'perf', 'decks')
  const sloodgePath = join(deckDir, `stress-${String(slideCount)}.sloodge`)
  const payloadPath = join(deckDir, `stress-${String(slideCount)}.deck-update.json`)
  const exportPath = join(
    repoRoot,
    'perf',
    'results',
    `export-${String(slideCount)}-${String(index)}.zip`,
  )

  // The unzip half of a real File ▸ Open, measured with the shipped reader. `File ▸ Open` is not
  // wired to anything yet, so this cost is reported separately rather than folded into deckOpenMs.
  const readStart = Date.now()
  const read = await readDeck(sloodgePath)
  if (!read.ok)
    throw new Error(`readDeck failed for the stress deck: ${JSON.stringify(read.error)}`)
  const deckReadMs = Date.now() - readStart

  // The roadmap budget is "open **and save** of a 500-slide deck < 5s". Save has no UI path either,
  // so it is timed the same way: the shipped `writeDeck` (zip + fsync + atomic rename) over the
  // bundle just read. Measured out-of-process, so it excludes IPC and any UI the eventual File ▸ Save
  // will add — a floor, not the whole cost.
  const savePath = join(tmpdir(), `sloodge-perf-save-${String(index)}.sloodge`)
  const writeStart = Date.now()
  const written = await writeDeck(savePath, read.bundle)
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
  const options: RunOptions = {
    repoRoot,
    slideCount,
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

  const deckMeta = JSON.parse(
    await readFile(join(repoRoot, 'perf', 'deck-hashes.json'), 'utf8'),
  ) as Record<
    string,
    {
      seed: number
      slideCount: number
      totalSlideBytes: number
      archetypeCounts: Record<string, number>
    }
  >
  const meta = deckMeta[`stress-${String(slideCount)}`]
  if (meta === undefined) {
    throw new Error(
      `No generated deck for ${String(slideCount)} slides — run pnpm perf:generate first.`,
    )
  }

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
  const allSwitches = collected.flatMap((run) =>
    run.session.switches.map((s) => s.latencyMs).filter((v): v is number => v !== null),
  )
  const allFrames = collected.flatMap((run) => [...run.session.activeSlideFrameIntervalsMs])
  const allHeap = collected.flatMap((run) =>
    run.samples
      .map((s) => s.rendererHeapUsedKb)
      .filter((v): v is number => v !== null)
      .map(kbToMb),
  )

  // A budgeted series with no samples is a failed run, not a 0 that happens to be under budget.
  // `summarize` throws on an empty series; these name the cause so the fix is obvious.
  if (allRam.length === 0) {
    throw new Error(
      `No RAM samples on the ${options.ramBasis} basis (proc-* bases need Linux /proc).`,
    )
  }
  if (allSwitches.length === 0) {
    throw new Error(
      'No slide switch produced a canvas `load`; every latency is null. The canvas iframe is not ' +
        'reloading on switch, or the recorder is watching the wrong element.',
    )
  }
  const metrics: PerfMetrics = {
    coldStartMs: median(collected.map((r) => r.session.coldStartMs)),
    deckOpenMs: median(collected.map((r) => r.session.deckRenderMs)),
    slideSwitchMs: summarize(allSwitches),
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
    idleRamMb: median(
      collected
        .map((r) => {
          const idle = ramSeriesMb(idleSamples(r), options.ramBasis)
          return idle.length > 0 ? summarize(idle).median : Number.NaN
        })
        .filter((v) => Number.isFinite(v)),
    ),
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
      const switches = run.session.switches
        .map((s) => s.latencyMs)
        .filter((v): v is number => v !== null)
      return {
        coldStartMs: run.session.coldStartMs,
        deckOpenMs: run.session.deckRenderMs,
        medianRamMb: ram.length > 0 ? summarize(ram).median : Number.NaN,
        medianSlideSwitchMs: switches.length > 0 ? summarize(switches).median : Number.NaN,
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
      `Idle RAM (starter deck, before the stress deck): ${metrics.idleRamMb.toFixed(0)} MB on the ${options.ramBasis} basis.`,
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

  await writeFile(options.outFile, `${JSON.stringify(report, null, 2)}\n`, 'utf8')

  // Raw series, for re-deriving any summary and for flamegraph-adjacent inspection.
  const tracePath = options.outFile.replace(/\.json$/, '.trace.json')
  await writeFile(
    tracePath,
    `${JSON.stringify(
      collected.map((run, i) => ({
        run: i,
        marks: run.marks,
        samples: run.samples,
        switches: run.session.switches,
        frameIntervalsMs: run.session.activeSlideFrameIntervalsMs,
      })),
      null,
      2,
    )}\n`,
    'utf8',
  )

  console.log(`\n${budgetTable(checkBudgets(metrics))}`)
  console.log(`\nReport: ${options.outFile}`)
  console.log(`Trace:  ${tracePath}`)
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
  return values.length === 0 ? Number.NaN : summarize(values).median
}
