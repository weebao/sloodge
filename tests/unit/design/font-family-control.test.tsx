/** @vitest-environment happy-dom */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  FontFamilyControl,
  buildFontRows,
  scrollTopFor,
  visibleRange,
} from '../../../src/renderer/src/features/design/FontFamilyControl'
import { SYSTEM_FONT_GROUP } from '../../../src/shared/fonts/family'
import type { SystemFontsResponse } from '../../../src/shared/ipc-contract'

afterEach(cleanup)

/**
 * Deliberately short: the System group is 1 header + 7 faces, so only three installed faces fit
 * inside the initial 12-row window. A longer fixture would have the windowing hide the very rows
 * these tests assert on — correct behaviour, confusing failure. The large-collection fixtures live
 * in the windowing tests, where being windowed out is the point.
 */
const INSTALLED = ['Bodoni MT', 'Papyrus', 'Verdana']

function loaderFor(families: readonly string[]): () => Promise<SystemFontsResponse> {
  return async () => ({ families, source: 'powershell' })
}

/** A machine whose fonts could not be enumerated. Module-scoped so the prop stays stable. */
const LOAD_NOTHING = async (): Promise<SystemFontsResponse> => ({ families: [], source: 'none' })

/**
 * A loader whose promise the test resolves by hand, so it can act while enumeration is still in
 * flight. Module-scoped so the JSX prop is a stable reference (react-perf); the test swaps the
 * promise, not the function.
 */
let deferredFonts: Promise<SystemFontsResponse> = Promise.resolve({ families: [], source: 'none' })
const LOAD_DEFERRED = (): Promise<SystemFontsResponse> => deferredFonts

/**
 * Open the popover and wait for the *installed* list to have arrived. Waiting on the listbox alone
 * would race: it renders with the System group before the loader resolves, and the arrival of the
 * fonts resets the cursor — so a keystroke sent in that window is silently undone.
 */
async function open(
  current: string | null,
  onPick: (name: string) => void,
  families: readonly string[] = INSTALLED,
  settled = 'font-option-Bodoni MT',
): Promise<void> {
  render(<FontFamilyControl current={current} onPick={onPick} loadFonts={loaderFor(families)} />)
  fireEvent.click(screen.getByTestId('prop-fontFamily'))
  await waitFor(() => {
    expect(screen.getByTestId(settled)).toBeTruthy()
  })
}

describe('FontFamilyControl — pure windowing helpers', () => {
  it('groups the system faces first, then the installed ones', () => {
    const rows = buildFontRows(['Papyrus'], '')
    expect(rows[0]).toEqual({ kind: 'header', key: 'h:system', label: 'System' })
    const headers = rows.filter((row) => row.kind === 'header').map((row) => row.label)
    expect(headers).toEqual(['System', 'Installed'])
    const systemIndex = rows.findIndex((row) => row.kind === 'font' && row.name === 'Segoe UI')
    const installedIndex = rows.findIndex((row) => row.kind === 'font' && row.name === 'Papyrus')
    expect(systemIndex).toBeLessThan(installedIndex)
  })

  it('does not list a face twice when the machine also has a system face installed', () => {
    const rows = buildFontRows(['Arial', 'Papyrus'], '')
    const arials = rows.filter((row) => row.kind === 'font' && row.name === 'Arial')
    expect(arials).toHaveLength(1)
  })

  it('filters case-insensitively on a substring, across both groups', () => {
    const names = buildFontRows(INSTALLED, 'ver')
      .filter((row) => row.kind === 'font')
      .map((row) => (row.kind === 'font' ? row.name : ''))
    expect(names).toEqual(['Verdana'])
    expect(buildFontRows(INSTALLED, 'geo').map((row) => row.kind)).toContain('font')
  })

  it('drops a group header entirely when nothing in it matches', () => {
    const rows = buildFontRows(['Papyrus'], 'papy')
    expect(rows.filter((row) => row.kind === 'header').map((row) => row.label)).toEqual([
      'Installed',
    ])
  })

  it('windows the list so a huge collection never mounts in full', () => {
    const { start, end } = visibleRange(800, 0)
    expect(start).toBe(0)
    expect(end).toBe(12)
    expect(visibleRange(800, 28 * 100)).toEqual({ start: 96, end: 112 })
  })

  it('clamps the window to the ends of the list', () => {
    expect(visibleRange(5, 0)).toEqual({ start: 0, end: 5 })
    expect(visibleRange(0, 0)).toEqual({ start: 0, end: 0 })
  })

  it('scrolls only as far as it must to reveal a row', () => {
    expect(scrollTopFor(0, 0)).toBe(0)
    // Row 3 is already inside the 8-row viewport, so nothing moves.
    expect(scrollTopFor(3, 0)).toBe(0)
    // Row 8 is one past the bottom edge: scroll by exactly one row.
    expect(scrollTopFor(8, 0)).toBe(28)
    // Scrolling back up to a row above the viewport aligns it to the top.
    expect(scrollTopFor(2, 200)).toBe(56)
  })
})

