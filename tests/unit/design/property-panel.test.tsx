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
import { DEFAULT_MAX_HISTORY_ENTRIES } from '../../../src/shared/document/history'
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

/** Injected eyedropper seams (M3.8) — module-scoped so they are stable object props (react-perf). */
const SAMPLING_PICKER = { pickColor: (): Promise<string | null> => Promise.resolve('#00ff00') }
const CANCELLING_PICKER = { pickColor: (): Promise<string | null> => Promise.resolve(null) }

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
  it('renders the dock with an empty state and no fields when there is no selection', () => {
    // The dock is always mounted in Design Mode (round-2 review: mounting it on select re-fit the
    // slide under a double-click), so no selection means the shell plus a hint, never `null`.
    render(<PropertyPanel slide={currentSlide()} />)
    expect(screen.getByTestId('property-panel')).toBeTruthy()
    expect(screen.getByTestId('property-panel-empty').textContent).toContain('Double-click text')
    expect(screen.queryByTestId('prop-text')).toBeNull()
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

  it('the Content field shows decoded text and an unchanged blur commits nothing (M3.12)', () => {
    // The roadmap repro, through the component: the field must show `X & Y`, not the source bytes
    // `X &amp; Y`, and leaving it as shown must not write — before the fix every blur re-escaped.
    useDeckStore.getState().setSlideHtml(slideId, '<h1>X &amp; Y</h1>', slideId, 'entities')
    const before = useDeckStore.getState().history
    select()
    render(<PropertyPanel slide={currentSlide()} />)
    const input = screen.getByTestId('prop-text') as HTMLInputElement
    expect(input.value).toBe('X & Y')
    fireEvent.blur(input)
    expect(useDeckStore.getState().history).toBe(before)
    expect(getSlideHtml(useDeckStore.getState().slideHtml, slideId)).toBe('<h1>X &amp; Y</h1>')

    fireEvent.change(input, { target: { value: 'X & Y!' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(getSlideHtml(useDeckStore.getState().slideHtml, slideId)).toBe('<h1>X &amp; Y!</h1>')
    // And after the commit the remounted field reads back what was typed, one level of escaping.
    cleanup()
    render(<PropertyPanel slide={currentSlide()} />)
    expect((screen.getByTestId('prop-text') as HTMLInputElement).value).toBe('X & Y!')
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

/** Current undo-stack depth — the thing a per-`input` commit would inflate one entry at a time. */
function undoDepth(): number {
  return useDeckStore.getState().history.summary().undoDepth
}

/**
 * Simulate an OS colour-picker gesture: Chromium fires `input` continuously as the user drags, then
 * exactly one `change` when the picker is confirmed. Only the `change` may reach the undo stack.
 */
function pickerDrag(element: HTMLElement, intermediates: readonly string[], final: string): void {
  for (const value of intermediates) fireEvent.input(element, { target: { value } })
  fireEvent.change(element, { target: { value: final } })
}

describe('PropertyPanel — colour controls (M3.8)', () => {
  it('a native swatch pick commits a colour hex as one undoable command, byte-exact undo', () => {
    select()
    render(<PropertyPanel slide={currentSlide()} picker={null} />)
    const before = undoDepth()
    fireEvent.change(screen.getByTestId('swatch-color'), { target: { value: '#ff0000' } })

    const patched = getSlideHtml(useDeckStore.getState().slideHtml, slideId)!
    expect(patched).toContain('color: #ff0000')
    // Mutation guard: the other declaration survives the colour write.
    expect(patched).toContain('font-size: 44px')
    expect(undoDepth()).toBe(before + 1)
    expect(useDeckStore.getState().canUndo).toBe(true)
    expect(useDeckStore.getState().undo()).toBe(true)
    expect(getSlideHtml(useDeckStore.getState().slideHtml, slideId)).toBe(SOURCE)
  })

  it('a whole picker DRAG is ONE undo entry — intermediates never touch the stack', () => {
    select()
    render(<PropertyPanel slide={currentSlide()} picker={null} />)
    const before = undoDepth()
    // Many `input` events (the drag), then the single `change` Chromium fires on confirm.
    pickerDrag(
      screen.getByTestId('swatch-color'),
      ['#000031', '#0000aa', '#00aa55', '#88bb00'],
      '#ff0000',
    )

    // Exactly one entry, carrying the FINAL colour — not the intermediates.
    expect(undoDepth()).toBe(before + 1)
    const patched = getSlideHtml(useDeckStore.getState().slideHtml, slideId)!
    expect(patched).toContain('color: #ff0000')
    for (const mid of ['#000031', '#0000aa', '#00aa55', '#88bb00']) {
      expect(patched).not.toContain(mid)
    }
    // One undo reverses it byte-exact.
    expect(useDeckStore.getState().undo()).toBe(true)
    expect(getSlideHtml(useDeckStore.getState().slideHtml, slideId)).toBe(SOURCE)
  })

  it('a 250-event drag does NOT evict the user’s pre-existing history (the 200-entry cap)', () => {
    select()
    render(<PropertyPanel slide={currentSlide()} picker={null} />)
    const before = undoDepth()
    // A short real drag emits hundreds of `input` events. Committing per event would overflow
    // history.ts's 200-entry cap and silently destroy everything the user did before this pick.
    const intermediates = Array.from(
      { length: 250 },
      (_, index) => `#0000${(index % 100).toString().padStart(2, '0')}`,
    )
    pickerDrag(screen.getByTestId('swatch-color'), intermediates, '#ff0000')

    expect(undoDepth()).toBe(before + 1)
    expect(undoDepth()).toBeLessThan(DEFAULT_MAX_HISTORY_ENTRIES)
    // The pre-existing history is intact: one undo still reaches the seeded source.
    expect(useDeckStore.getState().undo()).toBe(true)
    expect(getSlideHtml(useDeckStore.getState().slideHtml, slideId)).toBe(SOURCE)
  })

  it('a cancelled picker (input events, no change) leaves the document untouched', () => {
    select()
    render(<PropertyPanel slide={currentSlide()} picker={null} />)
    const before = undoDepth()
    const swatch = screen.getByTestId('swatch-color')
    // The user dragged, then pressed Escape: `input` fired, `change` never did.
    for (const value of ['#000031', '#0000aa']) {
      fireEvent.input(swatch, { target: { value } })
    }
    expect(undoDepth()).toBe(before)
    expect(getSlideHtml(useDeckStore.getState().slideHtml, slideId)).toBe(SOURCE)
  })

  it('an aborted gesture leaves the swatch showing the SOURCE colour, not the preview', () => {
    select()
    render(<PropertyPanel slide={currentSlide()} picker={null} />)
    const swatch = screen.getByTestId('swatch-color') as HTMLInputElement
    // The source is `color: #111`, which the native input renders as `#111111`.
    expect(swatch.value).toBe('#111111')

    // Drag to a colour, then dismiss without confirming (no `change`).
    fireEvent.input(swatch, { target: { value: '#00ff00' } })
    expect(swatch.value).toBe('#00ff00') // live preview during the gesture
    fireEvent.blur(swatch)

    // The abandoned preview is gone: the swatch reflects the source again.
    expect(swatch.value).toBe('#111111')
    expect(getSlideHtml(useDeckStore.getState().slideHtml, slideId)).toBe(SOURCE)
  })

  it('a change that merely restates the source colour costs ZERO undo entries', () => {
    // A non-canonical source colour: some pickers cancel by reverting and firing `change` with the
    // canonicalized form, which must not rewrite `red` to `#ff0000` for a cancelled gesture.
    const namedSource = '<h1 style="color: red; font-size: 44px">Hello</h1>'
    useDeckStore.getState().setSlideHtml(slideId, namedSource, slideId, 'seed-named')
    select()
    render(<PropertyPanel slide={currentSlide()} picker={null} />)
    const before = undoDepth()

    fireEvent.change(screen.getByTestId('swatch-color'), { target: { value: '#ff0000' } })

    expect(undoDepth()).toBe(before)
    // The source keeps the author's spelling, byte-for-byte.
    expect(getSlideHtml(useDeckStore.getState().slideHtml, slideId)).toBe(namedSource)
  })

  it('a restating change against a TRANSLUCENT source costs ZERO undo entries', () => {
    // The write re-attaches the source's alpha, and a native colour input can never report alpha — so
    // the no-op guard has to compare the MERGED value. Comparing the raw picked hex would always see a
    // difference here (`#ff0000` vs `rgba(255,0,0,0.5)`) and spend an entry rewriting the declaration
    // to `#ff000080`: same colour, same alpha, nothing to see.
    const alphaSource = '<h1 style="color: rgba(255, 0, 0, 0.5); font-size: 44px">Hello</h1>'
    useDeckStore.getState().setSlideHtml(slideId, alphaSource, slideId, 'seed-translucent')
    select()
    render(<PropertyPanel slide={currentSlide()} picker={null} />)
    const before = undoDepth()

    fireEvent.change(screen.getByTestId('swatch-color'), { target: { value: '#ff0000' } })

    expect(undoDepth()).toBe(before)
    expect(getSlideHtml(useDeckStore.getState().slideHtml, slideId)).toBe(alphaSource)
  })

  it('the no-op guard does not over-swallow: a new hue on a translucent source still commits', () => {
    const alphaSource = '<h1 style="color: rgba(255, 0, 0, 0.5); font-size: 44px">Hello</h1>'
    useDeckStore.getState().setSlideHtml(slideId, alphaSource, slideId, 'seed-translucent')
    select()
    render(<PropertyPanel slide={currentSlide()} picker={null} />)
    const before = undoDepth()

    fireEvent.change(screen.getByTestId('swatch-color'), { target: { value: '#00ff00' } })

    expect(undoDepth()).toBe(before + 1)
    // The new hue landed AND the source's alpha survived.
    expect(getSlideHtml(useDeckStore.getState().slideHtml, slideId)).toContain('color: #00ff0080')
  })

  it('a genuinely different colour still commits against a non-canonical source', () => {
    const namedSource = '<h1 style="color: red; font-size: 44px">Hello</h1>'
    useDeckStore.getState().setSlideHtml(slideId, namedSource, slideId, 'seed-named')
    select()
    render(<PropertyPanel slide={currentSlide()} picker={null} />)
    const before = undoDepth()

    fireEvent.change(screen.getByTestId('swatch-color'), { target: { value: '#00ff00' } })

    expect(undoDepth()).toBe(before + 1)
    expect(getSlideHtml(useDeckStore.getState().slideHtml, slideId)).toContain('color: #00ff00')
  })

  it('a swatch pick preserves the source alpha (does not silently drop it)', () => {
    const alphaSource = '<h1 style="color: rgba(0, 0, 0, 0.5)">Hello</h1>'
    useDeckStore.getState().setSlideHtml(slideId, alphaSource, slideId, 'seed-alpha')
    select()
    render(<PropertyPanel slide={currentSlide()} picker={null} />)
    fireEvent.change(screen.getByTestId('swatch-color'), { target: { value: '#ff0000' } })
    expect(getSlideHtml(useDeckStore.getState().slideHtml, slideId)).toContain('color: #ff000080')
  })

  it('a theme-token swatch writes a var() reference, re-themeable, one undoable command', () => {
    select()
    render(<PropertyPanel slide={currentSlide()} picker={null} />)
    // The default palette (no deck theme) offers accent; it applies to the Text target.
    fireEvent.click(screen.getByTestId('theme-color-accent'))
    const patched = getSlideHtml(useDeckStore.getState().slideHtml, slideId)!
    expect(patched).toContain('color: var(--sl-accent, #4c8dff)')
    expect(useDeckStore.getState().undo()).toBe(true)
    expect(getSlideHtml(useDeckStore.getState().slideHtml, slideId)).toBe(SOURCE)
  })

  it('the eyedropper samples via the injected picker and applies to the target', async () => {
    select()
    render(<PropertyPanel slide={currentSlide()} picker={SAMPLING_PICKER} />)
    fireEvent.click(screen.getByTestId('eyedrop-fill'))
    await waitFor(() =>
      expect(getSlideHtml(useDeckStore.getState().slideHtml, slideId)).toContain(
        'background-color: #00ff00',
      ),
    )
  })

  it('a cancelled eyedropper pick (null) writes nothing', async () => {
    select()
    render(<PropertyPanel slide={currentSlide()} picker={CANCELLING_PICKER} />)
    fireEvent.click(screen.getByTestId('eyedrop-color'))
    // Give the microtask a chance; the source must remain the seeded one.
    await Promise.resolve()
    expect(getSlideHtml(useDeckStore.getState().slideHtml, slideId)).toBe(SOURCE)
  })

  it('the eyedropper button is hidden when no picker is available (feature-detect)', () => {
    select()
    render(<PropertyPanel slide={currentSlide()} picker={null} />)
    expect(screen.queryByTestId('eyedrop-color')).toBeNull()
    // The swatches and theme row are still present without an eyedropper.
    expect(screen.getByTestId('swatch-color')).toBeTruthy()
    expect(screen.getByTestId('theme-color-accent')).toBeTruthy()
  })

  it('the stroke swatch writes border-color plus border-style for an HTML element', () => {
    select()
    render(<PropertyPanel slide={currentSlide()} picker={null} />)
    fireEvent.change(screen.getByTestId('swatch-stroke'), { target: { value: '#123456' } })
    const patched = getSlideHtml(useDeckStore.getState().slideHtml, slideId)!
    expect(patched).toContain('border-color: #123456')
    expect(patched).toContain('border-style: solid')
  })
})
