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

/**
 * A refused text edit waiting to be explained, and the slide it was raised on (M3.11). M3.6's
 * transform actions raise their caveats through the same channel — a flip that mirrored text, a
 * duplicate that could not be offset — since each is the same kind of sentence: what just happened
 * to the selected element and why, shown where the element is.
 *
 * Ephemeral view state like the rest of this store, but it lives here rather than in
 * `useTextEditing`'s own `useState` for one reason: the two exits that can refuse an edit *while
 * unmounting the overlay* — turning Design Mode off, and Present, which forces it off — start the
 * refusal in the same React commit that destroys the component. A local setter called from the
 * frame's answer, which lands afterwards, updates a component that is gone, so those two exits
 * refused in silence while `Enter` and `Esc` explained themselves (round-8 minor). This store
 * outlives the overlay, and `SlideCanvas` renders the notice in either mode.
 *
 * The `slideId` is what keeps the explanation attached to the edit that caused it: the rail can move
 * to another slide while Design Mode is off, and a notice that followed the user there would name an
 * element the new slide has never had.
 */
export type TextEditNotice = {
  readonly slideId: string
  readonly text: string
}

export type DesignSnapshot = {
  /**
   * Whether Design Mode is active. **On is the default** (M3.11); `Present` (later) forces it off.
   *
   * ## Why edit-first, and why this is not persisted
   *
   * It shipped as `false` through M3.2–M3.10 and that was wrong: with it off, `SlideCanvas` hands
   * pointer events to the slide, so clicking text on a fresh deck does *nothing at all* until the
   * user discovers `Ctrl/⌘+D`. A slide editor whose default state is "clicking does nothing" reads
   * as broken — which is exactly how it was reported — and PowerPoint is edit-first.
   *
   * The flag stays session-scoped and is deliberately **not** persisted across launches. Turning
   * Design Mode off is a transient, exploratory act ("let me play with this slide's live chart"),
   * not a durable preference; persisting it would mean a user who poked at an interactive slide once
   * and quit comes back to an inert deck, reintroducing the original bug in a stickier form with no
   * obvious way out. It also keeps the promise this file's header makes — ephemeral view state,
   * never persisted — and Present mode already covers "I want to look, not edit".
   */
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
  /**
   * The `slId` with an open in-place text edit (M3.11), or `null`.
   *
   * Ephemeral like the rest of this store: the caret and the in-progress characters live in the
   * frame's DOM, and nothing reaches the document — or the undo stack — until the session commits.
   * That is the whole of the undo-coalescing strategy: a typing burst cannot push entries because
   * typing never touches `deckStore` at all.
   */
  readonly editing: string | null
  /** The refused edit to explain, or `null`. See `TextEditNotice`. */
  readonly notice: TextEditNotice | null
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
  /**
   * Drop hover and selection without leaving Design Mode — e.g. pointer left the stage. `notice` is
   * not in it, for the same reason it is not in `OFF`: none of its callers invalidate a refusal the
   * user may still be reading. The one that does — a remote deck replacement — clears it explicitly.
   */
  clearTransient: () => void
  /**
   * Open a text-edit session on `slId`. Ignored while Design Mode is off. Does not change the
   * selection — editing is a mode *on* the selected element, and the overlay keeps drawing its box.
   */
  beginEditing: (slId: string) => void
  /** Close any open session. Idempotent; safe to call when nothing is being edited. */
  endEditing: () => void
  /** Raise or dismiss the refused-edit notice. */
  setNotice: (notice: TextEditNotice | null) => void
}

const CLEARED = { hover: null, selections: [], selection: null, editing: null } as const

/**
 * What turning Design Mode off resets. `notice` is deliberately **not** in it: the refusal a toggle
 * can cause is decided a moment after the toggle, and clearing here would erase the explanation the
 * user is owed for it.
 */
const OFF: Omit<DesignSnapshot, 'notice'> = { enabled: false, ...CLEARED }

/** De-duplicate a hit list by `slId`, keeping each id's **last** occurrence (freshest geometry). */
function dedupeBySlId(hits: readonly SlHit[]): SlHit[] {
  const byId = new Map<string, SlHit>()
  for (const hit of hits) byId.set(hit.slId, hit)
  return [...byId.values()]
}

export const useDesignStore = createStore<DesignState>((set, get) => ({
  ...OFF,
  notice: null,
  // Edit-first: the app opens with Design Mode on. See the note on `DesignSnapshot.enabled`.
  enabled: true,

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
    //
    // Selecting a *different* element ends any open edit — the caret belongs to the element that
    // had it. Re-selecting the element already being edited deliberately does not, which is what
    // makes double-click race-free: the dblclick's `beginEditing` and the preceding click's
    // in-flight hit-test response can arrive in either order without one cancelling the other.
    const editing = get().editing
    const keepEditing = editing !== null && hit !== null && hit.slId === editing
    set({
      selections: hit === null ? [] : [hit],
      selection: hit,
      hover: null,
      editing: keepEditing ? editing : null,
    })
  },

  toggleSelection: (hit) => {
    if (!get().enabled || hit === null) return
    const current = get().selections
    const without = current.filter((entry) => entry.slId !== hit.slId)
    // Re-clicking a selected element removes it; a new one is appended and becomes the anchor.
    const next = without.length === current.length ? [...without, hit] : without
    set({ selections: next, selection: next.at(-1) ?? null, hover: null, editing: null })
  },

  setSelections: (hits) => {
    if (!get().enabled) return
    const next = dedupeBySlId(hits)
    set({ selections: next, selection: next.at(-1) ?? null, hover: null, editing: null })
  },

  clearTransient: () => {
    set({ ...CLEARED })
  },

  beginEditing: (slId) => {
    if (!get().enabled) return
    set({ editing: slId, hover: null })
  },

  endEditing: () => {
    set({ editing: null })
  },

  setNotice: (notice) => {
    set({ notice })
  },
}))
