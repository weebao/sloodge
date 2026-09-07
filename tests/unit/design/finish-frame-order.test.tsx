/**
 * @vitest-environment happy-dom
 *
 * M3.13, round-2 review — the session as the app actually opens it, against the frame as it
 * actually runs.
 *
 * Two things `finish-outlives-renavigation.test.tsx` structurally cannot show, both found in review:
 *
 * 1. **The acquire on the real path.** Every session there opens through the store
 *    (`beginEditing`), which is `useTextEditing`'s *effect* acquire site. The app opens a session
 *    through `beginEdit`'s reply — a different site — and deleting the acquire there left the whole
 *    suite green while the frame re-navigated at the toggle for every real double-click. So here the
 *    session is opened by a double-click on the real overlay, and the `begin` is answered by the
 *    real frame script.
 *
 * 2. **Posting order.** The frame is single-threaded and runs the parent's messages in the order
 *    they were posted; a stalled frame runs none of them and then runs the queue. So "a newer caret
 *    answered before the stale session's `commit`" cannot happen on one document, while "the newer
 *    `begin` queued behind the stale `commit`, and the stale `cancel` behind both" is exactly what
 *    happens — and the store cannot see a caret whose `begin` has not been answered.
 *
 * The frame is therefore `designBridgeFrameMain` — the real script — run against a real (happy-dom)
 * document, behind a fake `contentWindow` that delivers at once while the frame is live and queues
 * while it is `stalled`, draining in posting order when it comes back. happy-dom cannot run an
 * iframe, so the frame's document is a `<div>` in the test page; the script only ever addresses it
 * by `data-sl-id`.
 */

/* oxlint-disable no-underscore-dangle -- the test resets the frame's `__slDesignBridge` flag. */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useMemo, type JSX } from 'react'
import { SlideCanvas } from '../../../src/renderer/src/features/canvas/SlideCanvas'
import { useDesignStore } from '../../../src/renderer/src/features/design/designStore'
import { designBridgeFrameMain } from '../../../src/renderer/src/features/design/frameScript'
import {
  createStarterDeck,
  getSlideHtml,
  selectSlideViews,
  useDeckStore,
} from '../../../src/renderer/src/stores/deckStore'
import { SL_EDIT } from '../../../src/shared/design/bridge-protocol'
import { buildSlideMap } from '../../../src/shared/design/slide-map'

/** `FINISH_TIMEOUT_MS` in `useDesignBridge.ts` — how long `finish` waits before giving up. */
const FINISH_TIMEOUT_MS = 2000

const NOW = 1_700_000_000_000
const FRAME_DOC_ID = 'frame-doc-m313'

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

interface EditMessage {
  readonly type: string
  readonly payload: { readonly action: string; readonly slId: string }
}

/**
 * The frame's window as the parent sees it: `postMessage` runs the frame script at once, or — while
 * the slide's own JS is `stalled` — queues, in order, for `drain`. Every message is also logged.
 */
interface FrameWindow {
  stalled: boolean
  readonly queue: unknown[]
  readonly posted: EditMessage[]
  postMessage: (message: unknown) => void
}

let frame: FrameWindow
/** The parent as the frame script sees it: its replies are delivered to the page from `frame`. */
let parentStub: { postMessage: (reply: unknown) => void }

function dispatch(data: unknown, source: unknown): void {
  const event = new MessageEvent('message', { data })
  Object.defineProperty(event, 'source', { value: source, configurable: true })
  window.dispatchEvent(event)
}

/** The frame comes back: it runs everything the parent posted while it was stalled, in order. */
function drain(): void {
  act(() => {
    frame.stalled = false
    for (const message of frame.queue.splice(0)) dispatch(message, parentStub)
  })
}

/** The `SL_EDIT` actions the parent has posted to the frame, in order. */
function editActions(): string[] {
  return frame.posted.filter((m) => m.type === SL_EDIT).map((m) => m.payload.action)
}

function frameElement(slId: string): HTMLElement {
  return document.querySelector(`#${FRAME_DOC_ID} [data-sl-id="${slId}"]`) as HTMLElement
}

function stageFrame(): HTMLIFrameElement {
  return screen.getByTitle(/^Slide: /) as HTMLIFrameElement
}

