/**
 * @vitest-environment happy-dom
 */
import {
  act,
  cleanup,
  createEvent,
  fireEvent,
  render,
  screen,
  within,
} from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AppShell } from '../../src/renderer/src/app/AppShell'
import { useDesignStore } from '../../src/renderer/src/features/design/designStore'
import { createStarterDeck, useDeckStore } from '../../src/renderer/src/stores/deckStore'
import type { MenuAction } from '../../src/shared/ipc-contract'
import { installFakeIntersectionObserver } from './deck/fake-intersection-observer'
import type { OpenDeckPayload } from '../../src/shared/document/open'

const NOW = 1_770_000_000_000

let createObjectUrl = vi.fn<(obj: Blob | MediaSource) => string>()

beforeEach(() => {
  // The deck store is a module singleton; reset it so selection does not leak between tests.
  useDeckStore.setState(createStarterDeck(NOW))
  // So is the design store, and as of M3.11 its `enabled` default is `true` — a test that toggles
  // the switch off would otherwise leak that into every test after it.
  useDesignStore.setState({
    enabled: true,
    hover: null,
    selections: [],
    selection: null,
    editing: null,
  })
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
  vi.unstubAllGlobals()
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

  it('renders the canvas frame at once and a thumbnail frame only once the rail sees its card', () => {
    const observers = installFakeIntersectionObserver()
    const { container } = render(<AppShell />)

    // One document: the canvas. The rail's three cards are placeholders until the observer reports
    // them on screen, and the canvas's neighbours wait for the active frame to load (M8.2).
    expect(container.querySelectorAll('iframe')).toHaveLength(1)

    observers.instances[0]?.reportAll(true)

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
    expect(buttons).toHaveLength(10)
    for (const button of buttons) {
      expect(button.getAttribute('aria-disabled')).toBe('true')
    }

    // Selects are `disabled` rather than aria-disabled: an operable-looking
    // control that does nothing is worse than an obviously dead one.
    for (const select of within(toolbar).getAllByRole('combobox', { hidden: true })) {
      expect((select as HTMLSelectElement).disabled).toBe(true)
      expect(select.getAttribute('aria-disabled')).toBeNull()
    }
  })

  /**
   * M3.11. The toggle used to live inside the Formatting toolbar, and that is precisely what this
   * now forbids: the toolbar is a *tab panel* whose contents M6.1 swaps per ribbon tab (including
   * contextually, on selection), so a control there is reachable only on some tabs. Design Mode
   * decides whether clicking the canvas selects or interacts, and its keyboard fallback does not
   * work when focus is inside the slide iframe — so if the button can be hidden, the mode can become
   * impossible to leave. Asserting it is *outside* the toolbar pins that structurally, without this
   * branch needing any of M6.1's code.
   */
  it('renders the Design Mode switch in persistent chrome, never inside the toolbar tab panel', () => {
    render(<AppShell />)

    const design = screen.getByRole('switch', { name: /design mode/i })
    const toolbar = screen.getByRole('toolbar', { name: 'Formatting' })
    expect(toolbar.contains(design)).toBe(false)

    // Live, and its state is readable as text rather than only as a colour.
    expect(design.getAttribute('aria-disabled')).toBeNull()
    expect(design.getAttribute('aria-checked')).toBe('true')
    expect(design.textContent).toContain('On')

    fireEvent.click(design)
    expect(design.getAttribute('aria-checked')).toBe('false')
    expect(design.textContent).toContain('Off')
  })

  /**
   * The M3.11 headline: a fresh deck is directly manipulable. Before this, `enabled` initialized to
   * `false`, so clicking text on the canvas did nothing at all until the user found `Ctrl/⌘+D` —
   * which is exactly how the bug was reported.
   */
  it('opens with Design Mode on so a fresh deck is editable without hunting for a toggle', () => {
    render(<AppShell />)

    expect(useDesignStore.getState().enabled).toBe(true)
    expect(screen.getByRole('switch', { name: /design mode/i }).getAttribute('aria-checked')).toBe(
      'true',
    )
    // The canvas hint is the *off*-state affordance, so it must not be showing.
    expect(screen.queryByTestId('canvas-live-hint')).toBeNull()
  })

  it('names the live-slide state on the canvas when Design Mode is off', () => {
    render(<AppShell />)

    fireEvent.click(screen.getByRole('switch', { name: /design mode/i }))

    const hint = screen.getByTestId('canvas-live-hint')
    expect(hint.textContent).toMatch(/live slide/i)
    expect(hint.textContent).toMatch(/Ctrl\/⌘\+D/)
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

/**
 * Undo has exactly one owner per host, and in Electron it is the native menu — a menu item's
 * accelerator is registered with the OS, so CmdOrCtrl+Z fires the menu and may never reach the
 * page. These two tests are the pair that matters: with the bridge present the keydown path is
 * *gone* (so one keypress can never be handled twice), and the menu path works in its place.
 */
/**
 * M4.1 Present mode entry/exit at the shell: the status-bar button opens the fullscreen surface, and
 * exiting restores the Design-Mode state Present force-disabled on entry (the transparency contract
 * documented in AppShell and 10-architecture.md §8).
 */
const presentButton = (): HTMLElement =>
  within(screen.getByRole('contentinfo', { name: 'Status bar' })).getByRole('button', {
    name: /present/i,
  })

describe('AppShell present mode', () => {
  it('opens the present surface and forces Design Mode off while presenting', () => {
    render(<AppShell />)
    act(() => {
      useDesignStore.getState().setEnabled(true)
    })

    fireEvent.click(presentButton())

    expect(screen.getByRole('dialog', { name: 'Presentation' })).toBeTruthy()
    expect(useDesignStore.getState().enabled).toBe(false)
  })

  it('restores the prior Design-Mode state on exit (was on)', () => {
    render(<AppShell />)
    act(() => {
      useDesignStore.getState().setEnabled(true)
    })

    fireEvent.click(presentButton())
    fireEvent.keyDown(document.body, { key: 'Escape' })

    expect(screen.queryByRole('dialog', { name: 'Presentation' })).toBeNull()
    expect(useDesignStore.getState().enabled).toBe(true)
  })

  it('leaves Design Mode off on exit when it was off before (no surprise re-enable)', () => {
    render(<AppShell />)
    act(() => {
      useDesignStore.getState().setEnabled(false)
    })

    fireEvent.click(presentButton())
    fireEvent.keyDown(document.body, { key: 'Escape' })

    expect(useDesignStore.getState().enabled).toBe(false)
  })
})

const menuListeners = new Set<(action: MenuAction) => void>()

/**
 * Fire an `app:menu` event the way the preload would.
 *
 * `act`, because an IPC event is not a React event: without it the store updates but the render it
 * schedules has not flushed when the assertion reads the DOM.
 */
function emit(action: MenuAction): void {
  act(() => {
    for (const listener of menuListeners) listener(action)
  })
}

describe('AppShell under Electron (bridge present)', () => {
  beforeEach(() => {
    menuListeners.clear()
    window.sloodge = {
      onMenuAction: (listener) => {
        menuListeners.add(listener)
        return () => menuListeners.delete(listener)
      },
    }
  })

  afterEach(() => {
    delete window.sloodge
  })

  it('leaves the chord to the menu — the window handler is not bound at all', () => {
    render(<AppShell />)
    fireEvent.click(within(railRegion()).getByRole('button', { name: '+ New' }))

    const event = createEvent.keyDown(document.body, { key: 'z', ctrlKey: true })
    fireEvent(document.body, event)

    expect(statusText()).toContain('Slide 4 of 4')
    // Not merely ignored: nothing is listening, so the keystroke is not even consumed.
    expect(event.defaultPrevented).toBe(false)
  })

  it('undoes and redoes from the menu instead', () => {
    render(<AppShell />)
    fireEvent.click(within(railRegion()).getByRole('button', { name: '+ New' }))

    emit('edit.undo')
    expect(statusText()).toContain('Slide 3 of 3')

    emit('edit.redo')
    expect(statusText()).toContain('of 4')
  })

  /**
   * File ▸ Open's outcome lands in the status bar (M4.5, review r3: the importer's warnings and
   * conversion notes crossed IPC and were dropped). A payload that lost something shows a one-line
   * summary with the details as its tooltip; a clean one shows nothing.
   */
  function openedPayload(
    overrides: Partial<Pick<OpenDeckPayload, 'warnings' | 'import'>> = {},
  ): OpenDeckPayload {
    const snapshot = createStarterDeck(NOW)
    return {
      path: '/tmp/talk.pptx',
      fileName: 'talk.pptx',
      source: 'pptx',
      deck: { manifest: snapshot.deck, slides: snapshot.slideHtml, notes: {}, theme: null },
      warnings: [],
      ...overrides,
    }
  }

  async function openFromMenu(payload: OpenDeckPayload): Promise<void> {
    window.sloodge = {
      onMenuAction: (listener) => {
        menuListeners.add(listener)
        return () => menuListeners.delete(listener)
      },
      openDeck: async () => ({ canceled: false, ok: true, payload }),
    }
    render(<AppShell />)
    await act(async () => {
      for (const listener of menuListeners) listener('file.open')
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  }

  it('shows what a lossy import degraded, with the details as the tooltip', async () => {
    await openFromMenu(
      openedPayload({
        warnings: ['package has 600 slides; imported the first 500'],
        import: {
          slideCount: 500,
          convertedCount: 497,
          fallbackCount: 3,
          sourceSha256: 'a'.repeat(64),
          retainedBytes: 1,
          partCount: 1,
          conversionNotes: ['an image over 4194304 bytes was not inlined'],
        },
      }),
    )

    const status = screen.getByRole('status')
    expect(status.textContent).toContain(
      'Imported 500 slides · 3 as text-only · 1 warning · 1 conversion note',
    )
    expect(status.getAttribute('title')).toContain('imported the first 500')
    expect(status.getAttribute('title')).toContain('was not inlined')
    expect(screen.getByText(/talk\.pptx/)).toBeTruthy()
  })

  it('shows nothing for an import that lost nothing', async () => {
    await openFromMenu(
      openedPayload({
        import: {
          slideCount: 3,
          convertedCount: 3,
          fallbackCount: 0,
          sourceSha256: 'a'.repeat(64),
          retainedBytes: 1,
          partCount: 1,
          conversionNotes: [],
        },
      }),
    )
    expect(screen.queryByRole('status')).toBeNull()
    expect(screen.getByText(/talk\.pptx/)).toBeTruthy()
  })

  it('sends a chord typed in the composer to the field, never to the deck', () => {
    render(<AppShell />)
    fireEvent.click(within(railRegion()).getByRole('button', { name: '+ New' }))
    screen.getByPlaceholderText('Ask Claude…').focus()

    const execCommand = vi.fn(() => true)
    // happy-dom has no execCommand; the spy is the observation point either way.
    Object.defineProperty(document, 'execCommand', { value: execCommand, configurable: true })
    emit('edit.undo')

    expect(execCommand).toHaveBeenCalledWith('undo')
    expect(statusText()).toContain('Slide 4 of 4')
  })
})
