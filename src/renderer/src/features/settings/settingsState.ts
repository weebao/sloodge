/**
 * The Settings dialog's state machine (M2.7) — which tab is showing, whether there is unsaved input,
 * and what a close request should do about it.
 *
 * Pure and separate from the component so the interesting behaviour (you cannot lose a half-typed
 * credential to a stray Escape) is unit-tested rather than eyeballed in a recording.
 */

/** Tab order is the render order; Auth is first because it is the one that gates everything else. */
export const SETTINGS_TABS = ['auth', 'model', 'budget', 'about'] as const

export type SettingsTab = (typeof SETTINGS_TABS)[number]

export const SETTINGS_TAB_LABELS: Readonly<Record<SettingsTab, string>> = {
  auth: 'Auth',
  model: 'Model',
  budget: 'Budget',
  about: 'About',
}

export function isSettingsTab(value: unknown): value is SettingsTab {
  return typeof value === 'string' && (SETTINGS_TABS as readonly string[]).includes(value)
}

export type SettingsState = {
  readonly open: boolean
  readonly tab: SettingsTab
  /** A credential has been typed but not saved. Set by the Auth tab as the user types. */
  readonly dirty: boolean
  /** A close was requested while dirty; the dialog is showing the discard confirmation. */
  readonly confirmingDiscard: boolean
}

export const INITIAL_SETTINGS_STATE: SettingsState = {
  open: false,
  tab: 'auth',
  dirty: false,
  confirmingDiscard: false,
}

export type SettingsAction =
  /** File ▸ Settings… / `Ctrl+,`. Optionally deep-links a tab (the chat gate opens `auth`). */
  | { readonly type: 'open'; readonly tab?: SettingsTab }
  | { readonly type: 'select-tab'; readonly tab: SettingsTab }
  | { readonly type: 'set-dirty'; readonly dirty: boolean }
  /** Escape, backdrop click, or Close — may be intercepted by the dirty guard. */
  | { readonly type: 'request-close' }
  | { readonly type: 'confirm-discard' }
  | { readonly type: 'cancel-discard' }

export function settingsReducer(state: SettingsState, action: SettingsAction): SettingsState {
  switch (action.type) {
    case 'open':
      // Always reopens clean: a draft abandoned in a previous session must not resurface, and the
      // deep-link target (or Auth) should win over whatever tab was last viewed.
      return { open: true, tab: action.tab ?? 'auth', dirty: false, confirmingDiscard: false }

    case 'select-tab':
      if (state.tab === action.tab) return state
      // Switching tabs abandons the draft deliberately — the input unmounts, so keeping `dirty` set
      // would strand the user behind a confirmation for text that no longer exists.
      return { ...state, tab: action.tab, dirty: false, confirmingDiscard: false }

    case 'set-dirty':
      if (state.dirty === action.dirty) return state
      return { ...state, dirty: action.dirty }

    case 'request-close':
      if (!state.open) return state
      // The whole point of the machine: a half-typed token survives a stray Escape.
      if (state.dirty) return { ...state, confirmingDiscard: true }
      return { ...state, open: false, confirmingDiscard: false }

    case 'confirm-discard':
      return { ...state, open: false, dirty: false, confirmingDiscard: false }

    case 'cancel-discard':
      return { ...state, confirmingDiscard: false }
  }
}

/**
 * Roving arrow-key movement across the tab strip, matching the ARIA tabs pattern. Wraps at both ends
 * so the strip behaves like a native tab list.
 */
export function nextTab(current: SettingsTab, delta: 1 | -1): SettingsTab {
  const index = SETTINGS_TABS.indexOf(current)
  const count = SETTINGS_TABS.length
  return SETTINGS_TABS[(index + delta + count) % count] as SettingsTab
}
