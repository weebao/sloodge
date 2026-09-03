import { describe, expect, it, vi } from 'vitest'
import { AgentSession, QUERY_ENDED_SUBTYPE } from '../../../src/main/agent/session'
import type {
  AgentQueryFn,
  AgentQueryHandle,
  AgentQueryOptions,
} from '../../../src/main/agent/query-contract'
import type { AgentEvent } from '../../../src/shared/agent/types'

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
    expect(emitted.at(-1)).toEqual({ type: 'turn-end', costUsd: 0, subtype: QUERY_ENDED_SUBTYPE })
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
      { type: 'turn-end', costUsd: 0, subtype: QUERY_ENDED_SUBTYPE },
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
