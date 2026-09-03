/**
 * @vitest-environment happy-dom
 *
 * The Present surface's behaviour: it renders the current slide through the same sandboxed frame the
 * editor uses, the presentation keys move / blank / exit, and the controls auto-hide and come back on
 * a mouse move. happy-dom measures every element 0x0 and cannot fetch a `blob:` URL, so — as in
 * `slide-frame.test.tsx` — the object-URL API is stubbed to about:blank and the assertions are about
 * DOM and props, never pixels. The scale-to-fit *math* is pinned separately in `slide-fit.test.ts`.
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PresentSurface } from '../../../src/renderer/src/features/present/PresentSurface'
import type { SlideView } from '../../../src/renderer/src/stores/deckStore'
import { createStarterSlideHtml } from '../../../src/shared/document/starter-slide'
import type { SlideId } from '../../../src/shared/document/types'

const ids = ['s_a', 's_b', 's_c'] as unknown as SlideId[]
const titles = ['Alpha', 'Beta', 'Gamma']
const slides: SlideView[] = ids.map((id, index) => ({
  id,
  title: titles[index] ?? 'x',
  html: createStarterSlideHtml({ id, title: titles[index] ?? 'x' }),
}))

beforeEach(() => {
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('about:blank')
  vi.spyOn(URL, 'revokeObjectURL').mockReturnValue(undefined)
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

function renderSurface(startIndex = 0) {
  const onExit = vi.fn()
  render(<PresentSurface slides={slides} startIndex={startIndex} onExit={onExit} />)
  return onExit
}

describe('PresentSurface rendering', () => {
  it('renders the start slide in a sandboxed frame', () => {
    renderSurface(1)
    const frame = screen.getByTitle('Presenting: Beta') as HTMLIFrameElement
    // Same delivery as the editor: url src, exactly `allow-scripts`, nothing widened.
    expect(frame.getAttribute('src')).toBe('about:blank')
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts')
    expect(screen.getByText('2 / 3')).toBeTruthy()
  })
})

describe('PresentSurface pre-warm (M8.2)', () => {
  it('keeps the outgoing slide mounted and the next one pre-warmed, so advancing never blanks', () => {
    renderSurface(0)
    const alpha = screen.getByTitle('Presenting: Alpha')
    // Only the current slide until it has loaded; then its neighbour warms behind it.
    expect(screen.queryByTitle('Preloading: Beta')).toBeNull()
    fireEvent.load(alpha)
    const beta = screen.getByTitle('Preloading: Beta')

    fireEvent.keyDown(document.body, { key: 'ArrowRight' })

    // The same two iframe elements, roles swapped — nothing navigated, nothing went blank.
    expect(screen.getByTitle('Presenting: Beta')).toBe(beta)
    expect(screen.getByTitle('Preloading: Alpha')).toBe(alpha)
  })
})

describe('PresentSurface navigation keys', () => {
  it('advances on ArrowRight / Space / PageDown and goes back on ArrowLeft', () => {
    renderSurface(0)
    expect(screen.getByTitle('Presenting: Alpha')).toBeTruthy()

    fireEvent.keyDown(document.body, { key: 'ArrowRight' })
    expect(screen.getByTitle('Presenting: Beta')).toBeTruthy()
    expect(screen.getByText('2 / 3')).toBeTruthy()

    fireEvent.keyDown(document.body, { key: ' ' })
    expect(screen.getByTitle('Presenting: Gamma')).toBeTruthy()

    fireEvent.keyDown(document.body, { key: 'ArrowLeft' })
    expect(screen.getByTitle('Presenting: Beta')).toBeTruthy()
  })

  it('clamps at the last slide (no wrap)', () => {
    renderSurface(2)
    fireEvent.keyDown(document.body, { key: 'ArrowRight' })
    expect(screen.getByTitle('Presenting: Gamma')).toBeTruthy()
    expect(screen.getByText('3 / 3')).toBeTruthy()
  })

  it('jumps to the ends with Home / End', () => {
    renderSurface(1)
    fireEvent.keyDown(document.body, { key: 'End' })
    expect(screen.getByTitle('Presenting: Gamma')).toBeTruthy()
    fireEvent.keyDown(document.body, { key: 'Home' })
    expect(screen.getByTitle('Presenting: Alpha')).toBeTruthy()
  })

  it('the on-screen chevrons advance the deck too', () => {
    renderSurface(0)
    fireEvent.click(screen.getByLabelText('Next slide'))
    expect(screen.getByTitle('Presenting: Beta')).toBeTruthy()
    fireEvent.click(screen.getByLabelText('Previous slide'))
    expect(screen.getByTitle('Presenting: Alpha')).toBeTruthy()
  })
})

describe('PresentSurface blank + exit', () => {
  it('toggles a black screen with B, leaving the slide mounted underneath', () => {
    renderSurface(0)
    expect(screen.queryByLabelText('Blanked screen')).toBeNull()

    fireEvent.keyDown(document.body, { key: 'b' })
    expect(screen.getByLabelText('Blanked screen')).toBeTruthy()
    // The slide frame is still there behind the black overlay — nothing reloaded.
    expect(screen.getByTitle('Presenting: Alpha')).toBeTruthy()

    fireEvent.keyDown(document.body, { key: 'b' })
    expect(screen.queryByLabelText('Blanked screen')).toBeNull()
  })

  it('exits on Escape', () => {
    const onExit = renderSurface(0)
    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(onExit).toHaveBeenCalledTimes(1)
  })

  it('exits from the on-screen stop button', () => {
    const onExit = renderSurface(0)
    fireEvent.click(screen.getByLabelText('Exit presentation (Esc)'))
    expect(onExit).toHaveBeenCalledTimes(1)
  })
})

describe('PresentSurface auto-hiding controls', () => {
  it('shows the controls on entry, fades them after inactivity, and restores them on mouse move', () => {
    vi.useFakeTimers()
    try {
      const onExit = vi.fn()
      render(<PresentSurface slides={slides} startIndex={0} onExit={onExit} />)
      const controls = screen.getByLabelText('Presentation controls')

      // Visible on entry.
      expect(controls.getAttribute('aria-hidden')).toBeNull()

      // Fades after the idle timeout.
      act(() => {
        vi.advanceTimersByTime(4000)
      })
      expect(controls.getAttribute('aria-hidden')).toBe('true')

      // A mouse move brings them back.
      act(() => {
        fireEvent.mouseMove(screen.getByLabelText('Presentation'))
      })
      expect(controls.getAttribute('aria-hidden')).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  // The full-bleed case: with the slide filling a 16:9 screen the mouse sits over the sandboxed
  // frame, so a keypress must be able to reveal the faded controls, not only a mouse move.
  it('re-reveals faded controls on a navigation key', () => {
    vi.useFakeTimers()
    try {
      const onExit = vi.fn()
      render(<PresentSurface slides={slides} startIndex={0} onExit={onExit} />)
      const controls = screen.getByLabelText('Presentation controls')

      act(() => {
        vi.advanceTimersByTime(4000)
      })
      expect(controls.getAttribute('aria-hidden')).toBe('true')

      act(() => {
        fireEvent.keyDown(document.body, { key: 'ArrowRight' })
      })
      expect(controls.getAttribute('aria-hidden')).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })
})
