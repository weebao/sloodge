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

/**
 * Round-5 blocker 2. Every other send in the bridge addresses whatever `frameRef` points at when it
 * runs, which since M8.2 is not the frame an already-open caret lives in: the outgoing slide's frame
 * stays mounted as a hidden neighbour while the ref and the slide id move to the incoming one. A
 * `cancel` sent that way names the wrong slide and the old frame's own slide guard drops it, leaving
 * it `contenteditable` and showing text the deck does not have. `pinEdit` is what closes that.
 */
describe('useDesignBridge — pinEdit addresses the frame it was pinned to', () => {
  interface Sent {
    readonly slide: string
    readonly payload: { readonly slId: string; readonly action: string }
  }
  interface FakeWindow {
    readonly sent: Sent[]
    readonly postMessage: (message: unknown) => void
  }

  function frame(): FakeWindow {
    const sent: Sent[] = []
    return {
      sent,
      postMessage: (message: unknown) => {
        sent.push(message as Sent)
      },
    }
  }

  it('sends to the pinned frame and slide after the bridge has moved on', () => {
    const outgoing = frame()
    const incoming = frame()
    const frameRef = { current: { contentWindow: outgoing } as unknown as HTMLIFrameElement }
    const { result, rerender } = renderHook(
      (props: { slideId: string }) =>
        useDesignBridge({ frameRef, slideId: props.slideId, enabled: true, onHit: vi.fn() }),
      { initialProps: { slideId: SLIDE } },
    )

    const send = result.current.pinEdit('e_1')

    // The step: the stage promotes the neighbour, so the ref and the slide id both change.
    frameRef.current = { contentWindow: incoming } as unknown as HTMLIFrameElement
    rerender({ slideId: 's_next' })
    send('cancel')

    expect(outgoing.sent).toHaveLength(1)
    expect(outgoing.sent[0]).toMatchObject({
      slide: SLIDE,
      payload: { slId: 'e_1', action: 'cancel' },
    })
    expect(incoming.sent).toEqual([])
  })

  it('is a no-op once its own frame has gone, rather than posting to a detached window', () => {
    const gone = frame()
    const element = { contentWindow: gone } as unknown as HTMLIFrameElement
    const frameRef = { current: element }
    const { result } = renderHook(() =>
      useDesignBridge({ frameRef, slideId: SLIDE, enabled: true, onHit: vi.fn() }),
    )
    const send = result.current.pinEdit('e_1')

    // An unmounted iframe: the element survives in the closure, its `contentWindow` does not. This
    // is why the pin holds the element and reads the window at send time.
    ;(element as { contentWindow: unknown }).contentWindow = null
    send('cancel')

    expect(gone.sent).toEqual([])
  })
})
