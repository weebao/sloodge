import { describe, expect, it, vi } from 'vitest'
import { AgentService } from '../../../src/main/agent/service'
import type { AgentCredential } from '../../../src/main/agent/auth-env'
import type { AgentQueryFn, AgentQueryHandle } from '../../../src/main/agent/query-contract'
import type { AgentEvent } from '../../../src/shared/agent/types'

/**
 * What the vault resolves to once the user is configured (M2.7: `loadCredential` replaced the bare
 * `loadApiKey`). `null` still means "nothing stored", which is what the refusal tests turn on.
 */
const LIVE: AgentCredential = { kind: 'api-key', value: 'sk-ant-live' }

/**
 * A queryFn that counts how many `query()` subprocesses it opens (`starts`) and records every
 * `handle.return()` (the close path). A leaked subprocess shows up as `starts` exceeding the number
 * of sessions that were ever closed.
 */
function recordingQueryFn(): {
  queryFn: AgentQueryFn
  returns: ReturnType<typeof vi.fn>
  starts: () => number
} {
  const returns = vi.fn()
  let starts = 0
  const queryFn: AgentQueryFn = () => {
    starts += 1
    // A *live* streaming-input query: it stays open between turns and ends only when returned, which
    // is what the real SDK does. A generator that ended immediately would model a query that had
    // already terminated — and since M2.5 a terminated query correctly makes the session re-arm on
    // the next send, so `starts` would count re-arms instead of the session creations these tests
    // are about. The gate is released by `return()` so teardown still completes promptly.
    let release: (() => void) | null = null
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const gen = (async function* (): AsyncGenerator<unknown, void, unknown> {
      await gate
      // Unreachable in practice: the gate is only released by `return()`, which resumes this
      // generator with a return completion. Present so the fake is a real generator.
      yield undefined
    })()
    const handle = gen as unknown as AgentQueryHandle
    handle.interrupt = async () => undefined
    handle.setModel = async () => undefined
    const originalReturn = gen.return.bind(gen)
    handle.return = ((value?: void) => {
      returns()
      release?.()
      return originalReturn(value)
    }) as AgentQueryHandle['return']
    return handle
  }
  return { queryFn, returns, starts: () => starts }
}

const PATHS = () => ({ cwd: '/w', configDir: '/c' })
const NOOP = (): void => {}

