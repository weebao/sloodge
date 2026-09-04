/**
 * `perf:diff` end to end on two files, with the console captured. It launches nothing; what is
 * pinned is what the table says about a field one side never sampled, and that a rise in unmeasured
 * switches is named as the regression it is.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { main } from '../../../perf/cli/diff'
import { PerfReportSchema, type PerfReport } from '../../../perf/lib/report'
import baseline from '../../../perf/results/baseline-main.json'

describe('perf:diff', () => {
  const report = PerfReportSchema.parse(baseline)
  const lines: string[] = []
  let dir = ''

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'sloodge-perf-diff-'))
    lines.length = 0
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(' '))
    })
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    process.exitCode = undefined
    await rm(dir, { recursive: true, force: true })
  })

  async function write(name: string, document: PerfReport): Promise<string> {
    const path = join(dir, name)
    await writeFile(path, JSON.stringify(document), 'utf8')
    return path
  }

  it('marks idle RAM NOT COMPARED when the candidate never sampled it, and still diffs the budgets', async () => {
    const a = await write('a.json', report)
    const b = await write('b.json', {
      ...report,
      metrics: { ...report.metrics, idleRamMb: null },
    })
    await main([a, b])
    const idleRow = lines.find((line) => line.startsWith('| Idle RAM'))
    expect(idleRow).toContain('n/a')
    expect(idleRow).toContain('NOT COMPARED')
    expect(lines.some((line) => line.startsWith('| Slide switch (median) |'))).toBe(true)
    expect(lines.some((line) => line.includes('REGRESSED'))).toBe(false)
  })

  it('names a rise in unmeasured switches as the slide-switch regression', async () => {
    const a = await write('a.json', report)
    const b = await write('b.json', {
      ...report,
      metrics: { ...report.metrics, unmeasuredSwitches: report.metrics.unmeasuredSwitches + 2 },
    })
    await main([a, b])
    const switchRow = lines.find((line) => line.startsWith('| Slide switch (median) |'))
    expect(switchRow).toContain('REGRESSED')
    expect(lines.join('\n')).toContain(
      `Unmeasured switches (no canvas load within the wait bound): baseline ${String(report.metrics.unmeasuredSwitches)}, candidate ${String(report.metrics.unmeasuredSwitches + 2)} — the rise counts as a slide-switch regression.`,
    )
    expect(process.exitCode).toBe(1)
  })
})
