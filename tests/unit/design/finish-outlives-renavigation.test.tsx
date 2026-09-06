/**
 * @vitest-environment happy-dom
 *
 * M3.13 — a finishing text session must not outlive the stage frame's re-navigation.
 *
 * Turning Design Mode off with a caret open finishes the session on a channel that outlives the
 * overlay (`PinnedEdit.finish`, M3.11 round-7). But the same toggle also swapped the stage frame's
 * document from the instrumented copy back to the raw slide — a new `slide://` URL, +28 ms after the
 * click in the built app — so `finish` waited on a document already on its way out. A slide whose
 * own JS stalled its main thread across the toggle answered too late: measured, the text committed
 * at 0/50/100/200/400 ms of stall and was **lost at 800 ms** — reverted, and nothing said.
 *
 * The canvas is rendered for real here; the frame is a double. `contentWindow` is one stable object
 * per iframe element (a WindowProxy keeps its identity across navigations, which is why capturing it
 * at pin time could never have told the documents apart), and the slide's stalled script is modelled
 * by hand: its answer is dispatched after `stall` ms of fake time **unless the frame was re-navigated
 * and the old document torn down first**. The teardown latency is pinned inside the measured window —
 * a document that has been navigated away from is gone `NAVIGATION_COMMIT_MS` later — so the same
 * sweep the roadmap row names runs here, deterministically: 400 ms survives either way, 800 ms is
 * where the unfixed canvas loses the text.
 */

import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useMemo, type JSX } from 'react'
import { SlideCanvas } from '../../../src/renderer/src/features/canvas/SlideCanvas'
import { useDesignStore } from '../../../src/renderer/src/features/design/designStore'
import {
  createStarterDeck,
  getSlideHtml,
  selectSlideViews,
  useDeckStore,
} from '../../../src/renderer/src/stores/deckStore'
import { makeEditEvent } from '../../../src/shared/design/bridge-protocol'
import { buildSlideMap } from '../../../src/shared/design/slide-map'

/**
 * How long after a navigation starts the old document is gone and can no longer answer. The built
 * app kept the text at 400 ms of stall and lost it at 800 ms, so the bound lies between the two.
 */
const NAVIGATION_COMMIT_MS = 500

/** `FINISH_TIMEOUT_MS` in `useDesignBridge.ts` — how long `finish` waits before giving up. */
const FINISH_TIMEOUT_MS = 2000

const NOW = 1_700_000_000_000

let slideId = ''
let h1Id = ''
let pId = ''

/** The canvas as the shell mounts it, subscribed to the deck so a commit re-renders it. */
function Canvas(): JSX.Element {
  const deck = useDeckStore((state) => state.deck)
  const slideHtml = useDeckStore((state) => state.slideHtml)
  const slides = useMemo(
    () => selectSlideViews(deck, slideHtml).filter((view) => view.id === slideId),
    [deck, slideHtml],
  )
  return <SlideCanvas slides={slides} currentIndex={0} />
}

/** One stable `contentWindow` per iframe element, recording what the parent posts to it. */
const windows = new WeakMap<
  HTMLIFrameElement,
  { posted: unknown[]; postMessage: (m: unknown) => void }
>()
function windowOf(frame: HTMLIFrameElement) {
  let known = windows.get(frame)
  if (known === undefined) {
    const posted: unknown[] = []
    known = { posted, postMessage: (message: unknown) => posted.push(message) }
    windows.set(frame, known)
  }
  return known
}
const originalContentWindow = Object.getOwnPropertyDescriptor(
  HTMLIFrameElement.prototype,
  'contentWindow',
)

class FakeResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

function activeFrame(): HTMLIFrameElement {
  return screen.getByTitle(/^Slide: /) as HTMLIFrameElement
}

function currentHtml(): string {
  return getSlideHtml(useDeckStore.getState().slideHtml, slideId) ?? ''
}

/** The frame's stalled script finally runs the blur handler: it posts the `SL_EDIT` a blur posts. */
function frameAnswers(frame: HTMLIFrameElement, text: string): void {
  const event = new MessageEvent('message', {
    data: makeEditEvent(slideId, { slId: h1Id, text, reason: 'blur' }),
  })
  Object.defineProperty(event, 'source', { value: windowOf(frame), configurable: true })
  window.dispatchEvent(event)
}

/** The actions the parent has posted to `frame`, in order. */
function postedActions(frame: HTMLIFrameElement): string[] {
  return windowOf(frame).posted.map((m) => (m as { payload: { action: string } }).payload.action)
}

/** Open a session on the <h1> (or `slId`), as the overlay does once the frame confirms a `begin`. */
function openSession(slId = h1Id): void {
  act(() => {
    useDesignStore.getState().setSelection({
      slId,
      tag: 'h1',
      id: null,
      classes: [],
      rect: { x: 0, y: 0, width: 1, height: 1 },
      ancestors: [],
    })
    useDesignStore.getState().beginEditing(slId)
  })
}

