/**
 * The in-memory deck model: pure, immutable operations over a `DeckManifest`.
 *
 * Every operation returns a *new* manifest and never mutates its input. That is deliberate —
 * M1.2's command/undo layer (`DocumentSession.apply` + `invert`, see 10-architecture.md §5)
 * wraps these functions, and computing an inverse is only sound if the pre-state is still
 * intact after the forward op ran.
 *
 * Scope: the manifest only. Slide HTML, notes text and theme bytes live in the bundle that
 * `src/main/document/store.ts` reads and writes; callers that duplicate or delete a slide are
 * responsible for the matching file copy/removal there.
 *
 * **Prototype-key discipline** (the same rule store.ts states at its head, applied here because
 * M1.2's command layer calls these functions with ids that originate in the renderer). Slide ids
 * are attacker-influenced strings used as object keys, so `deck.slides[id]` on a plain object
 * would resolve `constructor`/`toString` up the prototype chain and hand back a function — or, in
 * `updateSlide`, fabricate a slide out of `Object.prototype.toString`. Every read goes through
 * `getSlide`/`hasSlide` (i.e. `Object.hasOwn`) and every map this module builds is a
 * null-prototype object, so the two can never disagree about what the deck contains. Today only
 * the `s_<ULID>` schema regex keeps the bad ids out; this makes the guarantee structural.
 */

import { createSlideId } from '../slide-id'
import {
  CANVAS_HEIGHT,
  CANVAS_WIDTH,
  DEFAULT_SLIDE_HIDDEN,
  DEFAULT_SLIDE_KIND,
  MAX_FORMAT_VERSION,
  notesFilePath,
  slideFilePath,
  type DeckManifest,
  type SlideCapability,
  type SlideEntry,
  type SlideId,
} from './types'

export type DeckErrorCode =
  'slide-not-found' | 'duplicate-slide-id' | 'index-out-of-range' | 'not-a-permutation'

export class DeckError extends Error {
  readonly code: DeckErrorCode

  constructor(code: DeckErrorCode, message: string) {
    super(message)
    this.name = 'DeckError'
    this.code = code
  }
}

export function newDeckId(now: number = Date.now()): string {
  return `d_${createSlideId(now)}`
}

export function newSlideId(now: number = Date.now()): SlideId {
  return `s_${createSlideId(now)}`
}

export function newAssetId(now: number = Date.now()): string {
  return `a_${createSlideId(now)}`
}

/**
 * A slide map that cannot be reached through `Object.prototype`. Every manifest this module
 * produces carries one, so a bare index would return `undefined` rather than a prototype member
 * even if some future call site forgets `Object.hasOwn`.
 */
function slideMap(source?: Readonly<Record<string, SlideEntry>>): Record<string, SlideEntry> {
  const map = Object.create(null) as Record<string, SlideEntry>
  if (source) {
    for (const key of Object.keys(source)) map[key] = source[key]!
  }
  return map
}

export type CreateDeckOptions = {
  id?: string
  title?: string
  subtitle?: string
  authors?: readonly string[]
  /** Epoch ms; injectable so tests are deterministic. */
  now?: number
  generator?: { app: string; version: string }
  /**
   * Archive path of the deck's `theme.json`. Omitted by default — see `createEmptyDeck`. Pass
   * `DEFAULT_THEME_PATH` when you are also supplying theme bytes to write alongside the manifest.
   */
  theme?: string
}

/**
 * A brand new, slideless deck. `slideOrder`/`slides` are empty, which the schema allows.
 *
 * **No `theme` key unless one is asked for.** `manifest.theme` is a *reference to a file in the
 * archive*, and §2 of 30-slide-format.md marks it optional (`"default": "theme/theme.json"` is a
 * reader-side default, not a promise that the file exists). §4.3 is explicit about when the file
 * appears: "user picks a theme → `theme.json` written, `version` bumped". Nothing in M1.1 picks a
 * theme, so a manifest that pointed at `theme/theme.json` would name a file no writer creates and
 * `readDeck` would — correctly — report `missing theme file theme/theme.json` on every open of
 * every brand-new deck. The alternative (materializing a default `theme.json` at save time) would
 * have to invent a theme id, name and palette that §4.2 says the user chose, and would make the
 * reader's genuine "your theme file is gone" warning unreachable. Slides are self-contained and
 * carry their own `sl:theme` token block (§4.1), so a themeless deck renders correctly.
 */
