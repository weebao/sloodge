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
 * - `duplicate` — the panel's Duplicate button *and* `Ctrl/⌘+D` (`useDuplicateKey` calls straight
 *   into this callback, so the accelerator's refusal is exactly this refusal).
 *
 * Each action gets its own assertion: they share `lockRefusal` but not a gate — flip and rotate go
 * through `commitTransform`, duplicate through `buildDuplicatePatch` — and a suite that only drove
 * flip would leave the other two riding on an argument rather than on a test.
 */

import { cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { SlHit } from '../../../src/shared/design/bridge-protocol'
import { buildSlideMap } from '../../../src/shared/design/slide-map'
import { useDesignStore } from '../../../src/renderer/src/features/design/designStore'
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

  it('duplicate writes nothing and leaves the selection where it was (Ctrl/⌘+D too)', () => {
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
})
