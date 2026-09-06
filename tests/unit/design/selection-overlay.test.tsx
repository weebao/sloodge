/**
 * @vitest-environment happy-dom
 *
 * The renderer-side overlay: given a selection in the store, it draws the selection box, its eight
 * handles, and the breadcrumb. The postMessage round trip cannot run under happy-dom (the iframe is
 * inert), so this covers only what the parent renders from state — the bridge itself is proven in
 * `bridge-protocol.test.ts` and `frame-script.test.tsx`.
 */

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
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

  it('the 45° magnet catches a near-45° sweep; a 40° one is free', () => {
    render(<SelectionOverlay frameRef={frameRef} slideId={slideId} scale={1} />)
    // East (0°) → ~43° (atan2(68, 73)): within the magnet's 4° of 45°.
    drag(screen.getByTestId('design-handle-rotate'), { x: 348, y: 78 }, { x: 321, y: 146 })
    expect(getSlideHtml(useDeckStore.getState().slideHtml, slideId)).toContain('rotate(45deg)')
    // Undo outside a gesture, flushed so the overlay reads the restored angle before the next one.
    act(() => {
      expect(useDeckStore.getState().undo()).toBe(true)
    })
    // East → ~40° (atan2(64, 77) = 39.7°): outside the magnet, so a free whole degree.
    drag(screen.getByTestId('design-handle-rotate'), { x: 348, y: 78 }, { x: 325, y: 142 })
    expect(getSlideHtml(useDeckStore.getState().slideHtml, slideId)).toContain('rotate(40deg)')
  })

  it('Shift forces the 15° grid; Alt bypasses the magnet', () => {
    render(<SelectionOverlay frameRef={frameRef} slideId={slideId} scale={1} />)
    const handle = screen.getByTestId('design-handle-rotate')
    // ~37° (atan2(60, 80) = 36.9°) with Shift → 30.
    fireEvent.pointerDown(handle, { clientX: 348, clientY: 78 })
    fireEvent.pointerMove(window, { clientX: 328, clientY: 138, shiftKey: true })
    fireEvent.pointerUp(window, { clientX: 328, clientY: 138, shiftKey: true })
    expect(getSlideHtml(useDeckStore.getState().slideHtml, slideId)).toContain('rotate(30deg)')
    act(() => {
      expect(useDeckStore.getState().undo()).toBe(true)
    })
    // ~44° (atan2(69, 72) = 43.8°) with Alt → 44, where a plain drag would magnet to 45.
    fireEvent.pointerDown(handle, { clientX: 348, clientY: 78 })
    fireEvent.pointerMove(window, { clientX: 320, clientY: 147, altKey: true })
    fireEvent.pointerUp(window, { clientX: 320, clientY: 147, altKey: true })
    expect(getSlideHtml(useDeckStore.getState().slideHtml, slideId)).toContain('rotate(44deg)')
  })

  it('successive rotations start from the committed whole degree, so nothing drifts', () => {
    render(<SelectionOverlay frameRef={frameRef} slideId={slideId} scale={1} />)
    const handle = screen.getByTestId('design-handle-rotate')
    // Ten sweeps of ~40° (atan2(64, 77) = 39.7°, free). Each commits an integer and the next reads
    // it back from the source; ten of them land on exactly 400 → 40, never 397 or 40.4.
    for (let i = 0; i < 10; i += 1) {
      drag(handle, { x: 348, y: 78 }, { x: 325, y: 142 })
    }
    expect(undoDepth()).toBe(10)
    expect(getSlideHtml(useDeckStore.getState().slideHtml, slideId)).toContain('rotate(40deg)')
  })

  it('shows the live angle in the badge while rotating', async () => {
    render(<SelectionOverlay frameRef={frameRef} slideId={slideId} scale={1} />)
    const handle = screen.getByTestId('design-handle-rotate')
    fireEvent.pointerDown(handle, { clientX: 348, clientY: 78 })
    fireEvent.pointerMove(window, { clientX: 248, clientY: 178 })
    await act(
      () =>
        new Promise<void>((resolve) => {
          requestAnimationFrame(() => resolve())
        }),
    )
    expect(screen.getByTestId('design-selection').textContent).toContain('90°')
    fireEvent.keyDown(window, { key: 'Escape' })
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

/**
 * Multi-select, group move (M3.7). Selection is seeded as an ordered set (as the marquee/shift-click
 * would leave it); the overlay draws a dashed group box plus a light outline per element, and a drag
 * on the group box moves every element in one undoable command.
 */
describe('SelectionOverlay — multi-select (M3.7)', () => {
  let slideId: string
  let originalHtml: string
  let hits: SlHit[]

  beforeEach(() => {
    useDeckStore.setState(createStarterDeck(0))
    const state = useDeckStore.getState()
    slideId = state.deck.slideOrder[0]!
    originalHtml = getSlideHtml(state.slideHtml, slideId)!
    const map = buildSlideMap(slideId, originalHtml)
    const bySlId = (tag: string): string =>
      [...map.byId].find(([, span]) => span.tagName === tag)![0]
    hits = [
      {
        slId: bySlId('h1'),
        tag: 'h1',
        id: null,
        classes: ['title'],
        rect: { x: 48, y: 48, width: 300, height: 60 },
        ancestors: [],
      },
      {
        slId: bySlId('p'),
        tag: 'p',
        id: null,
        classes: ['subtitle'],
        rect: { x: 48, y: 132, width: 400, height: 30 },
        ancestors: [],
      },
    ]
    useDesignStore.setState({ enabled: true, hover: null, selection: hits[1]!, selections: hits })
  })

  it('draws a group box and a light outline per element (no resize handles)', () => {
    render(<SelectionOverlay frameRef={frameRef} slideId={slideId} scale={1} />)
    expect(screen.getByTestId('design-group')).toBeTruthy()
    expect(screen.getAllByTestId('design-member').length).toBe(2)
    // A group only moves — no per-corner handles.
    expect(screen.queryByTestId('design-handle-se')).toBeNull()
    expect(screen.getByTestId('design-group').textContent).toContain('2 selected')
  })

  it('dragging the group box moves BOTH elements as one undoable command', () => {
    render(<SelectionOverlay frameRef={frameRef} slideId={slideId} scale={1} />)
    const group = screen.getByTestId('design-group')
    drag(group, { x: 48, y: 48 }, { x: 108, y: 88 }, 3) // +60, +40 frame px

    expect(undoDepth()).toBe(1) // mutation guard: per-element commits would be 2
    const html = getSlideHtml(useDeckStore.getState().slideHtml, slideId)!
    // Both in-flow elements moved via transform:translate.
    expect(html.match(/translate\(/g)?.length).toBe(2)

    expect(useDeckStore.getState().undo()).toBe(true)
    expect(getSlideHtml(useDeckStore.getState().slideHtml, slideId)).toBe(originalHtml)
  })

  it('a zero-distance click on the group commits nothing', () => {
    render(<SelectionOverlay frameRef={frameRef} slideId={slideId} scale={1} />)
    const group = screen.getByTestId('design-group')
    drag(group, { x: 48, y: 48 }, { x: 48, y: 48 }, 1)
    expect(undoDepth()).toBe(0)
  })
})

/**
 * Resize under rotation and the transform lock (M3.6). The slide is seeded directly so the element
 * under test carries the transform in question; the selection's `box` is the unrotated layout box
 * the frame would report, and the expected bytes were computed by hand (see `drag.test.ts`).
 */
describe('SelectionOverlay — transform controls on a rotated or locked element (M3.6)', () => {
  const ROTATED =
    '<div style="position:absolute;left:100px;top:100px;width:200px;height:100px;transform: rotate(90deg)">A</div>'
  const LOCKED =
    '<div style="position:absolute;left:100px;top:100px;width:200px;height:100px;transform: matrix(1, 0, 0, 1, 0, 0)">A</div>'
  let slideId: string

  /** Install `html` as the deck's only slide with a clean (empty) undo stack, and select its div. */
  function seed(html: string): void {
    const base = createStarterDeck(0)
    const id = base.currentSlideId!
    const slides = Object.assign(Object.create(null) as Record<string, string>, { [id]: html })
    base.history.reset({
      manifest: base.deck,
      slides,
      notes: Object.create(null) as Record<string, string>,
      theme: null,
    })
    useDeckStore.setState({
      history: base.history,
      deck: base.history.doc.manifest,
      slideHtml: base.history.doc.slides,
      currentSlideId: id,
      canUndo: base.history.canUndo,
      canRedo: base.history.canRedo,
    })
    slideId = id
    const slId = buildSlideMap(id, html).order[0]!
    const hit: SlHit = {
      slId,
      tag: 'div',
      id: null,
      classes: [],
      // The rendered bounds of a 200×100 box turned 90° about its centre (200, 150) …
      rect: { x: 150, y: 50, width: 100, height: 200 },
      // … and its unrotated layout box, which every gesture starts from.
      box: { x: 100, y: 100, width: 200, height: 100 },
      ancestors: [],
    }
    useDesignStore.setState({ enabled: true, selection: hit, selections: [hit], hover: null })
  }

  afterEach(cleanup)

  it('draws the box turned by the source rotation, with cursors that turn with it', () => {
    seed(ROTATED)
    render(<SelectionOverlay frameRef={frameRef} slideId={slideId} scale={1} />)
    expect(screen.getByTestId('design-selection').style.transform).toBe('rotate(90deg)')
    // The east grip now points straight down.
    expect(screen.getByTestId('design-handle-e').style.cursor).toBe('ns-resize')
    expect(screen.getByTestId('design-handle-n').style.cursor).toBe('ew-resize')
  })

  it('dragging the east handle of a 90° box downward stretches its width along its own axis', () => {
    seed(ROTATED)
    render(<SelectionOverlay frameRef={frameRef} slideId={slideId} scale={1} />)
    // 40px straight down on screen is 40px along the element's +x. Hand-computed (drag.test.ts):
    // the unrotated box becomes {80, 120, 240, 100}, so left −20, top +20, width 240.
    drag(screen.getByTestId('design-handle-e'), { x: 300, y: 150 }, { x: 300, y: 190 })

    expect(undoDepth()).toBe(1)
    const html = getSlideHtml(useDeckStore.getState().slideHtml, slideId)!
    // Mutation guard: the screen-axis math writes neither of these — a downward drag on an
    // unrotated `e` handle changes nothing at all.
    expect(html).toContain('width: 240px')
    expect(html).toContain('left: 80px')
    expect(html).toContain('top: 120px')
    expect(html).toContain('height: 100px')
    expect(html).toContain('rotate(90deg)')
  })

  it('refreshes the selection box after a rotated resize, so the next gesture starts from it', () => {
    seed(ROTATED)
    render(<SelectionOverlay frameRef={frameRef} slideId={slideId} scale={1} />)
    drag(screen.getByTestId('design-handle-e'), { x: 300, y: 150 }, { x: 300, y: 190 })
    const selection = useDesignStore.getState().selection!
    // The unrotated box is what the gesture produced (drag.test.ts); the rendered rect is that box
    // turned 90° about its centre (200, 170): width and height swap. Mutation guard: writing only
    // `rect` (the M3.5 path) leaves `box` at the pre-resize {100, 100, 200, 100}.
    expect(selection.box).toEqual({ x: 80, y: 120, width: 240, height: 100 })
    expect(selection.rect.x).toBeCloseTo(150)
    expect(selection.rect.y).toBeCloseTo(50)
    expect(selection.rect.width).toBeCloseTo(100)
    expect(selection.rect.height).toBeCloseTo(240)
    expect(screen.getByTestId('design-selection').textContent).toContain('240 × 100')
  })

  it('a rotated resize is one undo step that restores the source byte-exact', () => {
    seed(ROTATED)
    render(<SelectionOverlay frameRef={frameRef} slideId={slideId} scale={1} />)
    drag(screen.getByTestId('design-handle-e'), { x: 300, y: 150 }, { x: 300, y: 190 }, 6)
    expect(undoDepth()).toBe(1)
    expect(useDeckStore.getState().undo()).toBe(true)
    expect(getSlideHtml(useDeckStore.getState().slideHtml, slideId)).toBe(ROTATED)
  })

  it('an opaque transform locks every handle and says why', () => {
    seed(LOCKED)
    render(<SelectionOverlay frameRef={frameRef} slideId={slideId} scale={1} />)
    const lock = screen.getByTestId('design-transform-lock')
    expect(lock.textContent).toContain('matrix(1, 0, 0, 1, 0, 0)')
    expect(screen.queryByTestId('design-handle-e')).toBeNull()
    expect(screen.queryByTestId('design-handle-rotate')).toBeNull()
    expect(screen.getByTestId('design-selection').style.cursor).toBe('default')
  })

  it('a locked element cannot be moved by dragging its body: no command, source unchanged', () => {
    seed(LOCKED)
    render(<SelectionOverlay frameRef={frameRef} slideId={slideId} scale={1} />)
    drag(screen.getByTestId('design-selection'), { x: 150, y: 150 }, { x: 200, y: 180 })
    expect(undoDepth()).toBe(0)
    expect(getSlideHtml(useDeckStore.getState().slideHtml, slideId)).toBe(LOCKED)
  })

  it('an editable element shows no lock', () => {
    seed(ROTATED)
    render(<SelectionOverlay frameRef={frameRef} slideId={slideId} scale={1} />)
    expect(screen.queryByTestId('design-transform-lock')).toBeNull()
  })
})
