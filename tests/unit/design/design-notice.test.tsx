/**
 * @vitest-environment happy-dom
 *
 * `DesignNotice` is the host a refused text edit is explained from (M3.11 round-8). It sits on the
 * canvas rather than inside `SelectionOverlay` because the two exits that most need it — turning
 * Design Mode off, and Present, which forces it off — refuse the edit while the overlay is being
 * unmounted. So the two things worth pinning down here are that it does not need Design Mode to be
 * on, and that a notice never outlives the slide it names.
 */

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DesignNotice } from '../../../src/renderer/src/features/design/DesignNotice'
import { useDesignStore } from '../../../src/renderer/src/features/design/designStore'
import { SlideCanvas } from '../../../src/renderer/src/features/canvas/SlideCanvas'
import {
  createStarterDeck,
  selectSlideViews,
  useDeckStore,
  type SlideView,
} from '../../../src/renderer/src/stores/deckStore'

/** The one-slide deck the canvas renders, hoisted so the prop is not a fresh array (react-perf). */
let slides: SlideView[] = []

beforeEach(() => {
  useDesignStore.setState({ enabled: true, notice: null })
})

afterEach(cleanup)

describe('DesignNotice', () => {
  it('shows a refusal raised on the slide it is mounted for', () => {
    useDesignStore.setState({ notice: { slideId: 'slide-1', text: 'That text is too long' } })
    render(<DesignNotice slideId="slide-1" />)

    const notice = screen.getByTestId('design-notice')
    expect(notice.getAttribute('role')).toBe('status')
    expect(notice.textContent).toContain('That text is too long')
  })

  it('shows it with Design Mode off — the state the toggle refusal lands in', () => {
    useDesignStore.setState({
      enabled: false,
      notice: { slideId: 'slide-1', text: 'That text is too long' },
    })
    render(<DesignNotice slideId="slide-1" />)

    expect(screen.getByTestId('design-notice').textContent).toContain('That text is too long')
  })

  it('drops a notice raised on another slide rather than showing it here', () => {
    useDesignStore.setState({ notice: { slideId: 'slide-1', text: 'That text is too long' } })
    render(<DesignNotice slideId="slide-2" />)

    expect(screen.queryByTestId('design-notice')).toBeNull()
    // Dropped, not merely hidden: a there-and-back must not bring it up again (round-4).
    expect(useDesignStore.getState().notice).toBeNull()
  })

  it('dismisses on the ✕', () => {
    useDesignStore.setState({ notice: { slideId: 'slide-1', text: 'That text is too long' } })
    render(<DesignNotice slideId="slide-1" />)

    fireEvent.click(screen.getByRole('button', { name: /dismiss/i }))

    expect(screen.queryByTestId('design-notice')).toBeNull()
    expect(useDesignStore.getState().notice).toBeNull()
  })
})

/**
 * A second identical refusal writes a fresh notice object, so the store notifies and React
 * re-renders — but the node must not be replaced. That is the decision, not an accident: keying it
 * so a repeat remounted would make the polite region re-read a sentence that never left the screen,
 * when the element snapping back to its stored text is already the feedback (round-9 minor).
 */
describe('DesignNotice — a repeated identical refusal', () => {
  it('keeps the same node rather than remounting it', () => {
    const notice = { slideId: 'slide-1', text: 'That text is too long' }
    useDesignStore.setState({ notice })
    render(<DesignNotice slideId="slide-1" />)
    const first = screen.getByTestId('design-notice')

    act(() => {
      useDesignStore.getState().setNotice({ ...notice })
    })

    expect(screen.getByTestId('design-notice')).toBe(first)
    expect(first.textContent).toContain('That text is too long')
  })
})

/**
 * Where the canvas puts the notice — the half of the round-8 fix no test held. Both properties here
 * have been wrong in a shipped build: the notice lived inside the Design Mode branch, so the toggle
 * and Present refused in silence (round-8 minor 1); and it was its own live region, created already
 * carrying its text, which screen readers commonly do not announce (round-9 minor 1).
 */
describe('SlideCanvas hosts the notice', () => {
  beforeEach(() => {
    // happy-dom's `createObjectURL` has no blob store behind it; the frame's URL is irrelevant here.
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('about:blank')
    vi.spyOn(URL, 'revokeObjectURL').mockReturnValue(undefined)
    useDeckStore.setState(createStarterDeck(0))
    const state = useDeckStore.getState()
    slides = [selectSlideViews(state.deck, state.slideHtml)[0]!]
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('shows a refusal with Design Mode off — where the toggle and Present leave the user', () => {
    useDesignStore.setState({
      enabled: false,
      notice: { slideId: slides[0]!.id, text: 'That text is too long' },
    })
    render(<SlideCanvas slides={slides} currentIndex={0} />)

    // The mode really is off: the overlay is gone and the canvas says so.
    expect(screen.getByTestId('canvas-live-hint')).toBeTruthy()
    expect(screen.getByTestId('design-notice').textContent).toContain('That text is too long')
  })

  it('mounts the live region before there is anything to announce, and speaks through it', () => {
    useDesignStore.setState({ enabled: true, notice: null })
    render(<SlideCanvas slides={slides} currentIndex={0} />)

    const region = screen.getByTestId('design-notice-region')
    expect(region.getAttribute('aria-live')).toBe('polite')
    expect(screen.queryByTestId('design-notice')).toBeNull()

    act(() => {
      useDesignStore.getState().setNotice({ slideId: slides[0]!.id, text: 'That text is too long' })
    })

    // Same region node throughout — the announcement is an insertion into a region that was already
    // on the page, not a region that arrived with its text already in it.
    expect(screen.getByTestId('design-notice-region')).toBe(region)
    expect(region.contains(screen.getByTestId('design-notice'))).toBe(true)
  })
})
