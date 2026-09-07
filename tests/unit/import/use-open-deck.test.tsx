/**
 * @vitest-environment happy-dom
 *
 * The renderer's File ▸ Open trigger (M4.5). The behaviours worth pinning are the ones a user
 * notices when they go wrong: a dismissed dialog must be a no-op, a failed read must leave the
 * current deck alone and say so, and the callback identity must be stable or `useMenuActions` will
 * resubscribe `app:menu` on every render.
 */

import { renderHook, act } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useOpenDeck } from '../../../src/renderer/src/features/document/useOpenDeck'
import type { OpenDeckResponse } from '../../../src/shared/document/open'
import type { SloodgeBridge } from '../../../src/renderer/src/host/bridge'

function installBridge(openDeck: () => Promise<OpenDeckResponse>): void {
  window.sloodge = {
    onMenuAction: () => () => undefined,
    openDeck,
  } satisfies Partial<SloodgeBridge> as SloodgeBridge
}

function payloadResponse(fileName: string): OpenDeckResponse {
  return {
    canceled: false,
    ok: true,
    payload: {
      path: `/tmp/${fileName}`,
      fileName,
      source: 'pptx',
      deck: {
        manifest: { formatVersion: 1 } as never,
        slides: {},
        notes: {},
        theme: null,
      },
      warnings: [],
    },
  }
}

afterEach(() => {
  delete window.sloodge
  vi.restoreAllMocks()
})

describe('useOpenDeck', () => {
  it('adopts an opened document and reports it', async () => {
    installBridge(async () => payloadResponse('deck.pptx'))
    const applyRemoteDeck = vi.fn(() => true)
    const onOpened = vi.fn()

    const { result } = renderHook(() => useOpenDeck({ applyRemoteDeck, onOpened }))
    await act(async () => {
      result.current()
      await Promise.resolve()
    })

    expect(applyRemoteDeck).toHaveBeenCalledTimes(1)
    expect(onOpened).toHaveBeenCalledWith(expect.objectContaining({ fileName: 'deck.pptx' }))
  })

  it('does nothing when the user dismisses the dialog', async () => {
    installBridge(async () => ({ canceled: true }))
    const applyRemoteDeck = vi.fn(() => true)
    const onError = vi.fn()

    const { result } = renderHook(() => useOpenDeck({ applyRemoteDeck, onError }))
    await act(async () => {
      result.current()
      await Promise.resolve()
    })

    // A dismissed chooser is not an error and must not disturb the open document.
    expect(applyRemoteDeck).not.toHaveBeenCalled()
    expect(onError).not.toHaveBeenCalled()
  })

  it('reports a read failure and leaves the current deck untouched', async () => {
    installBridge(async () => ({
      canceled: false,
      ok: false,
      error: { code: 'not-a-zip', message: 'bad magic bytes' },
    }))
    const applyRemoteDeck = vi.fn(() => true)
    const onError = vi.fn()

    const { result } = renderHook(() => useOpenDeck({ applyRemoteDeck, onError }))
    await act(async () => {
      result.current()
      await Promise.resolve()
    })

    expect(applyRemoteDeck).not.toHaveBeenCalled()
    expect(onError).toHaveBeenCalledWith({ code: 'not-a-zip', message: 'bad magic bytes' })
  })

  it('reports an adoption that the store rejected', async () => {
    installBridge(async () => payloadResponse('bad.pptx'))
    const applyRemoteDeck = vi.fn(() => false)
    const onError = vi.fn()
    const onOpened = vi.fn()

    const { result } = renderHook(() => useOpenDeck({ applyRemoteDeck, onOpened, onError }))
    await act(async () => {
      result.current()
      await Promise.resolve()
    })

    // Silence here would leave the user staring at the previous deck, unsure whether it worked.
    expect(onOpened).not.toHaveBeenCalled()
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ code: 'manifest-invalid' }))
  })

  it('survives a bridge that throws', async () => {
    installBridge(async () => {
      throw new Error('ipc exploded')
    })
    const onError = vi.fn()
    const { result } = renderHook(() => useOpenDeck({ applyRemoteDeck: () => true, onError }))
    await act(async () => {
      result.current()
      await Promise.resolve()
    })
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ code: 'io' }))
  })

  it('is inert in a plain-browser host with no bridge', async () => {
    const applyRemoteDeck = vi.fn(() => true)
    const { result } = renderHook(() => useOpenDeck({ applyRemoteDeck }))
    await act(async () => {
      result.current()
      await Promise.resolve()
    })
    expect(applyRemoteDeck).not.toHaveBeenCalled()
  })

  it('runs one open at a time: a second call while the first is pending is dropped', async () => {
    let resolve: ((response: OpenDeckResponse) => void) | undefined
    const openDeck = vi.fn(
      () =>
        new Promise<OpenDeckResponse>((r) => {
          resolve = r
        }),
    )
    installBridge(openDeck)
    const applyRemoteDeck = vi.fn(() => true)

    const { result } = renderHook(() => useOpenDeck({ applyRemoteDeck }))
    await act(async () => {
      result.current()
      result.current()
      await Promise.resolve()
    })
    expect(openDeck).toHaveBeenCalledTimes(1)

    await act(async () => {
      resolve?.(payloadResponse('first.pptx'))
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(applyRemoteDeck).toHaveBeenCalledTimes(1)

    // Once settled, the next invocation goes through again.
    await act(async () => {
      result.current()
      await Promise.resolve()
    })
    expect(openDeck).toHaveBeenCalledTimes(2)
  })

  it('keeps a stable callback identity across renders', () => {
    installBridge(async () => ({ canceled: true }))
    const { result, rerender } = renderHook(
      (props: { applyRemoteDeck: () => boolean }) => useOpenDeck(props),
      { initialProps: { applyRemoteDeck: () => true } },
    )
    const first = result.current
    // A new handler object each render is exactly what a caller does; the identity must not move,
    // or `useMenuActions` tears down and rebuilds its `app:menu` subscription every keystroke.
    rerender({ applyRemoteDeck: () => true })
    expect(result.current).toBe(first)
  })
})
