/**
 * @vitest-environment happy-dom
 *
 * M8b.3 surface 4 (ui-design-audit.md §4.8, §7 row 4): the Settings dialog and its Auth and Budget
 * tabs stay on the role tokens and the M8b.2 primitives, and the five findings the row names — T1,
 * U1, U5, U16, U17 — stay closed.
 *
 * Two halves, because neither can see the other's regression:
 *
 *  - **The file gate, run as a test** — `tests/unit/design/migrated-files-check.test.ts` spawns
 *    `node scripts/design-inventory.mjs --check` once over every migrated file, these three among
 *    them, so a retired token, a `dark:` twin, a palette colour, an alpha suffix or an arbitrary
 *    value coming back reds `pnpm test`.
 *  - **The rendered class of each finding's element.** The gate cannot see a *role* token that is
 *    the wrong role, or a primitive swapped for a hand-rolled element that spells declared tokens:
 *    `bg-surface` on a credential field instead of `bg-field` is U1 back at 1.00:1 with every column
 *    still 0; a `Notice` whose tone slips from `warning` to `info` keeps every column 0 while the
 *    warning box is no longer a warning; `<Button>` swapped for `<Button variant="subtle">` on Close
 *    is U5's control border gone. So each element is rendered and its class list read.
 *
 * **What this file pins, exactly:** the five §3.1 rows on the elements the rows name; the §4.8
 * work-list items that are observable in a class list (the `Dialog` shell and its motion classes,
 * the tab recipe, the `Button` variants including the two `primary` sites T7 guards, the
 * `text-success` Saved line, `accent-accent`, `tabular-nums`). **What it knowingly does not catch:**
 * wrong-role tokens on elements that are not a §3.1 row or a work-list item — the Model tab's
 * copy, the About tab, the `$` sign — escape both halves; and nothing here shows that the tokens
 * paint the ratios the audit measured (happy-dom applies no stylesheet; the census does that).
 *
 * Mutations, each run on this branch and recorded in the PR: swapping either `<Input>` for a raw
 * `<input>` spelling `bg-surface border-line` reds U1 while `--check` stays green; each `Notice`'s
 * tone changed (`warning` → `info` on the endpoint warning, the approaching-limit line and the
 * confirm box) reds U16 / T1 / U17; Close `<Button>` → `variant="subtle"` reds U5; Discard
 * `variant="primary"` → `"secondary"` reds the T7 pin; the selected tab's `border-accent` →
 * `border-line-strong` reds the tab case; `text-success` → `text-text-muted` and a deleted
 * `tabular-nums` red their cases; `accent-accent` → `accent-[var(--color-accent)]` reds here and
 * as `arbitrary = 1` in the gate; `shadow-overlay` → `shadow-floating` and a dropped
 * `starting:scale-98` on the primitive red the Dialog case.
 */

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AuthTab } from '../../../src/renderer/src/features/settings/AuthTab'
import { BudgetTab } from '../../../src/renderer/src/features/settings/BudgetTab'
import { SettingsDialog } from '../../../src/renderer/src/features/settings/SettingsDialog'
import { useBudgetStore } from '../../../src/renderer/src/stores/budgetStore'
import { useSessionMeterStore } from '../../../src/renderer/src/stores/sessionMeterStore'
import type { BudgetCap } from '../../../src/shared/agent/budget'
import { deriveAuthStatus, UNCONFIGURED, type AuthStatus } from '../../../src/shared/agent/auth'
import { DEFAULT_ENDPOINT } from '../../../src/shared/agent/endpoint'

const setBudgetCap = vi.fn(async (cap: BudgetCap) => cap)
const getBudgetCap = vi.fn(async (): Promise<BudgetCap> => 2)

vi.mock('../../../src/renderer/src/features/chat/agentClient', () => ({
  getAgentBridge: () => ({
    setBudgetCap: (cap: BudgetCap) => setBudgetCap(cap),
    getBudgetCap: () => getBudgetCap(),
  }),
}))

/** Written out, not imported from `focusRing.ts`: the assertion must not track the drift it guards. */
const RING = [
  'focus-visible:outline-2',
  'focus-visible:outline-focus',
  'focus-visible:outline-offset-2',
] as const

