import { describe, expect, it, vi } from 'vitest'
import { createPresentBridge } from '../../../src/preload/presentBridge'
import { PRESENT_SET_FULLSCREEN_CHANNEL } from '../../../src/shared/ipc-contract'

describe('createPresentBridge', () => {
  it('invokes the fullscreen channel with the requested flag', async () => {
    const invoke = vi.fn().mockResolvedValue({ fullscreen: true })
    const bridge = createPresentBridge(invoke)

    const result = await bridge.setPresentFullscreen(true)

    expect(invoke).toHaveBeenCalledWith(PRESENT_SET_FULLSCREEN_CHANNEL, { fullscreen: true })
    expect(result).toBe(true)
  })

  it('returns the window state the main process reports, not the requested one', async () => {
    // Asked for fullscreen, but main says the OS refused — the surface must trust the real state.
    const invoke = vi.fn().mockResolvedValue({ fullscreen: false })
    const bridge = createPresentBridge(invoke)

    expect(await bridge.setPresentFullscreen(true)).toBe(false)
  })

  it('reads a malformed response as not fullscreen rather than throwing', async () => {
    const results = await Promise.all(
      [null, undefined, {}, { fullscreen: 'yes' }, 7].map((bad) =>
        createPresentBridge(vi.fn().mockResolvedValue(bad)).setPresentFullscreen(false),
      ),
    )
    expect(results).toEqual([false, false, false, false, false])
  })
})
