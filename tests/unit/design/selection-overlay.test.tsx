/**
 * @vitest-environment happy-dom
 *
 * The renderer-side overlay: given a selection in the store, it draws the selection box, its eight
 * handles, and the breadcrumb. The postMessage round trip cannot run under happy-dom (the iframe is
 * inert), so this covers only what the parent renders from state — the bridge itself is proven in
 * `bridge-protocol.test.ts` and `frame-script.test.tsx`.
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { SlHit } from '../../../src/shared/design/bridge-protocol'
import { buildSlideMap } from '../../../src/shared/design/slide-map'
import { useDesignStore } from '../../../src/renderer/src/features/design/designStore'
import { SelectionOverlay } from '../../../src/renderer/src/features/design/SelectionOverlay'
import {
  createStarterDeck,
  getSlideHtml,
  useDeckStore,
} from '../../../src/renderer/src/stores/deckStore'

const SELECTION: SlHit = {
  slId: 's_x:5',
  tag: 'rect',
  id: 'bar',
  classes: ['bar'],
  rect: { x: 100, y: 200, width: 320, height: 84 },
  ancestors: [
    {
      slId: 's_x:2',
      tag: 'g',
      id: null,
      classes: ['bars'],
      rect: { x: 0, y: 0, width: 1, height: 1 },
    },
    {
      slId: 's_x:0',
      tag: 'section',
      id: null,
      classes: ['slide'],
      rect: { x: 0, y: 0, width: 1, height: 1 },
    },
  ],
}

const frameRef = { current: null }

/** The number of undoable commands on the deck's stack — one per committed gesture (§7.1). */
function undoDepth(): number {
  return useDeckStore.getState().history.undoStack().length
}

/** pointerdown on `target`, N window pointermoves, then a window pointerup — one gesture. */
function drag(
  target: HTMLElement,
  from: { x: number; y: number },
  to: { x: number; y: number },
  moves = 1,
): void {
  fireEvent.pointerDown(target, { clientX: from.x, clientY: from.y })
  for (let i = 1; i <= moves; i += 1) {
    const t = i / moves
    fireEvent.pointerMove(window, {
      clientX: from.x + (to.x - from.x) * t,
      clientY: from.y + (to.y - from.y) * t,
    })
  }
  fireEvent.pointerUp(window, { clientX: to.x, clientY: to.y })
}

beforeEach(() => {
  useDesignStore.setState({ enabled: true, hover: null, selection: null })
})

afterEach(cleanup)

describe('SelectionOverlay', () => {
  it('renders nothing but the capture layer with no selection', () => {
    render(<SelectionOverlay frameRef={frameRef} slideId="s_x" scale={1} />)
    expect(screen.queryByTestId('design-selection')).toBeNull()
    expect(screen.queryByRole('navigation', { name: 'Selection breadcrumb' })).toBeNull()
  })

  it('draws the selection box, eight handles, and the breadcrumb', () => {
    useDesignStore.setState({ enabled: true, selection: SELECTION, hover: null })
    render(<SelectionOverlay frameRef={frameRef} slideId="s_x" scale={1} />)

    const box = screen.getByTestId('design-selection')
    expect(box.style.left).toBe('100px')
    expect(box.style.width).toBe('320px')

    for (const handle of ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']) {
      expect(screen.getByTestId(`design-handle-${handle}`)).toBeTruthy()
    }

    // Breadcrumb is root-first: section › g › rect (the selection is the last, bold crumb).
    const crumb = screen.getByRole('navigation', { name: 'Selection breadcrumb' })
    expect(crumb.textContent).toContain('section.slide')
    expect(crumb.textContent).toContain('g.bars')
    expect(crumb.textContent).toContain('rect#bar.bar')
  })

  it('scales the selection box by the fit factor', () => {
    useDesignStore.setState({ enabled: true, selection: SELECTION, hover: null })
    render(<SelectionOverlay frameRef={frameRef} slideId="s_x" scale={0.5} />)
    const box = screen.getByTestId('design-selection')
    expect(box.style.left).toBe('50px')
    expect(box.style.width).toBe('160px')
  })

  it('makes the handles interactive (M3.5): auto pointer events and a direction cursor', () => {
    useDesignStore.setState({ enabled: true, selection: SELECTION, hover: null })
    render(<SelectionOverlay frameRef={frameRef} slideId="s_x" scale={1} />)
    const se = screen.getByTestId('design-handle-se')
    expect(se.style.pointerEvents).toBe('auto')
    expect(se.style.cursor).toBe('nwse-resize')
    const body = screen.getByTestId('design-selection')
    expect(body.style.cursor).toBe('move')
  })
})

/**
 * Drag-to-move / resize (M3.5). The gesture runs against the real `deckStore` so the commit path —
 * re-derive from current bytes, patch the source, push one command — is exercised end to end, and
 * the coalescing guarantee (a whole drag is exactly one command) is asserted by counting commits.
 */