const noop = (): void => undefined
const classes = (el: Element | null | undefined): string[] =>
  (el?.className ?? '').split(/\s+/).filter(Boolean)
/** The `Notice` that carries an element: its `role` is the primitive's own attribute. */
const noticeOf = (el: Element): Element => {
  const notice = el.closest('[role="status"], [role="alert"]')
  if (notice === null) throw new Error('element is not inside a Notice')
  return notice
}

const NO_AUTH: AuthStatus = deriveAuthStatus(UNCONFIGURED, UNCONFIGURED, DEFAULT_ENDPOINT)
/** Both credentials stored — the two Remove links render. Masked suffixes only, never a key. */
const BOTH_STORED: AuthStatus = deriveAuthStatus(
  { configured: true, last4: 'test' },
  { configured: true, last4: 'test' },
  DEFAULT_ENDPOINT,
)
const PROXIED: AuthStatus = deriveAuthStatus(UNCONFIGURED, UNCONFIGURED, {
  custom: true,
  host: 'https://proxy.internal',
  transport: 'network',
})

/** Put the budget store in the state it would be in after the probe resolved. */
function loaded(cap: BudgetCap, spentUsd = 0): void {
  act(() => {
    useBudgetStore.getState().setCap(cap)
    useSessionMeterStore.getState().setCostUsd(spentUsd)
  })
}

beforeEach(() => {
  act(() => {
    useBudgetStore.getState().reset()
    useSessionMeterStore.getState().reset()
  })
  setBudgetCap.mockClear()
  getBudgetCap.mockClear()
  getBudgetCap.mockResolvedValue(2)
})

afterEach(() => {
  cleanup()
  document.getElementById('sloodge-shell')?.remove()
})

describe('M8b.3 surface 4 — the Auth tab on the design tokens', () => {
  it('U1 — both credential fields are the Input primitive: field fill, strong border, the one ring', () => {
    render(<AuthTab status={NO_AUTH} onDirtyChange={noop} />)
    for (const name of ['Claude subscription token', 'Anthropic API key']) {
      const klass = classes(screen.getByLabelText(name))
      expect(klass, `U1: ${name} is bg-field (was chrome on chrome, 1.00:1)`).toContain('bg-field')
      expect(klass, `U1: ${name} border is line-strong (3.95 / 3.76 on field)`).toContain(
        'border-line-strong',
      )
      for (const part of RING) expect(klass, `${name} is missing ${part}`).toContain(part)
      expect(
        klass.filter((c) => c.startsWith('focus:')),
        'only focus-visible: survives (R6)',
      ).toEqual([])
    }
  })

  it('U16 — the endpoint warning is the warning Notice, full-strength border, no alpha', () => {
    render(<AuthTab status={PROXIED} onDirtyChange={noop} />)
    const notice = noticeOf(screen.getByTestId('auth-endpoint-warning'))
    const klass = classes(notice)
    expect(klass, 'U16: border-warning (6.83 / 7.65) replaces amber-500/50 (1.45)').toContain(
      'border-warning',
    )
    expect(klass, 'U16: the tint is warning-soft').toContain('bg-warning-soft')
    expect(
      klass.filter((c) => c.includes('/') || c.includes('amber')),
      'U16: no alpha, no palette',
    ).toEqual([])
    expect(notice.getAttribute('role'), 'read before the next keystroke').toBe('alert')
    expect(notice.textContent, 'the tone word is the non-colour half').toMatch(/^Warning:/)
  })

  it('U5 / item 3 / item 4 — the status card is a sunken well without a border; the buttons are the variants the list names', () => {
    render(<AuthTab status={BOTH_STORED} onDirtyChange={noop} />)

    const card = screen.getByTestId('auth-status').parentElement
    const cardClass = classes(card)
    expect(cardClass, 'item 4: bg-surface-sunken').toContain('bg-surface-sunken')
    expect(cardClass, 'item 4: rounded-panel (the one 6px radius outside PPTX)').toContain(
      'rounded-panel',
    )
    expect(
      cardClass.filter((c) => c.startsWith('border')),
      'U5: the card border (chrome-line on chrome, 1.24:1) is gone, not restyled',
    ).toEqual([])

    const saveToken = classes(screen.getByRole('button', { name: 'Save token' }))
    expect(saveToken, 'item 3: Save token is primary — T7 pair').toContain('bg-accent')
    expect(saveToken, 'T7: on-fill, never white, on the accent').toContain('text-on-fill')

    const saveKey = classes(screen.getByRole('button', { name: 'Save key' }))
    expect(saveKey, 'U5: Save key is secondary — line-strong border').toContain(
      'border-line-strong',
    )
    expect(saveKey).toContain('bg-surface-raised')

    for (const name of ['Remove subscription token', 'Remove API key']) {
      const link = classes(screen.getByRole('button', { name }))
      expect(link, `item 3: ${name} is the link variant — accent, not muted grey`).toContain(
        'text-accent',
      )
      expect(link).toContain('underline')
      expect(
        link.filter((c) => c.includes('muted')),
        'no muted-grey link',
      ).toEqual([])
    }
  })
})

