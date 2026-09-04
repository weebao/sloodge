import { describe, expect, it, vi } from 'vitest'
import { AgentSession, QUERY_ENDED_SUBTYPE } from '../../../src/main/agent/session'
import type {
  AgentQueryFn,
  AgentQueryHandle,
  AgentQueryOptions,
} from '../../../src/main/agent/query-contract'
import type { AgentEvent } from '../../../src/shared/agent/types'
import { evaluateBudget } from '../../../src/shared/agent/budget'

const OPTIONS: AgentQueryOptions = {
  credential: { kind: 'api-key', value: 'sk-ant-test' },
  model: 'claude-opus-5',
  cwd: '/workspace',
  configDir: '/config',
}

/** Build a fake handle that yields a scripted message list, then optionally throws. */
function fakeHandle(
  messages: readonly unknown[],
  opts: { throwError?: unknown; interrupt?: () => Promise<unknown> } = {},
): AgentQueryHandle {
  async function* gen(): AsyncGenerator<unknown, void, unknown> {
    // `for await` in the session awaits each step, so a plain yield still interleaves.
    yield* messages
    if (opts.throwError !== undefined) throw opts.throwError
  }
  const handle = gen() as AgentQueryHandle
  handle.interrupt = opts.interrupt ?? (async () => undefined)
  handle.setModel = async () => undefined
  return handle
}

/** A `system:init` message reporting exactly the skills the runtime says it loaded. */
const initWith = (skills: readonly string[]): Record<string, unknown> => ({
  type: 'system',
  subtype: 'init',
  session_id: 's1',
  model: 'claude-opus-5',
  skills,
})

