/**
 * @vitest-environment happy-dom
 *
 * Align / distribute as **one** undoable command (M3.7), driven through the real deck + design
 * stores and the `ArrangeBar` UI. happy-dom cannot run the iframe, so the selection geometry is
 * seeded into the design store directly (as the bridge would); the assertions are about the source
 * patch and the undo stack, which are pure of the DOM.
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { SlHit, SlRect } from '../../../src/shared/design/bridge-protocol'
import { buildSlideMap } from '../../../src/shared/design/slide-map'
import { readStyleProp } from '../../../src/shared/design/patch'
import type { ElementSpan } from '../../../src/shared/design/types'
import { ArrangeBar } from '../../../src/renderer/src/features/design/ArrangeBar'
import { useArrangeActions } from '../../../src/renderer/src/features/design/useArrangeActions'
import { useDesignStore } from '../../../src/renderer/src/features/design/designStore'
import {
  createStarterDeck,
  getSlideHtml,
  useDeckStore,
} from '../../../src/renderer/src/stores/deckStore'
import { renderHook } from '@testing-library/react'

const SLIDE_HTML = `<!doctype html><html><body>
<div class="slide" data-sl-slide="X">
  <div class="a" style="position:absolute;left:10px;top:20px;width:100px;height:40px">A</div>
  <div class="b" style="position:absolute;left:200px;top:60px;width:80px;height:40px">B</div>
  <div class="c" style="position:absolute;left:400px;top:100px;width:60px;height:40px">C</div>
</div>
</body></html>`

let slideId = ''

/** Install `SLIDE_HTML` as the deck's only slide with a clean (empty) undo stack. */
function seedDeck(): string {
  const base = createStarterDeck(0)
  const id = base.currentSlideId
  if (id === null) throw new Error('starter deck has no slide')
  const slides = Object.assign(Object.create(null) as Record<string, string>, { [id]: SLIDE_HTML })
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
  return id
}

/** The rect an element declares in source, for seeding a plausible selection hit. */
function rectOf(source: string, span: ElementSpan): SlRect {
  const num = (prop: string): number => Number.parseFloat(readStyleProp(source, span, prop) ?? '0')
  return { x: num('left'), y: num('top'), width: num('width'), height: num('height') }
}

/** Build selection hits for the three shapes, resolving their sl-ids from the map. */
function shapeHits(): SlHit[] {
  const map = buildSlideMap(slideId, SLIDE_HTML)
  const hits: SlHit[] = []
  for (const cls of ['a', 'b', 'c']) {
    for (const [id, span] of map.byId as ReadonlyMap<string, ElementSpan>) {
      const outer = SLIDE_HTML.slice(span.outer.start, span.outer.end)
      if (outer.startsWith(`<div class="${cls}"`)) {
        hits.push({
          slId: id,
          tag: 'div',
          id: null,
          classes: [cls],
          rect: rectOf(SLIDE_HTML, span),
          ancestors: [],
        })
        break
      }
    }
  }
  return hits
}

function undoDepth(): number {
  return useDeckStore.getState().history.undoStack().length
}

beforeEach(() => {
  slideId = seedDeck()
  useDesignStore.setState({ enabled: true, hover: null, selection: null, selections: [] })
})

afterEach(cleanup)

describe('useArrangeActions', () => {
  it('align left moves every element to left:10px as ONE undoable command', () => {
    useDesignStore.getState().setSelections(shapeHits())
    const { result } = renderHook(() => useArrangeActions(slideId))

    expect(result.current.canAlign).toBe(true)
    result.current.align('left')

    const patched = getSlideHtml(useDeckStore.getState().slideHtml, slideId) ?? ''
    // All three now declare left:10px, and the whole align is a single stack entry.
    expect(patched.match(/left:\s*10px/g)?.length).toBe(3)
    expect(undoDepth()).toBe(1) // mutation guard: per-element commits would make this 3

    // Undo restores the original bytes exactly.
    expect(useDeckStore.getState().undo()).toBe(true)
    expect(getSlideHtml(useDeckStore.getState().slideHtml, slideId)).toBe(SLIDE_HTML)
  })

  it('align top moves every element to top:20px as one command', () => {
    useDesignStore.getState().setSelections(shapeHits())
    const { result } = renderHook(() => useArrangeActions(slideId))
    result.current.align('top')
    const patched = getSlideHtml(useDeckStore.getState().slideHtml, slideId) ?? ''
    expect(patched.match(/top:\s*20px/g)?.length).toBe(3)
    expect(undoDepth()).toBe(1)
  })

  it('distribute horizontal commits one command and evens the centres', () => {
    useDesignStore.getState().setSelections(shapeHits())
    const { result } = renderHook(() => useArrangeActions(slideId))
    expect(result.current.canDistribute).toBe(true)
    result.current.distribute('horizontal')
    expect(undoDepth()).toBe(1)
    // Middle element (B) moved; its center should sit between A's and C's centers.
    const patched = getSlideHtml(useDeckStore.getState().slideHtml, slideId) ?? ''
    expect(patched).not.toBe(SLIDE_HTML)
  })

  it('align is disabled below two selected, distribute below three', () => {
    useDesignStore.getState().setSelections(shapeHits().slice(0, 2))
    const { result } = renderHook(() => useArrangeActions(slideId))
    expect(result.current.canAlign).toBe(true)
    expect(result.current.canDistribute).toBe(false)
    result.current.distribute('horizontal') // no-op
    expect(undoDepth()).toBe(0)
  })
})

describe('ArrangeBar', () => {
  it('is hidden below two selected elements', () => {
    useDesignStore.getState().setSelection(shapeHits()[0]!)
    render(<ArrangeBar slideId={slideId} />)
    expect(screen.queryByTestId('arrange-bar')).toBeNull()
  })

  it('shows the arrange toolbar with a live count for a multi-selection', () => {
    useDesignStore.getState().setSelections(shapeHits())
    render(<ArrangeBar slideId={slideId} />)
    expect(screen.getByTestId('arrange-bar')).toBeTruthy()
    expect(screen.getByText('3 selected')).toBeTruthy()
    expect((screen.getByLabelText('Distribute horizontally') as HTMLButtonElement).disabled).toBe(
      false,
    )
  })

  it('clicking Align left commits one undoable align', () => {
    useDesignStore.getState().setSelections(shapeHits())
    render(<ArrangeBar slideId={slideId} />)
    fireEvent.click(screen.getByLabelText('Align left'))
    expect(undoDepth()).toBe(1)
    const patched = getSlideHtml(useDeckStore.getState().slideHtml, slideId) ?? ''
    expect(patched.match(/left:\s*10px/g)?.length).toBe(3)
  })

  it('disables distribute with only two selected', () => {
    useDesignStore.getState().setSelections(shapeHits().slice(0, 2))
    render(<ArrangeBar slideId={slideId} />)
    expect((screen.getByLabelText('Distribute horizontally') as HTMLButtonElement).disabled).toBe(
      true,
    )
  })
})
