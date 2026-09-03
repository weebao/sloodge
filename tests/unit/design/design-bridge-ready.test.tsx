/**
 * @vitest-environment happy-dom
 *
 * `useDesignBridge` delivering the frame's `SL_READY` to its `onReady` consumer (M3.11 round-1 fix).
 *
 * A session can only begin after the first `SL_READY` armed the frame, so a READY arriving while the
 * parent still holds a session means the frame has a *fresh document* — the bytes changed, or the
 * slide switched — and the session it remembers is about nothing. `useTextEditing.onFrameReady` ends
 * it; this file pins the delivery, with the same forced-`source` trick `frame-script-edit` uses.
 */

import { renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { useDesignBridge } from '../../../src/renderer/src/features/design/useDesignBridge'
import { SL_MAGIC, SL_PROTOCOL_VERSION, SL_READY } from '../../../src/shared/design/bridge-protocol'

const SLIDE = 's_1'

function ready(slide = SLIDE): Record<string, unknown> {
  return {
    __sl: SL_MAGIC,
    v: SL_PROTOCOL_VERSION,
    id: 0,
    dir: 'evt',
    type: SL_READY,
    slide,
    payload: { w: 1280, h: 720, mappedCount: 3 },
  }
}

function post(data: unknown, source: unknown): void {
  const event = new MessageEvent('message', { data })
  Object.defineProperty(event, 'source', { value: source, configurable: true })
  window.dispatchEvent(event)
}

function mount(onReady: () => void): { frameWindow: object } {
  const frameWindow = {}
  const frameRef = { current: { contentWindow: frameWindow } as unknown as HTMLIFrameElement }
  renderHook(() =>
    useDesignBridge({ frameRef, slideId: SLIDE, enabled: true, onHit: vi.fn(), onReady }),
  )
  return { frameWindow }
}

describe('useDesignBridge — SL_READY reaches onReady', () => {
  it('delivers a READY from this frame for this slide', () => {
    const onReady = vi.fn()
    const { frameWindow } = mount(onReady)

    post(ready(), frameWindow)

    expect(onReady).toHaveBeenCalledTimes(1)
  })

  it('ignores a READY from another window or for another slide', () => {
    const onReady = vi.fn()
    const { frameWindow } = mount(onReady)

    post(ready(), {})
    post(ready('s_other'), frameWindow)

    expect(onReady).not.toHaveBeenCalled()
  })
})
