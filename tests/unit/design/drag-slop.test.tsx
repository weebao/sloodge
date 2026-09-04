/**
 * @vitest-environment happy-dom
 *
 * Round-4 major 1: one gesture, one threshold.
 *
 * A press-and-release used to be judged twice. The overlay compared client pixels to decide whether
 * to swallow the synthetic `click`, while whether anything *committed* fell out of `geometryDelta`'s
 * rounding to whole frame pixels — about 0.29 client px at the shipped fit scale. Every movement
 * between the two therefore both moved the user's content and re-hit-tested the pointer, and on a
 * multi-selection that moved every member *and* collapsed the selection to the full-bleed slide root:
 * the state round 3 exists to prevent, reachable from a 2 px hand tremor (reproduced in the app).
 *
 * These tests drive the whole 0–5 px band on both axes, on a single selection and on a group, and
 * assert both halves of the verdict for each: whether the deck mutated, and whether the click fell
 * through to a hit-test. They are the mutation guard for reuniting the two thresholds — restore the
 * unconditional commit in `useDragGesture.onUp` and every 1–3 px row goes red on `mutated`.
 *
 * Scale is 1 throughout, so one client pixel is one frame pixel and the band reads directly. The
 * rects are chosen to sit clear of every smart-guide target (the slide's own edges and centre lines
 * are within `GUIDE_THRESHOLD` of nothing here), because snapping silently masked the horizontal axis
 * in the round-4 review and would make a "did not move" assertion prove nothing.
 *
 * happy-dom cannot run the iframe, so the frame is a stub that records what the parent posts to it.
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { RefObject } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SL_HITTEST, type SlHit } from '../../../src/shared/design/bridge-protocol'
import { buildSlideMap } from '../../../src/shared/design/slide-map'
import { DRAG_SLOP_PX } from '../../../src/renderer/src/features/design/useDragGesture'
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
let originalHtml = ''
let titleHit: SlHit
let subtitleHit: SlHit

/**
 * The two starter-deck elements, given rects that leave a whitespace band between them. The union is
 * `48,48 400×114`; the h1 owns y 48–108 and the p owns y 132–162, so y 109–131 is inside the group
 * box and inside neither member — the gap major 2 is about.
 */
beforeEach(() => {
  useDeckStore.setState(createStarterDeck(0))
  const state = useDeckStore.getState()
  slideId = state.deck.slideOrder[0]!
  originalHtml = getSlideHtml(state.slideHtml, slideId)!
  const map = buildSlideMap(slideId, originalHtml)
  const idOf = (tag: string): string => [...map.byId].find(([, span]) => span.tagName === tag)![0]
  titleHit = {
    slId: idOf('h1'),
    tag: 'h1',
    id: null,
    classes: ['title'],
    rect: { x: 48, y: 48, width: 300, height: 60 },
    ancestors: [],
  }
  subtitleHit = {
    slId: idOf('p'),
    tag: 'p',
    id: null,
    classes: ['subtitle'],
    rect: { x: 48, y: 132, width: 400, height: 30 },
    ancestors: [],
  }
  useDesignStore.setState({
    enabled: true,
    hover: null,
    selections: [],
    selection: null,
    editing: null,
  })
})

afterEach(cleanup)

function mount(frameRef: RefObject<HTMLIFrameElement | null>): void {
  render(<SelectionOverlay frameRef={frameRef} slideId={slideId} scale={1} />)
}

const hitTests = (posted: readonly Posted[]): readonly Posted[] =>
  posted.filter((message) => message.type === SL_HITTEST)

/** Whether the gesture wrote to the deck at all — the "silent mutation" half of the verdict. */
function mutated(): boolean {
  return getSlideHtml(useDeckStore.getState().slideHtml, slideId) !== originalHtml
}

/** The current source bytes of the first `tag` element, for asking which element a commit hit. */
function outerOf(tag: string): string {
  const html = getSlideHtml(useDeckStore.getState().slideHtml, slideId)!
  const span = [...buildSlideMap(slideId, html).byId].find(([, el]) => el.tagName === tag)![1]
  return html.slice(span.outer.start, span.outer.end)
}

