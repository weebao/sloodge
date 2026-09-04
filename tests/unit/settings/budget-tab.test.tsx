/**
 * @vitest-environment happy-dom
 *
 * Settings ▸ Budget (M2.5) — the tab M2.7 left as a placeholder. The parsing rules are proven in
 * `agent/budget.test.ts`; this covers the form: what it shows, what it persists, and that it cannot
 * leave the user in a state where the limit is "on" but capping nothing.
 */

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BudgetTab } from '../../../src/renderer/src/features/settings/BudgetTab'
import { useBudgetStore } from '../../../src/renderer/src/stores/budgetStore'
import { useSessionMeterStore } from '../../../src/renderer/src/stores/sessionMeterStore'
import type { BudgetCap } from '../../../src/shared/agent/budget'

const setBudgetCap = vi.fn(async (cap: BudgetCap) => cap)

const getBudgetCap = vi.fn(async (): Promise<BudgetCap> => 2)

vi.mock('../../../src/renderer/src/features/chat/agentClient', () => ({
  getAgentBridge: () => ({
    setBudgetCap: (cap: BudgetCap) => setBudgetCap(cap),
    getBudgetCap: () => getBudgetCap(),
  }),
}))

const reset = (): void => {
  act(() => {
    useBudgetStore.getState().reset()
    useSessionMeterStore.getState().reset()
  })
}

beforeEach(() => {
  reset()
  setBudgetCap.mockClear()
  getBudgetCap.mockClear()
  getBudgetCap.mockResolvedValue(2)
})

afterEach(() => {
  cleanup()
  reset()
})

/** Put the store in the state it would be in after the probe resolved. */
function loaded(cap: BudgetCap, spentUsd = 0): void {
  act(() => {
    useBudgetStore.getState().setCap(cap)
    useSessionMeterStore.getState().setCostUsd(spentUsd)
  })
}

const amount = (): HTMLInputElement =>
  screen.getByLabelText('Session budget in dollars') as HTMLInputElement
const limitToggle = (): HTMLInputElement =>
  screen.getByLabelText(/limit what one session can spend/i) as HTMLInputElement

describe('BudgetTab — what the session has spent', () => {
  it('shows the spend against the cap, marked approximate', () => {
    loaded(2, 0.42)
    render(<BudgetTab />)
    expect(screen.getByTestId('budget-spend').textContent).toContain('$0.42')
    expect(screen.getByTestId('budget-spend').textContent).toContain('≈')
    expect(document.body.textContent).toContain('of $2.00')
  })

  it('says the estimate is not the bill and that the total is per session', () => {
    // Both are things a user cannot infer and would otherwise file a support case about.
    loaded(2, 0.42)
    render(<BudgetTab />)
    expect(document.body.textContent).toMatch(/not from your bill/i)
    expect(document.body.textContent).toMatch(/starts again when Sloodge restarts/i)
  })

  it('describes an unlimited budget rather than showing a phantom cap', () => {
    loaded(null, 3)
    render(<BudgetTab />)
    expect(document.body.textContent).toContain('unlimited')
  })

  it('warns as the cap approaches', () => {
    loaded(2, 1.7)
    render(<BudgetTab />)
    expect(document.body.textContent).toMatch(/approaching the limit/i)
  })

  it('explains the blocked state', () => {
    loaded(2, 2.4)
    render(<BudgetTab />)
    expect(screen.getByTestId('budget-blocked').textContent).toMatch(/being refused/i)
  })

  it('says a running message is stopped only when the limit is lowered below what was spent', () => {
    loaded(2, 0.4)
    render(<BudgetTab />)
    expect(document.body.textContent).toMatch(/allowed to finish — unless you lower the limit/i)
    // The two facts the guard cannot hide from the user: cost is learned only when a message ends,
    // and a query re-armed after a stop is bounded by the cap on its own (§10).
    expect(document.body.textContent).toMatch(/past the limit before anything stops it/i)
    expect(document.body.textContent).toMatch(/on top of what the session had already spent/i)
  })
})

