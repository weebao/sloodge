/**
 * @vitest-environment happy-dom
 *
 * The Properties panel: renders fields for the selected element read from the slide source, and
 * commits each edit as one undoable `slide.setHtml` on the deck store. The iframe never runs under
 * happy-dom, so this covers the parent-side edit path (read → edit → commit → undo); the pure
 * field↔source mapping is proven exhaustively in `property-model.test.ts`.
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { SlHit } from '../../../src/shared/design/bridge-protocol'
import { buildSlideMap } from '../../../src/shared/design/slide-map'
import { useDesignStore } from '../../../src/renderer/src/features/design/designStore'
import { useChatContextStore } from '../../../src/renderer/src/features/chat/chatContextStore'
import { PropertyPanel } from '../../../src/renderer/src/features/design/PropertyPanel'
import {
  createStarterDeck,
  getSlideHtml,
  useDeckStore,
  type SlideView,
} from '../../../src/renderer/src/stores/deckStore'

const NOW = 1_700_000_000_000
const SOURCE = '<h1 style="color: #111; font-size: 44px">Hello</h1>'

let slideId: string

/** The SlideView the canvas would pass, reflecting the store's current bytes for the slide. */
function currentSlide(): SlideView {
  return {
    id: slideId,
    title: 'Slide',
    html: getSlideHtml(useDeckStore.getState().slideHtml, slideId)!,
  }
}

/** The sl-id of the <h1> in the seeded source, keyed by the slide id (as the map assigns it). */
function h1Id(): string {
  const map = buildSlideMap(slideId, SOURCE)
  return map.order[0]!
}

function select(): void {
  const hit: SlHit = {
    slId: h1Id(),
    tag: 'h1',
    id: null,
    classes: [],
    rect: { x: 0, y: 0, width: 100, height: 40 },
    ancestors: [],
  }
  useDesignStore.setState({ enabled: true, hover: null, selection: hit })
}

beforeEach(() => {
  useDeckStore.setState(createStarterDeck(NOW))
  slideId = useDeckStore.getState().currentSlideId!
  // Install a controlled, known source for the current slide (one undoable step).
  useDeckStore.getState().setSlideHtml(slideId, SOURCE, slideId, 'seed')
  useDesignStore.setState({ enabled: true, hover: null, selection: null })
})

afterEach(cleanup)

describe('PropertyPanel', () => {
  it('renders nothing when there is no selection', () => {
    render(<PropertyPanel slide={currentSlide()} />)
    expect(screen.queryByTestId('property-panel')).toBeNull()
  })

  it('populates fields from the element’s source values', () => {
    select()
    render(<PropertyPanel slide={currentSlide()} />)
    expect((screen.getByTestId('prop-text') as HTMLInputElement).value).toBe('Hello')
    expect((screen.getByTestId('prop-color') as HTMLInputElement).value).toBe('#111')
    expect((screen.getByTestId('prop-fontSize') as HTMLInputElement).value).toBe('44px')
    expect((screen.getByTestId('prop-fontWeight') as HTMLInputElement).value).toBe('')
  })

  it('commits a font-size edit to the slide source on blur, patching only that declaration', () => {
    select()
    render(<PropertyPanel slide={currentSlide()} />)
    const input = screen.getByTestId('prop-fontSize') as HTMLInputElement
    fireEvent.change(input, { target: { value: '60' } })
    fireEvent.blur(input)

    const patched = getSlideHtml(useDeckStore.getState().slideHtml, slideId)!
    expect(patched).toBe('<h1 style="color: #111; font-size: 60px">Hello</h1>')
    expect(useDeckStore.getState().canUndo).toBe(true)
  })

  it('commits a text edit on Enter', () => {
    select()
    render(<PropertyPanel slide={currentSlide()} />)
    const input = screen.getByTestId('prop-text') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'Goodbye' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(getSlideHtml(useDeckStore.getState().slideHtml, slideId)).toBe(
      '<h1 style="color: #111; font-size: 44px">Goodbye</h1>',
    )
  })

  it('an edit is undoable, restoring the exact prior source', () => {
    select()
    render(<PropertyPanel slide={currentSlide()} />)
    const input = screen.getByTestId('prop-color') as HTMLInputElement
    fireEvent.change(input, { target: { value: '#f0f2f5' } })
    fireEvent.blur(input)
    expect(getSlideHtml(useDeckStore.getState().slideHtml, slideId)).toContain('color: #f0f2f5')

    expect(useDeckStore.getState().undo()).toBe(true)
    expect(getSlideHtml(useDeckStore.getState().slideHtml, slideId)).toBe(SOURCE)
  })

  it('does not commit when the value is unchanged/empty (no wasted undo step)', () => {
    select()
    render(<PropertyPanel slide={currentSlide()} />)
    const input = screen.getByTestId('prop-fontWeight') as HTMLInputElement
    fireEvent.blur(input) // still empty
    // Only the seed command is on the stack; the empty blur added nothing.
    useDeckStore.getState().undo()
    expect(getSlideHtml(useDeckStore.getState().slideHtml, slideId)).not.toBe(SOURCE)
    expect(getSlideHtml(useDeckStore.getState().slideHtml, slideId)).toBeDefined()
  })

  it('reflects the new value after a commit re-renders the panel with patched source', () => {
    select()
    const { rerender } = render(<PropertyPanel slide={currentSlide()} />)
    const input = screen.getByTestId('prop-fontSize') as HTMLInputElement
    fireEvent.change(input, { target: { value: '60' } })
    fireEvent.blur(input)
    // The canvas re-renders the panel with the freshly-patched bytes; the field reflects them.
    rerender(<PropertyPanel slide={currentSlide()} />)
    expect((screen.getByTestId('prop-fontSize') as HTMLInputElement).value).toBe('60px')
  })

  it('commits against the current store bytes, not stale render-time bytes', () => {
    select()
    render(<PropertyPanel slide={currentSlide()} />)
    const input = screen.getByTestId('prop-fontSize') as HTMLInputElement
    fireEvent.change(input, { target: { value: '60' } })
    // A concurrent edit lands in the store between render and blur (same h1, sl-id stays stable).
    useDeckStore
      .getState()
      .setSlideHtml(
        slideId,
        '<h1 style="color: crimson; font-size: 44px">Hello</h1>',
        slideId,
        'ext',
      )
    fireEvent.blur(input)
    const patched = getSlideHtml(useDeckStore.getState().slideHtml, slideId)!
    // The concurrent color change survived AND the font-size edit applied — no clobber.
    expect(patched).toContain('color: crimson')
    expect(patched).toContain('font-size: 60px')
  })

  it('shows the shell but no fields when the selected sl-id no longer resolves', () => {
    useDesignStore.setState({
      enabled: true,
      hover: null,
      selection: {
        slId: `${slideId}:999`,
        tag: 'h1',
        id: null,
        classes: [],
        rect: { x: 0, y: 0, width: 1, height: 1 },
        ancestors: [],
      },
    })
    render(<PropertyPanel slide={currentSlide()} />)
    expect(screen.getByTestId('property-panel')).toBeTruthy()
    expect(screen.queryByTestId('prop-fontSize')).toBeNull()
  })
})