/**
 * The scenario: a caret is open, the user has typed, and Design Mode is turned off while the slide's
 * script is stalled for `stall` ms. Returns whether the frame's answer could still be delivered —
 * i.e. whether the document that holds the caret was still there when the script came back.
 */
function toggleOffUnderStall(stall: number): { frame: HTMLIFrameElement; delivered: boolean } {
  const frame = activeFrame()
  const srcAtPin = frame.getAttribute('src')
  act(() => {
    useDesignStore.getState().setEnabled(false)
  })
  const renavigated = frame.getAttribute('src') !== srcAtPin
  act(() => {
    vi.advanceTimersByTime(stall)
  })
  const delivered = !renavigated || stall < NAVIGATION_COMMIT_MS
  if (delivered) {
    act(() => {
      frameAnswers(frame, 'Typed under a stall')
    })
  }
  return { frame, delivered }
}

beforeEach(() => {
  vi.useFakeTimers()
  useDeckStore.setState(createStarterDeck(NOW))
  slideId = useDeckStore.getState().currentSlideId!
  const map = buildSlideMap(slideId, currentHtml())
  h1Id = [...map.byId.values()].find((el) => el.tagName === 'h1')!.slId
  pId = [...map.byId.values()].find((el) => el.tagName === 'p')!.slId
  useDesignStore.setState({
    enabled: true,
    hover: null,
    selection: null,
    selections: [],
    editing: null,
    notice: null,
  })
  let minted = 0
  vi.spyOn(URL, 'createObjectURL').mockImplementation(() => {
    minted += 1
    return `about:blank#doc${String(minted)}`
  })
  vi.spyOn(URL, 'revokeObjectURL').mockReturnValue(undefined)
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(
    () =>
      ({
        width: 1280,
        height: 720,
        x: 0,
        y: 0,
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        toJSON: () => ({}),
      }) as DOMRect,
  )
  vi.stubGlobal('ResizeObserver', FakeResizeObserver)
  Object.defineProperty(HTMLIFrameElement.prototype, 'contentWindow', {
    configurable: true,
    get(this: HTMLIFrameElement) {
      return windowOf(this)
    },
  })
  render(<Canvas />)
  openSession()
  expect(useDesignStore.getState().editing).toBe(h1Id)
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
  if (originalContentWindow) {
    Object.defineProperty(HTMLIFrameElement.prototype, 'contentWindow', originalContentWindow)
  }
  useDesignStore.setState({ enabled: false, editing: null, notice: null, finishing: 0 })
})

