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

export type ProcessMetric = {
  readonly type: string
  readonly pid: number
  readonly workingSetKb: number
  readonly cpuPercent: number
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
  for (const proc of snapshot.processes) {
    const memory = await readProcMemoryKb(proc.pid)
    if (memory === null) continue
    pssKb += memory.pss
    rssKb += memory.rss
    covered += 1
  }
  const coverage = snapshot.processes.length === 0 ? 0 : covered / snapshot.processes.length
  const enoughCoverage = coverage >= 0.9
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
    processes: snapshot.processes,
    appMetricsWorkingSetKb: snapshot.processes.reduce((sum, p) => sum + p.workingSetKb, 0),
    procPssKb,
    procRssKb,
    procCoverage: coverage,
    rendererHeapUsedKb,
    cpuPercentTotal: snapshot.processes.reduce((sum, p) => sum + p.cpuPercent, 0),
  }
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

  /** Samples between two marks, for per-phase attribution. */
  between(fromMark: string, toMark: string): Sample[] {
    const from = this.marks.find((m) => m.name === fromMark)
    const to = this.marks.find((m) => m.name === toMark)
    if (from === undefined || to === undefined) return []
    return this.samples.filter((s) => s.t >= from.t && s.t <= to.t)
  }
}
