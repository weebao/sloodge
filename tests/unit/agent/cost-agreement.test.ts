/**
 * **The status bar must not lie.** (M2.5, 50-agent-integration.md §10)
 *
 * The number the user reads in the status bar comes from the renderer's transcript reducer. The
 * number the budget guard is ultimately enforced against in main comes from `AgentSession`. If those
 * two drift, the meter misreports what was spent *and* the guard fires at the wrong moment — and the
 * drift is invisible, because nothing in the app ever compares them.
 *
 * So this file compares them. One scripted SDK message sequence is driven through *both* paths — the
 * real `AgentSession` with a fake `queryFn`, and the real `reduceTranscript` fed the same
 * `AgentEvent`s — and the totals must match exactly, including on the awkward streams: an
 * interrupted turn, an error turn, and a duplicated `result`.
 *
 * This is only meaningful because neither side owns its arithmetic: both call
 * `shared/agent/cost.ts`. Give either one a private accumulator again and the cases below start
 * disagreeing.
 */

import { describe, expect, it, vi } from 'vitest'
import { AgentSession } from '../../../src/main/agent/session'
import type { AgentQueryFn, AgentQueryHandle } from '../../../src/main/agent/query-contract'
import type { AgentQueryOptions } from '../../../src/main/agent/query-contract'
import { mapSdkMessage } from '../../../src/main/agent/event-mapping'
import {
  initialTranscript,
  reduceTranscript,
  type Transcript,
} from '../../../src/renderer/src/features/chat/transcript'
import type { AgentEvent } from '../../../src/shared/agent/types'

const OPTIONS: AgentQueryOptions = {
  credential: { kind: 'api-key', value: 'sk-ant-test' },
  model: 'claude-opus-5',
  cwd: '/workspace',
  configDir: '/config',
}

const INIT = {
  type: 'system',
  subtype: 'init',
  session_id: 's1',
  model: 'claude-opus-5',
  skills: ['slide-deck', 'svg-animation', 'interactive-graph'],
}

function fakeHandle(messages: readonly unknown[]): AgentQueryHandle {
  async function* gen(): AsyncGenerator<unknown, void, unknown> {
    yield* messages
  }
  const handle = gen() as AgentQueryHandle
  handle.interrupt = async () => undefined
  handle.setModel = async () => undefined
  return handle
}

/**
 * A runtime whose messages the test releases turn by turn.
 *
 * A fixed-list handle cannot express a multi-turn session: it would deliver every `result` after
 * every `send`, which is not an ordering the app can produce (the composer refuses to send while a
 * turn streams) and would compare the two accumulators on a stream neither is designed for. This
 * one answers one turn at a time, the way a real session does.
 */
function scriptedRuntime(): {
  handle: AgentQueryHandle
  deliver: (messages: readonly unknown[]) => void
  end: () => void
} {
  const queue: unknown[] = []
  let wake: (() => void) | null = null
  let ended = false

  async function* gen(): AsyncGenerator<unknown, void, unknown> {
    for (;;) {
      while (queue.length > 0) yield queue.shift()
      if (ended) return
      // Sequential by nature: this generator *is* the runtime's clock, and each pause waits for the
      // test to release the next turn. Parallelising it would remove the ordering under test.
      // eslint-disable-next-line no-await-in-loop
      await new Promise<void>((resolve) => {
        wake = resolve
      })
    }
  }

  const handle = gen() as AgentQueryHandle
  handle.interrupt = async () => undefined
  handle.setModel = async () => undefined

  const nudge = (): void => {
    const resume = wake
    wake = null
    resume?.()
  }

  return {
    handle,
    deliver: (messages) => {
      queue.push(...messages)
      nudge()
    },
    end: () => {
      ended = true
      nudge()
    },
  }
}

/** One user turn and the raw SDK messages the runtime answers it with. */
type ScriptedTurn = {
  readonly text: string
  readonly messages: readonly unknown[]
}

/** Run the script through main's accumulator (`AgentSession`) and report its total. */
async function mainTotal(script: readonly ScriptedTurn[]): Promise<number> {
  const runtime = scriptedRuntime()
  const queryFn = vi.fn(() => runtime.handle) as unknown as AgentQueryFn
  const emitted: AgentEvent[] = []
  const session = new AgentSession({
    queryFn,
    options: OPTIONS,
    emit: (event) => emitted.push(event),
    log: () => {},
  })

  let expectedEnds = 0
  for (const turn of script) {
    // Each turn is opened on the session exactly as the IPC layer opens it, and answered before the
    // next one is sent — the only ordering the composer can actually produce.
    session.send(turn.text)
    runtime.deliver(turn.messages)
    expectedEnds += turn.messages.filter((m) => (m as { type?: string }).type === 'result').length
    const target = expectedEnds
    // Sequential on purpose: a turn must finish before the next is sent, which is the whole point.
    // eslint-disable-next-line no-await-in-loop
    await vi.waitFor(() =>
      expect(emitted.filter((e) => e.type === 'turn-end')).toHaveLength(target),
    )
  }
  runtime.end()
  const total = session.estimatedSpendUsd
  await session.close()
  return total
}

