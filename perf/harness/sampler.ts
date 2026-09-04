/**
 * Periodic metric sampling across the whole Electron process tree.
 *
 * Three memory views are recorded on every tick, because they answer different questions and the
 * roadmap's "median RAM < 200 MB" does not by itself say which one it means:
 *
 *  - **`appMetricsWorkingSetKb`** — `app.getAppMetrics()`, summed over every process. This is
 *    Electron's own cross-platform answer and matches what a user sees in Task Manager. It is the
 *    default basis, because it is the number reproducible on the Windows machine this app ships to.
 *  - **`procPssKb`** — Linux `/proc/<pid>/smaps_rollup` Pss, summed. Chromium processes share a lot
 *    of mapped memory (the binary, fonts, V8 snapshots), so summing per-process RSS across ~4
 *    processes *double-counts* those pages. PSS divides each shared page by the number of sharers
 *    and is the only one of the three that is a physically honest total on Linux.
 *  - **`procRssKb`** — the naive sum, recorded only so the gap against PSS is visible rather than
 *    argued about.
 *
 * `perf/README.md` states which one the headline number uses and why; the report records the basis
 * so a later run cannot silently change it.
 */

import { readFile } from 'node:fs/promises'
import type { CdpClient } from './cdp'
import { summarize, type Summary } from '../lib/stats'

export type ProcessMetric = {
  readonly type: string
  readonly pid: number
  readonly workingSetKb: number
  readonly cpuPercent: number
  /** From `/proc/<pid>/smaps_rollup`; null off Linux or when the process exited mid-sample. */
  readonly pssKb: number | null
  readonly rssKb: number | null
}

export type Sample = {
  /** Milliseconds since the sampler started. */
  readonly t: number
  readonly mainRssKb: number
  readonly mainHeapUsedKb: number
  readonly processes: readonly ProcessMetric[]
  readonly appMetricsWorkingSetKb: number
  readonly procPssKb: number | null
  readonly procRssKb: number | null
  /** Fraction of the reported processes whose `/proc` entry was readable at sample time. */
  readonly procCoverage: number
  /**
   * Host 1-minute load average and free memory at sample time.
   *
   * Recorded on every tick because this is a developer workstation, not a quiet lab: other agents
   * run full test suites on the same box. A committed baseline has to carry the evidence of what
   * else was happening while it was taken, or a later reader cannot tell a regression from a noisy
   * afternoon.
   */
  readonly hostLoadAvg1: number
  readonly hostMemAvailableMb: number
  readonly rendererHeapUsedKb: number | null
  readonly cpuPercentTotal: number
}

const KB_PER_MB = 1024

/**
 * Fraction of a process set that must have a `/proc` reading for its memory sum to count as a
 * sample. Shared by the per-sample totals and the per-type breakdown so the two cannot disagree
 * about which samples exist: the breakdown used to demand every process, and on the 300-slide tier
 * that dropped the loaded-phase samples (hundreds of pids, one always mid-exit) and put the `Tab`
 * median ~10 % low for a reason unrelated to the app.
 */
const MIN_PROC_COVERAGE = 0.9

export function kbToMb(kb: number): number {
  return kb / KB_PER_MB
}

/** Host contention at sample time: 1-minute load average and MemAvailable. */
async function readHostPressure(): Promise<{ loadAvg1: number; memAvailableMb: number }> {
  try {
    const [loadRaw, memRaw] = await Promise.all([
      readFile('/proc/loadavg', 'utf8'),
      readFile('/proc/meminfo', 'utf8'),
    ])
    const loadAvg1 = Number(loadRaw.trim().split(/\s+/)[0] ?? 0)
    const available = /^MemAvailable:\s+(\d+) kB$/m.exec(memRaw)
    return {
      loadAvg1: Number.isFinite(loadAvg1) ? loadAvg1 : 0,
      memAvailableMb: available?.[1] === undefined ? 0 : Math.round(Number(available[1]) / 1024),
    }
  } catch {
    return { loadAvg1: 0, memAvailableMb: 0 }
  }
}

/** Read Pss/Rss for one pid from `/proc`. Returns null off Linux or if the process just exited. */
async function readProcMemoryKb(pid: number): Promise<{ pss: number; rss: number } | null> {
  try {
    const text = await readFile(`/proc/${String(pid)}/smaps_rollup`, 'utf8')
    const pss = /^Pss:\s+(\d+) kB$/m.exec(text)
    const rss = /^Rss:\s+(\d+) kB$/m.exec(text)
    if (pss?.[1] === undefined || rss?.[1] === undefined) return null
    return { pss: Number(pss[1]), rss: Number(rss[1]) }
  } catch {
    return null
  }
}

