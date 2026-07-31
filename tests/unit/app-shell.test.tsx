/**
 * @vitest-environment happy-dom
 */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AppShell } from '../../src/renderer/src/app/AppShell'
import { createStarterDeck, useDeckStore } from '../../src/renderer/src/stores/deckStore'

const NOW = 1_770_000_000_000

let createObjectUrl = vi.fn<(obj: Blob | MediaSource) => string>()

beforeEach(() => {
  // The deck store is a module singleton; reset it so selection does not leak between tests.
  useDeckStore.setState(createStarterDeck(NOW))
  // happy-dom cannot fetch a `blob:` URL, so the frames are pointed at about:blank. The spy is
  // still the real production path — AppShell has no seam of its own — so what it records is
  // genuine evidence about what the shell delivers to its frames.
  createObjectUrl = vi.fn<(obj: Blob | MediaSource) => string>(() => 'about:blank')
  vi.spyOn(URL, 'createObjectURL').mockImplementation(createObjectUrl)
  vi.spyOn(URL, 'revokeObjectURL').mockReturnValue(undefined)
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('AppShell', () => {
  it('renders every shell region', () => {
    render(<AppShell />)

    expect(screen.getByRole('button', { name: 'Home' })).toBeTruthy()
    expect(screen.getByRole('toolbar', { name: 'Formatting' })).toBeTruthy()
    expect(screen.getByRole('navigation', { name: 'Slides' })).toBeTruthy()
    expect(screen.getByRole('main', { name: 'Slide canvas' })).toBeTruthy()
    expect(screen.getByRole('complementary', { name: 'Chat' })).toBeTruthy()
    expect(screen.getByRole('contentinfo', { name: 'Status bar' })).toBeTruthy()
  })

  it('shows the boot deck, chat composer and status bar values', () => {
    render(<AppShell />)

    const rail = screen.getByRole('navigation', { name: 'Slides' })
    // 3 boot slides + the "New" button.
    expect(within(rail).getAllByRole('button')).toHaveLength(4)
    expect(within(rail).getByRole('button', { name: '+ New' })).toBeTruthy()

    expect(screen.getByPlaceholderText('Ask Claude…')).toBeTruthy()
    expect(screen.getByRole('button', { name: /send/i })).toBeTruthy()

    const status = screen.getByRole('contentinfo', { name: 'Status bar' })
    expect(status.textContent).toContain('Slide 1 of 3')
    expect(status.textContent).toContain('theme: Ocean')
    expect(status.textContent).toContain('0 issues')
    expect(status.textContent).toContain('$0.00')
    expect(within(status).getByRole('button', { name: /present/i })).toBeTruthy()
  })

  it('renders one live sandboxed frame per slide, plus the canvas', () => {
    const { container } = render(<AppShell />)

    const frames = [...container.querySelectorAll('iframe')]
    // Three rail thumbnails + the canvas, all showing the same documents.
    expect(frames).toHaveLength(4)
    for (const frame of frames) {
      expect(frame.getAttribute('sandbox')).toBe('allow-scripts')
      // Blob delivery, never srcdoc — the frames are fed by `src` alone.
      expect(frame.getAttribute('srcdoc')).toBeNull()
      expect(frame.getAttribute('src')).toBeTruthy()
    }

    // Four documents, each delivered through the object-URL API as a text/html blob.
    expect(createObjectUrl).toHaveBeenCalledTimes(4)
    for (const [source] of createObjectUrl.mock.calls) {
      // The DOM signature admits MediaSource; a slide is always a Blob.
      expect(source).toBeInstanceOf(Blob)
      const blob = source as Blob
      expect(blob.type).toBe('text/html')
      expect(blob.size).toBeGreaterThan(0)
    }
  })

  it('shows the selected slide on the canvas', () => {
    render(<AppShell />)

    const canvas = screen.getByRole('main', { name: 'Slide canvas' })
    expect(canvas.querySelector('iframe')?.getAttribute('title')).toBe('Slide: Untitled deck')
  })

  it('moves the canvas and status bar when a thumbnail is clicked', () => {
    render(<AppShell />)

    const rail = screen.getByRole('navigation', { name: 'Slides' })
    fireEvent.click(within(rail).getByRole('button', { name: /Slide 3 thumbnail/ }))

    const canvas = screen.getByRole('main', { name: 'Slide canvas' })
    expect(canvas.querySelector('iframe')?.getAttribute('title')).toBe('Slide: Third slide')
    expect(screen.getByRole('contentinfo', { name: 'Status bar' }).textContent).toContain(
      'Slide 3 of 3',
    )
  })

  it('marks exactly one thumbnail current', () => {
    render(<AppShell />)

    const rail = screen.getByRole('navigation', { name: 'Slides' })
    fireEvent.click(within(rail).getByRole('button', { name: /Slide 2 thumbnail/ }))

    const current = within(rail)
      .getAllByRole('button')
      .filter((button) => button.getAttribute('aria-current') === 'true')
    expect(current).toHaveLength(1)
    expect(current[0]?.textContent).toContain('Second slide')
  })

  it('keeps every formatting control inert', () => {
    render(<AppShell />)

    const toolbar = screen.getByRole('toolbar', { name: 'Formatting' })
    const buttons = within(toolbar).getAllByRole('button')
    expect(buttons).toHaveLength(11)
    for (const button of buttons) {
      expect(button.getAttribute('aria-disabled')).toBe('true')
    }

    // Selects are `disabled` rather than aria-disabled: an operable-looking
    // control that does nothing is worse than an obviously dead one.
    for (const select of within(toolbar).getAllByRole('combobox', { hidden: true })) {
      expect((select as HTMLSelectElement).disabled).toBe(true)
      expect(select.getAttribute('aria-disabled')).toBeNull()
    }

    expect(within(toolbar).getByRole('button', { name: /design mode/i })).toBeTruthy()
  })
})

const railRegion = (): HTMLElement => screen.getByRole('navigation', { name: 'Slides' })
const statusText = (): string =>
  screen.getByRole('contentinfo', { name: 'Status bar' }).textContent ?? ''

/**
 * M1.4 end to end: the rail's gestures reach the store's command layer and come back out as a
 * changed canvas, rail and status bar — and the undo chord is bound at the shell, where the focus
 * guard has to survive contact with a real text field (the chat composer).
 */
describe('AppShell slide CRUD', () => {
  it('appends and selects a slide from [+ New]', () => {
    render(<AppShell />)

    fireEvent.click(within(railRegion()).getByRole('button', { name: '+ New' }))

    expect(statusText()).toContain('Slide 4 of 4')
    expect(useDeckStore.getState().deck.slideOrder).toHaveLength(4)
  })

  it('duplicates and deletes through the context menu', () => {
    render(<AppShell />)

    fireEvent.contextMenu(within(railRegion()).getByRole('button', { name: /Slide 2 thumbnail/ }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Duplicate' }))
    expect(statusText()).toContain('Slide 3 of 4')

    fireEvent.contextMenu(within(railRegion()).getByRole('button', { name: /Slide 3 thumbnail/ }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }))
    expect(statusText()).toContain('Slide 3 of 3')
  })

  it('undoes and redoes with the keyboard', () => {
    render(<AppShell />)

    fireEvent.click(within(railRegion()).getByRole('button', { name: '+ New' }))
    expect(statusText()).toContain('of 4')

    fireEvent.keyDown(document.body, { key: 'z', ctrlKey: true })
    expect(statusText()).toContain('Slide 3 of 3')

    // Redo brings the fourth slide back. The selection stays on the slide the user is looking at,
    // which survived the round trip — see `reselect` in the store.
    fireEvent.keyDown(document.body, { key: 'y', ctrlKey: true })
    expect(statusText()).toContain('Slide 3 of 4')
  })

  it('does not rewind the deck when the chord is typed in the chat composer', () => {
    render(<AppShell />)

    fireEvent.click(within(railRegion()).getByRole('button', { name: '+ New' }))
    fireEvent.keyDown(screen.getByPlaceholderText('Ask Claude…'), { key: 'z', ctrlKey: true })

    expect(statusText()).toContain('Slide 4 of 4')
  })
})
