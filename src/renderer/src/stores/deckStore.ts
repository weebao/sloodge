/**
 * Renderer-side deck state: the open deck's manifest, the slide HTML the frames render, the
 * current selection, and — since M1.4 — the CRUD actions that change any of it.
 *
 * **Every mutation goes through `DocumentHistory`** (§5 of 10-architecture.md). The store owns one
 * `DocumentHistory<DeckDoc>` and its `deck` / `slideHtml` fields are *views of `history.doc`*, never
 * independently maintained copies: an action builds a `DocCommand`, hands it to `history.apply`,
 * and then republishes `history.doc.manifest` / `history.doc.slides`. A store action that edited a
 * manifest directly would be a mutation undo can never see, and the two states would drift on the
 * first Ctrl+Z.
 *
 * Actions return `boolean` — `true` when a command was applied, `false` when the store declined
 * (unknown id, out-of-range index, a no-op drag, the last-slide guard) or the funnel rejected the
 * batch. Errors are values here exactly as they are in `commands.ts`; a click handler must not
 * throw, but a *silent* no-op is the failure mode that layer exists to prevent, so the caller (and
 * the test) can always tell whether anything happened.
 *
 * Slide text lives beside the manifest rather than inside it because the manifest is the *file*
 * `manifest.json` and must round-trip byte-faithfully (§5.2 "unknown fields are preserved").
 * Keeping HTML out of it means the store can hold a slide's in-flight text without inventing a
 * manifest field that no reader or writer knows about.
 *
 * **Prototype-key discipline**, same rule as `deck.ts` and `store.ts`: slide ids are
 * attacker-influenced strings used as object keys, so `slideHtml[id]` on a plain object would
 * resolve `constructor` up the prototype chain and hand a *function* to `SlideFrame` as a
 * document. Every map here is null-prototype and every read goes through `getSlideHtml`.
 */

import type { DeckDoc, DocCommand } from '../../../shared/document/commands'
import {
  addSlide as addSlideToDeck,
  createEmptyDeck,
  createSlideEntry,
  duplicateSlide as duplicateSlideInDeck,
  getSlide,
  hasSlide,
} from '../../../shared/document/deck'
import type { DeckUpdate } from '../../../shared/document/deck-update'
import {
  applyAgentCommandsToHistory,
  snapshotOfDoc,
  type AgentApplyResult,
  type AgentDeckSnapshot,
} from '../../../shared/document/agent-edit'
import { DocumentHistory } from '../../../shared/document/history'
import { createStarterSlideHtml } from '../../../shared/document/starter-slide'
import {
  parseManifest,
  parseTheme,
  type DeckManifest,
  type SlideEntry,
  type SlideId,
} from '../../../shared/document/types'
import { createStore } from './createStore'

/** One slide as the rail and canvas need it: identity, label, and the bytes to render. */
export type SlideView = {
  readonly id: SlideId
  readonly title: string
  readonly html: string
}

export type SlideHtmlMap = Readonly<Record<string, string>>

export type DeckSnapshot = {
  /**
   * The undo funnel, and the owner of the document. `deck` and `slideHtml` below are
   * `history.doc.manifest` / `history.doc.slides` by identity — replacing one without the other
   * would fork the document from its own history.
   *
   * It is a state field rather than a module singleton so that `setState(createStarterDeck())`
   * replaces the document *and* its history in one atomic patch, which is what "open a new deck"
   * means (§5: history is per document and cleared on `doc:open`) and what every test needs
   * between cases.
   */
  readonly history: DocumentHistory<DeckDoc>
  readonly deck: DeckManifest
  readonly slideHtml: SlideHtmlMap
  /** `null` only for a deck with no slides — the shell renders its empty state then. */
  readonly currentSlideId: SlideId | null
  /**
   * Mirrors of `history.canUndo` / `canRedo`. Kept as primitives in the state rather than read off
   * the instance in a selector because the history object's identity never changes, so a component
   * subscribing to it would never re-render when the stacks moved.
   *
   * **No production consumer yet** — nothing in the renderer renders an undo affordance, because
   * since M1.4 the only one is the native Edit menu, and graying its items out needs a
   * renderer -> main channel that M5.1 (File/Edit menus with OS accelerators) owns. These two are
   * kept rather than dropped because they are what that channel will send, and because they are
   * the cheapest possible statement of history state for the tests that assert it. If M5.1 slips
   * past this becoming stale, delete them — a `set` that maintains state for nobody is a cost.
   */
  readonly canUndo: boolean
  readonly canRedo: boolean
}