describe('PropertyPanel — transform actions (M3.6)', () => {
  it('Flip H composes scale(-1, 1) into the transform as one command', () => {
    select()
    render(<PropertyPanel slide={currentSlide()} />)
    fireEvent.click(screen.getByTestId('transform-flip-h'))
    const patched = getSlideHtml(useDeckStore.getState().slideHtml, slideId)!
    expect(patched).toContain('transform: scale(-1, 1)')
    // Mutation guard: clobbering the other declarations reds here.
    expect(patched).toContain('color: #111')
    expect(patched).toContain('font-size: 44px')
  })

  it('Flip V then Flip V again restores the source byte-exact (two undoable steps)', () => {
    select()
    render(<PropertyPanel slide={currentSlide()} />)
    fireEvent.click(screen.getByTestId('transform-flip-v'))
    expect(getSlideHtml(useDeckStore.getState().slideHtml, slideId)).toContain('scale(1, -1)')
    fireEvent.click(screen.getByTestId('transform-flip-v'))
    expect(getSlideHtml(useDeckStore.getState().slideHtml, slideId)).toBe(SOURCE)
  })

  it('Duplicate clones the element as one command', () => {
    select()
    render(<PropertyPanel slide={currentSlide()} />)
    fireEvent.click(screen.getByTestId('transform-duplicate'))
    const patched = getSlideHtml(useDeckStore.getState().slideHtml, slideId)!
    expect(patched.match(/<h1/g)?.length).toBe(2)
    expect(useDeckStore.getState().undo()).toBe(true)
    expect(getSlideHtml(useDeckStore.getState().slideHtml, slideId)).toBe(SOURCE)
  })

  it('“Ask Claude about this element” attaches the element context bundle (§6.1) without a frame', async () => {
    useChatContextStore.getState().clear()
    select()
    // No `inspect` prop (no live frame): the bundle still builds from the parent-owned source map and
    // the selection's rect hint — computed styles are an enrichment, not a requirement.
    render(<PropertyPanel slide={currentSlide()} />)
    fireEvent.click(screen.getByTestId('ask-claude-element'))

    await waitFor(() => expect(useChatContextStore.getState().attachment).not.toBeNull())
    const bundle = useChatContextStore.getState().attachment!
    // Authoritative HTML is re-derived from the store's current bytes (§2.2), not any bridge payload.
    expect(bundle.element.outerHtml).toBe(SOURCE)
    expect(bundle.element.tag).toBe('h1')
    expect(bundle.element.rect).toEqual({ x: 0, y: 0, width: 100, height: 40 })
    useChatContextStore.getState().clear()
  })
})