describe('FontFamilyControl — ARIA', () => {
  it('exposes the trigger as a collapsed listbox opener', () => {
    render(<FontFamilyControl current={null} onPick={vi.fn()} loadFonts={loaderFor([])} />)
    const trigger = screen.getByTestId('prop-fontFamily')
    expect(trigger.getAttribute('aria-haspopup')).toBe('listbox')
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    expect(trigger.getAttribute('aria-label')).toBe('Font family')
  })

  it('marks the trigger expanded once the popover is open', async () => {
    await open(null, vi.fn())
    expect(screen.getByTestId('prop-fontFamily').getAttribute('aria-expanded')).toBe('true')
  })

  it('gives the filter input combobox semantics wired to the listbox', async () => {
    await open(null, vi.fn())
    const input = screen.getByTestId('font-filter')
    const list = screen.getByTestId('font-listbox')
    expect(input.getAttribute('role')).toBe('combobox')
    expect(input.getAttribute('aria-autocomplete')).toBe('list')
    expect(input.getAttribute('aria-controls')).toBe(list.getAttribute('id'))
    expect(list.getAttribute('role')).toBe('listbox')
  })

  it('points aria-activedescendant at a real option element', async () => {
    await open(null, vi.fn())
    const active = screen.getByTestId('font-filter').getAttribute('aria-activedescendant')
    expect(active).toBeTruthy()
    const element = document.getElementById(active!)
    expect(element?.getAttribute('role')).toBe('option')
  })

  it('marks the current family as the selected option', async () => {
    await open('Papyrus, Segoe UI, system-ui, sans-serif', vi.fn())
    expect(screen.getByTestId('font-option-Papyrus').getAttribute('aria-selected')).toBe('true')
    expect(screen.getByTestId('font-option-Verdana').getAttribute('aria-selected')).toBe('false')
  })

  it('opens with the cursor on the current family, so Enter is not a surprise', async () => {
    await open('Papyrus, Segoe UI, system-ui, sans-serif', vi.fn())
    // `waitFor`, not a single read: the cursor lands on the current face only once the enumerated
    // list has arrived and the effect that re-homes it has run.
    await waitFor(() => {
      const active = screen.getByTestId('font-filter').getAttribute('aria-activedescendant')
      expect(document.getElementById(active!)?.getAttribute('data-testid')).toBe(
        'font-option-Papyrus',
      )
    })
  })
})

