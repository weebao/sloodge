/**
 * Renderer-side deck state: the open deck's manifest, the slide HTML the frames render, and the
 * current selection.
 *
 * Scope is deliberately M1.3-shaped — **read and select, nothing else**. Add/delete/reorder/edit go
 * through M1.4's command layer (`DocumentSession.apply` + `invert`, §5 of 10-architecture.md) so
 * that every mutation is undoable by construction; adding a bare `addSlide` action here would be a
 * mutation path that undo can never see, and it would have to be taken back out.
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

import {
  addSlide,
  createEmptyDeck,
  createSlideEntry,
  getSlide,
  hasSlide,
} from '../../../shared/document/deck'
import { createStarterSlideHtml } from '../../../shared/document/starter-slide'
import type { DeckManifest, SlideId } from '../../../shared/document/types'
import { createStore } from './createStore'

/** One slide as the rail and canvas need it: identity, label, and the bytes to render. */
export type SlideView = {
  readonly id: SlideId
  readonly title: string
  readonly html: string
}

export type SlideHtmlMap = Readonly<Record<string, string>>

export type DeckSnapshot = {
  readonly deck: DeckManifest
  readonly slideHtml: SlideHtmlMap
  /** `null` only for a deck with no slides — the shell renders its empty state then. */
  readonly currentSlideId: SlideId | null
}

export type DeckState = DeckSnapshot & {
  /** No-op for an id the deck does not contain, so a stale rail click cannot blank the canvas. */
  selectSlide: (id: SlideId) => void
  /** Select by position in `slideOrder`; out-of-range indices are ignored. */
  selectSlideAt: (index: number) => void
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
 * A slide whose bytes are not loaded renders as an empty document rather than vanishing from the
 * rail: the deck says it exists, and a silently shorter rail would be a worse lie than a blank card.
 */
export function selectSlideViews(deck: DeckManifest, slideHtml: SlideHtmlMap): SlideView[] {
  const views: SlideView[] = []
  for (const id of deck.slideOrder) {
    const entry = getSlide(deck, id)
    if (!entry) continue
    views.push({ id, title: entry.title, html: getSlideHtml(slideHtml, id) ?? '' })
  }
  return views
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
    deck = addSlide(deck, entry)
    html.push([
      entry.id,
      createStarterSlideHtml({
        id: entry.id,
        title: spec.title,
        ...(spec.subtitle === undefined ? {} : { subtitle: spec.subtitle }),
      }),
    ])
  }

  return {
    deck,
    slideHtml: htmlMap(html),
    currentSlideId: deck.slideOrder[0] ?? null,
  }
}

export const useDeckStore = createStore<DeckState>((set, get) => ({
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
}))
