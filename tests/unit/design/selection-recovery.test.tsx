/**
 * @vitest-environment happy-dom
 *
 * Round-3 blocker: with Design Mode on by default, one click on empty canvas selects the slide root,
 * whose selection box covers the whole 1280×720 stage. That box swallowed every later click, so no
 * element could be selected and no caret could be opened — the milestone's own headline feature,
 * dead one click into a fresh deck, with no discoverable way back (measured in the built app).
 *
 * The three exits asserted here are the fix: a stationary click on a selection box falls through to
 * the root's hit-test, `Esc` deselects (§4.2 of 40-design-mode.md), and a visible button does the
 * same with the pointer. Plus round-3 major 3: a selection never outlives the slide it was made on.
 *
 * happy-dom cannot run the iframe, so the frame is a stub that records what the parent posts to it —
 * the same shape `text-editing-gesture.test.tsx` uses.
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { RefObject } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  SL_HITTEST,
  SL_MAGIC,
  SL_PROTOCOL_VERSION,
  type SlHit,
} from '../../../src/shared/design/bridge-protocol'
import { buildSlideMap } from '../../../src/shared/design/slide-map'
import { useDesignStore } from '../../../src/renderer/src/features/design/designStore'
import { SelectionOverlay } from '../../../src/renderer/src/features/design/SelectionOverlay'
import {
  createStarterDeck,
  getSlideHtml,
  useDeckStore,
} from '../../../src/renderer/src/stores/deckStore'

interface Posted {
  readonly type: string
  readonly payload: Record<string, unknown>
}

function fakeFrame(): { frameRef: RefObject<HTMLIFrameElement | null>; posted: Posted[] } {
  const posted: Posted[] = []
  const contentWindow = {
    postMessage: (message: unknown): void => {
      posted.push(message as Posted)
    },
  }
  return { frameRef: { current: { contentWindow } as unknown as HTMLIFrameElement }, posted }
}

let slideId = ''
let otherSlideId = ''
/** The slide root — the full-bleed selection one click on empty canvas produces. */
let rootHit: SlHit
let titleHit: SlHit

function hitFor(slId: string, tag: string, rect: SlHit['rect']): SlHit {
  return { slId, tag, id: null, classes: [], rect, ancestors: [] }
}

beforeEach(() => {
  useDeckStore.setState(createStarterDeck(0))
  const state = useDeckStore.getState()
  slideId = state.deck.slideOrder[0]!
  otherSlideId = state.deck.slideOrder[1]!
  const map = buildSlideMap(slideId, getSlideHtml(state.slideHtml, slideId)!)
  const rootId = [...map.byId].find(([, span]) => span.tagName === 'div')![0]
  const titleId = [...map.byId].find(([, span]) => span.tagName === 'h1')![0]
  rootHit = hitFor(rootId, 'div', { x: 0, y: 0, width: 1280, height: 720 })
  titleHit = hitFor(titleId, 'h1', { x: 48, y: 48, width: 1184, height: 55 })
  useDesignStore.setState({
    enabled: true,
    hover: null,
    selections: [],
    selection: null,
    editing: null,
  })
})

afterEach(cleanup)

function mount(frameRef: RefObject<HTMLIFrameElement | null>, id = slideId): HTMLElement {
  const { container } = render(<SelectionOverlay frameRef={frameRef} slideId={id} scale={1} />)
  return container.firstElementChild as HTMLElement
}

const hitTests = (posted: readonly Posted[]): readonly Posted[] =>
  posted.filter((message) => message.type === SL_HITTEST)

