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

vi.mock('../../../src/renderer/src/features/chat/agentClient', () => ({
  getAgentBridge: () => ({ setBudgetCap: (cap: BudgetCap) => setBudgetCap(cap) }),
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

  it('explains the blocked state, including that a running turn was allowed to finish', () => {
    loaded(2, 2.4)
    render(<BudgetTab />)
    expect(screen.getByTestId('budget-blocked').textContent).toMatch(/allowed to finish/i)
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

  it('turns the limit off as an explicit null, not as a blank field', async () => {
    loaded(2)
    render(<BudgetTab />)

    fireEvent.click(limitToggle())

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

  it('stays disabled until the cap has actually been loaded from main', () => {
    // Before the probe resolves the renderer does not know the user's cap; offering an editable
    // field would let them overwrite it with the placeholder they were shown.
    render(<BudgetTab />)
    expect(limitToggle().disabled).toBe(true)
    expect(amount().disabled).toBe(true)
  })

  it('reports a failed save instead of leaving the user believing it stuck', async () => {
    loaded(2)
    setBudgetCap.mockRejectedValueOnce(new Error('EACCES'))
    render(<BudgetTab />)

    fireEvent.change(amount(), { target: { value: '4' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    expect((await screen.findByRole('alert')).textContent).toMatch(/could not be saved/i)
  })
})
