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
import {
  SL_EDIT,
  SL_MAGIC,
  SL_PROTOCOL_VERSION,
  SL_READY,
} from '../../../src/shared/design/bridge-protocol'

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

function editResponse(id: number, text: string, slide = SLIDE): Record<string, unknown> {
  return {
    __sl: SL_MAGIC,
    v: SL_PROTOCOL_VERSION,
    id,
    dir: 'res',
    type: SL_EDIT,
    slide,
    payload: { slId: 'e_1', text, editing: false },
  }
}

/** The `SL_EDIT` a frame posts by itself when focus leaves the editing host. */
function editEvent(text: string, slId = 'e_1'): Record<string, unknown> {
  return {
    __sl: SL_MAGIC,
    v: SL_PROTOCOL_VERSION,
    id: 0,
    dir: 'evt',
    type: SL_EDIT,
    slide: SLIDE,
    payload: { slId, text, reason: 'blur' },
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

    const session = result.current.pinEdit('e_1')

    // The step: the stage promotes the neighbour, so the ref and the slide id both change.
    frameRef.current = { contentWindow: incoming } as unknown as HTMLIFrameElement
    rerender({ slideId: 's_next' })
    session.send('cancel')

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
    const session = result.current.pinEdit('e_1')

    // An unmounted iframe: the element survives in the closure, its `contentWindow` does not. This
    // is why the pin holds the element and reads the window at send time.
    ;(element as { contentWindow: unknown }).contentWindow = null
    session.send('cancel')

    expect(gone.sent).toEqual([])
  })
})

/**
 * Round-7 major. Leaving Design Mode unmounts the overlay and the bridge's `message` listener with
 * it, in the same React commit the click produces — so the `SL_EDIT` carrying what the user typed
 * arrives at a parent that is no longer listening, and the session was cancelled instead: the typing
 * was silently thrown away. `finish` is the answer, and what these pin is that its listener is *not*
 * the bridge's: it must still hear the frame after the hook that made it is gone.
 */
describe('useDesignBridge — a pinned session can be finished after the bridge is gone', () => {
  interface Posted {
    readonly id: number
    readonly payload: { readonly slId: string; readonly action: string }
  }

  function pinned(): {
    readonly session: ReturnType<ReturnType<typeof useDesignBridge>['pinEdit']>
    readonly posted: Posted[]
    readonly frameWindow: object
    readonly unmount: () => void
  } {
    const posted: Posted[] = []
    const frameWindow = {
      postMessage: (message: unknown) => {
        posted.push(message as Posted)
      },
    }
    const frameRef = { current: { contentWindow: frameWindow } as unknown as HTMLIFrameElement }
    const { result, unmount } = renderHook(() =>
      useDesignBridge({ frameRef, slideId: SLIDE, enabled: true, onHit: vi.fn() }),
    )
    return { session: result.current.pinEdit('e_1'), posted, frameWindow, unmount }
  }

  it('asks the frame to commit and reports the text it answers with, after unmount', () => {
    const { session, posted, frameWindow, unmount } = pinned()
    const onText = vi.fn()

    session.finish(onText)
    unmount()
    expect(posted).toHaveLength(1)
    expect(posted[0]).toMatchObject({ payload: { slId: 'e_1', action: 'commit' } })
    expect(onText).not.toHaveBeenCalled()

    post(editResponse(posted[0]!.id, 'What the user typed'), frameWindow)

    expect(onText).toHaveBeenCalledExactlyOnceWith('What the user typed')
  })

  it('settles on the event a blur already posted, which carries the same text', () => {
    const { session, frameWindow, unmount } = pinned()
    const onText = vi.fn()

    session.finish(onText)
    unmount()
    post(editEvent('Typed then blurred'), frameWindow)

    expect(onText).toHaveBeenCalledExactlyOnceWith('Typed then blurred')
  })

  it('ignores another window, another slide, another element, and answers once', () => {
    const { session, posted, frameWindow, unmount } = pinned()
    const onText = vi.fn()

    session.finish(onText)
    unmount()
    post(editResponse(posted[0]!.id, 'from nowhere'), {})
    post(editResponse(posted[0]!.id, 'from another slide', 's_other'), frameWindow)
    post(editEvent('another element', 'e_2'), frameWindow)
    post(editResponse(posted[0]!.id + 99, 'another request', SLIDE), frameWindow)
    expect(onText).not.toHaveBeenCalled()

    post(editResponse(posted[0]!.id, 'mine'), frameWindow)
    post(editResponse(posted[0]!.id, 'again'), frameWindow)

    expect(onText).toHaveBeenCalledExactlyOnceWith('mine')
  })

  it('answers null for a frame that is already gone rather than waiting on nothing', () => {
    const frameRef = { current: null }
    const { result } = renderHook(() =>
      useDesignBridge({ frameRef, slideId: SLIDE, enabled: true, onHit: vi.fn() }),
    )
    const onText = vi.fn()

    result.current.pinEdit('e_1').finish(onText)

    expect(onText).toHaveBeenCalledExactlyOnceWith(null)
  })

  it('answers null when the frame never replies, so the caller can put the element back', () => {
    vi.useFakeTimers()
    try {
      const { session, unmount } = pinned()
      const onText = vi.fn()

      session.finish(onText)
      unmount()
      expect(onText).not.toHaveBeenCalled()

      vi.advanceTimersByTime(2000)

      expect(onText).toHaveBeenCalledExactlyOnceWith(null)
    } finally {
      vi.useRealTimers()
    }
  })

  it('answers an edit request the bridge drops when the slide moves on under it', () => {
    const posted: Posted[] = []
    const frameWindow = {
      postMessage: (message: unknown) => {
        posted.push(message as Posted)
      },
    }
    const frameRef = { current: { contentWindow: frameWindow } as unknown as HTMLIFrameElement }
    const { result, rerender } = renderHook(
      (props: { slideId: string }) =>
        useDesignBridge({ frameRef, slideId: props.slideId, enabled: true, onHit: vi.fn() }),
      { initialProps: { slideId: SLIDE } },
    )
    const onResult = vi.fn()

    result.current.requestEdit('e_1', 'begin', onResult)
    // The listener effect re-subscribes for the new slide, and its cleanup is where a `begin` still
    // in flight would otherwise be dropped without a word — leaving a caret the parent never owns.
    rerender({ slideId: 's_next' })

    expect(onResult).toHaveBeenCalledExactlyOnceWith(null)
  })
})