export function createEmptyDeck(options: CreateDeckOptions = {}): DeckManifest {
  const now = options.now ?? Date.now()
  const iso = new Date(now).toISOString()
  const manifest: DeckManifest = {
    formatVersion: MAX_FORMAT_VERSION,
    id: options.id ?? newDeckId(now),
    title: options.title ?? 'Untitled deck',
    createdAt: iso,
    updatedAt: iso,
    canvas: { width: CANVAS_WIDTH, height: CANVAS_HEIGHT },
    slideOrder: [],
    slides: slideMap(),
  }
  if (options.theme !== undefined) manifest.theme = options.theme
  if (options.subtitle !== undefined) manifest.subtitle = options.subtitle
  if (options.authors !== undefined) manifest.authors = [...options.authors]
  if (options.generator !== undefined) manifest.generator = { ...options.generator }
  return manifest
}

export type CreateSlideEntryOptions = {
  id?: SlideId
  title?: string
  kind?: SlideEntry['kind']
  capabilities?: readonly SlideCapability[]
  /** Attach a `notes/<id>.md` reference. The note file itself is the caller's business. */
  withNotes?: boolean
  hidden?: boolean
  origin?: SlideEntry['origin']
  now?: number
}

/** Build a manifest entry for a slide. Pure; does not touch a deck. */
export function createSlideEntry(options: CreateSlideEntryOptions = {}): SlideEntry {
  const now = options.now ?? Date.now()
  const iso = new Date(now).toISOString()
  const id = options.id ?? newSlideId(now)
  const entry: SlideEntry = {
    id,
    file: slideFilePath(id),
    title: options.title ?? 'Untitled slide',
    kind: options.kind ?? DEFAULT_SLIDE_KIND,
    capabilities: options.capabilities ? [...options.capabilities] : ['static'],
    hidden: options.hidden ?? DEFAULT_SLIDE_HIDDEN,
    createdAt: iso,
    updatedAt: iso,
    validation: { status: 'unknown' },
  }
  if (options.withNotes) entry.notes = notesFilePath(id)
  if (options.origin !== undefined) entry.origin = { ...options.origin }
  return entry
}

/** The one read path into `deck.slides`. `Object.hasOwn`, never a bare index (see file header). */
export function getSlide(deck: DeckManifest, id: SlideId): SlideEntry | undefined {
  return Object.hasOwn(deck.slides, id) ? deck.slides[id] : undefined
}

export function hasSlide(deck: DeckManifest, id: SlideId): boolean {
  return Object.hasOwn(deck.slides, id)
}

export function slideCount(deck: DeckManifest): number {
  return deck.slideOrder.length
}

/** Slides in presentation order — `slideOrder` is authoritative, filenames are not. */
export function slidesInOrder(deck: DeckManifest): SlideEntry[] {
  const out: SlideEntry[] = []
  for (const id of deck.slideOrder) {
    const slide = getSlide(deck, id)
    if (slide) out.push(slide)
  }
  return out
}

export function indexOfSlide(deck: DeckManifest, id: SlideId): number {
  return deck.slideOrder.indexOf(id)
}

function requireSlide(deck: DeckManifest, id: SlideId): SlideEntry {
  const slide = getSlide(deck, id)
  if (!slide) throw new DeckError('slide-not-found', `no slide ${id} in deck ${deck.id}`)
  return slide
}

/** Position of `id` in `slideOrder`, or a `slide-not-found` throw — never a silent -1 (see below). */
function requireIndex(deck: DeckManifest, id: SlideId): number {
  const index = indexOfSlide(deck, id)
  if (index === -1) {
    // Invariant 1 (slideOrder is a permutation of the slide keys) makes this unreachable for any
    // schema-valid manifest. Guarded anyway because the failure is silent and destructive:
    // `splice(-1, 1)` drops the *last* slide and an insert at `-1 + 1` lands at the front.
    throw new DeckError('slide-not-found', `slide ${id} is not in the order of deck ${deck.id}`)
  }
  return index
}

function withSlides(
  deck: DeckManifest,
  slides: Readonly<Record<string, SlideEntry>>,
  slideOrder: SlideId[],
): DeckManifest {
  return { ...deck, slides: slideMap(slides), slideOrder }
}

