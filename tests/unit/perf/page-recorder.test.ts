/**
 * The in-page recorder's pairing rule, run under `node:vm` exactly as `Runtime.evaluate` would run
 * it. The rule decides which canvas `load` a click owns, and its one failure mode is quiet: a click
 * that produced no load borrows the next one and the series gains a sample that never happened.
 */

import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import { READ_SWITCHES, RECORDER_GLOBAL } from '../../../perf/harness/page-recorder'
import type { SwitchRecord } from '../../../perf/harness/session'

type RecorderState = {
  switches: { index: number; clickAt: number; loadsBefore: number }[]
  canvasLoads: number[]
}

/** Evaluate in a fresh realm and round-trip through JSON, as `CdpClient.evaluate` does. */
function readSwitches(state?: RecorderState): SwitchRecord[] {
  const sandbox = state === undefined ? {} : { [RECORDER_GLOBAL]: state }
  return JSON.parse(JSON.stringify(runInNewContext(READ_SWITCHES, sandbox))) as SwitchRecord[]
}

describe('READ_SWITCHES', () => {
  it('pairs each click with its own load when every load landed before the next click', () => {
    const out = readSwitches({
      switches: [
        { index: 5, clickAt: 100, loadsBefore: 0 },
        { index: 10, clickAt: 320, loadsBefore: 1 },
        { index: 15, clickAt: 540, loadsBefore: 2 },
      ],
      canvasLoads: [150, 380, 610],
    })
    expect(out.map((s) => s.latencyMs)).toStrictEqual([50, 60, 70])
    expect(out.map((s) => s.loadAt)).toStrictEqual([150, 380, 610])
  })

  it('records a click on the already-active slide as unmeasured instead of borrowing the next load', () => {
    // Every committed run used to open with this: slide 0 is already selected after the deck push,
    // the click fires no `load`, and the second click's load was attributed to both — the first
    // switch then reported the real latency plus the 220 ms inter-click sleep.
    const out = readSwitches({
      switches: [
        { index: 0, clickAt: 100, loadsBefore: 0 },
        { index: 5, clickAt: 320, loadsBefore: 0 },
      ],
      canvasLoads: [375],
    })
    expect(out[0]).toStrictEqual({ index: 0, clickAt: 100, loadAt: null, latencyMs: null })
    expect(out[1]).toStrictEqual({ index: 5, clickAt: 320, loadAt: 375, latencyMs: 55 })
    expect(out.filter((s) => s.latencyMs !== null)).toHaveLength(1)
  })

  it('gives a load that landed after the next click to that click', () => {
    // Swapping the canvas src cancels the navigation in flight, so one `load` follows two clicks
    // and it is the later click's. A load that arrived before the next click stays with its own.
    const out = readSwitches({
      switches: [
        { index: 5, clickAt: 100, loadsBefore: 0 },
        { index: 10, clickAt: 320, loadsBefore: 0 },
        { index: 15, clickAt: 540, loadsBefore: 1 },
      ],
      canvasLoads: [350, 600],
    })
    expect(out.map((s) => s.latencyMs)).toStrictEqual([null, 30, 60])
  })

  it('leaves the last switch unmeasured while its load has not arrived', () => {
    const out = readSwitches({
      switches: [{ index: 5, clickAt: 100, loadsBefore: 0 }],
      canvasLoads: [],
    })
    expect(out[0]?.latencyMs).toBeNull()
  })

  it('returns an empty series when the recorder was never installed', () => {
    expect(readSwitches()).toStrictEqual([])
  })
})