describe('Design Mode off with a caret open, under a stalled slide (M3.13)', () => {
  it.each([0, 50, 100, 200, 400, 800, 1500])('keeps the typed text at %i ms of stall', (stall) => {
    const { delivered } = toggleOffUnderStall(stall)

    expect(delivered).toBe(true)
    expect(currentHtml()).toContain('Typed under a stall')
    expect(useDeckStore.getState().history.summary().undoDepth).toBe(1)
    expect(useDesignStore.getState().notice).toBeNull()
  })

  it('holds the frame on its document until the session settles, then lets it go', () => {
    const frame = activeFrame()
    const srcAtPin = frame.getAttribute('src')
    act(() => {
      useDesignStore.getState().setEnabled(false)
    })
    // The overlay is gone and the flag with it, but the frame has not been re-navigated: the
    // document the caret is in is the only one that can answer.
    expect(useDesignStore.getState().editing).toBeNull()
    expect(screen.queryByTestId('design-selection')).toBeNull()
    expect(frame.getAttribute('src')).toBe(srcAtPin)
    expect(windowOf(frame).posted).toHaveLength(1)

    act(() => {
      frameAnswers(frame, 'Answered')
    })

    expect(currentHtml()).toContain('Answered')
    // Settled: the frame moves on to the new bytes, raw, in one navigation.
    expect(frame.getAttribute('src')).not.toBe(srcAtPin)
    expect(useDesignStore.getState().finishing).toBe(0)
  })

  it('re-navigates at once when Design Mode goes off with no session open', () => {
    act(() => {
      useDesignStore.getState().endEditing()
    })
    const frame = activeFrame()
    const srcBefore = frame.getAttribute('src')
    act(() => {
      useDesignStore.getState().setEnabled(false)
    })
    expect(frame.getAttribute('src')).not.toBe(srcBefore)
    expect(useDesignStore.getState().finishing).toBe(0)
  })

  it('a toggle that catches a session before it was pinned holds nothing', () => {
    // `beginEditing` and `setEnabled(false)` in one batch: the store raised `finishing` on its own
    // `editing`, but the hook never pinned a frame to finish on. The flag must not outlive that.
    act(() => {
      useDesignStore.getState().endEditing()
      useDesignStore.getState().setEnabled(true)
    })
    const frame = activeFrame()
    const srcBefore = frame.getAttribute('src')
    act(() => {
      useDesignStore.getState().beginEditing(h1Id)
      useDesignStore.getState().setEnabled(false)
    })
    expect(useDesignStore.getState().finishing).toBe(0)
    expect(frame.getAttribute('src')).not.toBe(srcBefore)
  })

  it('a frame that never answers is given up on, said out loud, and released', () => {
    const frame = activeFrame()
    const srcAtPin = frame.getAttribute('src')
    act(() => {
      useDesignStore.getState().setEnabled(false)
    })
    act(() => {
      vi.advanceTimersByTime(FINISH_TIMEOUT_MS - 1)
    })
    expect(frame.getAttribute('src')).toBe(srcAtPin)
    expect(useDesignStore.getState().notice).toBeNull()

    act(() => {
      vi.advanceTimersByTime(1)
    })

    // Nothing written — text the parent never read is text it cannot vouch for — but the loss is
    // announced where the overlay no longer is, and the frame is put back and released.
    expect(useDeckStore.getState().history.summary().undoDepth).toBe(0)
    expect(screen.getByTestId('design-notice').textContent).toMatch(/couldn’t confirm/)
    expect(useDesignStore.getState().notice?.slideId).toBe(slideId)
    expect(postedActions(frame)).toEqual(['commit', 'cancel', 'revert'])
    expect(useDesignStore.getState().finishing).toBe(0)
    expect(frame.getAttribute('src')).not.toBe(srcAtPin)
  })

  /**
   * Round-1 review, major 1. The hold is per session, not one shared flag: a second toggle inside
   * the first session's 2 s window arms a second finish on the same frame, and the first session
   * settling — here, timing out — must not release the document the second is still waiting on.
   */
  it('a session that settles does not release the frame a later session still waits on', () => {
    const frame = activeFrame()
    const srcAtPin = frame.getAttribute('src')
    act(() => {
      useDesignStore.getState().setEnabled(false)
    })
    act(() => {
      vi.advanceTimersByTime(300)
    })
    act(() => {
      useDesignStore.getState().setEnabled(true)
    })
    openSession()
    act(() => {
      useDesignStore.getState().setEnabled(false)
    })
    expect(useDesignStore.getState().finishing).toBe(2)

    // Session A's own timeout. The frame stays where it is: B has not answered.
    act(() => {
      vi.advanceTimersByTime(FINISH_TIMEOUT_MS - 300)
    })
    expect(useDesignStore.getState().finishing).toBe(1)
    expect(frame.getAttribute('src')).toBe(srcAtPin)

    act(() => {
      frameAnswers(frame, 'Second session, answered late')
    })
    expect(currentHtml()).toContain('Second session, answered late')
    expect(useDesignStore.getState().finishing).toBe(0)
    expect(frame.getAttribute('src')).not.toBe(srcAtPin)
  })

  /**
   * Round-1 review, major 2. A finish that times out after Design Mode came back must not reach
   * into a caret a newer session has opened on the same element — no `cancel`/`revert` into the
   * live caret, and no "wasn't saved" about a session that is not the user's.
   */
  it('a stale finish does not cancel, revert or announce over a live caret on the same element', () => {
    const frame = activeFrame()
    act(() => {
      useDesignStore.getState().setEnabled(false)
    })
    act(() => {
      vi.advanceTimersByTime(200)
    })
    act(() => {
      useDesignStore.getState().setEnabled(true)
    })
    openSession()
    expect(useDesignStore.getState().editing).toBe(h1Id)

    act(() => {
      vi.advanceTimersByTime(FINISH_TIMEOUT_MS)
    })

    expect(postedActions(frame)).toEqual(['commit'])
    expect(useDesignStore.getState().editing).toBe(h1Id)
    expect(useDesignStore.getState().notice).toBeNull()
    // The stale session released its own hold; the live one still holds.
    expect(useDesignStore.getState().finishing).toBe(1)
  })

  it('a stale finish still puts back and announces when the live caret is on another element', () => {
    const frame = activeFrame()
    act(() => {
      useDesignStore.getState().setEnabled(false)
    })
    act(() => {
      vi.advanceTimersByTime(200)
    })
    act(() => {
      useDesignStore.getState().setEnabled(true)
    })
    openSession(pId)

    act(() => {
      vi.advanceTimersByTime(FINISH_TIMEOUT_MS)
    })

    // `cancel` for an element that is not the frame's open session is inert in the frame, and
    // `revert` only ever touches the element the stale session ended on — so the live caret on the
    // <p> is untouched and the <h1>'s loss is reported.
    const posted = windowOf(frame).posted as { payload: { action: string; slId: string } }[]
    expect(posted.map((m) => m.payload.action)).toEqual(['commit', 'cancel', 'revert'])
    expect(posted.every((m) => m.payload.slId === h1Id)).toBe(true)
    expect(useDesignStore.getState().editing).toBe(pId)
    expect(screen.getByTestId('design-notice').textContent).toMatch(/couldn’t confirm/)
  })
})
