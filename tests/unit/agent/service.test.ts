import { describe, expect, it, vi } from 'vitest'
import { AgentService } from '../../../src/main/agent/service'
import type { AgentQueryFn, AgentQueryHandle } from '../../../src/main/agent/query-contract'

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
    const gen = (async function* () {})()
    const handle = gen as unknown as AgentQueryHandle
    handle.interrupt = async () => undefined
    handle.setModel = async () => undefined
    const originalReturn = gen.return.bind(gen)
    handle.return = ((value?: void) => {
      returns()
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
      loadApiKey: async () => null,
      resolvePaths: PATHS,
    })
    expect(await service.send(1, 'hi', () => {})).toEqual({ accepted: false })
    expect(rec.starts()).toBe(0)
  })

  it('accepts a turn once a key is configured, and does not cache the no-key refusal', async () => {
    const rec = recordingQueryFn()
    const loadApiKey = vi
      .fn<() => Promise<string | null>>()
      .mockResolvedValueOnce(null)
      .mockResolvedValue('sk-ant-live')
    const service = new AgentService({ queryFn: rec.queryFn, loadApiKey, resolvePaths: PATHS })

    expect(await service.send(1, 'first', () => {})).toEqual({ accepted: false })
    expect(await service.send(1, 'second', () => {})).toEqual({ accepted: true })
    expect(rec.starts()).toBe(1)
  })

  it('creates exactly one session under concurrent sends for one sender (no orphaned subprocess)', async () => {
    const rec = recordingQueryFn()
    let resolveKey: (key: string | null) => void = NOOP
    const loadApiKey = vi.fn(
      () =>
        new Promise<string | null>((resolve) => {
          resolveKey = resolve
        }),
    )
    const service = new AgentService({ queryFn: rec.queryFn, loadApiKey, resolvePaths: PATHS })

    // Two sends race before the first key load resolves.
    const p1 = service.send(7, 'a', () => {})
    const p2 = service.send(7, 'b', () => {})
    expect(loadApiKey).toHaveBeenCalledTimes(1) // the second send awaits the first's creation

    resolveKey('sk-ant-live')
    expect(await Promise.all([p1, p2])).toEqual([{ accepted: true }, { accepted: true }])

    expect(rec.starts()).toBe(1) // exactly one subprocess spawned for the sender

    await service.disposeAll()
    expect(rec.returns).toHaveBeenCalledTimes(1) // that one session was closed — nothing orphaned
  })

  it('closes — never orphans — a session created while a dispose was in flight', async () => {
    const rec = recordingQueryFn()
    let resolveKey: (key: string | null) => void = NOOP
    const loadApiKey = vi.fn(
      () =>
        new Promise<string | null>((resolve) => {
          resolveKey = resolve
        }),
    )
    const service = new AgentService({ queryFn: rec.queryFn, loadApiKey, resolvePaths: PATHS })

    const sendP = service.send(5, 'a', () => {}) // creation goes in flight
    const disposeP = service.dispose(5) // races the creation, before the key resolves
    resolveKey('sk-ant-live')
    await Promise.all([sendP, disposeP])

    // The invariant that matters: every subprocess that started was also closed — none orphaned.
    expect(rec.returns).toHaveBeenCalledTimes(rec.starts())
    expect(rec.starts()).toBe(1)
    expect(rec.returns).toHaveBeenCalledTimes(1)

    // And the sender is not permanently poisoned — a later send builds a fresh session.
    const send2 = service.send(5, 'b', () => {})
    resolveKey('sk-ant-live')
    await send2
    expect(rec.starts()).toBe(2)
  })

  it('disposeAll waits for in-flight creations and closes them too', async () => {
    const rec = recordingQueryFn()
    let resolveKey: (key: string | null) => void = NOOP
    const loadApiKey = vi.fn(
      () =>
        new Promise<string | null>((resolve) => {
          resolveKey = resolve
        }),
    )
    const service = new AgentService({ queryFn: rec.queryFn, loadApiKey, resolvePaths: PATHS })

    const sendP = service.send(8, 'a', () => {}) // creation in flight
    const allP = service.disposeAll() // quit races the creation
    resolveKey('sk-ant-live')
    await Promise.all([sendP, allP])

    expect(rec.returns).toHaveBeenCalledTimes(rec.starts())
    expect(rec.returns).toHaveBeenCalledTimes(1)
  })

  it('disposeAll closes every live session even when an in-flight creation rejects (no orphans at quit)', async () => {
    const rec = recordingQueryFn()
    let rejectB: (reason?: unknown) => void = NOOP
    const loadApiKey = vi
      .fn<() => Promise<string | null>>()
      .mockResolvedValueOnce('sk-ant-live') // sender A: resolves, becomes a live session
      .mockImplementationOnce(
        () =>
          new Promise<string | null>((_resolve, reject) => {
            rejectB = reject // sender B: creation will reject
          }),
      )
    const service = new AgentService({ queryFn: rec.queryFn, loadApiKey, resolvePaths: PATHS })

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
    const loadApiKey = vi.fn(
      () =>
        new Promise<string | null>((_resolve, reject) => {
          rejectKey = reject
        }),
    )
    const service = new AgentService({ queryFn: rec.queryFn, loadApiKey, resolvePaths: PATHS })

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
      loadApiKey: async () => 'sk-ant-live',
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
      loadApiKey: async () => 'sk-ant-live',
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
        loadApiKey: async () => 'sk-ant-live',
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
        loadApiKey: async () => 'sk-ant-live',
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
        loadApiKey: async () => 'sk-ant-live',
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
        loadApiKey: async () => 'sk-ant-live',
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
        loadApiKey: async () => 'sk-ant-live',
        resolvePaths: PATHS,
        prepareWorkspace: () => Promise.reject(new Error('EACCES')),
      })

      expect(await service.send(1, 'hi', NOOP)).toEqual({ accepted: true })
      expect(rec.starts()).toBe(1)
    })
  })
})
