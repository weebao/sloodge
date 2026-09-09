/**
 * @vitest-environment happy-dom
 *
 * `useElementActions` under `data-sl-lock` (M3.16) — the wiring behind flip, rotate and duplicate,
 * exercised at the hook rather than through one surface, because each of its three actions has more
 * than one entry point and they do not all have a button:
 *
 * - `flip` — the panel's Flip H/V (covered in `property-panel.test.tsx` too, at the button).
 * - `rotateTo` — the overlay's **rotation handle**, which is a pointer gesture with no other
 *   component test; the handle is hidden on a locked element, so the commit half needs pinning here.
 * - `duplicate` — the panel's Duplicate button *and* `Ctrl/⌘+D`. `useDuplicateKey` is handed this
 *   exact callback, and rather than leave that coupling as an argument the accelerator is *driven*
 *   here: `withDuplicateKey` mounts both hooks together and the test dispatches the real chord.
 *
 * Each action gets its own assertion: they share `lockRefusal` but not a gate — flip and rotate go
 * through `commitTransform`, duplicate through `buildDuplicatePatch` — and a suite that only drove
 * flip would leave the other two riding on an argument rather than on a test.
 */

import { cleanup, fireEvent, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { SlHit } from '../../../src/shared/design/bridge-protocol'
import { buildSlideMap } from '../../../src/shared/design/slide-map'
import { useDesignStore } from '../../../src/renderer/src/features/design/designStore'
import { useDuplicateKey } from '../../../src/renderer/src/features/design/useDuplicateKey'
import { useElementActions } from '../../../src/renderer/src/features/design/useElementActions'
import {
  createStarterDeck,
  getSlideHtml,
  useDeckStore,
} from '../../../src/renderer/src/stores/deckStore'

const LOCKED = '<div data-sl-lock style="width:200px;height:100px">A</div>'
const FREE = LOCKED.replace(' data-sl-lock', '')

let slideId = ''

/** Install `html` as the deck's only slide with a clean (empty) undo stack, and select its div. */
function seed(source: string): void {
  const base = createStarterDeck(0)
  const id = base.currentSlideId!
  const slides = Object.assign(Object.create(null) as Record<string, string>, { [id]: source })
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
  const slId = buildSlideMap(id, source).order[0]!
  const hit: SlHit = {
    slId,
    tag: 'div',
    id: null,
    classes: [],
    rect: { x: 0, y: 0, width: 200, height: 100 },
    box: { x: 0, y: 0, width: 200, height: 100 },
    ancestors: [],
  }
  useDesignStore.setState({ enabled: true, selection: hit, selections: [hit], hover: null })
}

/**
 * Mount `useElementActions` with `useDuplicateKey` bound to its `duplicate`, exactly as
 * `SelectionOverlay` wires them, so a dispatched `Ctrl/⌘+D` reaches the same callback the panel
 * button calls. Returned so a test can also invoke the callback directly and compare the two.
 */
function withDuplicateKey() {
  return renderHook(() => {
    const actions = useElementActions(slideId)
    useDuplicateKey(actions.duplicate, true)
    return actions
  })
}

/** The accelerator as the user presses it, on a real descendant so window sees capture-then-bubble. */
function ctrlD(): void {
  fireEvent.keyDown(document.body, { key: 'd', ctrlKey: true })
}

function undoDepth(): number {
  return useDeckStore.getState().history.undoStack().length
}

function html(): string {
  return getSlideHtml(useDeckStore.getState().slideHtml, slideId)!
}

beforeEach(() => {
  useDesignStore.setState({
    enabled: true,
    hover: null,
    selection: null,
    selections: [],
    notice: null,
  })
})

afterEach(cleanup)

describe('useElementActions — data-sl-lock (M3.16)', () => {
  it('flip writes nothing, pushes no command, and raises no notice', () => {
    seed(LOCKED)
    const { result } = renderHook(() => useElementActions(slideId))
    result.current.flip('x')
    result.current.flip('y')
    expect(html()).toBe(LOCKED)
    expect(undoDepth()).toBe(0)
    // Not even the mirrored-text notice: nothing was flipped, so there is nothing to caption.
    expect(useDesignStore.getState().notice).toBeNull()
  })

  it('rotateTo writes nothing — the overlay handle is hidden, and the commit refuses anyway', () => {
    seed(LOCKED)
    const { result } = renderHook(() => useElementActions(slideId))
    result.current.rotateTo(0, 45)
    expect(html()).toBe(LOCKED)
    expect(undoDepth()).toBe(0)
  })

  it('duplicate writes nothing and leaves the selection where it was', () => {
    seed(LOCKED)
    const before = useDesignStore.getState().selection!.slId
    const { result } = renderHook(() => useElementActions(slideId))
    result.current.duplicate()
    expect(html()).toBe(LOCKED)
    expect(undoDepth()).toBe(0)
    // A refusal must not move the selection onto a clone that was never inserted.
    expect(useDesignStore.getState().selection!.slId).toBe(before)
    expect(useDesignStore.getState().notice).toBeNull()
  })

  it('Ctrl/⌘+D writes nothing either — the accelerator, dispatched', () => {
    // Driven rather than argued: the chord is the second entry point to `duplicate`, and a title
    // claiming it while only calling the callback is coverage this repo has shipped before.
    seed(LOCKED)
    const before = useDesignStore.getState().selection!.slId
    withDuplicateKey()
    ctrlD()
    expect(html()).toBe(LOCKED)
    expect(undoDepth()).toBe(0)
    expect(useDesignStore.getState().selection!.slId).toBe(before)
  })

  it('all three act on the identical element without the attribute', () => {
    // The paired half: without it, a hook that had simply stopped calling its builders would pass.
    seed(FREE)
    const { result } = renderHook(() => useElementActions(slideId))
    result.current.flip('x')
    expect(html()).toContain('scale(-1, 1)')
    result.current.rotateTo(0, 45)
    expect(html()).toContain('rotate(45deg)')
    result.current.duplicate()
    expect(html().match(/<div style/g)?.length).toBe(2)
    expect(undoDepth()).toBe(3)
  })

  it('the chord really does duplicate the unlocked twin — the harness can see its own subject', () => {
    // Without this half, a chord that never matched (wrong key, unmounted listener, a guard that
    // swallowed it) would let the locked assertion above pass while proving nothing.
    seed(FREE)
    withDuplicateKey()
    ctrlD()
    expect(html().match(/<div style/g)?.length).toBe(2)
    expect(undoDepth()).toBe(1)
  })
})