describe('AgentSession', () => {
  it('starts the query lazily and streams mapped events for a turn', async () => {
    const emitted: AgentEvent[] = []
    const queryFn = vi.fn(() =>
      fakeHandle([
        {
          type: 'system',
          subtype: 'init',
          session_id: 's1',
          model: 'claude-opus-5',
          // A healthy session: all three bundled skills loaded, so no degradation notice.
          skills: ['slide-deck', 'svg-animation', 'interactive-graph'],
        },
        {
          type: 'stream_event',
          event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hi' } },
        },
        { type: 'result', subtype: 'success', total_cost_usd: 0.02 },
      ]),
    ) as unknown as AgentQueryFn

    const session = new AgentSession({
      queryFn,
      options: OPTIONS,
      emit: (e) => emitted.push(e),
      log: () => {},
    })
    session.send('hello')

    await vi.waitFor(() => expect(emitted.some((e) => e.type === 'turn-end')).toBe(true))
    // `skills-status` rides with `ready` from M2.5: every resolved init reports how the session
    // loaded its craft knowledge, so a fallback restart can never be invisible (§8).
    expect(emitted.map((e) => e.type)).toEqual([
      'ready',
      'skills-status',
      'assistant-delta',
      'turn-end',
    ])
    expect(session.estimatedSpendUsd).toBeCloseTo(0.02)
  })

  it('passes the SDK options through and feeds the sent text into the prompt', async () => {
    let captured: Parameters<AgentQueryFn>[0] | null = null
    const queryFn: AgentQueryFn = (params) => {
      captured = params
      return fakeHandle([])
    }
    const session = new AgentSession({ queryFn, options: OPTIONS, emit: () => {} })
    session.send('make a title slide')

    expect(captured).not.toBeNull()
    const params = captured as unknown as Parameters<AgentQueryFn>[0]
    expect(params.options).toEqual(OPTIONS)
    const first = await params.prompt[Symbol.asyncIterator]().next()
    expect(first.done === false && first.value.message.content).toBe('make a title slide')
    await session.close()
  })

  it('reuses one query across turns (one subprocess per session)', () => {
    const queryFn = vi.fn(() => fakeHandle([])) as unknown as AgentQueryFn
    const session = new AgentSession({ queryFn, options: OPTIONS, emit: () => {} })
    session.send('first')
    session.send('second')
    expect(queryFn).toHaveBeenCalledTimes(1)
  })

  it('surfaces a thrown generator error as a typed event, not a rejection', async () => {
    const emitted: AgentEvent[] = []
    const queryFn: AgentQueryFn = () =>
      fakeHandle([], { throwError: new Error('getaddrinfo ENOTFOUND api.anthropic.com') })
    const session = new AgentSession({
      queryFn,
      options: OPTIONS,
      emit: (e) => emitted.push(e),
      log: () => {},
    })
    session.send('hi')

    await vi.waitFor(() => expect(emitted.some((e) => e.type === 'error')).toBe(true))
    expect(emitted.filter((e) => e.type === 'error')).toEqual([
      expect.objectContaining({ type: 'error', kind: 'network', recoverable: true }),
    ])
    // The throw ended the query with the turn open: main closes that turn at $0 — once, silently,
    // because the network error above already said why.
    await vi.waitFor(() => expect(emitted.filter((e) => e.type === 'turn-end')).toHaveLength(1))
    expect(emitted.at(-1)).toEqual({
      type: 'turn-end',
      snapshotUsd: 0,
      generation: 0,
      subtype: QUERY_ENDED_SUBTYPE,
    })
    expect(session.openTurns).toBe(0)
  })

  it('interrupt() delegates to the live handle and reports false when idle', async () => {
    const interrupt = vi.fn(async () => undefined)
    const queryFn: AgentQueryFn = () => fakeHandle([], { interrupt })
    const session = new AgentSession({ queryFn, options: OPTIONS, emit: () => {} })

    expect(await session.interrupt()).toBe(false) // never started
    session.send('go')
    expect(await session.interrupt()).toBe(true)
    expect(interrupt).toHaveBeenCalledOnce()
    await session.close()
  })

  it('close() is idempotent and stops accepting sends', async () => {
    const queryFn = vi.fn(() => fakeHandle([])) as unknown as AgentQueryFn
    const session = new AgentSession({ queryFn, options: OPTIONS, emit: () => {} })
    session.send('one')
    await session.close()
    await session.close()
    session.send('after-close')
    // No second query is started by a post-close send.
    expect(queryFn).toHaveBeenCalledTimes(1)
  })

  it('closes a turn its query ended without answering — on both ledgers, with a reason', async () => {
    // A query that ends (the SDK's ceiling with a second turn queued behind it, a stream closed
    // unannounced) leaves a turn no `result` will close. Left alone it wedged the renderer in
    // `streaming` with no bubble and left both open-turn counts one too high. Main is the side that
    // can see the query end, so main ends the turn: a $0 `turn-end` the renderer folds identically,
    // then an error the user can act on.
    const emitted: AgentEvent[] = []
    const queryFn = vi.fn(() =>
      fakeHandle([initWith(['slide-deck', 'svg-animation', 'interactive-graph'])]),
    ) as unknown as AgentQueryFn
    const session = new AgentSession({
      queryFn,
      options: OPTIONS,
      emit: (e) => emitted.push(e),
      log: () => {},
    })
    session.send('hello')

    await vi.waitFor(() => expect(emitted.some((e) => e.type === 'error')).toBe(true))
    expect(emitted.filter((e) => e.type === 'turn-end')).toEqual([
      { type: 'turn-end', snapshotUsd: 0, generation: 0, subtype: QUERY_ENDED_SUBTYPE },
    ])
    expect(emitted.at(-1)).toMatchObject({ type: 'error', kind: 'unknown', recoverable: true })
    expect(session.openTurns).toBe(0)
    expect(session.estimatedSpendUsd).toBe(0)
    // The next send re-arms a fresh query rather than pushing into the dead one.
    session.send('again')
    expect(queryFn).toHaveBeenCalledTimes(2)
    await session.close()
  })

  it('does not close open turns on dispose — the renderer is gone, and both ledgers stay symmetric', async () => {
    const emitted: AgentEvent[] = []
    const queryFn = vi.fn(() => fakeHandle([])) as unknown as AgentQueryFn
    const session = new AgentSession({
      queryFn,
      options: OPTIONS,
      emit: (e) => emitted.push(e),
      log: () => {},
    })
    session.send('hello')
    await session.close()
    expect(emitted).toEqual([])
    expect(session.openTurns).toBe(1)
  })

  it('refuses local-command text itself rather than trusting its single caller', async () => {
    // `AgentService.send` already refuses this, with a reason the renderer can explain — but this
    // class is exported and directly constructible, so the cap's guarantee that a `/clear` never
    // reaches the wire rested on that call site staying unique. Here it is a construction instead:
    // no subprocess is started, no turn is opened, and nothing is written to the stream.
    const logged: string[] = []
    const queryFn = vi.fn(() => fakeHandle([]))
    const session = new AgentSession({
      queryFn: queryFn as unknown as AgentQueryFn,
      options: OPTIONS,
      emit: () => {},
      log: (line) => logged.push(line),
    })
    session.send('  /clear ')
    expect(queryFn).not.toHaveBeenCalled()
    expect(session.openTurns).toBe(0)
    expect(logged.some((line) => line.includes('local-command text refused'))).toBe(true)
    await session.close()
  })

  it('normalises a malformed cap through the same sanitiser admission uses', async () => {
    // A cap of 0 is rejected by `isBudgetCap` at both the IPC boundary and the file parse, so this
    // is unreachable today. It is pinned because the two enforcers must not *disagree* about it:
    // `evaluateBudget` reads 0 as the $2.00 default, and this used to hand `maxBudgetUsd: 0` to the
    // query — a backstop that would end every turn on its first API call.
    const calls: Parameters<AgentQueryFn>[0][] = []
    const queryFn = ((params: Parameters<AgentQueryFn>[0]) => {
      calls.push(params)
      return fakeHandle([])
    }) as unknown as AgentQueryFn
    const session = new AgentSession({ queryFn, options: OPTIONS, emit: () => {}, log: () => {} })
    session.setBudgetCap(0)
    session.send('hi')
    expect(calls[0]?.options.maxBudgetUsd).toBe(evaluateBudget(0, 0).capUsd)
    expect(calls[0]?.options.maxBudgetUsd).toBe(2)
    await session.close()
  })

  describe('skillStatus — the §8 assertion that the bundled skills reached the model', () => {
    it('reports nothing missing, and no degradation notice, when init lists all three', async () => {
      const emitted: AgentEvent[] = []
      const logged: string[] = []
      const queryFn = vi.fn(() =>
        fakeHandle([initWith(['slide-deck', 'svg-animation', 'interactive-graph'])]),
      ) as unknown as AgentQueryFn
      const session = new AgentSession({
        queryFn,
        options: OPTIONS,
        emit: (e) => emitted.push(e),
        log: (m) => logged.push(m),
      })
      session.send('hello')

      await vi.waitFor(() => expect(session.skillStatus.known).toBe(true))
      expect(session.skillStatus).toEqual({
        known: true,
        mode: 'skills',
        loaded: ['slide-deck', 'svg-animation', 'interactive-graph'],
        missing: [],
      })
      expect(emitted.some((e) => e.type === 'skills-degraded')).toBe(false)
      expect(emitted.find((e) => e.type === 'skills-status')).toEqual({
        type: 'skills-status',
        status: 'ok',
      })
      // A healthy session still logs, so a support case can answer "did it have the skills?".
      expect(logged.join('\n')).toContain('slide-deck')
      await session.close()
    })

    // No `loadFallbackPrompt` dep on these sessions, so §8's repair is unavailable and M2.4's loud
    // state is the correct outcome. The repaired path is covered in skills-fallback.test.ts.
    it('emits a user-visible degradation notice naming what did not load', async () => {
      const emitted: AgentEvent[] = []
      const logged: string[] = []
      const queryFn = vi.fn(() => fakeHandle([initWith(['slide-deck'])])) as unknown as AgentQueryFn
      const session = new AgentSession({
        queryFn,
        options: OPTIONS,
        emit: (e) => emitted.push(e),
        log: (m) => logged.push(m),
      })
      session.send('hello')

      await vi.waitFor(() => expect(emitted.some((e) => e.type === 'skills-degraded')).toBe(true))
      expect(emitted.find((e) => e.type === 'skills-degraded')).toEqual({
        type: 'skills-degraded',
        missing: ['svg-animation', 'interactive-graph'],
      })
      // The notice follows `ready`, so the renderer has an open session when it lands, and the
      // status-bar indicator lands with it reading `unavailable` (M2.5).
      expect(emitted.map((e) => e.type).slice(0, 3)).toEqual([
        'ready',
        'skills-status',
        'skills-degraded',
      ])
      expect(emitted.find((e) => e.type === 'skills-status')).toEqual({
        type: 'skills-status',
        status: 'unavailable',
      })
      expect(logged.join('\n')).toContain('MISSING')
      await session.close()
    })

    it('announces at most once, even if the runtime re-inits mid-session', async () => {
      const emitted: AgentEvent[] = []
      const queryFn = vi.fn(() =>
        fakeHandle([initWith([]), initWith([])]),
      ) as unknown as AgentQueryFn
      const session = new AgentSession({
        queryFn,
        options: OPTIONS,
        emit: (e) => emitted.push(e),
        log: () => {},
      })
      session.send('hello')

      await vi.waitFor(() => expect(emitted.filter((e) => e.type === 'ready')).toHaveLength(2))
      expect(emitted.filter((e) => e.type === 'skills-degraded')).toHaveLength(1)
      await session.close()
    })

    it('is "not yet known" before init, so a consumer cannot misread the handshake as absence', () => {
      const queryFn = vi.fn(() => fakeHandle([])) as unknown as AgentQueryFn
      const session = new AgentSession({ queryFn, options: OPTIONS, emit: () => {} })
      expect(session.skillStatus).toEqual({ known: false })
    })
  })
})