describe('a selection box is never a dead zone (round-3 blocker)', () => {
  it('a stationary click on the full-bleed root box re-hit-tests the pointer', () => {
    const { frameRef, posted } = fakeFrame()
    useDesignStore.getState().setSelection(rootHit)
    mount(frameRef)
    const box = screen.getByTestId('design-selection')

    fireEvent.pointerDown(box, { clientX: 600, clientY: 70 })
    fireEvent.pointerUp(window, { clientX: 600, clientY: 70 })
    fireEvent.click(box, { detail: 1, clientX: 600, clientY: 70 })

    // Without the fall-through this is `[]` — the click never reaches the root's hit-test and the
    // element under the pointer can never be selected.
    expect(hitTests(posted)).toHaveLength(1)
    expect(hitTests(posted)[0]!.payload).toMatchObject({ x: 600, y: 70, mode: 'select' })
  })

  it('the click that ends a real drag is still swallowed', () => {
    const { frameRef, posted } = fakeFrame()
    useDesignStore.getState().setSelection(rootHit)
    mount(frameRef)
    const box = screen.getByTestId('design-selection')

    fireEvent.pointerDown(box, { clientX: 600, clientY: 70 })
    fireEvent.pointerMove(window, { clientX: 640, clientY: 110 })
    fireEvent.pointerUp(window, { clientX: 640, clientY: 110 })
    fireEvent.click(box, { detail: 1, clientX: 640, clientY: 110 })

    // Re-hit-testing here would select whatever the drag left under the pointer.
    expect(hitTests(posted)).toEqual([])
  })

  it('a click on a resize handle does not fall through', () => {
    const { frameRef, posted } = fakeFrame()
    useDesignStore.getState().setSelection(titleHit)
    mount(frameRef)
    const handle = screen.getByTestId('design-handle-se')

    fireEvent.pointerDown(handle, { clientX: 1232, clientY: 103 })
    fireEvent.pointerUp(window, { clientX: 1232, clientY: 103 })
    fireEvent.click(handle, { detail: 1, clientX: 1232, clientY: 103 })

    expect(hitTests(posted)).toEqual([])
  })

  it('the second click of a double-click on the box still sends no hit-test', () => {
    const { frameRef, posted } = fakeFrame()
    useDesignStore.getState().setSelection(rootHit)
    mount(frameRef)
    const box = screen.getByTestId('design-selection')

    fireEvent.pointerDown(box, { clientX: 600, clientY: 70 })
    fireEvent.pointerUp(window, { clientX: 600, clientY: 70 })
    fireEvent.click(box, { detail: 2, clientX: 600, clientY: 70 })

    expect(hitTests(posted)).toEqual([])
  })
})

describe('Esc deselects (§4.2 stage one)', () => {
  it('clears the selection when no caret is open', () => {
    const { frameRef } = fakeFrame()
    useDesignStore.getState().setSelection(rootHit)
    mount(frameRef)

    fireEvent.keyDown(window, { key: 'Escape' })

    expect(useDesignStore.getState().selection).toBeNull()
    expect(useDesignStore.getState().selections).toEqual([])
    // Design Mode itself stays on — this is the first stage, not the third.
    expect(useDesignStore.getState().enabled).toBe(true)
  })

  it('leaves an open text-edit session alone — that Escape is the frame’s', () => {
    const { frameRef } = fakeFrame()
    useDesignStore.getState().setSelection(titleHit)
    useDesignStore.getState().beginEditing(titleHit.slId)
    mount(frameRef)

    fireEvent.keyDown(window, { key: 'Escape' })

    expect(useDesignStore.getState().editing).toBe(titleHit.slId)
    expect(useDesignStore.getState().selection?.slId).toBe(titleHit.slId)
  })

  it('does not steal Escape from a focused text field', () => {
    const { frameRef } = fakeFrame()
    useDesignStore.getState().setSelection(rootHit)
    mount(frameRef)
    const input = document.createElement('input')
    document.body.append(input)

    fireEvent.keyDown(input, { key: 'Escape' })

    expect(useDesignStore.getState().selection?.slId).toBe(rootHit.slId)
    input.remove()
  })

  it('ignores Escape with a modifier', () => {
    const { frameRef } = fakeFrame()
    useDesignStore.getState().setSelection(rootHit)
    mount(frameRef)

    fireEvent.keyDown(window, { key: 'Escape', shiftKey: true })

    expect(useDesignStore.getState().selection?.slId).toBe(rootHit.slId)
  })

  it('leaves a live drag to its own Escape (cancel the gesture, keep the selection)', () => {
    const { frameRef } = fakeFrame()
    useDesignStore.getState().setSelection(titleHit)
    mount(frameRef)
    const box = screen.getByTestId('design-selection')

    fireEvent.pointerDown(box, { clientX: 100, clientY: 100 })
    fireEvent.pointerMove(window, { clientX: 140, clientY: 140 })
    fireEvent.keyDown(window, { key: 'Escape' })

    expect(useDesignStore.getState().selection?.slId).toBe(titleHit.slId)
  })
})

describe('the clear affordance is visible', () => {
  it('renders a real button while something is selected and clears on click', () => {
    const { frameRef, posted } = fakeFrame()
    useDesignStore.getState().setSelection(rootHit)
    mount(frameRef)

    const button = screen.getByRole('button', { name: /clear selection/i })
    expect(button.className).not.toContain('sr-only')

    fireEvent.click(button, { detail: 1, clientX: 600, clientY: 700 })

    expect(useDesignStore.getState().selection).toBeNull()
    // Clearing must not immediately re-select whatever sits under the button.
    expect(hitTests(posted)).toEqual([])
  })

  it('is absent with nothing selected', () => {
    const { frameRef } = fakeFrame()
    mount(frameRef)
    expect(screen.queryByTestId('design-clear-selection')).toBeNull()
  })
})

