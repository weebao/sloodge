/**
 * The per-process-type breakdown that makes a RAM number's composition readable from the report.
 * The idle baseline turned out to hinge on whether WSLg's software-GL GPU process was alive, so the
 * breakdown has to show an intermittent process as `min: 0`, not average it away.
 */

import { describe, expect, it } from 'vitest'
import {
  processTypeBreakdown,
  type ProcessMetric,
  type Sample,
} from '../../../perf/harness/sampler'

function proc(type: string, pid: number, kb: number, pssKb: number | null = kb): ProcessMetric {
  return { type, pid, workingSetKb: kb, cpuPercent: 0, pssKb, rssKb: pssKb }
}

function sample(t: number, processes: ProcessMetric[]): Sample {
  return {
    t,
    mainRssKb: 0,
    mainHeapUsedKb: 0,
    processes,
    appMetricsWorkingSetKb: processes.reduce((sum, p) => sum + p.workingSetKb, 0),
    procPssKb: null,
    procRssKb: null,
    procCoverage: 1,
    hostLoadAvg1: 0,
    hostMemAvailableMb: 0,
    rendererHeapUsedKb: null,
    cpuPercentTotal: 0,
  }
}

const MB = 1024

describe('processTypeBreakdown', () => {
  it('sums memory per type per sample and counts a type absent from a sample as zero', () => {
    const samples = [
      sample(0, [proc('Browser', 1, 100 * MB), proc('GPU', 2, 230 * MB), proc('Tab', 3, 40 * MB)]),
      sample(250, [proc('Browser', 1, 100 * MB), proc('Tab', 3, 40 * MB), proc('Tab', 4, 40 * MB)]),
    ]
    const out = processTypeBreakdown(samples, 'proc-pss-sum')
    expect(Object.keys(out)).toStrictEqual(['Browser', 'GPU', 'Tab'])
    expect(out['GPU']?.processes).toMatchObject({ count: 2, min: 0, max: 1 })
    expect(out['GPU']?.memoryMb).toMatchObject({ min: 0, max: 230, median: 115 })
    expect(out['Tab']?.processes).toMatchObject({ min: 1, max: 2 })
    expect(out['Tab']?.memoryMb).toMatchObject({ min: 40, max: 80 })
  })

  it('leaves out only the samples where a process of the type had no reading', () => {
    // One renderer exiting mid-sample must not null the whole Tab row for the session; with 100+
    // renderers that happens in nearly every run.
    const samples = [
      sample(0, [proc('Tab', 1, 40 * MB), proc('Tab', 2, 40 * MB, null)]),
      sample(250, [proc('Tab', 1, 40 * MB), proc('Tab', 3, 40 * MB)]),
    ]
    const out = processTypeBreakdown(samples, 'proc-pss-sum')
    expect(out['Tab']?.processes.count).toBe(2)
    expect(out['Tab']?.memoryMb).toMatchObject({ count: 1, median: 80 })
  })

  it('includes a sample when at least 90 % of the type had a reading — the same rule as the totals', () => {
    // Demanding every process put the 300-slide `Tab` median ~10 % low: with hundreds of renderers
    // one is always mid-exit, so the loaded-phase samples were the ones dropped.
    const tabs = (unread: number): ProcessMetric[] =>
      Array.from({ length: 10 }, (_, i) => proc('Tab', i + 1, 40 * MB, i < unread ? null : 40 * MB))
    const out = processTypeBreakdown([sample(0, tabs(1)), sample(250, tabs(2))], 'proc-pss-sum')
    expect(out['Tab']?.processes.count).toBe(2)
    expect(out['Tab']?.memoryMb).toMatchObject({ count: 1, median: 360 })
  })

  it('reports null memory for a basis with no per-process reading, but still counts processes', () => {
    const samples = [sample(0, [proc('Browser', 1, 100 * MB, null), proc('Tab', 2, 40 * MB)])]
    const out = processTypeBreakdown(samples, 'proc-pss-sum')
    expect(out['Browser']?.memoryMb).toBeNull()
    expect(out['Browser']?.processes.median).toBe(1)
    expect(out['Tab']?.memoryMb?.median).toBe(40)
    expect(
      processTypeBreakdown(samples, 'app-metrics-working-set-sum')['Browser']?.memoryMb?.median,
    ).toBe(100)
  })

  it('is empty for an empty window', () => {
    expect(processTypeBreakdown([], 'proc-pss-sum')).toStrictEqual({})
  })
})