/**
 * A runtime the test feeds by hand: `deliver` queues messages, `end` closes the stream, `fail` makes
 * the generator throw (a transport failure). `interrupt()` is counted and answered with whatever
 * `onInterrupt` returns.
 */
function liveRuntime(onInterrupt: () => readonly unknown[] = () => []): {
  handle: AgentQueryHandle
  deliver: (...messages: readonly unknown[]) => void
  fail: (error: unknown) => void
  interrupts: () => number
} {
  const queue: unknown[] = []
  let wake: (() => void) | null = null
  let ended = false
  let failure: unknown
  let interrupts = 0
  const nudge = (): void => {
    const resume = wake
    wake = null
    resume?.()
  }
  async function* gen(): AsyncGenerator<unknown, void, unknown> {
    for (;;) {
      while (queue.length > 0) yield queue.shift()
      if (failure !== undefined) throw failure
      if (ended) return
      // eslint-disable-next-line no-await-in-loop
      await new Promise<void>((resolve) => {
        wake = resolve
      })
    }
  }
  const handle = gen() as AgentQueryHandle
  const deliver = (...messages: readonly unknown[]): void => {
    queue.push(...messages)
    nudge()
  }
  handle.interrupt = async () => {
    interrupts += 1
    deliver(...onInterrupt())
  }
  handle.setModel = async () => undefined
  const originalReturn = handle.return.bind(handle)
  handle.return = ((value?: void) => {
    ended = true
    nudge()
    return originalReturn(value)
  }) as AgentQueryHandle['return']
  return {
    handle,
    deliver,
    fail: (error) => {
      failure = error
      nudge()
    },
    interrupts: () => interrupts,
  }
}

