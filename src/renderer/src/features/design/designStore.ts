/**
 * Design Mode's on/off state and current hover/selection — §2 of
 * `.claude/plans/init/40-design-mode.md`.
 *
 * This is a **separate store from `deckStore`**, deliberately. `deckStore` owns the *document*: every
 * mutation there goes through `DocumentHistory` and is undoable, because it changes bytes that get
 * saved. Design Mode's enabled flag and its transient hover/selection are none of those things —
 * they are ephemeral view state, never persisted, never on the undo stack (§7.1: Design Mode emits
 * commands *onto* the deck stack for edits, but the selection itself is not an edit). Keeping them
 * here means toggling Design Mode or moving the pointer can never fork the document from its history,
 * and the document store stays the single reviewable place where undoable state lives.
 *
 * Built on the same `createStore` as `deckStore` — Zustand's shape (see `createStore.ts`) — so the
 * selector contract is identical: subscribe to stable slices, derive in `useMemo`.
 *
 * The renderer is the source of truth for selection (§2.2): the frame holds no state, so if it
 * reloads, the parent re-sends the selection by `data-sl-id`. That is why `selection` is a full
 * `SlHit` and not just an id — the last known geometry keeps the overlay painted across a reload
 * until a fresh `SL_MEASURE`/`SL_HITTEST` refreshes it (measurement refresh is M3.5).
 */

import type { SlHit } from '../../../../shared/design/bridge-protocol'
import { createStore } from '../../stores/createStore'

export type DesignSnapshot = {
  /** Whether Design Mode is active. Off is the default; `Present` (later) forces it off. */
  readonly enabled: boolean
  /** The element under the pointer, or `null` when hovering nothing addressable. */
  readonly hover: SlHit | null
  /** The committed selection, or `null` when nothing is selected. */
  readonly selection: SlHit | null
}

export type DesignState = DesignSnapshot & {
  /** Flip Design Mode. Turning it off clears hover and selection (the overlay disappears). */
  toggle: () => void
  /** Set the enabled flag explicitly; turning off clears transient state, same as `toggle`. */
  setEnabled: (enabled: boolean) => void
  /** Update the hover outline. Ignored while Design Mode is off. */
  setHover: (hit: SlHit | null) => void
  /** Commit a selection (and clear hover, since the box supersedes the outline). Ignored while off. */
  setSelection: (hit: SlHit | null) => void
  /** Drop hover and selection without leaving Design Mode — e.g. pointer left the stage. */
  clearTransient: () => void
}

const OFF: DesignSnapshot = { enabled: false, hover: null, selection: null }

export const useDesignStore = createStore<DesignState>((set, get) => ({
  ...OFF,

  toggle: () => {
    get().setEnabled(!get().enabled)
  },

  setEnabled: (enabled) => {
    // Turning off resets everything to the single OFF snapshot so no stale outline survives a
    // later re-enable; turning on keeps hover/selection null (they were already null while off).
    set(enabled ? { enabled: true } : OFF)
  },

  setHover: (hit) => {
    if (!get().enabled) return
    set({ hover: hit })
  },

  setSelection: (hit) => {
    if (!get().enabled) return
    // Selecting supersedes the hover outline — the selection box is the stronger affordance and two
    // outlines on one element reads as a bug.
    set({ selection: hit, hover: null })
  },

  clearTransient: () => {
    set({ hover: null, selection: null })
  },
}))