describe('FontFamilyControl — keyboard', () => {
  it('opens from the trigger with ArrowDown', async () => {
    render(<FontFamilyControl current={null} onPick={vi.fn()} loadFonts={loaderFor(INSTALLED)} />)
    fireEvent.keyDown(screen.getByTestId('prop-fontFamily'), { key: 'ArrowDown' })
    await waitFor(() => {
      expect(screen.getByTestId('font-listbox')).toBeTruthy()
    })
  })

  it('moves the cursor with the arrow keys and skips group headers', async () => {
    await open(null, vi.fn())
    const input = screen.getByTestId('font-filter')
    const activeName = (): string | null | undefined =>
      document
        .getElementById(input.getAttribute('aria-activedescendant')!)
        ?.getAttribute('data-testid')

    await waitFor(() => {
      expect(activeName()).toBe(`font-option-${SYSTEM_FONT_GROUP[0]!.name}`)
    })
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    expect(activeName()).toBe(`font-option-${SYSTEM_FONT_GROUP[1]!.name}`)
    fireEvent.keyDown(input, { key: 'ArrowUp' })
    expect(activeName()).toBe(`font-option-${SYSTEM_FONT_GROUP[0]!.name}`)

    // Walk off the end of the System group; the next stop must be a font, never the header row.
    for (let i = 0; i < SYSTEM_FONT_GROUP.length; i += 1) {
      fireEvent.keyDown(input, { key: 'ArrowDown' })
    }
    const landed = document.getElementById(input.getAttribute('aria-activedescendant')!)
    expect(landed?.getAttribute('role')).toBe('option')
  })

  it('does not run off either end of the list', async () => {
    await open(null, vi.fn())
    const input = screen.getByTestId('font-filter')
    for (let i = 0; i < 5; i += 1) fireEvent.keyDown(input, { key: 'ArrowUp' })
    const first = input.getAttribute('aria-activedescendant')
    expect(document.getElementById(first!)?.getAttribute('data-testid')).toBe(
      `font-option-${SYSTEM_FONT_GROUP[0]!.name}`,
    )
    for (let i = 0; i < 200; i += 1) fireEvent.keyDown(input, { key: 'ArrowDown' })
    const last = document.getElementById(input.getAttribute('aria-activedescendant')!)
    expect(last?.getAttribute('role')).toBe('option')
  })

  it('picks the active family on Enter and closes', async () => {
    const onPick = vi.fn()
    await open(null, onPick)
    const input = screen.getByTestId('font-filter')
    await waitFor(() => {
      expect(input.getAttribute('aria-activedescendant')).toBeTruthy()
    })
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onPick).toHaveBeenCalledTimes(1)
    expect(onPick).toHaveBeenCalledWith(SYSTEM_FONT_GROUP[1]!.name)
    expect(screen.queryByTestId('font-listbox')).toBeNull()
  })

  it('does not lose an arrow-key move when the font list arrives mid-gesture', async () => {
    // Enumeration is a subprocess spawn, so it lands well after the popover opens — and lands later
    // on a slower machine. If its arrival re-homed the cursor, the user's keystroke would silently
    // vanish, and only sometimes.
    let release!: (value: SystemFontsResponse) => void
    deferredFonts = new Promise<SystemFontsResponse>((resolve) => {
      release = resolve
    })
    const onPick = vi.fn()
    render(<FontFamilyControl current={null} onPick={onPick} loadFonts={LOAD_DEFERRED} />)
    fireEvent.click(screen.getByTestId('prop-fontFamily'))

    const input = await screen.findByTestId('font-filter')
    await waitFor(() => {
      expect(input.getAttribute('aria-activedescendant')).toBeTruthy()
    })
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    const moved = input.getAttribute('aria-activedescendant')
    expect(document.getElementById(moved!)?.textContent).toBe(SYSTEM_FONT_GROUP[1]!.name)

    release({ families: INSTALLED, source: 'powershell' })
    await waitFor(() => {
      expect(screen.getByTestId('font-option-Bodoni MT')).toBeTruthy()
    })

    const after = input.getAttribute('aria-activedescendant')
    expect(document.getElementById(after!)?.textContent).toBe(SYSTEM_FONT_GROUP[1]!.name)
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onPick).toHaveBeenCalledWith(SYSTEM_FONT_GROUP[1]!.name)
  })

  it('closes on Escape without picking anything', async () => {
    const onPick = vi.fn()
    await open(null, onPick)
    fireEvent.keyDown(screen.getByTestId('font-filter'), { key: 'Escape' })
    expect(screen.queryByTestId('font-listbox')).toBeNull()
    expect(onPick).not.toHaveBeenCalled()
  })

  it('type-to-filter narrows the list and lands the cursor on a match', async () => {
    const onPick = vi.fn()
    await open(null, onPick)
    const input = screen.getByTestId('font-filter')
    fireEvent.change(input, { target: { value: 'papyr' } })
    await waitFor(() => {
      expect(screen.getByTestId('font-option-Papyrus')).toBeTruthy()
    })
    expect(screen.queryByTestId('font-option-Verdana')).toBeNull()
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onPick).toHaveBeenCalledWith('Papyrus')
  })

  it('shows an empty state when nothing matches', async () => {
    await open(null, vi.fn())
    fireEvent.change(screen.getByTestId('font-filter'), { target: { value: 'zzzznope' } })
    await waitFor(() => {
      expect(screen.getByTestId('font-empty')).toBeTruthy()
    })
    expect(screen.queryAllByRole('option')).toHaveLength(0)
  })
})