describe('a selection never outlives its slide (round-3 major)', () => {
  it('switching slides clears hover, selection and any editing flag', () => {
    const { frameRef } = fakeFrame()
    useDesignStore.getState().setSelection(titleHit)
    useDesignStore.setState({ hover: rootHit })
    const { rerender } = render(
      <SelectionOverlay frameRef={frameRef} slideId={slideId} scale={1} />,
    )

    rerender(<SelectionOverlay frameRef={frameRef} slideId={otherSlideId} scale={1} />)

    expect(useDesignStore.getState().selection).toBeNull()
    expect(useDesignStore.getState().selections).toEqual([])
    expect(useDesignStore.getState().hover).toBeNull()
    expect(useDesignStore.getState().editing).toBeNull()
    expect(screen.queryByTestId('design-selection')).toBeNull()
  })

  it('a re-render on the same slide keeps the selection', () => {
    const { frameRef } = fakeFrame()
    useDesignStore.getState().setSelection(titleHit)
    const { rerender } = render(
      <SelectionOverlay frameRef={frameRef} slideId={slideId} scale={1} />,
    )

    rerender(<SelectionOverlay frameRef={frameRef} slideId={slideId} scale={0.5} />)

    expect(useDesignStore.getState().selection?.slId).toBe(titleHit.slId)
  })
})

/**
 * Shift-click, at the gesture level. The store's `toggleSelection` is tested directly in
 * `design-store.test.ts`, but that bypasses the overlay entirely — nothing asserted that a
 * shift-click *arrives* as a toggle. The round-3 builder skipped these on the grounds that
 * "happy-dom's MouseEvent drops shiftKey"; that is false — `fireEvent` maps `click` to a real
 * MouseEvent and `MouseEvent` reads `shiftKey` from its init, which the Esc test above already
 * relies on. So the gap was unforced, and this is the test that was missing.
 *
 * The assertion cannot be on the wire: the frame only understands `hover` and `select`, so a toggle
 * goes out as `select` and the toggle semantics live entirely in the parent's response handling
 * (`useDesignBridge`, `HitMode`). The observable is therefore what the answered hit-test *does* to
 * the selection — which is the behaviour anyone cares about anyway.
 */
describe('shift-click reaches the selection as a toggle', () => {
  /** Answer the parent's most recent hit-test with `hit`, as the frame would. */
  function answerHit(posted: readonly Posted[], frameWindow: unknown, hit: SlHit | null): void {
    const request = hitTests(posted).at(-1) as unknown as { id: number }
    const event = new MessageEvent('message', {
      data: {
        __sl: SL_MAGIC,
        v: SL_PROTOCOL_VERSION,
        id: request.id,
        dir: 'res',
        type: SL_HITTEST,
        slide: slideId,
        payload: hit,
      },
    })
    Object.defineProperty(event, 'source', { value: frameWindow, configurable: true })
    window.dispatchEvent(event)
  }

  it('adds to the ordered set instead of replacing it', () => {
    const { frameRef, posted } = fakeFrame()
    const frameWindow = frameRef.current!.contentWindow
    useDesignStore.getState().setSelection(titleHit)
    mount(frameRef)

    fireEvent.click(screen.getByTestId('design-selection'), {
      detail: 1,
      clientX: 600,
      clientY: 400,
      shiftKey: true,
    })
    answerHit(posted, frameWindow, rootHit)

    expect(useDesignStore.getState().selections.map((entry) => entry.slId)).toEqual([
      titleHit.slId,
      rootHit.slId,
    ])
  })

  it('a second shift-click on the same element takes it back out', () => {
    const { frameRef, posted } = fakeFrame()
    const frameWindow = frameRef.current!.contentWindow
    useDesignStore.setState({ selections: [titleHit, rootHit], selection: rootHit })
    mount(frameRef)

    fireEvent.click(screen.getByTestId('design-group'), {
      detail: 1,
      clientX: 600,
      clientY: 70,
      shiftKey: true,
    })
    answerHit(posted, frameWindow, rootHit)

    expect(useDesignStore.getState().selections.map((entry) => entry.slId)).toEqual([titleHit.slId])
  })

  it('a plain click on the same box collapses to one element', () => {
    const { frameRef, posted } = fakeFrame()
    const frameWindow = frameRef.current!.contentWindow
    useDesignStore.getState().setSelection(titleHit)
    mount(frameRef)

    fireEvent.click(screen.getByTestId('design-selection'), {
      detail: 1,
      clientX: 600,
      clientY: 400,
    })
    answerHit(posted, frameWindow, rootHit)

    expect(useDesignStore.getState().selections.map((entry) => entry.slId)).toEqual([rootHit.slId])
  })
})