export type DeckState = DeckSnapshot & {
  /** No-op for an id the deck does not contain, so a stale rail click cannot blank the canvas. */
  selectSlide: (id: SlideId) => void
  /** Select by position in `slideOrder`; out-of-range indices are ignored. */
  selectSlideAt: (index: number) => void
  /** Append a starter slide and select it. */
  addSlide: () => boolean
  /**
   * Remove a slide and select its neighbour. Declines on the deck's last slide — see
   * `canDeleteSlide`.
   */
  deleteSlide: (id: SlideId) => boolean
  /** Insert a copy directly after the original, and select the copy. */
  duplicateSlide: (id: SlideId) => boolean
  /** Move the slide at `fromIndex` to `toIndex` (absolute, post-move) and keep it selected. */
  moveSlide: (fromIndex: number, toIndex: number) => boolean
  /**
   * Replace one slide's HTML source with an already-patched string, as a single undoable command
   * with a `design` origin (§7.1). The Properties panel is the producer: it computes the patched
   * source from the current bytes and the parent-tracked sl-id, so the id keying `elementId` is a
   * source-map id, not a message payload. `label` is the Edit-menu text ("Font size 44 -> 46").
   */
  setSlideHtml: (id: SlideId, html: string, elementId: string, label: string) => boolean
  /**
   * Adopt a whole deck snapshot as a **document open / full reload** — `history.reset`, which clears
   * the undo stack (§5 `doc:open` semantics). Returns `false` (a no-op) when the snapshot's manifest
   * fails validation — a malformed push must never blank the editor.
   *
   * **Not the agent-edit path (M2.6).** An agent tool edit goes through `applyAgentCommands` so it
   * lands on the undo stack and Ctrl/⌘+Z reverses it. Resetting on every agent write would wipe the
   * user's undo history, which is exactly why the full-snapshot `deck:updated` path is now confined to
   * doc:open / full-reload and is not driven by the agent (see `deck-update.ts`).
   */
  applyRemoteDeck: (update: DeckUpdate) => boolean
  /**
   * Apply an agent turn's `DocCommand`s (M2.6) through the *same* `DocumentHistory` a manual edit
   * uses, tagged `origin: agent`, so the edit lands on the one undo stack the Edit menu drives — the
   * undo-parity invariant (§6 / §5). Unlike `applyRemoteDeck` this does **not** reset the history:
   * one call is one undo entry the standard Ctrl/⌘+Z reverses in a single step. Returns the applied
   * result (new revision + snapshot) or a typed error, which the tool relays back to the agent.
   */
  applyAgentCommands: (
    commands: readonly DocCommand[],
    turnId: string,
    toolUseId: string,
  ) => AgentApplyResult
  /** A serializable read of the authoritative deck, for the agent's `read_slide`/`screenshot` (§6). */
  snapshotForAgent: () => AgentDeckSnapshot
  undo: () => boolean
  redo: () => boolean
}

/**
 * UI policy, deliberately *not* a document-layer rule: the rail always keeps at least one slide.
 *
 * The document model permits an empty deck — `DeckManifestSchema.slideOrder` has no minimum,
 * `slide.remove` has no last-slide guard, and `SlideCanvas` already renders a `null` slide — and
 * nothing in the plan says otherwise, so removing the last slide is *representable*. What the plan
 * does not describe anywhere is what an empty rail should look like or how a user gets back out of
 * it: the wireframes' rail is a list of slides with `[+ New]` under it, and an editor whose canvas
 * can be emptied by a context menu is a state no screen was designed for. Enforcing the floor here,
 * in the action, keeps that a *view* decision — the commands, the file format and a future
 * agent tool are all still free to produce a zero-slide deck.
 */
export function canDeleteSlide(deck: DeckManifest, id: SlideId): boolean {
  return deck.slideOrder.length > 1 && hasSlide(deck, id)
}

function htmlMap(entries: readonly (readonly [SlideId, string])[]): SlideHtmlMap {
  const map = Object.create(null) as Record<string, string>
  for (const [id, html] of entries) map[id] = html
  return map
}

/** The one read path into the html map. `Object.hasOwn`, never a bare index (see file header). */
export function getSlideHtml(slideHtml: SlideHtmlMap, id: SlideId): string | undefined {
  return Object.hasOwn(slideHtml, id) ? slideHtml[id] : undefined
}

/* ------------------------------------------------------------------------------------------ *
 * Selectors — pure, and taking their inputs explicitly rather than the whole state.
 *
 * Each derives a *fresh* array/object, so none of them may be passed to `useDeckStore` directly
 * (see the selector contract in createStore.ts). Components subscribe to the stable slices and
 * derive through `useMemo`.
 * ------------------------------------------------------------------------------------------ */