function currentHtml(): string {
  return getSlideHtml(useDeckStore.getState().slideHtml, slideId) ?? ''
}

function undoDepth(): number {
  return useDeckStore.getState().history.summary().undoDepth
}

/** Select an element as a click would, then double-click the selection as the user does. */
function doubleClick(slId: string, tag: string): void {
  act(() => {
    useDesignStore.getState().setSelection({
      slId,
      tag,
      id: null,
      classes: [],
      rect: { x: 0, y: 0, width: 1, height: 1 },
      ancestors: [],
    })
  })
  act(() => {
    fireEvent.dblClick(screen.getByTestId('design-selection'))
  })
}

function setEnabled(enabled: boolean): void {
  act(() => {
    useDesignStore.getState().setEnabled(enabled)
  })
}

function advance(ms: number): void {
  act(() => {
    vi.advanceTimersByTime(ms)
  })
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

beforeEach(() => {
  vi.useFakeTimers()
  useDeckStore.setState(createStarterDeck(NOW))
  slideId = useDeckStore.getState().currentSlideId!
  const map = buildSlideMap(slideId, currentHtml())
  const h1 = [...map.byId.values()].find((el) => el.tagName === 'h1')!
  const p = [...map.byId.values()].find((el) => el.tagName === 'p')!
  h1Id = h1.slId
  pId = p.slId
  useDesignStore.setState({
    enabled: true,
    hover: null,
    selection: null,
    selections: [],
    editing: null,
    notice: null,
    finishing: 0,
    caretRequests: {},
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

  const posted: EditMessage[] = []
  const queue: unknown[] = []
  frame = {
    stalled: false,
    queue,
    posted,
    postMessage(message: unknown): void {
      posted.push(message as EditMessage)
      if (this.stalled) queue.push(message)
      else dispatch(message, parentStub)
    },
  }
  const frameWindow = frame
  parentStub = { postMessage: (reply) => dispatch(reply, frameWindow) }
  Object.defineProperty(HTMLIFrameElement.prototype, 'contentWindow', {
    configurable: true,
    get: () => frameWindow,
  })

  // The frame's document — the same text the source has, so an untouched caret commits nothing —
  // driven by the real frame script. A fresh parent stub per test is what retires the previous
  // test's script instance: its listener is still on the window, but it trusts only its own parent.
  const doc = document.createElement('div')
  doc.id = FRAME_DOC_ID
  doc.innerHTML = `<h1 data-sl-id="${h1Id}"></h1><p data-sl-id="${pId}"></p>`
  doc.firstElementChild!.textContent = h1.textContent
  doc.lastElementChild!.textContent = p.textContent
  document.body.prepend(doc)
  delete (window as unknown as { __slDesignBridge?: boolean }).__slDesignBridge
  designBridgeFrameMain(parentStub as unknown as Window)

  render(<Canvas />)
})

afterEach(() => {
  cleanup()
  document.getElementById(FRAME_DOC_ID)?.remove()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
  if (originalContentWindow) {
    Object.defineProperty(HTMLIFrameElement.prototype, 'contentWindow', originalContentWindow)
  }
  useDesignStore.setState({ enabled: false, editing: null, notice: null, finishing: 0 })
})

describe('a text session opened by double-click, against the real frame script (M3.13 round 3)', () => {
  it('holds the frame from the moment the frame confirms the caret, and the toggle waits for it', () => {
    doubleClick(h1Id, 'h1')

    // The real path: the overlay asked, the frame script opened the caret and answered, the hook
    // opened the session from that reply — and acquired the hold there, not in the effect.
    expect(useDesignStore.getState().editing).toBe(h1Id)
    expect(frameElement(h1Id).getAttribute('contenteditable')).not.toBeNull()
    expect(useDesignStore.getState().finishing).toBe(1)

    frameElement(h1Id).textContent = 'Typed by double-click'
    frame.stalled = true
    const stage = stageFrame()
    const srcAtPin = stage.getAttribute('src')
    setEnabled(false)

    // The overlay is gone and the session is finishing on a document the frame has not left.
    expect(useDesignStore.getState().editing).toBeNull()
    expect(stage.getAttribute('src')).toBe(srcAtPin)
    expect(useDesignStore.getState().finishing).toBe(1)
    expect(editActions()).toEqual(['begin', 'commit'])

    advance(800)
    drain()

    expect(currentHtml()).toContain('Typed by double-click')
    expect(undoDepth()).toBe(1)
    expect(useDesignStore.getState().notice).toBeNull()
    expect(useDesignStore.getState().finishing).toBe(0)
    expect(stage.getAttribute('src')).not.toBe(srcAtPin)
  })

  /**
   * Round-2 review, major 1. Toggle off under a stalled caret, back on, double-click the same
   * element: the new `begin` is queued behind the stale `commit`, so when the stale session times
   * out the store still shows no caret — yet the frame is about to open one and then run whatever
   * the stale session posts after it. The stale session has to judge itself superseded by the
   * request, which is the order the frame will honour.
   */
  it('a stale finish stays out of a caret whose begin is queued behind its commit (same element)', () => {
    doubleClick(h1Id, 'h1')
    frameElement(h1Id).textContent = 'Hello'
    frame.stalled = true

    setEnabled(false)
    advance(200)
    setEnabled(true)
    doubleClick(h1Id, 'h1')

    // B has been asked for and the frame has it, unanswered; the store cannot know.
    expect(editActions()).toEqual(['begin', 'commit', 'begin'])
    expect(useDesignStore.getState().editing).toBeNull()

    // Session A's own timeout: it must neither reach into the frame nor say anything.
    advance(FINISH_TIMEOUT_MS - 200)
    expect(editActions()).toEqual(['begin', 'commit', 'begin'])
    expect(useDesignStore.getState().notice).toBeNull()
    expect(useDesignStore.getState().finishing).toBe(0)

    drain()

    // The frame ran A's `commit` (the text stays) and then B's `begin`: one live caret, on the text
    // the user left there, and the store agrees with the frame about it.
    expect(frameElement(h1Id).getAttribute('contenteditable')).not.toBeNull()
    expect(frameElement(h1Id).textContent).toBe('Hello')
    expect(useDesignStore.getState().editing).toBe(h1Id)
    expect(useDesignStore.getState().finishing).toBe(1)
    expect(useDesignStore.getState().notice).toBeNull()

    // What is under the cursor is what B commits — nothing was lost, so nothing was said.
    setEnabled(false)
    expect(currentHtml()).toContain('Hello')
    expect(undoDepth()).toBe(1)
    expect(useDesignStore.getState().notice).toBeNull()
    expect(useDesignStore.getState().finishing).toBe(0)
  })

  it('a stale finish still says so when the queued caret is on another element, and that caret is untouched', () => {
    doubleClick(h1Id, 'h1')
    frameElement(h1Id).textContent = 'Hello'
    frame.stalled = true

    setEnabled(false)
    advance(200)
    setEnabled(true)
    doubleClick(pId, 'p')

    advance(FINISH_TIMEOUT_MS - 200)

    // Another element's request does not supersede this session: the <h1>'s loss is reported, and
    // the put-back is addressed to the <h1> alone.
    expect(editActions()).toEqual(['begin', 'commit', 'begin', 'cancel', 'revert'])
    const putBack = frame.posted.filter((m) => m.type === SL_EDIT).slice(-2)
    expect(putBack.every((m) => m.payload.slId === h1Id)).toBe(true)
    expect(screen.getByTestId('design-notice').textContent).toMatch(/couldn’t confirm/)

    drain()

    // The <p>'s caret opened and is live; the stale `cancel` named an element that is not the
    // frame's open session and was inert.
    expect(frameElement(pId).getAttribute('contenteditable')).not.toBeNull()
    expect(useDesignStore.getState().editing).toBe(pId)
    expect(useDesignStore.getState().finishing).toBe(1)
    expect(undoDepth()).toBe(0)
    // Known residual (roadmap M3.15): the frame keeps one `lastEnded` slot and clears it on any
    // `begin`, so a `revert` that reaches the frame behind another element's `begin` has nothing to
    // rewind — the <h1> keeps showing the unsaved text until the frame is next navigated.
    expect(frameElement(h1Id).getAttribute('contenteditable')).toBeNull()
    expect(frameElement(h1Id).textContent).toBe('Hello')
  })
})