const result = (uuid: string, totalCostUsd: number, subtype = 'success'): unknown => ({
  type: 'result',
  uuid,
  subtype,
  total_cost_usd: totalCostUsd,
})

const turnEnds = (emitted: readonly AgentEvent[]): number =>
  emitted.filter((e) => e.type === 'turn-end').length
const budgetErrors = (emitted: readonly AgentEvent[]): number =>
  emitted.filter((e) => e.type === 'error' && e.kind === 'budget').length

describe('AgentSession — total_cost_usd is the query’s running total (M2.5 round 4)', () => {
  it('folds snapshots 0.10 / 0.35 / 1.35 to a $1.35 session, not $1.80', async () => {
    const emitted: AgentEvent[] = []
    const rt = liveRuntime()
    const session = new AgentSession({
      queryFn: () => rt.handle,
      options: OPTIONS,
      emit: (e) => emitted.push(e),
      log: () => {},
    })
    for (const [i, snapshot] of [0.1, 0.35, 1.35].entries()) {
      session.send(`turn ${String(i)}`)
      rt.deliver(result(`r${String(i)}`, snapshot))
      // eslint-disable-next-line no-await-in-loop
      await vi.waitFor(() => expect(turnEnds(emitted)).toBe(i + 1))
    }
    expect(session.estimatedSpendUsd).toBeCloseTo(1.35, 10)
    await session.close()
  })

  it('a mid-generation tracker reset is banked, so a /clear cannot hide spend or the cap', async () => {
    // Round 5's blocker, end to end. `/clear` runs `Att()` inside the live subprocess, so its running
    // total restarts at $0 while the query keeps going: snapshots 1.5 → 0 → 1.0 in ONE generation for
    // $2.50 of real spend. Under the plain maximum both ledgers read $1.50, the $2.00 cap never bound
    // at admission, and the SDK's own backstop compared the same zeroed counter — the cap was
    // bypassable by typing a slash command. The fold now banks on the drop, and the cap binds.
    const emitted: AgentEvent[] = []
    const rt = liveRuntime()
    const session = new AgentSession({
      queryFn: () => rt.handle,
      options: { ...OPTIONS, maxBudgetUsd: 2 },
      emit: (e) => emitted.push(e),
      log: () => {},
    })
    for (const [i, snapshot] of [1.5, 0, 1].entries()) {
      session.send(`m${String(i)}`)
      rt.deliver(result(`r${String(i)}`, snapshot))
      // eslint-disable-next-line no-await-in-loop
      await vi.waitFor(() => expect(turnEnds(emitted)).toBe(i + 1))
    }
    expect(session.estimatedSpendUsd).toBeCloseTo(2.5, 10)
    // Both halves of the ledger agree on where the money went: the pre-reset segment is banked.
    expect(evaluateBudget(session.estimatedSpendUsd, 2).level).toBe('blocked')
    await session.close()
  })

  it('a re-armed query starts a fresh tracker: its snapshots add to the dead query’s final total', async () => {
    // Every resume is a fork (`client.ts`), so the CLI's cost-tracker restore — `xws(id)`, gated on
    // the per-cwd project config's `lastSessionId` matching the id the process is running under — has
    // no id to match. So the replacement's `total_cost_usd` restarts at $0 and the old generation's
    // last total is banked.
    const emitted: AgentEvent[] = []
    const runtimes: ReturnType<typeof liveRuntime>[] = []
    const resumes: (string | undefined)[] = []
    const queryFn: AgentQueryFn = ({ options }) => {
      resumes.push(options.resumeSessionId)
      const rt = liveRuntime()
      runtimes.push(rt)
      return rt.handle
    }
    const session = new AgentSession({
      queryFn,
      options: { ...OPTIONS, maxBudgetUsd: 2 },
      emit: (e) => emitted.push(e),
      log: () => {},
    })
    session.send('one')
    runtimes[0]?.deliver(initWith([]), result('r1', 0.1))
    await vi.waitFor(() => expect(turnEnds(emitted)).toBe(1))
    session.send('two')
    // The SDK's ceiling ends the query; the snapshot is that subprocess's final total.
    runtimes[0]?.deliver(result('r2', 2.4, 'error_max_budget_usd'))
    await vi.waitFor(() => expect(turnEnds(emitted)).toBe(2))
    expect(session.estimatedSpendUsd).toBeCloseTo(2.4, 10)

    session.setBudgetCap(10)
    session.send('three')
    expect(runtimes).toHaveLength(2)
    expect(resumes).toEqual([undefined, 's1'])
    runtimes[1]?.deliver(result('r3', 0.1))
    await vi.waitFor(() => expect(turnEnds(emitted)).toBe(3))
    expect(session.estimatedSpendUsd).toBeCloseTo(2.5, 10)
    await session.close()
  })

  it('if a future CLI restored the tracker on resume, the ledger would read high — never low', async () => {
    // Pinned deliberately, as the fallback behind `forkSession`. A resumed query whose first snapshot
    // already carried the old spend (2.4 + 0.1) is folded as a fresh generation, so the session reads
    // 2.4 + 2.5 = 4.9 for a real 2.5. That is the over-counting direction, which a spend control can
    // live with; the alternative rule ("a resumed snapshot IS the session total") reads 2.5 when the
    // restore does not fire — which is every Sloodge session on the bundled CLI
    // (sdk-cost-contract.test.ts) — and that is an undercount of the entire prior spend. Note the
    // restore's first snapshot is *above* the banked total, so the reset branch does not fire on it
    // either: a restore reads high, a reset reads exact, and neither reads low. Change this only with
    // the contract test.
    const emitted: AgentEvent[] = []
    const runtimes: ReturnType<typeof liveRuntime>[] = []
    const session = new AgentSession({
      queryFn: () => {
        const rt = liveRuntime()
        runtimes.push(rt)
        return rt.handle
      },
      options: { ...OPTIONS, maxBudgetUsd: 2 },
      emit: (e) => emitted.push(e),
      log: () => {},
    })
    session.send('one')
    runtimes[0]?.deliver(initWith([]), result('r1', 2.4, 'error_max_budget_usd'))
    await vi.waitFor(() => expect(turnEnds(emitted)).toBe(1))
    session.setBudgetCap(10)
    session.send('two')
    runtimes[1]?.deliver(result('r2', 2.5))
    await vi.waitFor(() => expect(turnEnds(emitted)).toBe(2))
    expect(session.estimatedSpendUsd).toBeCloseTo(4.9, 10)
    await session.close()
  })

  it('a cap-stop whose query dies before answering does not disarm the replacement’s cap-stop', async () => {
    // Round 4's major: `budgetInterruptPending` was cleared only by the fold of the interrupted
    // turn's result. A query that crashed before delivering it left the flag set, so the next
    // lower-below-spend on the re-armed query produced no interrupt and no budget error.
    const emitted: AgentEvent[] = []
    const runtimes: ReturnType<typeof liveRuntime>[] = []
    const session = new AgentSession({
      queryFn: () => {
        // The cap-stop's interrupt is answered with the stopped turn's result — on the second query.
        // The first query dies instead (see `fail` below).
        const rt = liveRuntime(() => (runtimes.length === 2 ? [result('r3', 0.5)] : []))
        runtimes.push(rt)
        return rt.handle
      },
      options: { ...OPTIONS, maxBudgetUsd: 1 },
      emit: (e) => emitted.push(e),
      log: () => {},
    })
    session.send('one')
    runtimes[0]?.deliver(initWith([]), result('r1', 0.5))
    await vi.waitFor(() => expect(turnEnds(emitted)).toBe(1))
    session.send('two')
    session.setBudgetCap(0.4)
    await vi.waitFor(() => expect(runtimes[0]?.interrupts()).toBe(1))
    expect(budgetErrors(emitted)).toBe(1)
    // The runtime dies before the interrupted turn's result.
    runtimes[0]?.fail(new Error('read ECONNRESET'))
    await vi.waitFor(() => expect(turnEnds(emitted)).toBe(2))
    expect(emitted.at(-1)).toEqual({
      type: 'turn-end',
      snapshotUsd: 0,
      generation: 0,
      subtype: QUERY_ENDED_SUBTYPE,
    })

    session.setBudgetCap(10)
    session.send('three')
    expect(runtimes).toHaveLength(2)
    session.setBudgetCap(0.4)
    await vi.waitFor(() => expect(runtimes[1]?.interrupts()).toBe(1))
    await vi.waitFor(() => expect(turnEnds(emitted)).toBe(3))
    expect(budgetErrors(emitted)).toBe(2)
    // 0.5 from the first query, 0.5 from the second; the crashed turn billed nothing.
    expect(session.estimatedSpendUsd).toBeCloseTo(1.0, 10)
    await session.close()
  })

  it('three open turns at the cap: every open turn is interrupted, the user is told once', async () => {
    const emitted: AgentEvent[] = []
    const rt = liveRuntime()
    const session = new AgentSession({
      queryFn: () => rt.handle,
      options: { ...OPTIONS, maxBudgetUsd: 1 },
      emit: (e) => emitted.push(e),
      log: () => {},
    })
    session.send('one')
    session.send('two')
    session.send('three')
    expect(session.openTurns).toBe(3)
    // The first result carries the total over the cap while two turns are still open.
    rt.deliver(result('r1', 1.2))
    await vi.waitFor(() => expect(rt.interrupts()).toBe(1))
    rt.deliver(result('r2', 1.25))
    await vi.waitFor(() => expect(rt.interrupts()).toBe(2))
    rt.deliver(result('r3', 1.3))
    await vi.waitFor(() => expect(turnEnds(emitted)).toBe(3))
    expect(budgetErrors(emitted)).toBe(1)
    expect(session.estimatedSpendUsd).toBeCloseTo(1.3, 10)
    // Back under the cap, the next crossing is a new event and is announced again.
    session.setBudgetCap(5)
    session.send('four')
    rt.deliver(result('r4', 5.5))
    await vi.waitFor(() => expect(turnEnds(emitted)).toBe(4))
    session.send('five')
    session.setBudgetCap(2)
    await vi.waitFor(() => expect(rt.interrupts()).toBe(3))
    expect(budgetErrors(emitted)).toBe(2)
    await session.close()
  })
})