/**
 * Slides in presentation order — `slideOrder` is authoritative, never `Object.keys(slides)`.
 *
 * **Index-for-index with `slideOrder`, always.** Callers pair this with `selectCurrentIndex`, which
 * is a position in `slideOrder`; skipping an element here would silently shift every later slide,
 * so the canvas would show one slide while the rail highlighted another and the status bar counted
 * a third. The manifest schema already guarantees the two agree (invariant 1, types.ts: `slideOrder`
 * is a strict permutation of the slide keys), but that guarantee is enforced at the zod boundary and
 * this function is called on in-memory decks. Emitting a placeholder rather than skipping makes the
 * correspondence structural instead of merely true.
 *
 * A slide whose *bytes* are not loaded likewise renders as an empty document rather than vanishing
 * from the rail: the deck says it exists, and a silently shorter rail is a worse lie than a blank card.
 */
export function selectSlideViews(deck: DeckManifest, slideHtml: SlideHtmlMap): SlideView[] {
  return deck.slideOrder.map((id) => ({
    id,
    title: getSlide(deck, id)?.title ?? 'Untitled slide',
    html: getSlideHtml(slideHtml, id) ?? '',
  }))
}

/** 0-based position of the selection in `slideOrder`, or `-1` when there is none. */
export function selectCurrentIndex(deck: DeckManifest, currentSlideId: SlideId | null): number {
  return currentSlideId === null ? -1 : deck.slideOrder.indexOf(currentSlideId)
}

/* ------------------------------------------------------------------------------------------ *
 * The boot deck
 * ------------------------------------------------------------------------------------------ */

/**
 * Content of the deck the app opens with until M1.4 wires File ▸ New / Open.
 *
 * Three slides rather than one: the rail, the selection highlight and the slide counter all need a
 * deck they can actually move around in, and a single-slide boot state would leave every one of
 * them untested against real data until the file milestone lands.
 */
const STARTER_SLIDES: readonly { title: string; subtitle?: string }[] = [
  { title: 'Untitled deck', subtitle: 'Ask Claude to draft your first slide' },
  { title: 'Second slide' },
  { title: 'Third slide' },
]

/**
 * Build the boot deck: a real `DeckManifest` plus contract-compliant slide HTML, so the frames
 * render the same code path a deck opened from disk will.
 *
 * `now` is injectable so tests get deterministic timestamps; slide ids stay random (ULID) even
 * with a fixed clock, which is what keeps two starter decks from colliding.
 */
export function createStarterDeck(now: number = Date.now()): DeckSnapshot {
  let deck = createEmptyDeck({ now, title: 'Untitled deck' })
  const html: (readonly [SlideId, string])[] = []

  for (const [index, spec] of STARTER_SLIDES.entries()) {
    const entry = createSlideEntry({
      now,
      title: spec.title,
      kind: index === 0 ? 'title' : 'content',
      origin: { type: 'template' },
    })
    deck = addSlideToDeck(deck, entry)
    html.push([
      entry.id,
      createStarterSlideHtml({
        id: entry.id,
        title: spec.title,
        ...(spec.subtitle === undefined ? {} : { subtitle: spec.subtitle }),
      }),
    ])
  }

  const history = new DocumentHistory<DeckDoc>({
    manifest: deck,
    slides: htmlMap(html),
    notes: Object.create(null) as Record<string, string>,
    theme: null,
  })

  return {
    history,
    ...published(history),
    currentSlideId: deck.slideOrder[0] ?? null,
  }
}

/* ------------------------------------------------------------------------------------------ *
 * Mutation plumbing
 * ------------------------------------------------------------------------------------------ */

/** The document fields the store publishes, re-read from the history after every apply. */
function published(history: DocumentHistory<DeckDoc>): {
  deck: DeckManifest
  slideHtml: SlideHtmlMap
  canUndo: boolean
  canRedo: boolean
} {
  return {
    deck: history.doc.manifest,
    slideHtml: history.doc.slides,
    canUndo: history.canUndo,
    canRedo: history.canRedo,
  }
}

