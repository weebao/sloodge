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
