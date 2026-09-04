/**
 * The per-process-type breakdown that makes a RAM number's composition readable from the report.
 * The idle baseline turned out to hinge on whether WSLg's software-GL GPU process was alive, so the
 * breakdown has to show an intermittent process as `min: 0`, not average it away.
 */

import { describe, expect, it } from 'vitest'
import {
  processCountByPhase,
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

/**
 * The per-phase process count exists so the milestone's headline claim — flat in the editor, one
 * higher across a switch, highest in Present — is checkable from the committed report rather than
 * from the trace, which is gitignored.
 */
describe('processCountByPhase', () => {
  const tab = (n: number): ProcessMetric[] =>
    Array.from({ length: n }, (_, i) => proc('Tab', i + 1, MB))

  it('buckets samples between each phase\u2019s start and end mark, pooling runs', () => {
    const out = processCountByPhase([
      {
        marks: [
          { name: 'switch:start', t: 100 },
          { name: 'switch:end', t: 300 },
          { name: 'present:start', t: 400 },
          { name: 'present:end', t: 600 },
        ],
        samples: [
          sample(0, tab(4)),
          sample(150, tab(7)),
          sample(250, tab(8)),
          sample(350, tab(4)),
          sample(500, tab(10)),
        ],
      },
      {
        marks: [
          { name: 'switch:start', t: 100 },
          { name: 'switch:end', t: 300 },
        ],
        samples: [sample(200, tab(7))],
      },
    ])
    expect(out['switch']).toMatchObject({ count: 3, min: 7, max: 8 })
    expect(out['present']).toMatchObject({ count: 1, min: 10, max: 10 })
    // The sample at t=350 falls in no phase and is in neither series.
    expect(Object.keys(out)).toStrictEqual(['present', 'switch'])
  })

  it('reports a phase whose window caught no sample as null rather than dropping it', () => {
    const out = processCountByPhase([
      {
        marks: [
          { name: 'idle:start', t: 100 },
          { name: 'idle:end', t: 110 },
        ],
        samples: [sample(0, tab(4)), sample(250, tab(4))],
      },
    ])
    expect(out['idle']).toBeNull()
  })

  it('ignores a start with no matching end, and bare marks with no phase edge', () => {
    const out = processCountByPhase([
      {
        marks: [
          { name: 'shell-ready', t: 0 },
          { name: 'export:start', t: 100 },
        ],
        samples: [sample(150, tab(9))],
      },
    ])
    expect(out).toStrictEqual({})
  })
})
