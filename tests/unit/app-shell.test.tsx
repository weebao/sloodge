/**
 * @vitest-environment happy-dom
 */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AppShell } from '../../src/renderer/src/app/AppShell'
import { createStarterDeck, useDeckStore } from '../../src/renderer/src/state/deckStore'

const NOW = 1_770_000_000_000

beforeEach(() => {
  // The deck store is a module singleton; reset it so selection does not leak between tests.
  useDeckStore.setState(createStarterDeck(NOW))
})

afterEach(() => {
  cleanup()
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
      expect(frame.getAttribute('srcdoc')).toContain('data-sl-contract="1"')
    }
  })

  it('shows the selected slide on the canvas', () => {
    render(<AppShell />)

    const canvas = screen.getByRole('main', { name: 'Slide canvas' })
    const frame = canvas.querySelector('iframe')
    expect(frame?.getAttribute('title')).toBe('Slide: Untitled deck')
    expect(frame?.getAttribute('srcdoc')).toContain('Ask Claude to draft your first slide')
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
