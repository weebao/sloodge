/**
 * @vitest-environment happy-dom
 *
 * M8b.3 surface 2 (ui-design-audit.md §4.1, §7 row 2): the app shell stays on the role tokens and
 * the M8b.2 primitives, and the five findings it closed — T5, U4, U10, U14, U15 — stay closed.
 *
 * Two halves, because neither can see the other's regression:
 *
 *  - **The file gate, run as a test.** `node scripts/design-inventory.mjs --check` over
 *    `AppShell.tsx`, `MenuTabStrip.tsx`, `FormatBar.tsx` and `DesignModeToggle.tsx` reds on a
 *    retired token, a `dark:` twin, a palette colour, an alpha suffix or an arbitrary value coming
 *    back. It is not spawned from here: #76 extracts one shared, list-driven spawn —
 *    `tests/unit/design/migrated-files-check.test.ts`, `it.each(MIGRATED)` — and the four files
 *    join that list when this PR rebases onto it. Until then the gate is command-run only.
 *  - **The rendered class of each finding's element — this file.** The gate cannot see a *role*
 *    token that is the wrong role. Review r1 of #75 measured two that pass `--check` AND the whole
 *    suite: the toolbar row on `bg-surface` instead of `bg-surface-raised` (the tone step that
 *    replaced the strip's `border-b` is gone, and the Home tab's `bg-surface-raised` has nothing to
 *    merge into), and the Off badge on `text-line` instead of `text-text-muted` (~1.2:1 on
 *    `surface-sunken` — an invisible label with every column still 0). So each element is rendered
 *    and its class list read — the same shape as `chat-panel-design.test.tsx` and
 *    `focus-ring.test.tsx`.
 *
 * ## What this file pins, and what it knowingly does not
 *
 * Pinned, one element each: the toolbar row's ground and hairline and the strip's ground (§4.1
 * item 3); the Home tab's text, ground, missing bottom edge and ring (T5, U10); the switch's edge
 * and ring (U4, U10); both selects' fill and edge (U4); the glyph's idle and on colour (U14, U15);
 * the badge's fill and text in both states (T7). A wrong-but-legal token on any of those reds here.
 *
 * Not caught here, by design or by limit:
 *  - the eight glyph buttons and the two worded controls carry the primitives' class strings, which
 *    are `toolbar-button` / `button` / `focus-ring` tests' business — a `ToolbarButton` swapped for a
 *    hand-rolled `<button>` with legal tokens passes this file (`semantic-contrast.test.ts`'s
 *    `<ToolbarButton` needle catches that in FormatBar.tsx; nothing here does);
 *  - hover / pressed fills (`hover:bg-hover`, `active:bg-pressed`) — owned by the primitives;
 *  - a wrong-role token on an element this file does not read: the strip's document-name caption
 *    (`text-text-muted`), the switch's `border-l border-line` divider, `dividerGap()` between the
 *    groups, the text-colour bar's `bg-accent`;
 *  - the values: happy-dom applies no stylesheet, so nothing here proves the tokens paint the ratios
 *    the audit measured — that is the census's business (`--check`, rows 2, 10, 11, 16, 18, 39, 43).
 *
 * Mutations, each run on this branch with `--check` printing `RESULT: pass` throughout: row
 * `bg-surface-raised` → `bg-surface` (1 failed | 5 passed), Off badge `text-text-muted` →
 * `text-line` (1 | 5), switch `variant="secondary"` → `"subtle"` (1 | 5), Home tab `${FOCUS_RING}`
 * deleted (1 | 5), idle glyph `text-text-muted` → `text-text` (1 | 5).
 */

import { cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AppShell } from '../../src/renderer/src/app/AppShell'
import { useDesignStore } from '../../src/renderer/src/features/design/designStore'
import { createStarterDeck, useDeckStore } from '../../src/renderer/src/stores/deckStore'

/** Written out, not imported from `focusRing.ts`: the assertion must not track the drift it guards. */
const RING = [
  'focus-visible:outline-2',
  'focus-visible:outline-focus',
  'focus-visible:outline-offset-2',
] as const

const NOW = 1_770_000_000_000

const classes = (el: Element | null | undefined): string[] => {
  expect(el, 'the element under test is mounted').toBeTruthy()
  return el!.className.split(/\s+/).filter(Boolean)
}

function mount(enabled: boolean): void {
  useDesignStore.setState({ enabled, hover: null, selections: [], selection: null, editing: null })
  render(<AppShell />)
}

const toolbar = (): HTMLElement => screen.getByRole('toolbar', { name: 'Formatting' })
const homeTab = (): HTMLElement => screen.getByRole('button', { name: 'Home' })
const designSwitch = (): HTMLElement => screen.getByRole('switch', { name: /design mode/i })
/** The glyph is the `currentColor` SVG's wrapper span — the element that carries the colour role. */
const glyph = (): Element | null => designSwitch().querySelector('svg')?.parentElement ?? null

