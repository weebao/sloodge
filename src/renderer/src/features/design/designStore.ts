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
  /**
   * The ordered multi-selection (M3.7). Empty for nothing selected; a single-element selection is a
   * one-entry list. The **last** entry is the anchor (`selection` below mirrors it). Order is the
   * order elements were added, which shift-click preserves and align/distribute read as-is.
   */
  readonly selections: readonly SlHit[]
  /**
   * The anchor selection — `selections.at(-1) ?? null`, maintained on every mutation. Kept as a
   * first-class field (not derived in a selector) so the many single-element consumers written before
   * M3.7 (the property panel, `useElementActions`, the chat context bundler) keep reading exactly the
   * slice they always did; multi-element features read `selections`.
   */
  readonly selection: SlHit | null
}

export type DesignState = DesignSnapshot & {
  /** Flip Design Mode. Turning it off clears hover and selection (the overlay disappears). */
  toggle: () => void
  /** Set the enabled flag explicitly; turning off clears transient state, same as `toggle`. */
  setEnabled: (enabled: boolean) => void
  /** Update the hover outline. Ignored while Design Mode is off. */
  setHover: (hit: SlHit | null) => void
  /**
   * Replace the whole selection with a single element (or clear it with `null`) and clear hover.
   * Ignored while Design Mode is off. This is the plain-click / single-select path.
   */
  setSelection: (hit: SlHit | null) => void
  /**
   * Shift-click: toggle one element in the ordered selection. Re-selecting the same `slId` removes
   * it (and drops any stale copy); a new element is appended and becomes the anchor. Ignored while
   * off. A `null` hit is a no-op — shift-clicking empty space changes nothing.
   */
  toggleSelection: (hit: SlHit | null) => void
  /**
   * Replace the whole selection with an ordered list (marquee result). De-duplicates by `slId`,
   * keeping the last occurrence's geometry. Clears hover. Ignored while off; an empty list clears.
   */
  setSelections: (hits: readonly SlHit[]) => void
  /** Drop hover and selection without leaving Design Mode — e.g. pointer left the stage. */
  clearTransient: () => void
}

const OFF: DesignSnapshot = { enabled: false, hover: null, selections: [], selection: null }

/** De-duplicate a hit list by `slId`, keeping each id's **last** occurrence (freshest geometry). */
function dedupeBySlId(hits: readonly SlHit[]): SlHit[] {
  const byId = new Map<string, SlHit>()
  for (const hit of hits) byId.set(hit.slId, hit)
  return [...byId.values()]
}

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
    // outlines on one element reads as a bug. A single click always collapses to one element.
    set({ selections: hit === null ? [] : [hit], selection: hit, hover: null })
  },

  toggleSelection: (hit) => {
    if (!get().enabled || hit === null) return
    const current = get().selections
    const without = current.filter((entry) => entry.slId !== hit.slId)
    // Re-clicking a selected element removes it; a new one is appended and becomes the anchor.
    const next = without.length === current.length ? [...without, hit] : without
    set({ selections: next, selection: next.at(-1) ?? null, hover: null })
  },

  setSelections: (hits) => {
    if (!get().enabled) return
    const next = dedupeBySlId(hits)
    set({ selections: next, selection: next.at(-1) ?? null, hover: null })
  },

  clearTransient: () => {
    set({ hover: null, selections: [], selection: null })
  },
}))
