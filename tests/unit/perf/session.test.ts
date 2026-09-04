/**
 * The switch phase against a fake page. The real recorder string is installed into a `node:vm`
 * context with a rail and a canvas, so the click bookkeeping, the wait predicate and the pairing
 * rule are the shipped code; only the DOM and the load latency are simulated. What is pinned is that
 * a slow switch is *measured* rather than lost to the next click, and that one too slow to see is
 * counted, not dropped.
 */

import { createContext, runInContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import type { CdpClient } from '../../../perf/harness/cdp'
import { INSTALL_RECORDER, SELECTORS } from '../../../perf/harness/page-recorder'
import { switchSlides } from '../../../perf/harness/session'

type Listener = (event: { target: { tagName: string } }) => void

/** A rail of `slideCount` items whose click fires a canvas `load` after `latencyMs(index)` — never, for null. */
function fakePage(
  slideCount: number,
  latencyMs: (index: number) => number | null,
): Pick<CdpClient, 'evaluate'> {
  const canvasListeners: Listener[] = []
  const element = (sink: Listener[]) => ({
    addEventListener: (_type: string, listener: Listener) => {
      sink.push(listener)
    },
  })
  const canvas = element(canvasListeners)
  const rail = element([])
  const scroller = { scrollTop: 0 }
  const item = (index: number) => ({
    click: () => {
      const ms = latencyMs(index)
      if (ms === null) return
      setTimeout(() => {
        for (const listener of canvasListeners) listener({ target: { tagName: 'IFRAME' } })
      }, ms)
    },
  })
  const context = createContext({
    performance,
    requestAnimationFrame: () => 0,
    document: {
      querySelector: (selector: string) => {
        if (selector === SELECTORS.canvas) return canvas
        if (selector === SELECTORS.rail) return rail
        if (selector === SELECTORS.railScroller) return scroller
        const index = Number(/data-slide-index="(\d+)"/.exec(selector)?.[1] ?? -1)
        return index >= 0 && index < slideCount ? item(index) : null
      },
    },
  })
  runInContext(INSTALL_RECORDER, context)
  return {
    evaluate: <T>(expression: string) => {
      const value: unknown = runInContext(expression, context)
      return Promise.resolve(
        (value === undefined ? undefined : JSON.parse(JSON.stringify(value))) as T,
      )
    },
  }
}

const alive = (): void => {}

describe('switchSlides', () => {
  // Six slides, three switches: stride 2, so the clicks land on 2, 4, 0.
  it('measures a switch slower than the settle instead of losing it to the next click', async () => {
    const page = fakePage(6, (index) => (index === 4 ? 120 : 20))
    const { switches, warnings } = await switchSlides({
      page,
      slideCount: 6,
      switchCount: 3,
      loadWaitMs: 1000,
      settleMs: 10,
      assertAlive: alive,
    })
    expect(switches.map((s) => s.index)).toStrictEqual([2, 4, 0])
    expect(switches.map((s) => s.censored)).toStrictEqual([false, false, false])
    // Comfortably past the 10 ms settle, so the number is the load's and not the cadence's. Not
    // asserted as >= 120: a libuv timer is scheduled off a millisecond-rounded loop clock and can
    // land a fraction under its delay on the sub-millisecond `performance.now()` the recorder uses.
    expect(switches[1]?.latencyMs).toBeGreaterThan(100)
    expect(switches[1]?.latencyMs).toBeLessThan(1000)
    expect(warnings).toStrictEqual([])
  })

  it('counts a switch that outlasts the wait bound as censored at the bound, not as a missing sample', async () => {
    const page = fakePage(6, (index) => (index === 4 ? null : 20))
    const { switches, warnings } = await switchSlides({
      page,
      slideCount: 6,
      switchCount: 3,
      loadWaitMs: 60,
      settleMs: 10,
      assertAlive: alive,
    })
    expect(switches).toHaveLength(3)
    expect(switches.map((s) => s.censored)).toStrictEqual([false, true, false])
    expect(switches[1]?.loadAt).toBeNull()
    expect(switches[1]?.latencyMs).toBeGreaterThanOrEqual(60)
    expect(warnings).toStrictEqual([
      '1 of 3 switches produced no canvas load before the next click 70 ms later; recorded as >= 60 ms and left out of slideSwitchMs.',
    ])
  })

  it('lands a single switch on the last slide rather than back on the active slide 0', async () => {
    const { switches } = await switchSlides({
      page: fakePage(6, () => 20),
      slideCount: 6,
      switchCount: 1,
      loadWaitMs: 1000,
      settleMs: 10,
      assertAlive: alive,
    })
    expect(switches.map((s) => s.index)).toStrictEqual([5])
    expect(switches[0]?.censored).toBe(false)
  })

  it('skips a rail item that is not in the DOM and says so', async () => {
    const { switches, warnings } = await switchSlides({
      page: fakePage(4, () => 20),
      slideCount: 6,
      switchCount: 3,
      loadWaitMs: 1000,
      settleMs: 10,
      assertAlive: alive,
    })
    expect(switches.map((s) => s.index)).toStrictEqual([2, 0])
    expect(warnings).toStrictEqual(['Rail item 4 was not in the DOM; switch skipped.'])
  })
})