/**
 * Read `app.getAppMetrics()` and `process.memoryUsage()` from the main process.
 *
 * `process.mainModule.require` is the seam: the main bundle is ESM, so the inspector's evaluation
 * context has neither a bare `require` nor a dynamic-import callback ("A dynamic import callback was
 * not specified"), but `process.mainModule` is a CJS module record whose `require` reaches the whole
 * Electron API. This is why no production hook is needed in `src/main`.
 */
const MAIN_SNAPSHOT_EXPRESSION = `(() => {
  const { app } = process.mainModule.require('electron');
  const mem = process.memoryUsage();
  return {
    rssKb: Math.round(mem.rss / 1024),
    heapUsedKb: Math.round(mem.heapUsed / 1024),
    processes: app.getAppMetrics().map((m) => ({
      type: m.type,
      pid: m.pid,
      workingSetKb: m.memory ? m.memory.workingSetSize : 0,
      cpuPercent: m.cpu ? m.cpu.percentCPUUsage : 0,
    })),
  };
})()`

type MainSnapshot = {
  rssKb: number
  heapUsedKb: number
  processes: ProcessMetric[]
}

export async function takeSample(
  main: CdpClient,
  page: CdpClient,
  startedAtMs: number,
): Promise<Sample> {
  const snapshot = await main.evaluate<MainSnapshot>(MAIN_SNAPSHOT_EXPRESSION)

  // Read /proc per pid, tolerating misses. With one renderer process per slide (see the README's
  // "process explosion" note) a 1000-slide deck churns ~1000 pids, and a process that exits between
  // `getAppMetrics()` and the `/proc` read is routine. Aborting the whole sample on the first miss
  // discarded every sample of the first run; instead the covered fraction is recorded, and the
  // sample is only invalidated when coverage is too low to be a meaningful total.
  let pssKb = 0
  let rssKb = 0
  let covered = 0
  const processes: ProcessMetric[] = []
  for (const proc of snapshot.processes) {
    const memory = await readProcMemoryKb(proc.pid)
    processes.push({ ...proc, pssKb: memory?.pss ?? null, rssKb: memory?.rss ?? null })
    if (memory === null) continue
    pssKb += memory.pss
    rssKb += memory.rss
    covered += 1
  }
  const coverage = processes.length === 0 ? 0 : covered / processes.length
  const enoughCoverage = coverage >= MIN_PROC_COVERAGE
  const procPssKb = enoughCoverage ? pssKb : null
  const procRssKb = enoughCoverage ? rssKb : null

  let rendererHeapUsedKb: number | null = null
  try {
    const metrics = await page.send('Performance.getMetrics')
    const list = (metrics['metrics'] ?? []) as { name: string; value: number }[]
    const heap = list.find((m) => m.name === 'JSHeapUsedSize')
    if (heap !== undefined) rendererHeapUsedKb = Math.round(heap.value / 1024)
  } catch {
    // The renderer can be mid-navigation; a missing heap read is not a failed sample.
  }

  const pressure = await readHostPressure()

  return {
    t: Date.now() - startedAtMs,
    hostLoadAvg1: pressure.loadAvg1,
    hostMemAvailableMb: pressure.memAvailableMb,
    mainRssKb: snapshot.rssKb,
    mainHeapUsedKb: snapshot.heapUsedKb,
    processes,
    appMetricsWorkingSetKb: processes.reduce((sum, p) => sum + p.workingSetKb, 0),
    procPssKb,
    procRssKb,
    procCoverage: coverage,
    rendererHeapUsedKb,
    cpuPercentTotal: processes.reduce((sum, p) => sum + p.cpuPercent, 0),
  }
}

/** Which per-process field a RAM basis sums. Mirrors the per-sample totals above. */
const PROCESS_MEMORY_FIELD = {
  'app-metrics-working-set-sum': 'workingSetKb',
  'proc-pss-sum': 'pssKb',
  'proc-rss-sum': 'rssKb',
} as const satisfies Record<string, keyof ProcessMetric>

export type ProcessTypeBreakdown = {
  /** Processes of this type per sample. A `min` of 0 means the type was not always alive. */
  readonly processes: Summary
  /**
   * Memory of this type per sample on the chosen basis, summed over the processes that had a
   * reading. A sample counts when at least `MIN_PROC_COVERAGE` of the type's processes were
   * readable — the same rule as the per-sample totals — so `count` can be below `processes.count`,
   * and a sample with one unread renderer in a hundred lands slightly low rather than being dropped.
   * null if no sample qualified.
   */
  readonly memoryMb: Summary | null
}