describe('SelectionOverlay — drag & resize (M3.5)', () => {
  let slideId: string
  let titleSlId: string
  let originalHtml: string

  beforeEach(() => {
    // A fresh starter deck so each case has a known slide with an in-flow <h1> title to drag.
    useDeckStore.setState(createStarterDeck(0))
    const state = useDeckStore.getState()
    slideId = state.deck.slideOrder[0]!
    originalHtml = getSlideHtml(state.slideHtml, slideId)!
    const map = buildSlideMap(slideId, originalHtml)
    titleSlId = [...map.byId].find(([, span]) => span.tagName === 'h1')![0]

    const hit: SlHit = {
      slId: titleSlId,
      tag: 'h1',
      id: null,
      classes: ['title'],
      rect: { x: 48, y: 48, width: 400, height: 60 },
      ancestors: [],
    }
    useDesignStore.setState({ enabled: true, selection: hit, hover: null })
  })

  afterEach(cleanup)

  it('drag on the body moves the element via one command (translate delta)', () => {
    render(<SelectionOverlay frameRef={frameRef} slideId={slideId} scale={1} />)
    drag(screen.getByTestId('design-selection'), { x: 100, y: 100 }, { x: 160, y: 140 })

    expect(undoDepth()).toBe(1)
    expect(getSlideHtml(useDeckStore.getState().slideHtml, slideId)).toContain(
      'translate(60px, 40px)',
    )
  })

  it('drag on a corner handle resizes via one command (absolute width/height)', () => {
    render(<SelectionOverlay frameRef={frameRef} slideId={slideId} scale={1} />)
    drag(screen.getByTestId('design-handle-se'), { x: 448, y: 108 }, { x: 468, y: 128 })

    expect(undoDepth()).toBe(1)
    const html = getSlideHtml(useDeckStore.getState().slideHtml, slideId)!
    expect(html).toContain('width: 420px')
    expect(html).toContain('height: 80px')
  })

  it('coalescing: a multi-move drag commits exactly ONE command, not one per move', () => {
    render(<SelectionOverlay frameRef={frameRef} slideId={slideId} scale={1} />)
    drag(screen.getByTestId('design-selection'), { x: 100, y: 100 }, { x: 200, y: 100 }, 8)

    // Eight intermediate moves, one undo step. Mutating the hook to commit per-move reds this.
    expect(undoDepth()).toBe(1)
  })

  it('a zero-distance click commits nothing', () => {
    render(<SelectionOverlay frameRef={frameRef} slideId={slideId} scale={1} />)
    drag(screen.getByTestId('design-selection'), { x: 100, y: 100 }, { x: 100, y: 100 })

    expect(undoDepth()).toBe(0)
    expect(getSlideHtml(useDeckStore.getState().slideHtml, slideId)).toBe(originalHtml)
  })

  it('Escape mid-drag cancels: no command, source unchanged', () => {
    render(<SelectionOverlay frameRef={frameRef} slideId={slideId} scale={1} />)
    const body = screen.getByTestId('design-selection')
    fireEvent.pointerDown(body, { clientX: 100, clientY: 100 })
    fireEvent.pointerMove(window, { clientX: 160, clientY: 140 })
    fireEvent.keyDown(window, { key: 'Escape' })
    fireEvent.pointerUp(window, { clientX: 160, clientY: 140 })

    expect(undoDepth()).toBe(0)
    expect(getSlideHtml(useDeckStore.getState().slideHtml, slideId)).toBe(originalHtml)
  })

  it('undo restores the pre-drag source byte-exact', () => {
    render(<SelectionOverlay frameRef={frameRef} slideId={slideId} scale={1} />)
    drag(screen.getByTestId('design-selection'), { x: 100, y: 100 }, { x: 160, y: 140 })
    expect(getSlideHtml(useDeckStore.getState().slideHtml, slideId)).not.toBe(originalHtml)

    expect(useDeckStore.getState().undo()).toBe(true)
    expect(getSlideHtml(useDeckStore.getState().slideHtml, slideId)).toBe(originalHtml)
  })

  it('a second drag is a second, independent undo step', () => {
    render(<SelectionOverlay frameRef={frameRef} slideId={slideId} scale={1} />)
    drag(screen.getByTestId('design-selection'), { x: 100, y: 100 }, { x: 130, y: 100 })
    const afterFirst = getSlideHtml(useDeckStore.getState().slideHtml, slideId)!

    // The overlay wrote the committed geometry back onto the selection, so the second drag starts
    // from the moved box — its own gesture, its own command.
    drag(screen.getByTestId('design-selection'), { x: 130, y: 100 }, { x: 160, y: 100 })
    expect(getSlideHtml(useDeckStore.getState().slideHtml, slideId)).not.toBe(afterFirst)

    expect(useDeckStore.getState().undo()).toBe(true)
    expect(getSlideHtml(useDeckStore.getState().slideHtml, slideId)).toBe(afterFirst)
    expect(useDeckStore.getState().undo()).toBe(true)
    expect(getSlideHtml(useDeckStore.getState().slideHtml, slideId)).toBe(originalHtml)
  })
})