/** A promise the test settles by hand, for asserting that a caller genuinely awaited it. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = NOOP
  const promise = new Promise<void>((r) => {
    resolve = r
  })
  return { promise, resolve: () => resolve() }
}

describe('AgentService', () => {
  it('refuses to start a session when no key is configured', async () => {
    const rec = recordingQueryFn()
    const service = new AgentService({
      queryFn: rec.queryFn,
      loadCredential: async () => null,
      resolvePaths: PATHS,
    })
    expect(await service.send(1, 'hi', () => {})).toEqual({
      accepted: false,
      reason: 'no-credential',
    })
    expect(rec.starts()).toBe(0)
  })

  it('accepts a turn once a key is configured, and does not cache the no-key refusal', async () => {
    const rec = recordingQueryFn()
    const loadCredential = vi
      .fn<() => Promise<AgentCredential | null>>()
      .mockResolvedValueOnce(null)
      .mockResolvedValue(LIVE)
    const service = new AgentService({ queryFn: rec.queryFn, loadCredential, resolvePaths: PATHS })

    expect(await service.send(1, 'first', () => {})).toEqual({
      accepted: false,
      reason: 'no-credential',
    })
    expect(await service.send(1, 'second', () => {})).toEqual({ accepted: true })
    expect(rec.starts()).toBe(1)
  })

  it('refuses a turn once the session has spent its cap — the authoritative guard (M2.5, §10)', async () => {
    // The renderer performs the same check so the composer can explain itself without a round trip,
    // but a guard that only exists in the renderer is one a renderer bug can walk past.
    let starts = 0
    const queryFn: AgentQueryFn = () => {
      starts += 1
      // One turn that ends having spent past the cap. It is not interrupted — it already ran.
      const gen = (async function* () {
        yield { type: 'result', subtype: 'success', total_cost_usd: 0.25 }
      })()
      const handle = gen as unknown as AgentQueryHandle
      handle.interrupt = async () => undefined
      handle.setModel = async () => undefined
      return handle
    }
    const emitted: AgentEvent[] = []
    const emit = (event: AgentEvent): void => {
      emitted.push(event)
    }
    const service = new AgentService({
      queryFn,
      loadCredential: async () => LIVE,
      resolvePaths: PATHS,
      loadBudgetCap: async () => 0.1,
    })

    // The first turn is never refused on budget: a session with no spend cannot have exhausted a
    // positive cap, and the check runs against the session that already exists.
    expect(await service.send(1, 'first', emit)).toEqual({ accepted: true })
    await vi.waitFor(() => expect(emitted.some((e) => e.type === 'turn-end')).toBe(true))

    expect(await service.send(1, 'second', emit)).toEqual({ accepted: false, reason: 'budget' })
    // A blocked send never opens another query.
    expect(starts).toBe(1)
    await service.dispose(1)
  })

  it('recovers after a budget stop: raising the cap makes the very next send actually run', async () => {
    // The claim this milestone writes into its own spec twice — "raise the limit in Settings and
    // carry on". Hitting the cap is the GUARANTEED end state of the feature (maxBudgetUsd is the
    // whole cap), and the SDK ends the query when it fires. If the session does not re-arm, every
    // later send pushes into a dead bridge while `accepted: true` comes back, and the chat panel is
    // finished for the life of the window.
    const ceilings: (number | undefined)[] = []
    let starts = 0
    const queryFn: AgentQueryFn = (params) => {
      starts += 1
      ceilings.push(params.options.maxBudgetUsd)
      const first = starts === 1
      const gen = (async function* () {
        if (first) {
          // The SDK's own ceiling fires and TERMINATES the query.
          yield { type: 'result', subtype: 'error_max_budget_usd', total_cost_usd: 2.4 }
        } else {
          yield { type: 'result', subtype: 'success', total_cost_usd: 0.1 }
        }
      })()
      const handle = gen as unknown as AgentQueryHandle
      handle.interrupt = async () => undefined
      handle.setModel = async () => undefined
      return handle
    }
    const emitted: AgentEvent[] = []
    const emit = (event: AgentEvent): void => {
      emitted.push(event)
    }
    let capUsd: number = 2
    const service = new AgentService({
      queryFn,
      loadCredential: async () => LIVE,
      resolvePaths: PATHS,
      loadBudgetCap: async () => capUsd,
    })

    expect(await service.send(1, 'expensive', emit)).toEqual({ accepted: true })
    await vi.waitFor(() => expect(emitted.filter((e) => e.type === 'turn-end')).toHaveLength(1))
    expect(ceilings[0]).toBe(2)

    // Still blocked while the cap stands.
    expect(await service.send(1, 'blocked', emit)).toEqual({ accepted: false, reason: 'budget' })
    expect(starts).toBe(1)

    // The user raises the limit in Settings.
    capUsd = 20
    expect(await service.send(1, 'after raising', emit)).toEqual({ accepted: true })

    // A genuinely new query, and it produces events rather than vanishing into a dead bridge.
    await vi.waitFor(() => expect(starts).toBe(2))
    await vi.waitFor(() => expect(emitted.filter((e) => e.type === 'turn-end')).toHaveLength(2))
    // ...carrying the RAISED cap's remaining budget, not the ceiling that stopped it.
    expect(ceilings[1]).toBeCloseTo(20 - 2.4)
    await service.dispose(1)
  })

  it('keeps accepting turns while under the cap', async () => {
    const rec = recordingQueryFn()
    const service = new AgentService({
      queryFn: rec.queryFn,
      loadCredential: async () => LIVE,
      resolvePaths: PATHS,
      loadBudgetCap: async () => 2,
    })
    expect(await service.send(1, 'first', NOOP)).toEqual({ accepted: true })
    expect(await service.send(1, 'second', NOOP)).toEqual({ accepted: true })
    expect(rec.starts()).toBe(1)
    await service.dispose(1)
  })

  it('hands the SDK the remaining budget as an in-flight ceiling', async () => {
    let captured: number | undefined
    const queryFn: AgentQueryFn = (params) => {
      captured = params.options.maxBudgetUsd
      const gen = (async function* () {})()
      const handle = gen as unknown as AgentQueryHandle
      handle.interrupt = async () => undefined
      handle.setModel = async () => undefined
      return handle
    }
    const service = new AgentService({
      queryFn,
      loadCredential: async () => LIVE,
      resolvePaths: PATHS,
      loadBudgetCap: async () => 2,
    })
    await service.send(1, 'hi', NOOP)
    expect(captured).toBe(2)
    await service.dispose(1)
  })

  it('omits the ceiling when the user has configured no cap', async () => {
    let captured: number | undefined = 999
    const queryFn: AgentQueryFn = (params) => {
      captured = params.options.maxBudgetUsd
      const gen = (async function* () {})()
      const handle = gen as unknown as AgentQueryHandle
      handle.interrupt = async () => undefined
      handle.setModel = async () => undefined
      return handle
    }
    const service = new AgentService({
      queryFn,
      loadCredential: async () => LIVE,
      resolvePaths: PATHS,
      loadBudgetCap: async () => null,
    })
    await service.send(1, 'hi', NOOP)
    expect(captured).toBeUndefined()
    await service.dispose(1)
  })

  it('creates exactly one session under concurrent sends for one sender (no orphaned subprocess)', async () => {
    const rec = recordingQueryFn()
    let resolveKey: (credential: AgentCredential | null) => void = NOOP
    const loadCredential = vi.fn(
      () =>
        new Promise<AgentCredential | null>((resolve) => {
          resolveKey = resolve
        }),
    )
    const service = new AgentService({ queryFn: rec.queryFn, loadCredential, resolvePaths: PATHS })

    // Two sends race before the first key load resolves.
    const p1 = service.send(7, 'a', () => {})
    const p2 = service.send(7, 'b', () => {})
    expect(loadCredential).toHaveBeenCalledTimes(1) // the second send awaits the first's creation

    resolveKey(LIVE)
    expect(await Promise.all([p1, p2])).toEqual([{ accepted: true }, { accepted: true }])

    expect(rec.starts()).toBe(1) // exactly one subprocess spawned for the sender

    await service.disposeAll()
    expect(rec.returns).toHaveBeenCalledTimes(1) // that one session was closed — nothing orphaned
  })

  it('closes — never orphans — a session created while a dispose was in flight', async () => {
    const rec = recordingQueryFn()
    let resolveKey: (credential: AgentCredential | null) => void = NOOP
    const loadCredential = vi.fn(
      () =>
        new Promise<AgentCredential | null>((resolve) => {
          resolveKey = resolve
        }),
    )
    const service = new AgentService({ queryFn: rec.queryFn, loadCredential, resolvePaths: PATHS })

    const sendP = service.send(5, 'a', () => {}) // creation goes in flight
    const disposeP = service.dispose(5) // races the creation, before the key resolves
    resolveKey(LIVE)
    await Promise.all([sendP, disposeP])

    // The invariant that matters: every subprocess that started was also closed — none orphaned.
    //
    // The exact count is deliberately NOT pinned. Whether the racing send gets far enough to open a
    // query depends on how many microtasks separate it from the dispose, and M2.5 added one (the
    // budget-cap read). Losing that race is the better outcome — no subprocess is spawned for a
    // renderer that is already gone — so asserting `starts() === 1` would pin an incidental
    // interleaving and call an improvement a regression.
    expect(rec.returns).toHaveBeenCalledTimes(rec.starts())

    // And the sender is not permanently poisoned — a later send builds a fresh, live session.
    const send2 = service.send(5, 'b', () => {})
    resolveKey(LIVE)
    expect(await send2).toEqual({ accepted: true })
    expect(rec.starts()).toBeGreaterThanOrEqual(1)

    const started = rec.starts()
    await service.disposeAll()
    expect(rec.returns).toHaveBeenCalledTimes(started)
  })

  it('disposeAll waits for in-flight creations and closes them too', async () => {
    const rec = recordingQueryFn()
    let resolveKey: (credential: AgentCredential | null) => void = NOOP
    const loadCredential = vi.fn(
      () =>
        new Promise<AgentCredential | null>((resolve) => {
          resolveKey = resolve
        }),
    )
    const service = new AgentService({ queryFn: rec.queryFn, loadCredential, resolvePaths: PATHS })

    const sendP = service.send(8, 'a', () => {}) // creation in flight
    const allP = service.disposeAll() // quit races the creation
    resolveKey(LIVE)
    await Promise.all([sendP, allP])

    expect(rec.returns).toHaveBeenCalledTimes(rec.starts())
    expect(rec.returns).toHaveBeenCalledTimes(1)
  })

  it('disposeAll closes every live session even when an in-flight creation rejects (no orphans at quit)', async () => {
    const rec = recordingQueryFn()
    let rejectB: (reason?: unknown) => void = NOOP
    const loadCredential = vi
      .fn<() => Promise<AgentCredential | null>>()
      .mockResolvedValueOnce(LIVE) // sender A: resolves, becomes a live session
      .mockImplementationOnce(
        () =>
          new Promise<AgentCredential | null>((_resolve, reject) => {
            rejectB = reject // sender B: creation will reject
          }),
      )
    const service = new AgentService({ queryFn: rec.queryFn, loadCredential, resolvePaths: PATHS })

    await service.send(1, 'a', () => {}) // A live, subprocess started
    expect(rec.starts()).toBe(1)

    const bSend = service.send(2, 'b', () => {}) // B creation in flight
    const allP = service.disposeAll() // quit races the rejecting creation
    rejectB(new Error('vault boom'))

    await expect(bSend).rejects.toThrow('vault boom')
    await expect(allP).resolves.toBeUndefined() // disposeAll must not throw...
    expect(rec.returns).toHaveBeenCalledTimes(1) // ...and A must still be closed, not orphaned
  })

  it('dispose does not throw when the in-flight creation rejects', async () => {
    const rec = recordingQueryFn()
    let rejectKey: (reason?: unknown) => void = NOOP
    const loadCredential = vi.fn(
      () =>
        new Promise<AgentCredential | null>((_resolve, reject) => {
          rejectKey = reject
        }),
    )
    const service = new AgentService({ queryFn: rec.queryFn, loadCredential, resolvePaths: PATHS })

    const sendP = service.send(4, 'a', () => {})
    const disposeP = service.dispose(4)
    rejectKey(new Error('vault boom'))

    await expect(sendP).rejects.toThrow('vault boom')
    await expect(disposeP).resolves.toBeUndefined()
    expect(rec.starts()).toBe(0) // nothing was created or started
  })

  it('keeps sessions per sender distinct', async () => {
    const rec = recordingQueryFn()
    const service = new AgentService({
      queryFn: rec.queryFn,
      loadCredential: async () => LIVE,
      resolvePaths: PATHS,
    })
    await service.send(1, 'a', () => {})
    await service.send(2, 'b', () => {})
    expect(rec.starts()).toBe(2)
    await service.disposeAll()
    expect(rec.returns).toHaveBeenCalledTimes(2)
  })

  it('interrupt and dispose report/act sanely when a sender has no session', async () => {
    const rec = recordingQueryFn()
    const service = new AgentService({
      queryFn: rec.queryFn,
      loadCredential: async () => LIVE,
      resolvePaths: PATHS,
    })
    expect(await service.interrupt(99)).toEqual({ interrupted: false })
    await expect(service.dispose(99)).resolves.toBeUndefined()

    await service.send(3, 'go', () => {})
    await service.dispose(3)
    expect(rec.returns).toHaveBeenCalledTimes(1)
    // A send after dispose starts a fresh session rather than reusing the closed one.
    await service.send(3, 'again', () => {})
    expect(rec.starts()).toBe(2)
  })

  describe('prepareWorkspace (M2.4 skill materialization)', () => {
    it('materializes the workspace before the query opens, with the session cwd', async () => {
      const rec = recordingQueryFn()
      // A *deferred* fake: `prepareWorkspace` does not settle until this test says so. A fake that
      // resolves synchronously would record "prepare" before "query" even if the service dropped the
      // await, which is exactly how the first version of this test passed against a `void` mutant.
      // The real `materializeSkills` does four files of fs I/O, so async is also the honest shape.
      const gate = deferred()
      const cwdSeen: string[] = []
      const prepareWorkspace = vi.fn((cwd: string) => {
        cwdSeen.push(cwd)
        return gate.promise
      })
      const service = new AgentService({
        queryFn: rec.queryFn,
        loadCredential: async () => LIVE,
        resolvePaths: PATHS,
        prepareWorkspace,
      })

      const send = service.send(1, 'hi', NOOP)
      await Promise.resolve()
      await Promise.resolve()

      // Skills are discovered from disk when the subprocess starts — a copy that lands afterwards
      // is a session with no skills, silently. So no subprocess may exist yet.
      expect(cwdSeen).toEqual(['/w'])
      expect(rec.starts()).toBe(0)

      gate.resolve()
      await send
      expect(rec.starts()).toBe(1)
      expect(prepareWorkspace).toHaveBeenCalledTimes(1)
    })

    it('logs what was installed, and names the file when part of the copy failed', async () => {
      const rec = recordingQueryFn()
      const logged: string[] = []
      const service = new AgentService({
        queryFn: rec.queryFn,
        loadCredential: async () => LIVE,
        resolvePaths: PATHS,
        prepareWorkspace: async () => ({
          installed: ['svg-animation'],
          failures: ['slide-deck: ENOENT icons.md'],
        }),
        log: (message) => logged.push(message),
      })

      await service.send(1, 'hi', NOOP)

      expect(logged.join('\n')).toContain('svg-animation')
      expect(logged.join('\n')).toContain('slide-deck: ENOENT icons.md')
    })

    it('logs the rejection rather than swallowing it silently', async () => {
      const rec = recordingQueryFn()
      const logged: string[] = []
      const service = new AgentService({
        queryFn: rec.queryFn,
        loadCredential: async () => LIVE,
        resolvePaths: PATHS,
        prepareWorkspace: () => Promise.reject(new Error('EACCES')),
        log: (message) => logged.push(message),
      })

      await service.send(1, 'hi', NOOP)

      expect(logged.join('\n')).toContain('EACCES')
    })

    it('runs once per session, not once per turn', async () => {
      const rec = recordingQueryFn()
      const prepareWorkspace = vi.fn(async () => {})
      const service = new AgentService({
        queryFn: rec.queryFn,
        loadCredential: async () => LIVE,
        resolvePaths: PATHS,
        prepareWorkspace,
      })

      await service.send(1, 'one', NOOP)
      await service.send(1, 'two', NOOP)

      expect(prepareWorkspace).toHaveBeenCalledTimes(1)
    })

    it('still starts the session when materialization fails — degraded, not dead', async () => {
      const rec = recordingQueryFn()
      const service = new AgentService({
        queryFn: rec.queryFn,
        loadCredential: async () => LIVE,
        resolvePaths: PATHS,
        prepareWorkspace: () => Promise.reject(new Error('EACCES')),
      })

      expect(await service.send(1, 'hi', NOOP)).toEqual({ accepted: true })
      expect(rec.starts()).toBe(1)
    })
  })
})
