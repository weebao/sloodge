import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ ipcHandle: vi.fn() }))

vi.mock('electron', () => ({
  ipcMain: { handle: mocks.ipcHandle },
}))

const { installFontsIpc } = await import('../../../src/main/fonts/install')
const contract = await import('../../../src/shared/ipc-contract')

type Handler = (event: unknown, payload: unknown) => Promise<unknown>

function handlerFor(channel: string): Handler {
  const call = mocks.ipcHandle.mock.calls.find((c) => c[0] === channel)
  if (!call) throw new Error(`no handler registered for ${channel}`)
  return call[1] as Handler
}

beforeEach(() => {
  mocks.ipcHandle.mockClear()
})

describe('app:listFonts', () => {
  it('is declared on the request allow-list', () => {
    expect(contract.IPC_REQUEST_CHANNELS).toContain(contract.APP_LIST_FONTS_CHANNEL)
    expect(contract.isIpcRequestChannel(contract.APP_LIST_FONTS_CHANNEL)).toBe(true)
  })

  it('registers exactly one handler on the shared channel constant', () => {
    installFontsIpc(async () => ({ families: [], source: 'none' }))
    expect(mocks.ipcHandle).toHaveBeenCalledTimes(1)
    expect(mocks.ipcHandle.mock.calls[0]?.[0]).toBe('app:listFonts')
  })

  it('returns the enumerated families', async () => {
    installFontsIpc(async () => ({ families: ['Arial', 'メイリオ'], source: 'powershell' }))
    await expect(handlerFor('app:listFonts')(null, {})).resolves.toEqual({
      families: ['Arial', 'メイリオ'],
      source: 'powershell',
    })
  })

  it('enumerates once per session, however many times the renderer asks', async () => {
    const enumerate = vi.fn(async () => ({ families: ['Arial'], source: 'fc-list' as const }))
    installFontsIpc(enumerate)
    const handler = handlerFor('app:listFonts')
    await Promise.all([handler(null, {}), handler(null, {}), handler(null, {})])
    await handler(null, {})
    // The Windows path spawns PowerShell; four opens of the dropdown must not be four spawns.
    expect(enumerate).toHaveBeenCalledTimes(1)
  })

  /**
   * The M9.0 release-blocker's second half. `enumerateSystemFonts` **never rejects** — a missing
   * tool, a non-zero exit and a timeout all resolve `{ families: [], source: 'none' }` — so the
   * rejection guard below could not fire for any failure that actually happens in production. A
   * cold-start PowerShell timeout resolved `none`, the memo kept it, and every later dropdown open
   * in the session was answered from the memo without re-spawning: one slow first open cost the
   * user their installed fonts until they restarted the app.
   *
   * It also silently disabled the retry `FontFamilyControl.loadFromBridge` had already written,
   * which clears its own memo on this exact result *on the stated grounds that main does not keep
   * one*. The renderer retried; main handed back the poison.
   */
  it('does not memoise a `none` result, so a cold-start timeout stays retryable', async () => {
    let calls = 0
    const enumerate = vi.fn(async () => {
      calls += 1
      // Exactly what a SIGTERM'd PowerShell produces: resolved, not rejected.
      if (calls === 1) return { families: [], source: 'none' as const }
      return { families: ['Arial'], source: 'powershell' as const }
    })
    installFontsIpc(enumerate)
    const handler = handlerFor('app:listFonts')

    await expect(handler(null, {})).resolves.toEqual({ families: [], source: 'none' })
    await expect(handler(null, {})).resolves.toEqual({
      families: ['Arial'],
      source: 'powershell',
    })
    expect(enumerate).toHaveBeenCalledTimes(2)
  })

  /**
   * The other side of that rule, and the reason it is written as `source === 'none'` rather than
   * `families.length === 0`. A machine that really has no families beyond the system group still
   * reports the source that enumerated it, and that is a success: re-spawning PowerShell on every
   * dropdown open for a host whose honest answer is "nothing extra" would reintroduce the cost the
   * cache exists to remove. Emptiness is not failure; `none` is.
   */
  it('memoises a successful but empty enumeration, because empty is not the same as failed', async () => {
    const enumerate = vi.fn(async () => ({ families: [], source: 'fc-list' as const }))
    installFontsIpc(enumerate)
    const handler = handlerFor('app:listFonts')

    await handler(null, {})
    await handler(null, {})
    expect(enumerate).toHaveBeenCalledTimes(1)
  })

  /**
   * Retryable must not mean unshared. Two panels opening the dropdown at the same moment on a cold
   * Windows host still get one spawn between them — dropping the memo on the way *out* would
   * otherwise turn every concurrent open into another PowerShell.
   */
  it('still shares one spawn between concurrent opens that all resolve `none`', async () => {
    let calls = 0
    const enumerate = vi.fn(async () => {
      calls += 1
      if (calls === 1) return { families: [], source: 'none' as const }
      return { families: ['Arial'], source: 'powershell' as const }
    })
    installFontsIpc(enumerate)
    const handler = handlerFor('app:listFonts')

    const together = await Promise.all([handler(null, {}), handler(null, {}), handler(null, {})])
    expect(together).toEqual([
      { families: [], source: 'none' },
      { families: [], source: 'none' },
      { families: [], source: 'none' },
    ])
    expect(enumerate).toHaveBeenCalledTimes(1)

    // ...and the session is not poisoned: the next open re-spawns and gets the real list.
    await expect(handler(null, {})).resolves.toEqual({
      families: ['Arial'],
      source: 'powershell',
    })
    expect(enumerate).toHaveBeenCalledTimes(2)
  })

  it('does not cache a failure, so one bad run does not empty the list for the session', async () => {
    let calls = 0
    const enumerate = vi.fn(async () => {
      calls += 1
      if (calls === 1) throw new Error('spawn failed')
      return { families: ['Arial'], source: 'fc-list' as const }
    })
    installFontsIpc(enumerate)
    const handler = handlerFor('app:listFonts')
    await expect(handler(null, {})).rejects.toThrow('spawn failed')
    await expect(handler(null, {})).resolves.toEqual({ families: ['Arial'], source: 'fc-list' })
  })

  it('refuses to return a name that did not pass the allow-list', async () => {
    // The schema is the assertion that normalisation actually ran. An enumerator that skipped it
    // must fail loudly here rather than ship OS strings into slide CSS.
    installFontsIpc(async () => ({ families: ['Arial', 'Evil"; } body {'], source: 'powershell' }))
    await expect(handlerFor('app:listFonts')(null, {})).rejects.toThrow()
  })

  it('refuses a response longer than the cap', async () => {
    const families = Array.from({ length: 2001 }, (_, i) => `Font${i}`)
    installFontsIpc(async () => ({ families, source: 'powershell' }))
    await expect(handlerFor('app:listFonts')(null, {})).rejects.toThrow()
  })

  it('refuses an unknown source value', async () => {
    installFontsIpc(async () => ({ families: [], source: 'made-up' }) as never)
    await expect(handlerFor('app:listFonts')(null, {})).rejects.toThrow()
  })

  it('starts cold for each install, so the cache is not module-global state', async () => {
    const first = vi.fn(async () => ({ families: ['Arial'], source: 'fc-list' as const }))
    installFontsIpc(first)
    await handlerFor('app:listFonts')(null, {})
    mocks.ipcHandle.mockClear()

    const second = vi.fn(async () => ({ families: ['Georgia'], source: 'fc-list' as const }))
    installFontsIpc(second)
    await expect(handlerFor('app:listFonts')(null, {})).resolves.toEqual({
      families: ['Georgia'],
      source: 'fc-list',
    })
    expect(second).toHaveBeenCalledTimes(1)
  })
})