describe('BudgetTab — setting the cap', () => {
  it('shows the stored cap in the field', () => {
    loaded(5)
    render(<BudgetTab />)
    expect(limitToggle().checked).toBe(true)
    expect(amount().value).toBe('5.00')
  })

  it('persists a new cap and mirrors it into the store', async () => {
    loaded(2)
    render(<BudgetTab />)

    fireEvent.change(amount(), { target: { value: '7.5' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(setBudgetCap).toHaveBeenCalledWith(7.5))
    expect(useBudgetStore.getState().capUsd).toBe(7.5)
    expect(amount().value).toBe('7.50')
  })

  it('commits on blur too, so a typed value is not lost by clicking away', async () => {
    loaded(2)
    render(<BudgetTab />)
    fireEvent.change(amount(), { target: { value: '3' } })
    fireEvent.blur(amount())
    await waitFor(() => expect(setBudgetCap).toHaveBeenCalledWith(3))
  })

  it('rejects an unusable amount with a message, and persists nothing', async () => {
    loaded(2)
    render(<BudgetTab />)

    fireEvent.change(amount(), { target: { value: '0' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(setBudgetCap).not.toHaveBeenCalled()
    expect(useBudgetStore.getState().capUsd).toBe(2)
  })

  it('asks before removing the limit — one stray click must not uncap a session', async () => {
    loaded(2)
    render(<BudgetTab />)

    fireEvent.click(limitToggle())

    // Nothing saved yet, and the limit is still on until the user says so.
    expect(await screen.findByTestId('budget-confirm-uncap')).toBeTruthy()
    expect(setBudgetCap).not.toHaveBeenCalled()
    expect(useBudgetStore.getState().capUsd).toBe(2)
    expect(limitToggle().checked).toBe(true)

    fireEvent.click(screen.getByRole('button', { name: /keep the limit/i }))
    expect(screen.queryByTestId('budget-confirm-uncap')).toBeNull()
    expect(setBudgetCap).not.toHaveBeenCalled()
  })

  it('turns the limit off as an explicit null once confirmed, not as a blank field', async () => {
    loaded(2)
    render(<BudgetTab />)

    fireEvent.click(limitToggle())
    fireEvent.click(await screen.findByRole('button', { name: /remove it/i }))

    await waitFor(() => expect(setBudgetCap).toHaveBeenCalledWith(null))
    expect(useBudgetStore.getState().capUsd).toBeNull()
    expect(amount().disabled).toBe(true)
  })

  it('restores a usable cap when the limit is turned back on — never "on but capping nothing"', async () => {
    loaded(null)
    render(<BudgetTab />)
    expect(limitToggle().checked).toBe(false)

    fireEvent.click(limitToggle())

    await waitFor(() => expect(setBudgetCap).toHaveBeenCalled())
    const stored = useBudgetStore.getState().capUsd
    expect(stored).not.toBeNull()
    expect(stored).toBeGreaterThan(0)
  })

  it('stays disabled while the probe is still pending, and says so', () => {
    // Before the probe resolves the renderer does not know the user's cap; offering an editable
    // field would let them overwrite it with the placeholder they were shown.
    getBudgetCap.mockReturnValue(new Promise<BudgetCap>(() => {}))
    render(<BudgetTab />)
    expect(limitToggle().disabled).toBe(true)
    expect(amount().disabled).toBe(true)
    expect(screen.getByTestId('budget-unloaded').textContent).toMatch(/reading your saved limit/i)
  })

  it('shows no placeholder as the saved setting while the probe is pending', () => {
    // The store seeds $2.00 with `loaded: false`. Rendering that as a ticked box and "2.00" next to
    // a banner saying the limit is still being read is a placeholder dressed as the user's setting.
    getBudgetCap.mockReturnValue(new Promise<BudgetCap>(() => {}))
    render(<BudgetTab />)
    expect(limitToggle().checked).toBe(false)
    expect(amount().value).toBe('')
    expect(document.body.textContent).not.toContain('of $2.00')
  })

  it('issues ONE save when the Save click also blurs the field', async () => {
    loaded(2)
    render(<BudgetTab />)
    fireEvent.change(amount(), { target: { value: '7.5' } })
    fireEvent.blur(amount())
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(setBudgetCap).toHaveBeenCalledWith(7.5))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(setBudgetCap).toHaveBeenCalledTimes(1)
  })

  it('re-probes on open and enables itself once the cap arrives', async () => {
    // `useChatSession` probes once at startup and swallows failures. Opening Settings is the natural
    // place to retry, and without it a single early failure disabled this tab for the whole run.
    getBudgetCap.mockResolvedValue(6)
    render(<BudgetTab />)

    await waitFor(() => expect(limitToggle().disabled).toBe(false))
    expect(amount().value).toBe('6.00')
    expect(screen.queryByTestId('budget-unloaded')).toBeNull()
  })

  it('a failed probe explains itself and still lets the user set a limit', async () => {
    getBudgetCap.mockRejectedValue(new Error('EIO'))
    render(<BudgetTab />)

    expect((await screen.findByTestId('budget-unloaded')).textContent).toMatch(/could not be read/i)
    // Editable rather than dead: main validates the save independently, so the worst case is the
    // user setting the limit they wanted anyway. Nothing is pre-filled — the unknown cap is shown
    // as unknown — so the user turns the limit on (which stores the default) and then sets theirs.
    await waitFor(() => expect(limitToggle().disabled).toBe(false))
    expect(limitToggle().checked).toBe(false)
    fireEvent.click(limitToggle())
    await waitFor(() => expect(setBudgetCap).toHaveBeenCalledWith(2))
    fireEvent.change(amount(), { target: { value: '3' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(setBudgetCap).toHaveBeenCalledWith(3))
  })

  it('does not claim the guard is refusing messages before the cap is known', async () => {
    // The store's placeholder default is not the user's cap. Reading it as one let this tab announce
    // "messages are being refused" while the guard was in fact switched off.
    getBudgetCap.mockReturnValue(new Promise<BudgetCap>(() => {}))
    act(() => useSessionMeterStore.getState().setCostUsd(9))
    render(<BudgetTab />)
    expect(screen.queryByTestId('budget-blocked')).toBeNull()
  })

  it('reports a failed save instead of leaving the user believing it stuck', async () => {
    loaded(2)
    setBudgetCap.mockRejectedValueOnce(new Error('EACCES'))
    render(<BudgetTab />)

    fireEvent.change(amount(), { target: { value: '4' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    expect((await screen.findByRole('alert')).textContent).toMatch(/could not be saved/i)
    // Rolled back: the guard is enforced against main's number, so the screen must not show another
    // — in the store *and* in the field, which the store's equal-write bail-out would not repaint.
    expect(useBudgetStore.getState().capUsd).toBe(2)
    expect(amount().value).toBe('2.00')
  })

  it('a failed probe shows the failure in the status store too, not only in this tab', async () => {
    getBudgetCap.mockRejectedValue(new Error('EIO'))
    render(<BudgetTab />)
    await waitFor(() => expect(useBudgetStore.getState().failed).toBe(true))
    expect((await screen.findByTestId('budget-unloaded')).textContent).toMatch(/could not be read/i)
  })
})