beforeEach(() => {
  useDeckStore.setState(createStarterDeck(NOW))
  // happy-dom cannot fetch a `blob:` URL; the frames are pointed at about:blank (as in app-shell.test.tsx).
  vi.spyOn(URL, 'createObjectURL').mockImplementation(() => 'about:blank')
  vi.spyOn(URL, 'revokeObjectURL').mockReturnValue(undefined)
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  useDesignStore.setState({
    enabled: true,
    hover: null,
    selections: [],
    selection: null,
    editing: null,
  })
})

describe('M8b.3 surface 2 — the app shell on the design tokens', () => {
  it('§4.1 item 3 — the toolbar row is surface-raised on the strip’s surface, one hairline below', () => {
    mount(true)
    const row = classes(toolbar().parentElement)
    expect(
      row,
      'the row is the raised surface (§5.4 row 12; census rows 2, 16, 39, 43, 57, 62)',
    ).toContain('bg-surface-raised')
    expect(row, 'the row’s one hairline is its bottom edge against the workspace').toEqual(
      expect.arrayContaining(['border-b', 'border-line']),
    )
    const strip = classes(homeTab().parentElement)
    expect(
      strip,
      'the strip is the base surface; the 1.04 / 1.09 tone step does the separating',
    ).toContain('bg-surface')
    expect(
      strip.filter((c) => c.startsWith('border')),
      'no line between strip and row — the border-b was the finding',
    ).toEqual([])
  })

  it('T5 — the Home tab is accent text on the row’s colour with no bottom edge and the one ring', () => {
    mount(true)
    const tab = classes(homeTab())
    expect(
      tab,
      'T5: text-accent alone (4.66 dark on surface-raised); the dead dark: twin stays gone',
    ).toContain('text-accent')
    expect(tab).toEqual(expect.arrayContaining(['bg-surface-raised', 'border-b-0']))
    expect(tab, 'S2: -mb-px had nothing left to overlap').not.toContain('-mb-px')
    for (const part of RING) expect(tab, `U10: the Home tab is missing ${part}`).toContain(part)
  })

  it('U4 / U10 — the switch is a secondary Button: line-strong edge, focus-visible ring only', () => {
    mount(true)
    const klass = classes(designSwitch())
    expect(
      klass,
      'U4: a standalone control on the row has a line-strong edge (3.95 / 3.22)',
    ).toContain('border-line-strong')
    expect(
      klass,
      'secondary, not subtle: the edge is what makes it a standalone control',
    ).toContain('border')
    for (const part of RING) expect(klass, `U10: the switch is missing ${part}`).toContain(part)
    expect(
      klass.filter((c) => c.startsWith('focus:')),
      'U10: `focus:` recipes were the 2.91:1 ring; only focus-visible: survives (R6)',
    ).toEqual([])
  })

  it('U4 — the selects are fields with a strong border', () => {
    mount(true)
    for (const name of ['Font', 'Font size']) {
      const klass = classes(screen.getByRole('combobox', { name }))
      expect(klass, `${name}: bg-field`).toContain('bg-field')
      expect(klass, `${name}: border-line-strong (3.95 / 3.76 on field)`).toContain(
        'border-line-strong',
      )
    }
  })

  it('U14 — off: the idle glyph and the badge are text-muted on their grounds', () => {
    mount(false)
    expect(designSwitch().getAttribute('aria-checked')).toBe('false')
    expect(
      classes(glyph()),
      'U14: idle glyph is text-text-muted (6.41 / 5.81 on surface-raised)',
    ).toContain('text-text-muted')
    const badge = classes(within(designSwitch()).getByText('Off'))
    expect(badge, 'Off badge text is text-text-muted (5.62 / 6.77 on surface-sunken)').toContain(
      'text-text-muted',
    )
    expect(badge, 'Off badge ground is the sunken well').toContain('bg-surface-sunken')
  })

  it('U15 / T7 — on: the glyph is accent and the badge is on-fill on accent', () => {
    mount(true)
    expect(designSwitch().getAttribute('aria-checked')).toBe('true')
    expect(
      classes(glyph()),
      'U15: on-glyph is text-accent (4.66 dark on surface-raised)',
    ).toContain('text-accent')
    const badge = classes(within(designSwitch()).getByText('On'))
    expect(badge, 'T7: on-fill, never text-white, on the accent fill (5.19 / 5.83)').toEqual(
      expect.arrayContaining(['bg-accent', 'text-on-fill']),
    )
    expect(badge).not.toContain('text-white')
  })
})