/**
 * Reduce a sample window by Chromium process type (Browser / GPU / Tab / Utility …).
 *
 * This is what makes a RAM number's composition inspectable from the report rather than from the
 * trace. It exists because the idle baseline turned out to hinge on one process: under WSLg the
 * software-GL GPU process is not reliably alive, and its ~230 MB working set was the difference
 * between a 264 MB and a 450 MB "idle" figure. Every type seen anywhere in the window contributes
 * a value to *every* sample — zero when absent — so an intermittent process shows up as `min: 0`
 * instead of vanishing from the summary.
 */
export function processTypeBreakdown(
  samples: readonly Sample[],
  basis: keyof typeof PROCESS_MEMORY_FIELD,
): Readonly<Record<string, ProcessTypeBreakdown>> {
  const field = PROCESS_MEMORY_FIELD[basis]
  const types = [...new Set(samples.flatMap((s) => s.processes.map((p) => p.type)))].toSorted()
  const out: Record<string, ProcessTypeBreakdown> = {}
  for (const type of types) {
    const counts: number[] = []
    const memory: number[] = []
    for (const sample of samples) {
      const own = sample.processes.filter((p) => p.type === type)
      counts.push(own.length)
      const readings = own.flatMap((p) => {
        const kb = p[field]
        return kb === null ? [] : [kb]
      })
      if (own.length === 0 || readings.length / own.length >= MIN_PROC_COVERAGE) {
        memory.push(kbToMb(readings.reduce((sum, kb) => sum + kb, 0)))
      }
    }
    out[type] = {
      processes: summarize(counts),
      memoryMb: memory.length > 0 ? summarize(memory) : null,
    }
  }
  return out
}

export type PhaseWindow = {
  readonly marks: readonly { readonly name: string; readonly t: number }[]
  readonly samples: readonly Sample[]
}

/**
 * Process count per named phase, pooled across runs.
 *
 * The aggregate `processCount` answers "how many processes does this app run", but not "when" — and
 * on a lazily-mounted stage those are different questions with different answers: the editor sits at
 * one number, a switch briefly holds the outgoing document's process alongside the incoming one, and
 * Present mounts a second stage on top of the editor's. Reading that split used to mean recomputing
 * it from the trace, which is gitignored, so the report's headline process claim was not checkable
 * from the committed artifact. A phase is the samples between its `x:start` and `x:end` marks.
 */
export function processCountByPhase(
  runs: readonly PhaseWindow[],
): Readonly<Record<string, Summary | null>> {
  const counts = new Map<string, number[]>()
  for (const run of runs) {
    for (const mark of run.marks) {
      const [phase, edge] = mark.name.split(':')
      if (phase === undefined || edge !== 'start') continue
      const end = run.marks.find((m) => m.name === `${phase}:end`)
      if (end === undefined) continue
      const series = counts.get(phase) ?? []
      for (const sample of run.samples) {
        if (sample.t >= mark.t && sample.t <= end.t) series.push(sample.processes.length)
      }
      counts.set(phase, series)
    }
  }
  return Object.fromEntries(
    [...counts]
      .toSorted(([a], [b]) => a.localeCompare(b))
      .map(([phase, series]) => [phase, series.length > 0 ? summarize(series) : null]),
  )
}

/** A background sampling loop. Stops when `stop()` resolves; never throws into the session. */
export class Sampler {
  readonly samples: Sample[] = []
  #running = false
  #loop: Promise<void> | null = null
  /** Phase boundaries, so the report can attribute a spike to `export` rather than to the run. */
  readonly marks: { name: string; t: number }[] = []

  readonly #main: CdpClient
  readonly #page: CdpClient
  readonly #startedAtMs: number
  readonly #intervalMs: number

  constructor(main: CdpClient, page: CdpClient, startedAtMs: number, intervalMs = 250) {
    this.#main = main
    this.#page = page
    this.#startedAtMs = startedAtMs
    this.#intervalMs = intervalMs
  }

  mark(name: string): void {
    this.marks.push({ name, t: Date.now() - this.#startedAtMs })
  }

  start(): void {
    if (this.#running) return
    this.#running = true
    this.#loop = (async () => {
      while (this.#running) {
        try {
          this.samples.push(await takeSample(this.#main, this.#page, this.#startedAtMs))
        } catch {
          // A dropped sample (renderer busy, socket mid-send) must not abort the session; the
          // sample count in the report makes any significant loss visible.
        }
        await new Promise((resolve) => setTimeout(resolve, this.#intervalMs))
      }
    })()
  }

  async stop(): Promise<void> {
    this.#running = false
    await this.#loop
    this.#loop = null
  }
}