/** Insert an entry at `index` (default: append). Rejects an id already in the deck. */
export function addSlide(deck: DeckManifest, entry: SlideEntry, index?: number): DeckManifest {
  if (hasSlide(deck, entry.id)) {
    throw new DeckError('duplicate-slide-id', `slide ${entry.id} is already in deck ${deck.id}`)
  }
  const at = index ?? deck.slideOrder.length
  if (!Number.isInteger(at) || at < 0 || at > deck.slideOrder.length) {
    throw new DeckError('index-out-of-range', `cannot insert at ${String(index)}`)
  }
  const slideOrder = [...deck.slideOrder]
  slideOrder.splice(at, 0, entry.id)
  return withSlides(deck, { ...deck.slides, [entry.id]: entry }, slideOrder)
}

export function removeSlide(deck: DeckManifest, id: SlideId): DeckManifest {
  requireSlide(deck, id)
  const slides = { ...deck.slides }
  delete slides[id]
  return withSlides(
    deck,
    slides,
    deck.slideOrder.filter((candidate) => candidate !== id),
  )
}

/**
 * Duplicate a slide entry. Ids are immutable for the life of a slide (§1.2), so the copy mints
 * a fresh id and fresh `slides/`/`notes/` paths; the copy lands directly after the original.
 * Validation is reset to `unknown` — the cached result belongs to the original's contentHash.
 */
export function duplicateSlide(
  deck: DeckManifest,
  id: SlideId,
  options: { newId?: SlideId; now?: number; title?: string } = {},
): DeckManifest {
  const source = requireSlide(deck, id)
  const at = requireIndex(deck, id)
  const now = options.now ?? Date.now()
  const iso = new Date(now).toISOString()
  const newId = options.newId ?? newSlideId(now)
  if (hasSlide(deck, newId)) {
    throw new DeckError('duplicate-slide-id', `slide ${newId} is already in deck ${deck.id}`)
  }
  const copy: SlideEntry = {
    ...structuredClone(source),
    id: newId,
    file: slideFilePath(newId),
    title: options.title ?? source.title,
    createdAt: iso,
    updatedAt: iso,
    validation: { status: 'unknown' },
  }
  if (source.notes !== undefined) copy.notes = notesFilePath(newId)
  if (source.thumb !== undefined) delete copy.thumb
  return addSlide(deck, copy, at + 1)
}

/** Move one slide to an absolute index in the new order. */
export function moveSlide(deck: DeckManifest, id: SlideId, to: number): DeckManifest {
  requireSlide(deck, id)
  const from = requireIndex(deck, id)
  if (!Number.isInteger(to) || to < 0 || to >= deck.slideOrder.length) {
    throw new DeckError('index-out-of-range', `cannot move to ${String(to)}`)
  }
  if (from === to) return deck
  const slideOrder = [...deck.slideOrder]
  slideOrder.splice(from, 1)
  slideOrder.splice(to, 0, id)
  return withSlides(deck, { ...deck.slides }, slideOrder)
}

/** Replace the whole order. The argument must be a permutation of the current ids. */
export function reorderSlides(deck: DeckManifest, order: readonly SlideId[]): DeckManifest {
  const current = new Set(deck.slideOrder)
  const next = new Set(order)
  const samePermutation =
    order.length === deck.slideOrder.length &&
    next.size === order.length &&
    order.every((id) => current.has(id))
  if (!samePermutation) {
    throw new DeckError(
      'not-a-permutation',
      'reorderSlides expects a permutation of the deck slide ids',
    )
  }
  return withSlides(deck, { ...deck.slides }, [...order])
}

/** Shallow-merge a patch into one slide entry. `id` and `file` are not patchable. */
export function updateSlide(
  deck: DeckManifest,
  id: SlideId,
  patch: Omit<Partial<SlideEntry>, 'id' | 'file'>,
): DeckManifest {
  const slide = requireSlide(deck, id)
  const next: SlideEntry = { ...slide, ...patch, id: slide.id, file: slide.file }
  return withSlides(deck, { ...deck.slides, [id]: next }, [...deck.slideOrder])
}

/** Stamp `updatedAt`. Kept separate so ops stay pure and testable without a clock. */
export function touchDeck(deck: DeckManifest, now: number = Date.now()): DeckManifest {
  return { ...deck, updatedAt: new Date(now).toISOString() }
}