/**
 * Selection after an undo/redo, which can delete the slide the user was looking at.
 *
 * Keep the current slide when it survived — the common case, and the one where moving the selection
 * would be the surprise. Otherwise fall back to whatever now occupies its old position, and to the
 * new last slide when the deck got shorter: "nearest surviving slide", by index, in the document
 * the user is now looking at.
 *
 * Deliberately *not* "select whatever the batch put back": undoing a delete or redoing a `+ New`
 * could reasonably jump to the restored slide, but working that out means reading the applied
 * entry's commands, and the rule stops being one sentence the moment a batch touches two slides —
 * which every agent turn will (§5: one turn is one undo entry). One rule that is right for a
 * one-command entry and defensible for a fifty-command one beats two that disagree.
 */
function reselect(
  deck: DeckManifest,
  current: SlideId | null,
  previousIndex: number,
): SlideId | null {
  if (current !== null && hasSlide(deck, current)) return current
  if (deck.slideOrder.length === 0) return null
  const index = Math.min(Math.max(previousIndex, 0), deck.slideOrder.length - 1)
  return deck.slideOrder[index] ?? null
}

/**
 * Selection after an agent turn. A create should be *visible*: if the batch inserted a slide, select
 * the (last) inserted one so the canvas jumps to what the agent just made — the "an agent tool call
 * visibly mutates the on-screen deck" acceptance criterion. Otherwise fall back to the same
 * nearest-surviving-slide rule `undo`/`redo` use, so an edit to an off-screen slide does not yank the
 * user away from where they were.
 */
function agentReselect(
  commands: readonly DocCommand[],
  deck: DeckManifest,
  current: SlideId | null,
  previousIndex: number,
): SlideId | null {
  let inserted: SlideId | null = null
  for (const command of commands) if (command.t === 'slide.insert') inserted = command.slide.id
  if (inserted !== null && hasSlide(deck, inserted)) return inserted
  return reselect(deck, current, previousIndex)
}