/**
 * Rotate / duplicate (M3.6). The rotation handle drives one gesture → one command through the same
 * deckStore history the Edit menu drives; `Ctrl/⌘+D` duplicates the selection. happy-dom reports
 * every box as 0×0, so the frame origin is (0,0) and the selection centre is the rect centre — which
 * is all the pure angle math needs.
 */
describe('SelectionOverlay — rotate & duplicate (M3.6)', () => {
  let slideId: string
  let titleSlId: string
  let originalHtml: string

  beforeEach(() => {
    useDeckStore.setState(createStarterDeck(0))
    const state = useDeckStore.getState()
    slideId = state.deck.slideOrder[0]!
    originalHtml = getSlideHtml(state.slideHtml, slideId)!
    const map = buildSlideMap(slideId, originalHtml)
    titleSlId = [...map.byId].find(([, span]) => span.tagName === 'h1')![0]

    const hit: SlHit = {
      slId: titleSlId,
      tag: 'h1',
      id: null,
      classes: ['title'],
      // Centre at frame (248, 78); with scale 1 and a 0×0 frame box that is also the client centre.
      rect: { x: 48, y: 48, width: 400, height: 60 },
      ancestors: [],
    }
    useDesignStore.setState({ enabled: true, selection: hit, hover: null })
  })

  afterEach(cleanup)

  it('renders a rotation handle above the selection', () => {
    render(<SelectionOverlay frameRef={frameRef} slideId={slideId} scale={1} />)
    expect(screen.getByTestId('design-handle-rotate')).toBeTruthy()
  })

  it('a rotation gesture writes rotate() as ONE command (swept 90°, snapped)', () => {
    render(<SelectionOverlay frameRef={frameRef} slideId={slideId} scale={1} />)
    // Grab east of centre (248,78) → (348,78) [0°], release south → (248,178) [90°]: swept +90°.
    drag(screen.getByTestId('design-handle-rotate'), { x: 348, y: 78 }, { x: 248, y: 178 })

    expect(undoDepth()).toBe(1)
    expect(getSlideHtml(useDeckStore.getState().slideHtml, slideId)).toContain('rotate(90deg)')
  })

  it('snaps a near-45° sweep to exactly 45°', () => {
    render(<SelectionOverlay frameRef={frameRef} slideId={slideId} scale={1} />)
    // East (0°) → down-right ~40° (snaps to 45°).
    drag(screen.getByTestId('design-handle-rotate'), { x: 348, y: 78 }, { x: 324, y: 142 })
    expect(getSlideHtml(useDeckStore.getState().slideHtml, slideId)).toContain('rotate(45deg)')
  })

  it('a rotation coalesces to one command and undo restores the source byte-exact', () => {
    render(<SelectionOverlay frameRef={frameRef} slideId={slideId} scale={1} />)
    drag(screen.getByTestId('design-handle-rotate'), { x: 348, y: 78 }, { x: 248, y: 178 }, 8)
    expect(undoDepth()).toBe(1)
    expect(useDeckStore.getState().undo()).toBe(true)
    expect(getSlideHtml(useDeckStore.getState().slideHtml, slideId)).toBe(originalHtml)
  })

  it('Escape mid-rotation cancels: no command, source unchanged', () => {
    render(<SelectionOverlay frameRef={frameRef} slideId={slideId} scale={1} />)
    const handle = screen.getByTestId('design-handle-rotate')
    fireEvent.pointerDown(handle, { clientX: 348, clientY: 78 })
    fireEvent.pointerMove(window, { clientX: 248, clientY: 178 })
    fireEvent.keyDown(window, { key: 'Escape' })
    fireEvent.pointerUp(window, { clientX: 248, clientY: 178 })

    expect(undoDepth()).toBe(0)
    expect(getSlideHtml(useDeckStore.getState().slideHtml, slideId)).toBe(originalHtml)
  })

  it('Ctrl+D duplicates the selection as one command and selects the clone', () => {
    render(<SelectionOverlay frameRef={frameRef} slideId={slideId} scale={1} />)
    fireEvent.keyDown(window, { key: 'd', ctrlKey: true })

    expect(undoDepth()).toBe(1)
    const html = getSlideHtml(useDeckStore.getState().slideHtml, slideId)!
    expect(html.match(/<h1/g)?.length).toBe(2)
    // Selection moved to the clone (a different sl-id than the original).
    expect(useDesignStore.getState().selection?.slId).not.toBe(titleSlId)
  })
})