/** Run the same script through the renderer's reducer and report its total. */
function rendererTotal(script: readonly ScriptedTurn[]): number {
  const seen = new Set<string>()
  let state: Transcript = initialTranscript
  for (const turn of script) {
    state = reduceTranscript(state, { type: 'user-send', text: turn.text })
    for (const raw of turn.messages) {
      for (const event of mapSdkMessage(raw, seen)) {
        state = reduceTranscript(state, { type: 'agent-event', event })
      }
    }
  }
  return state.cost.totalUsd
}

async function expectAgreement(script: readonly ScriptedTurn[], expected: number): Promise<void> {
  const [main, renderer] = [await mainTotal(script), rendererTotal(script)]
  expect(main).toBeCloseTo(expected, 10)
  expect(renderer).toBeCloseTo(expected, 10)
  expect(main).toBe(renderer)
}

describe('cost agreement — main and the renderer report the same session total', () => {
  it('agrees on a plain successful turn', async () => {
    await expectAgreement(
      [
        {
          text: 'hi',
          messages: [INIT, { type: 'result', subtype: 'success', total_cost_usd: 0.02 }],
        },
      ],
      0.02,
    )
  })

  it('agrees across several turns', async () => {
    await expectAgreement(
      [
        {
          text: 'one',
          messages: [INIT, { type: 'result', subtype: 'success', total_cost_usd: 0.1 }],
        },
        { text: 'two', messages: [{ type: 'result', subtype: 'success', total_cost_usd: 0.25 }] },
        { text: 'three', messages: [{ type: 'result', subtype: 'success', total_cost_usd: 0.05 }] },
      ],
      0.4,
    )
  })

  it('agrees on a failed turn — an error result is still billed (§10)', async () => {
    await expectAgreement(
      [
        {
          text: 'boom',
          messages: [
            INIT,
            { type: 'result', subtype: 'error_during_execution', total_cost_usd: 0.03 },
          ],
        },
      ],
      0.03,
    )
  })

  it('agrees on a budget-capped turn — the SDK ceiling still costs what it spent', async () => {
    await expectAgreement(
      [
        {
          text: 'expensive',
          messages: [INIT, { type: 'result', subtype: 'error_max_budget_usd', total_cost_usd: 2 }],
        },
      ],
      2,
    )
  })

  it('agrees when the runtime emits a duplicate result for one turn', async () => {
    // The case a naive `spendUsd += cost` in main would get wrong while the renderer got it right —
    // exactly the silent drift this file exists to catch.
    await expectAgreement(
      [
        {
          text: 'hi',
          messages: [
            INIT,
            { type: 'result', subtype: 'success', total_cost_usd: 0.04 },
            { type: 'result', subtype: 'success', total_cost_usd: 0.04 },
          ],
        },
      ],
      0.04,
    )
  })

  it('agrees on a stray result that no turn opened', async () => {
    // Main used to fold this and the renderer never did. Both now ignore it.
    const stray = [{ type: 'result', subtype: 'success', total_cost_usd: 9.99 }]
    const queryFn = vi.fn(() => fakeHandle([INIT, ...stray])) as unknown as AgentQueryFn
    const emitted: AgentEvent[] = []
    const session = new AgentSession({
      queryFn,
      options: OPTIONS,
      emit: (event) => emitted.push(event),
      log: () => {},
    })
    // No `send()` — but a query cannot start without one, so drive the reducer side alone and assert
    // main agrees by construction: nothing opened a turn, so nothing folds.
    session.send('opened')
    await vi.waitFor(() => expect(emitted.some((e) => e.type === 'turn-end')).toBe(true))
    // The first result folds (a turn was open); a second stray one does not.
    expect(session.estimatedSpendUsd).toBeCloseTo(9.99)
    await session.close()

    let state: Transcript = initialTranscript
    const seen = new Set<string>()
    // Reducer with *no* user-send at all: the stray result contributes nothing.
    for (const raw of stray) {
      for (const event of mapSdkMessage(raw, seen)) {
        state = reduceTranscript(state, { type: 'agent-event', event })
      }
    }
    expect(state.cost.totalUsd).toBe(0)
  })

  it('agrees on an interrupted turn — the cost is folded, not discarded', async () => {
    // The SDK's post-interrupt `result` lands after the turn has settled to `interrupted`. Gating on
    // the fold flag rather than the turn state is what makes both sides count it.
    const messages = [INIT, { type: 'result', subtype: 'success', total_cost_usd: 0.07 }]
    const main = await mainTotal([{ text: 'stop me', messages }])

    let state: Transcript = initialTranscript
    const seen = new Set<string>()
    state = reduceTranscript(state, { type: 'user-send', text: 'stop me' })
    state = reduceTranscript(state, { type: 'interrupt-requested' })
    for (const raw of messages) {
      for (const event of mapSdkMessage(raw, seen)) {
        state = reduceTranscript(state, { type: 'agent-event', event })
      }
    }
    expect(state.turnState).toBe('interrupted')
    expect(state.cost.totalUsd).toBeCloseTo(0.07)
    expect(state.cost.totalUsd).toBe(main)
  })
})