export const useDeckStore = createStore<DeckState>((set, get) => {
  /**
   * The one place a command reaches the document. Applies the batch, and republishes the document
   * plus the caller's selection only if the funnel accepted it — a rejected batch leaves the
   * document identical *by reference*, so publishing anyway would notify every subscriber that
   * nothing had changed.
   */
  const dispatch = (
    commands: readonly DocCommand[],
    label: string,
    currentSlideId: SlideId | null,
  ): boolean => {
    const { history } = get()
    const result = history.apply(commands, { kind: 'user', label })
    if (!result.ok) return false
    set({ ...published(history), currentSlideId })
    return true
  }

  return {
    ...createStarterDeck(),

    selectSlide: (id) => {
      if (!hasSlide(get().deck, id)) return
      set({ currentSlideId: id })
    },

    selectSlideAt: (index) => {
      const id = get().deck.slideOrder[index]
      if (id === undefined) return
      set({ currentSlideId: id })
    },

    addSlide: () => {
      const { deck } = get()
      const entry = createSlideEntry({
        title: 'Untitled slide',
        kind: 'content',
        origin: { type: 'template' },
      })
      const html = createStarterSlideHtml({ id: entry.id, title: entry.title })
      return dispatch(
        [{ t: 'slide.insert', at: deck.slideOrder.length, slide: entry, html }],
        'New slide',
        entry.id,
      )
    },

    deleteSlide: (id) => {
      const state = get()
      if (!canDeleteSlide(state.deck, id)) return false
      const index = state.deck.slideOrder.indexOf(id)
      // Resolved against the *post-remove* order: the slide that slides into the deleted one's
      // position, or the new last slide when the deleted one was at the end.
      const survivors = state.deck.slideOrder.filter((candidate) => candidate !== id)
      const neighbour = survivors[index] ?? survivors.at(-1) ?? null
      const selected = state.currentSlideId === id ? neighbour : state.currentSlideId
      return dispatch([{ t: 'slide.remove', id }], 'Delete slide', selected)
    },

    duplicateSlide: (id) => {
      const state = get()
      const index = state.deck.slideOrder.indexOf(id)
      if (index === -1) return false
      // The copy's *entry* is built by `deck.duplicateSlide` and then lifted back out of the
      // manifest it returned, which is thrown away. Reusing it rather than open-coding the copy
      // keeps one definition of what duplication means (fresh id and paths, reset validation,
      // dropped thumbnail) instead of a second one here that can drift from it.
      let copy: SlideEntry | undefined
      try {
        // `deck.duplicateSlide` inserts the copy at `index + 1` of the order it returns.
        const duplicated = duplicateSlideInDeck(state.deck, id)
        const copyId = duplicated.slideOrder[index + 1]
        copy = copyId === undefined ? undefined : getSlide(duplicated, copyId)
      } catch {
        return false
      }
      if (copy === undefined) return false
      const html = getSlideHtml(state.slideHtml, id) ?? ''
      const notes = state.history.doc.notes
      // `slide.insert` rejects a batch whose notes text and notes path disagree, so the two are
      // decided together: the copy declares a notes file iff the original had one.
      const command: DocCommand =
        copy.notes === undefined
          ? { t: 'slide.insert', at: index + 1, slide: copy, html }
          : {
              t: 'slide.insert',
              at: index + 1,
              slide: copy,
              html,
              notes: Object.hasOwn(notes, id) ? (notes[id] ?? '') : '',
            }
      return dispatch([command], 'Duplicate slide', copy.id)
    },

    moveSlide: (fromIndex, toIndex) => {
      const { deck } = get()
      const id = deck.slideOrder[fromIndex]
      if (id === undefined) return false
      if (!Number.isInteger(toIndex) || toIndex < 0 || toIndex >= deck.slideOrder.length) {
        return false
      }
      // A drop that changes nothing must not consume a Ctrl+Z; `slide.move` would happily record
      // an entry whose inverse is also a no-op.
      if (fromIndex === toIndex) return false
      return dispatch([{ t: 'slide.move', id, to: toIndex }], 'Move slide', id)
    },

    setSlideHtml: (id, html, elementId, label) => {
      const state = get()
      // Re-derive nothing from a message here: the caller passes the patched source it computed
      // from `state.slideHtml[id]` and the parent-tracked sl-id. The funnel rejects an unknown id.
      const result = state.history.apply([{ t: 'slide.setHtml', id, html }], {
        kind: 'design',
        label,
        elementId,
      })
      if (!result.ok) return false
      set({ ...published(state.history), currentSlideId: state.currentSlideId })
      return true
    },

    applyRemoteDeck: (update) => {
      // Validate the manifest before it can reach a selector: a malformed push must be a no-op, not
      // a blanked canvas. Main is the trusted sender, but the snapshot carries agent-authored HTML
      // and this is the one place a bad shape would surface as a runtime crash rather than a value.
      const parsed = parseManifest(update.manifest)
      if (!parsed.ok) return false
      const manifest = parsed.manifest

      const slides = Object.create(null) as Record<string, string>
      for (const id of Object.keys(update.slides)) slides[id] = update.slides[id] ?? ''
      const notes = Object.create(null) as Record<string, string>
      for (const id of Object.keys(update.notes)) notes[id] = update.notes[id] ?? ''
      // A theme that fails validation is dropped rather than trusted — same posture as `readDeck`.
      let theme = null
      if (update.theme !== null && update.theme !== undefined) {
        const parsedTheme = parseTheme(update.theme)
        if (parsedTheme.ok) theme = parsedTheme.theme
      }

      const state = get()
      const previousIndex = selectCurrentIndex(state.deck, state.currentSlideId)
      // `reset`, not `apply`: the shipped renderer owns its history, and an agent snapshot is a new
      // document state — not a command with an inverse this store computed. Replacing the document
      // and clearing the stacks (§5 `doc:open` semantics) keeps the two from forking. Undoing an
      // agent turn is coupled to the main-authoritative migration; noted in deck-update.ts.
      state.history.reset({ manifest, slides, notes, theme })
      set({
        ...published(state.history),
        currentSlideId: reselect(manifest, state.currentSlideId, previousIndex),
      })
      return true
    },

    applyAgentCommands: (commands, turnId, toolUseId) => {
      const state = get()
      const previousIndex = selectCurrentIndex(state.deck, state.currentSlideId)
      const result = applyAgentCommandsToHistory(state.history, commands, turnId, toolUseId)
      // A rejected batch leaves the document identical *by reference* (the funnel never mutated it),
      // so publishing anyway would notify every subscriber that nothing had changed.
      if (!result.ok) return result
      const manifest = state.history.doc.manifest
      set({
        ...published(state.history),
        currentSlideId: agentReselect(commands, manifest, state.currentSlideId, previousIndex),
      })
      return result
    },

    snapshotForAgent: () => snapshotOfDoc(get().history.doc),

    undo: () => {
      const state = get()
      const index = selectCurrentIndex(state.deck, state.currentSlideId)
      if (!state.history.undo().ok) return false
      set({
        ...published(state.history),
        currentSlideId: reselect(state.history.doc.manifest, state.currentSlideId, index),
      })
      return true
    },

    redo: () => {
      const state = get()
      const index = selectCurrentIndex(state.deck, state.currentSlideId)
      if (!state.history.redo().ok) return false
      set({
        ...published(state.history),
        currentSlideId: reselect(state.history.doc.manifest, state.currentSlideId, index),
      })
      return true
    },
  }
})