/**
 * One whole gesture on `box`: press at `from`, one move to `from + delta`, release there, then the
 * synthetic `click` the browser fires afterwards. `pointerId` is explicit so the gesture is one
 * pointer's, which is what `useDragGesture` now filters on.
 */
function gesture(
  box: HTMLElement,
  from: { x: number; y: number },
  delta: { x: number; y: number },
): void {
  const to = { x: from.x + delta.x, y: from.y + delta.y }
  fireEvent.pointerDown(box, { pointerId: 1, clientX: from.x, clientY: from.y })
  fireEvent.pointerMove(window, { pointerId: 1, clientX: to.x, clientY: to.y })
  fireEvent.pointerUp(window, { pointerId: 1, clientX: to.x, clientY: to.y })
  fireEvent.click(box, { detail: 1, clientX: to.x, clientY: to.y })
}

const BAND = [0, 1, 2, 3, 4, 5] as const
const AXES = [
  ['horizontal', (d: number) => ({ x: d, y: 0 })],
  ['vertical', (d: number) => ({ x: 0, y: d })],
] as const

describe('the drag threshold governs the commit and the swallow together (round-4 major 1)', () => {
  it('is at least the platform drag slop — a movement Windows calls a click is a click here', () => {
    // SM_CXDRAG defaults to 4. At 3 there was no magnitude at which a shaky click was inert.
    expect(DRAG_SLOP_PX).toBeGreaterThanOrEqual(4)
  })

  describe.each(AXES)('%s travel on a single selection', (_axis, deltaOf) => {
    it.each(BAND)('%d px', (distance) => {
      const { frameRef, posted } = fakeFrame()
      useDesignStore.getState().setSelection(titleHit)
      mount(frameRef)

      gesture(screen.getByTestId('design-selection'), { x: 200, y: 78 }, deltaOf(distance))

      const isDrag = distance >= DRAG_SLOP_PX
      // Below the threshold the gesture is a click: nothing commits, and the hit-test runs so the
      // box is never a dead zone. At or above it, it is a drag: it commits and it swallows.
      expect(mutated()).toBe(isDrag)
      expect(hitTests(posted).length).toBe(isDrag ? 0 : 1)
    })
  })

  describe.each(AXES)('%s travel on a group, starting in the gap', (_axis, deltaOf) => {
    it.each(BAND)('%d px', (distance) => {
      const { frameRef, posted } = fakeFrame()
      useDesignStore.setState({
        selections: [titleHit, subtitleHit],
        selection: subtitleHit,
      })
      mount(frameRef)

      gesture(screen.getByTestId('design-group'), { x: 200, y: 120 }, deltaOf(distance))

      // The whole finding, in one table: a sub-slop nudge from inside a group must move nothing and
      // must not cost the user the group. Above the threshold it moves both members, once.
      expect(mutated()).toBe(distance >= DRAG_SLOP_PX)
      expect(hitTests(posted)).toEqual([])
      expect(useDesignStore.getState().selections.length).toBe(2)
    })
  })

  it('a sub-slop nudge on a group is not merely un-committed — the undo stack is untouched', () => {
    const { frameRef } = fakeFrame()
    useDesignStore.setState({ selections: [titleHit, subtitleHit], selection: subtitleHit })
    mount(frameRef)

    gesture(screen.getByTestId('design-group'), { x: 200, y: 120 }, { x: 0, y: 2 })

    expect(useDeckStore.getState().history.undoStack().length).toBe(0)
  })

  it('a real drag on a group still moves both members as one command', () => {
    const { frameRef } = fakeFrame()
    useDesignStore.setState({ selections: [titleHit, subtitleHit], selection: subtitleHit })
    mount(frameRef)

    gesture(screen.getByTestId('design-group'), { x: 200, y: 120 }, { x: 60, y: 40 })

    expect(useDeckStore.getState().history.undoStack().length).toBe(1)
    expect(
      getSlideHtml(useDeckStore.getState().slideHtml, slideId)!.match(/translate\(/g),
    ).toHaveLength(2)
  })
})

describe('a group box is a union rect, not an element (round-4 major 2)', () => {
  it('a stationary click in the gap between members keeps the group', () => {
    const { frameRef, posted } = fakeFrame()
    useDesignStore.setState({ selections: [titleHit, subtitleHit], selection: subtitleHit })
    mount(frameRef)

    gesture(screen.getByTestId('design-group'), { x: 200, y: 120 }, { x: 0, y: 0 })

    // Falling through here answers with whatever is under the pointer, which on a real slide is the
    // full-bleed slide root — losing the group by clicking inside it.
    expect(hitTests(posted)).toEqual([])
    expect(useDesignStore.getState().selections.length).toBe(2)
  })

  it('a stationary click over an actual member still falls through to the hit-test', () => {
    const { frameRef, posted } = fakeFrame()
    useDesignStore.setState({ selections: [titleHit, subtitleHit], selection: subtitleHit })
    mount(frameRef)

    // (200, 78) is inside the h1's own rect, so the containment argument holds and collapsing to the
    // element under the cursor is the round-3 behaviour, deliberately kept.
    gesture(screen.getByTestId('design-group'), { x: 200, y: 78 }, { x: 0, y: 0 })

    expect(hitTests(posted)).toHaveLength(1)
    expect(hitTests(posted)[0]!.payload).toMatchObject({ x: 200, y: 78, mode: 'select' })
  })

  it('a click outside the union is unaffected by the rule', () => {
    const { frameRef, posted } = fakeFrame()
    useDesignStore.setState({ selections: [titleHit, subtitleHit], selection: subtitleHit })
    mount(frameRef)
    const root = screen.getByTestId('design-group').parentElement!

    fireEvent.click(root, { detail: 1, clientX: 900, clientY: 400 })

    expect(hitTests(posted)).toHaveLength(1)
  })
})

describe('a gesture belongs to the pointer that started it (round-4 major 3)', () => {
  it('a second pointer’s pointerup does not end the first pointer’s drag', () => {
    const { frameRef } = fakeFrame()
    useDesignStore.getState().setSelection(titleHit)
    mount(frameRef)
    const box = screen.getByTestId('design-selection')

    fireEvent.pointerDown(box, { pointerId: 1, clientX: 200, clientY: 78 })
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 260, clientY: 78 })
    // A second touch lands and lifts somewhere else entirely. Unfiltered, this committed the first
    // pointer's start rect at the second pointer's coordinates.
    fireEvent.pointerUp(window, { pointerId: 2, clientX: 900, clientY: 400 })

    expect(mutated()).toBe(false)

    fireEvent.pointerUp(window, { pointerId: 1, clientX: 260, clientY: 78 })
    expect(mutated()).toBe(true)
  })

  it('commits against the element the gesture started on, not the one selected at release', () => {
    const { frameRef } = fakeFrame()
    useDesignStore.getState().setSelection(titleHit)
    mount(frameRef)
    const box = screen.getByTestId('design-selection')

    fireEvent.pointerDown(box, { pointerId: 1, clientX: 200, clientY: 78 })
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 260, clientY: 78 })
    // A hit-test response for another element lands mid-drag and replaces the selection.
    useDesignStore.getState().setSelection(subtitleHit)
    fireEvent.pointerUp(window, { pointerId: 1, clientX: 260, clientY: 78 })

    // The h1 moved. Before the fix the subtitle moved instead, by the h1's delta.
    expect(outerOf('h1')).toContain('translate(')
    expect(outerOf('p')).not.toContain('translate(')
  })
})

describe('an Escape-cancelled drag does not cost the selection (round-4 minor)', () => {
  it('swallows the click the cancelled gesture’s release still fires', () => {
    const { frameRef, posted } = fakeFrame()
    useDesignStore.getState().setSelection(titleHit)
    mount(frameRef)
    const box = screen.getByTestId('design-selection')
    const root = box.parentElement!

    fireEvent.pointerDown(box, { pointerId: 1, clientX: 200, clientY: 78 })
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 270, clientY: 78 })
    fireEvent.keyDown(window, { key: 'Escape' })
    fireEvent.pointerUp(window, { pointerId: 1, clientX: 270, clientY: 78 })
    // The box has snapped back from under the pointer, so this click targets the root.
    fireEvent.click(root, { detail: 1, clientX: 270, clientY: 78 })

    expect(mutated()).toBe(false)
    expect(hitTests(posted)).toEqual([])
    expect(useDesignStore.getState().selection?.slId).toBe(titleHit.slId)
  })
})
