/**
 * The renderer's mirror of the persisted spend cap (M2.5, 50-agent-integration.md §10).
 *
 * Main owns the value — it persists it and hands `maxBudgetUsd` to the SDK — so this store never
 * invents one. It exists for the same reason `authStore` does: the cap is written from Settings ▸
 * Budget and read by the status bar and the composer's guard, three subtrees with no common ancestor
 * short of `AppShell`.
 *
 * `loaded` matters more here than it looks. Until the first `getBudgetCap()` resolves, the renderer
 * does not know the user's cap — and the initial value is a *guess at a limit*, not a neutral
 * default. Gating the guard on `loaded` keeps a slow IPC probe from refusing a turn against a cap
 * the user may not even have; main re-checks anyway, and main never guesses.
 */

import { DEFAULT_BUDGET_CAP_USD, type BudgetCap } from '../../../shared/agent/budget'
import { createStore } from './createStore'

export type BudgetState = {
  readonly capUsd: BudgetCap
  /** `false` until the first probe resolves. See the module docstring. */
  readonly loaded: boolean
  /**
   * The probe failed, as opposed to merely not having resolved. Distinct from `!loaded` because the
   * two need different UI: "reading…" versus "could not be read — main is still enforcing a cap you
   * cannot see here". Cleared by the next successful `setCap`.
   */
  readonly failed: boolean
  readonly setCap: (capUsd: BudgetCap) => void
  readonly markFailed: () => void
  readonly reset: () => void
}

export const useBudgetStore = createStore<BudgetState>((set) => ({
  capUsd: DEFAULT_BUDGET_CAP_USD,
  loaded: false,
  failed: false,
  setCap: (capUsd) => {
    set({ capUsd, loaded: true, failed: false })
  },
  markFailed: () => {
    set({ failed: true })
  },
  reset: () => {
    set({ capUsd: DEFAULT_BUDGET_CAP_USD, loaded: false, failed: false })
  },
}))

/** Selectors kept module-level so their identity is stable across renders (`createStore`'s contract). */
export const selectBudgetCap = (state: BudgetState): BudgetCap => state.capUsd
export const selectBudgetLoaded = (state: BudgetState): boolean => state.loaded
export const selectBudgetFailed = (state: BudgetState): boolean => state.failed