describe('FontFamilyControl — face previews and windowing', () => {
  it('previews each row in its own face, using the value that would be written', async () => {
    await open(null, vi.fn())
    // Asserted through `style.fontFamily` rather than the raw attribute: the DOM re-serialises a
    // font stack (moving the quotes onto the multi-word names), so a string match on the attribute
    // would be testing happy-dom's serialiser, not this component.
    const papyrus = (screen.getByTestId('font-option-Papyrus') as HTMLElement).style.fontFamily
    expect(papyrus).toContain('Papyrus')
    expect(papyrus).toContain('sans-serif')

    const georgia = (screen.getByTestId('font-option-Georgia') as HTMLElement).style.fontFamily
    expect(georgia).toContain('Georgia')
    expect(georgia).toContain('serif')
    // The serif branch really drops the sans-serif fallbacks, rather than merely ending in `serif`.
    expect(georgia).not.toContain('Segoe')
  })

  it('mounts only a small window of faces for a large collection', async () => {
    const many = Array.from({ length: 800 }, (_, i) => `Face ${String(i).padStart(3, '0')}`)
    await open(null, vi.fn(), many, 'font-option-Face 000')
    const options = screen.queryAllByRole('option')
    // 8 visible rows plus 4 rows of overscan either side — never 800.
    expect(options.length).toBeGreaterThan(0)
    expect(options.length).toBeLessThanOrEqual(16)
  })

  it('mounts a different window after scrolling', async () => {
    const many = Array.from({ length: 800 }, (_, i) => `Face ${String(i).padStart(3, '0')}`)
    await open(null, vi.fn(), many, 'font-option-Face 000')
    expect(screen.queryByTestId('font-option-Face 400')).toBeNull()

    const list = screen.getByTestId('font-listbox')
    // happy-dom does not lay the list out, so `scrollTop` has to be planted before the event; the
    // component reads it off `currentTarget` exactly as it would in a browser.
    Object.defineProperty(list, 'scrollTop', {
      value: 28 * 407,
      writable: true,
      configurable: true,
    })
    // Asserted synchronously, not through `waitFor`: `fireEvent.scroll` is wrapped in `act`, so
    // the re-render has already flushed by the time it returns. A poll loop here adds nothing but a
    // window for another test's timers to interleave — which is how this test red once in a full
    // `test:win-paths` run and then passed 3/3 in isolation.
    fireEvent.scroll(list)

    expect(screen.getByTestId('font-option-Face 400')).toBeTruthy()
    expect(screen.queryByTestId('font-option-Face 000')).toBeNull()
  })
})

describe('FontFamilyControl — export-fidelity warning', () => {
  it('warns for a face that will not travel', () => {
    render(
      <FontFamilyControl
        current="Papyrus, Segoe UI, system-ui, sans-serif"
        onPick={vi.fn()}
        loadFonts={loaderFor(INSTALLED)}
      />,
    )
    const note = screen.getByTestId('font-export-warning')
    expect(note.getAttribute('role')).toBe('status')
    expect(note.textContent).toContain("Won't travel")
    expect(note.textContent).toContain('PPTX')
  })

  it('stays hidden for a system face and for no declaration at all', () => {
    const { rerender } = render(
      <FontFamilyControl
        current="Georgia, serif"
        onPick={vi.fn()}
        loadFonts={loaderFor(INSTALLED)}
      />,
    )
    expect(screen.queryByTestId('font-export-warning')).toBeNull()

    rerender(<FontFamilyControl current={null} onPick={vi.fn()} loadFonts={loaderFor(INSTALLED)} />)
    expect(screen.queryByTestId('font-export-warning')).toBeNull()
  })

  it('stays hidden for a face outside the dropdown group that still travels', () => {
    // Verdana is not in `SYSTEM_FONT_GROUP` but the PPTX pass scores it as safe. Warning on it would
    // contradict the export report.
    render(
      <FontFamilyControl
        current="Verdana, Segoe UI, system-ui, sans-serif"
        onPick={vi.fn()}
        loadFonts={loaderFor(INSTALLED)}
      />,
    )
    expect(screen.queryByTestId('font-export-warning')).toBeNull()
  })
})

describe('FontFamilyControl — enumeration seam', () => {
  it('does not enumerate until the dropdown is opened', async () => {
    const loadFonts = vi.fn(loaderFor(INSTALLED))
    render(<FontFamilyControl current={null} onPick={vi.fn()} loadFonts={loadFonts} />)
    expect(loadFonts).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTestId('prop-fontFamily'))
    await waitFor(() => {
      expect(loadFonts).toHaveBeenCalledTimes(1)
    })
  })

  it('offers the system group even when the machine cannot be enumerated', async () => {
    render(<FontFamilyControl current={null} onPick={vi.fn()} loadFonts={LOAD_NOTHING} />)
    fireEvent.click(screen.getByTestId('prop-fontFamily'))
    await waitFor(() => {
      expect(screen.getByTestId('font-unavailable')).toBeTruthy()
    })
    expect(screen.getByTestId('font-option-Arial')).toBeTruthy()
  })
})

/**
 * A restore flag nobody has set. Module-scoped so the JSX prop is a stable reference (react-perf).
 */
const UNSET_FOCUS_FLAG = { current: false }

