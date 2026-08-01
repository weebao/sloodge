/**
 * The renderer's single source of truth for auth status (M2.7).
 *
 * Before this, `useChatSession` held the key status in local component state. That was fine while the
 * only way to enter a key was the composer's own gate — but the Settings dialog now writes the
 * credential from a completely different subtree, and per-hook state would leave the composer still
 * showing "Set up authentication" after a successful save. One store, both readers.
 *
 * Holds only the **masked** `AuthStatus` the bridge returns. No plaintext ever reaches the renderer,
 * so nothing here needs redacting before it goes near a devtools snapshot or a log.
 */

import { NOT_CONFIGURED, type AuthStatus } from '../../../shared/agent/auth'
import { createStore } from './createStore'

export type AuthState = {
  readonly status: AuthStatus
  /**
   * `false` until the first `getAuthStatus()` resolves. The composer must not flash the
   * "Set up authentication" gate at a user who *is* configured, so callers gate on this rather than
   * treating the initial `not-configured` as truth.
   */
  readonly loaded: boolean
  readonly setStatus: (status: AuthStatus) => void
  readonly reset: () => void
}

export const useAuthStore = createStore<AuthState>((set) => ({
  status: NOT_CONFIGURED,
  loaded: false,
  setStatus: (status) => {
    set({ status, loaded: true })
  },
  reset: () => {
    set({ status: NOT_CONFIGURED, loaded: false })
  },
}))

/** Selector kept module-level so its identity is stable across renders (see `createStore`'s contract). */
export const selectAuthStatus = (state: AuthState): AuthStatus => state.status
export const selectAuthLoaded = (state: AuthState): boolean => state.loaded