describe('M8b.3 surface 4 — the Budget tab on the design tokens', () => {
  it('T1 — the approaching-limit line is the warning Notice, not 12px amber text', () => {
    loaded(2, 1.7)
    render(<BudgetTab />)
    const klass = classes(noticeOf(screen.getByText(/approaching the limit/i)))
    expect(klass, 'T1: warning tone — text on warning-soft is 16.62 / 12.05').toContain(
      'bg-warning-soft',
    )
    expect(klass).toContain('border-warning')
    expect(
      klass.filter((c) => c.includes('amber')),
      'T1: amber-800 / amber-500 are gone',
    ).toEqual([])
  })

  it('U17 — the uncap confirmation is the warning Notice; Remove it is the danger Button', async () => {
    loaded(2)
    render(<BudgetTab />)
    fireEvent.click(screen.getByLabelText(/limit what one session can spend/i))
    const box = noticeOf(await screen.findByTestId('budget-confirm-uncap'))
    const klass = classes(box)
    expect(klass, 'U17: border-warning replaces amber-500/60 (1.56:1)').toContain('border-warning')
    expect(klass.filter((c) => c.includes('/') || c.includes('amber'))).toEqual([])

    const remove = classes(screen.getByRole('button', { name: /remove it/i }))
    expect(remove, 'bg-red-600 text-white → bg-danger text-on-fill (6.42)').toContain('bg-danger')
    expect(remove).toContain('text-on-fill')
    expect(classes(screen.getByRole('button', { name: /keep the limit/i }))).toContain(
      'border-line-strong',
    )
  })

  it('U2 / U4 / U5 / items 5–6 — the amount row: Input, secondary Save, accent-accent box, tabular figures', () => {
    loaded(2, 0.42)
    render(<BudgetTab />)
    const amount = classes(screen.getByLabelText('Session budget in dollars'))
    expect(amount, 'U2: bg-field (was bg-white on chrome, 1.04)').toContain('bg-field')
    expect(amount, 'U4: border-line-strong').toContain('border-line-strong')
    expect(classes(screen.getByRole('button', { name: 'Save' })), 'U5').toContain(
      'border-line-strong',
    )
    const box = classes(screen.getByLabelText(/limit what one session can spend/i))
    expect(box, 'accent-accent replaces the one arbitrary colour utility').toContain(
      'accent-accent',
    )
    expect(box.filter((c) => c.includes('['))).toEqual([])
    expect(classes(screen.getByTestId('budget-spend')), 'item 6').toContain('tabular-nums')
  })

  it('"Saved" is text-success with a check, not muted grey', async () => {
    loaded(2)
    render(<BudgetTab />)
    fireEvent.change(screen.getByLabelText('Session budget in dollars'), {
      target: { value: '7.5' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(setBudgetCap).toHaveBeenCalledWith(7.5))
    // Matched on the span's own text node — the check glyph is a child of its own.
    const saved = screen.getByText('Saved')
    const klass = classes(saved)
    expect(klass, 'C8: success, not muted').toContain('text-success')
    expect(klass.filter((c) => c.includes('muted'))).toEqual([])
    expect(
      saved.querySelector('[aria-hidden="true"]')?.textContent,
      'the check is decoration',
    ).toBe('✓')
  })

  it('the blocked and failed-save lines are the danger Notice (the alert is the role tests already read)', async () => {
    loaded(2, 2.4)
    render(<BudgetTab />)
    expect(classes(noticeOf(screen.getByTestId('budget-blocked')))).toContain('border-danger')
    fireEvent.change(screen.getByLabelText('Session budget in dollars'), {
      target: { value: '0' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    const alert = await screen.findByRole('alert')
    expect(classes(alert)).toContain('bg-danger-soft')
    expect(classes(alert).filter((c) => c.includes('red-'))).toEqual([])
  })
})

describe('M8b.3 surface 4 — the Settings dialog on the Dialog primitive', () => {
  it('item 1 — the shell is the primitive: overlay shadow, no border, scrim on z-dialog, token motion', () => {
    render(<SettingsDialog open initialTab="auth" onClose={noop} />)
    const dialog = screen.getByRole('dialog')
    const klass = classes(dialog)
    expect(klass, 'shadow-xl + border → shadow-overlay').toContain('shadow-overlay')
    expect(klass).toContain('rounded-overlay')
    expect(klass).toContain('bg-surface-raised')
    expect(
      klass.filter((c) => c.startsWith('border')),
      'no border on the panel',
    ).toEqual([])
    for (const part of [
      'transition',
      'duration-base',
      'starting:opacity-0',
      'starting:translate-y-1.5',
      'starting:scale-98',
    ]) {
      expect(klass, `panel arrival is missing ${part}`).toContain(part)
    }
    const scrim = classes(dialog.parentElement)
    expect(scrim, 'bg-black/40 → bg-scrim').toContain('bg-scrim')
    expect(scrim, 'z-50 → z-dialog').toContain('z-dialog')
    expect(scrim).toContain('transition-opacity')
    expect(scrim, 'the scrim fades at the fast step').toContain('duration-fast')
    expect(
      [...klass, ...scrim].filter((c) => /^(?:duration|ease)-\[|^duration-\d/.test(c)),
      'durations are tokens, never hand-typed',
    ).toEqual([])
  })

  it('item 2 — the tab strip: text-ui, accent underline when selected, muted → text on hover, the ring', () => {
    render(<SettingsDialog open initialTab="auth" onClose={noop} />)
    const tabs = screen.getAllByRole('tab')
    const selected = tabs.find((t) => t.getAttribute('aria-selected') === 'true')!
    const idle = tabs.find((t) => t.getAttribute('aria-selected') === 'false')!
    const on = classes(selected)
    expect(on).toContain('border-accent')
    expect(on).toContain('text-text')
    const off = classes(idle)
    expect(off).toContain('text-text-muted')
    expect(off).toContain('hover:text-text')
    expect(off).toContain('border-transparent')
    for (const tab of [on, off]) {
      expect(tab).toContain('text-ui')
      expect(tab, 'rounded-t → rounded-t-control').toContain('rounded-t-control')
      for (const part of RING) expect(tab, `tab is missing ${part}`).toContain(part)
      expect(tab.filter((c) => c.includes('['))).toEqual([])
    }
  })

  it('item 3 — Close is secondary (U5), Keep editing is subtle, Discard is primary (T7)', () => {
    render(<SettingsDialog open initialTab="auth" onClose={noop} />)
    const close = classes(screen.getByRole('button', { name: 'Close' }))
    expect(close, 'U5: chrome-line border (1.24:1) → line-strong').toContain('border-line-strong')

    fireEvent.change(screen.getByLabelText('Claude subscription token'), {
      target: { value: 'sk-ant-test' },
    })
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    const discard = classes(screen.getByRole('button', { name: 'Discard' }))
    expect(discard, 'T7: the primary pair').toContain('bg-accent')
    expect(discard).toContain('text-on-fill')
    const keep = classes(screen.getByRole('button', { name: 'Keep editing' }))
    expect(keep, 'a bare text button with no hover → subtle').toContain('hover:bg-hover')
    expect(
      keep.filter((c) => c.startsWith('border')),
      'subtle has no edge at rest',
    ).toEqual([])
    expect(
      keep.filter((c) => c.includes('muted')),
      'not muted grey',
    ).toEqual([])
  })
})