describe('FontFamilyControl — focus', () => {
  it('returns focus to the trigger on Escape', async () => {
    await open(null, vi.fn())
    expect(document.activeElement).toBe(screen.getByTestId('font-filter'))

    fireEvent.keyDown(screen.getByTestId('font-filter'), { key: 'Escape' })

    expect(screen.queryByTestId('font-listbox')).toBeNull()
    expect(document.activeElement).toBe(screen.getByTestId('prop-fontFamily'))
  })

  it('returns focus to the trigger after a pick', async () => {
    await open(null, vi.fn())

    fireEvent.click(screen.getByTestId('font-option-Papyrus'))

    expect(document.activeElement).toBe(screen.getByTestId('prop-fontFamily'))
  })

  it('does not steal focus on a mount that follows no pick', () => {
    // The focus-restore flag is consumed by the commit after a pick and by no later one; a panel
    // that merely remounts (a different element selected, say) must leave focus where it is.
    render(<FontFamilyControl current={null} onPick={vi.fn()} focusOnRemount={UNSET_FOCUS_FLAG} />)

    expect(document.activeElement).toBe(document.body)
  })
})

/** The face the cursor is on, read the way the ARIA does: the row marked active. */
function activeOption(): string | null {
  return document.querySelector('[data-active="true"]')?.textContent ?? null
}

describe('FontFamilyControl — paging and focus containment', () => {
  const MANY = Array.from({ length: 800 }, (_, i) => `Face ${String(i).padStart(3, '0')}`)

  it('closes when focus leaves the popover, so Tab cannot orphan it', async () => {
    await open(null, vi.fn())
    const outside = document.createElement('button')
    document.body.append(outside)

    fireEvent.focusOut(screen.getByTestId('font-filter'), { relatedTarget: outside })

    expect(screen.queryByTestId('font-listbox')).toBeNull()
    outside.remove()
  })

  it('stays open when focus goes nowhere, which is what a mousedown on a row reports', () => {
    // Closing on a null `relatedTarget` would cancel the very click that is about to pick a face.
    render(<FontFamilyControl current={null} onPick={vi.fn()} loadFonts={loaderFor(INSTALLED)} />)
    fireEvent.click(screen.getByTestId('prop-fontFamily'))

    fireEvent.focusOut(screen.getByTestId('font-filter'), { relatedTarget: null })

    expect(screen.getByTestId('font-listbox')).toBeTruthy()
  })

  it('Home and End move the cursor to the first and last face', async () => {
    await open(null, vi.fn(), MANY, 'font-option-Face 000')
    const filter = screen.getByTestId('font-filter')

    fireEvent.keyDown(filter, { key: 'End' })
    expect(activeOption()).toBe('Face 799')

    fireEvent.keyDown(filter, { key: 'Home' })
    expect(activeOption()).toBe(SYSTEM_FONT_GROUP[0]!.name)
  })

  it('PageDown and PageUp move by a viewport of selectable rows, skipping the group header', async () => {
    await open(null, vi.fn(), MANY, 'font-option-Face 000')
    const filter = screen.getByTestId('font-filter')

    fireEvent.keyDown(filter, { key: 'Home' })
    // Seven system faces, then the "Installed" header (which consumes no step), then the list.
    fireEvent.keyDown(filter, { key: 'PageDown' })
    expect(activeOption()).toBe('Face 001')

    fireEvent.keyDown(filter, { key: 'PageUp' })
    expect(activeOption()).toBe(SYSTEM_FONT_GROUP[0]!.name)
  })
})

describe('FontFamilyControl — empty state', () => {
  it('says why a face the machine has may not be listed', async () => {
    await open(null, vi.fn())

    fireEvent.change(screen.getByTestId('font-filter'), { target: { value: 'Akbar' } })

    const empty = screen.getByTestId('font-empty')
    expect(empty.textContent).toContain('No matching fonts.')
    // The allow-list drops 8% of one real machine's faces; without this the user cannot tell a
    // filtered-out font from a typo.
    expect(empty.textContent).toContain('unusual characters')
  })

  it('does not blame the allow-list on a machine whose fonts could not be enumerated', async () => {
    render(<FontFamilyControl current={null} onPick={vi.fn()} loadFonts={LOAD_NOTHING} />)
    fireEvent.click(screen.getByTestId('prop-fontFamily'))
    await waitFor(() => {
      expect(screen.getByTestId('font-unavailable')).toBeTruthy()
    })

    fireEvent.change(screen.getByTestId('font-filter'), { target: { value: 'Akbar' } })

    expect(screen.getByTestId('font-empty').textContent).not.toContain('unusual characters')
  })
})
