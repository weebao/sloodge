import { describe, expect, it, vi } from 'vitest'
import { AgentSession } from '../../../src/main/agent/session'
import type {
  AgentQueryFn,
  AgentQueryHandle,
  AgentQueryOptions,
} from '../../../src/main/agent/query-contract'
import type { AgentEvent } from '../../../src/shared/agent/types'

const OPTIONS: AgentQueryOptions = {
  apiKey: 'sk-ant-test',
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

describe('AgentSession', () => {
  it('starts the query lazily and streams mapped events for a turn', async () => {
    const emitted: AgentEvent[] = []
    const queryFn = vi.fn(() =>
      fakeHandle([
        { type: 'system', subtype: 'init', session_id: 's1', model: 'claude-opus-5' },
        {
          type: 'stream_event',
          event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hi' } },
        },
        { type: 'result', subtype: 'success', total_cost_usd: 0.02 },
      ]),
    ) as unknown as AgentQueryFn

    const session = new AgentSession({ queryFn, options: OPTIONS, emit: (e) => emitted.push(e) })
    session.send('hello')

    await vi.waitFor(() => expect(emitted.some((e) => e.type === 'turn-end')).toBe(true))
    expect(emitted.map((e) => e.type)).toEqual(['ready', 'assistant-delta', 'turn-end'])
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
    const session = new AgentSession({ queryFn, options: OPTIONS, emit: (e) => emitted.push(e) })
    session.send('hi')

    await vi.waitFor(() => expect(emitted.some((e) => e.type === 'error')).toBe(true))
    expect(emitted.at(-1)).toMatchObject({ type: 'error', kind: 'network', recoverable: true })
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
})
