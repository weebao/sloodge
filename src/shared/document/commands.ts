/**
 * `DocCommand` — the one vocabulary every document mutation is expressed in (§5 of
 * 10-architecture.md). Human edits, design-mode edits and agent tool calls all build commands and
 * push them through the same funnel; nothing is allowed to reach into a deck and change it.
 *
 * Two total functions over that vocabulary live here:
 *
 *   `applyCommand(doc, cmd)`      -> a new doc, or a typed error
 *   `invertCommand(doc, cmd)`     -> the command that undoes `cmd` **against that pre-state**
 *
 * The inverse is computed *before* the forward command runs, which is why every operation in
 * deck.ts is immutable: `invert` reads the pre-state that `apply` would otherwise have clobbered.
 * `applyBatch` does both in lockstep and is the only entry point history.ts uses.
 *
 * Deliberate shape decisions, and why:
 *
 *  - **Errors are values, never throws** (the store.ts convention): `{ ok: false, error: { code,
 *    message, issues? } }`. A command that cannot run — unknown slide id, index past the end, a
 *    theme patch that would delete a required color — fails loudly and leaves the document
 *    *identical by reference*. Silent no-ops are the failure mode this layer exists to prevent:
 *    an agent tool that "succeeded" while changing nothing is indistinguishable, downstream, from
 *    one that worked.
 *
 *  - **A batch is atomic.** `applyBatch` builds intermediate documents and returns the *original*
 *    reference if any command in the batch fails, so a half-applied batch cannot exist. This is
 *    free precisely because nothing mutates in place.
 *
 *  - **Commands are copied at the boundary, never aliased.** Anything a command puts *into* the
 *    document — `slide.insert`'s entry, `deck.setTheme`'s theme, the arrays in a meta or token
 *    patch — is deep-copied first. A caller that keeps a reference to the `SlideEntry` it just
 *    inserted and edits it later would otherwise be editing the live deck with no revision, no
 *    history entry and no patch: exactly the back door the funnel exists to close. `history.ts`
 *    copies the *commands* for the same reason, so what `redo()` replays cannot change under it.
 *
 *  - **No clock.** Commands are pure functions of `(doc, command)`; nothing stamps `updatedAt`.
 *    That is what makes undo an exact restoration rather than an approximation — a command layer
 *    that touched `updatedAt` could never satisfy `apply(inverse(apply(d)))` deep-equal `d`.
 *    `touchDeck` belongs to the save path, which knows when bytes actually hit disk.
 *
 *  - **`DeckDoc` is structural, and generic.** The M1.1 model splits the manifest (deck.ts) from
 *    the slide bodies (the `DeckBundle` that store.ts reads), but a `slide.setHtml` command needs
 *    both. So the command layer operates on the smallest shape that carries both — and does so
 *    generically (`<D extends DeckDoc>`), so `DocumentSession` can hand it a whole `DeckBundle`
 *    and get a `DeckBundle` back with `extras` (the forward-compat entries of §5.2) untouched.
 *    Declaring the type here rather than importing store.ts is what keeps this module free of
 *    Node and Electron.
 *
 * **Prototype-key discipline**, inherited from deck.ts and store.ts: slide ids in a command may
 * originate in the renderer or in a model's tool call, and they key `doc.slides` / `doc.notes`.
 * Every map this module builds is `Object.create(null)` and every read goes through
 * `Object.hasOwn`, so `{ t: 'slide.setHtml', id: 'constructor' }` is a `slide-not-found` error
 * rather than a function masquerading as slide HTML.
 *
 * Not implemented here, on purpose:
 *  - `slide.patchHtml` (byte-span edits) and the 500 ms drag coalescing that goes with it. Both
 *    are defined by design mode (40-design-mode.md) and neither has a producer yet; a `SpanEdit`
 *    invented now would be an untested guess at that milestone's shape. The union is open and
 *    `history.ts` treats entries opaquely, so it lands as an additive change.
 *  - `slide.reorder` (whole-order replacement). §5's union has `slide.move` only, and
 *    `reorderSlides` in deck.ts already covers the drag-drop case at the deck level; adding a
 *    second, wider ordering command would give two inverses for one user action.
 */

import {
  addSlide,
  DeckError,
  getSlide,
  hasSlide,
  indexOfSlide,
  moveSlide,
  removeSlide,
  updateSlide,
} from './deck'
import {
  DEFAULT_THEME_PATH,
  notesFilePath,
  parseManifest,
  parseTheme,
  SlideEntrySchema,
  type DeckManifest,
  type ManifestIssue,
  type SlideEntry,
  type SlideId,
  type Theme,
  type ThemeTokens,
} from './types'

/* -------------------------------------------------------------------------------------------- *
 * The document a command operates on
 * -------------------------------------------------------------------------------------------- */

/**
 * Manifest + bodies. Structurally a `DeckBundle` minus `extras`, so main can pass its bundle
 * straight in. `slides` and `notes` are keyed by slide id (never by archive path — the path is
 * derived from the id, and keying by it twice invites the two to disagree).
 */
export type DeckDoc = {
  manifest: DeckManifest
  /** Slide HTML by slide id. Every id in `manifest.slideOrder` must have an entry. */
  slides: Record<string, string>
  /** Speaker notes markdown by slide id. Absent key = the slide has no notes. */
  notes: Record<string, string>
  theme: Theme | null
}

/* -------------------------------------------------------------------------------------------- *
 * The command union (§5)
 * -------------------------------------------------------------------------------------------- */

/**
 * Deck-level metadata a user or an agent may rename. `null` removes an optional key, which is
 * what makes the inverse total: "this key was absent before" has to be expressible.
 * `title` is required by the schema, so it has no `null` case.
 */
export type DeckMetaPatch = {
  title?: string
  subtitle?: string | null
  authors?: readonly string[] | null
}

/**
 * A patch over `theme.tokens` (§4.2). Two levels: the group (`color`, `font`, …) and the token
 * within it. A `null` value deletes the token, so the inverse can restore "was absent" exactly.
 * Unknown token names are permitted — the theme schema's catchall decides whether the *value* is
 * legal, and it rejects a non-hex color no matter what it is called.
 */
export type ThemeTokenPatch = {
  color?: Readonly<Record<string, string | null>>
  font?: Readonly<Record<string, string | null>>
  size?: Readonly<Record<string, number | null>>
  space?: Readonly<Record<string, number | null>>
  /** The categorical chart palette. Replaced wholesale (it is an array); `null` removes it. */
  series?: readonly string[] | null
}

export type DocCommand =
  /** Insert a slide with its body. `notes` must be present iff `slide.notes` is. */
  | { t: 'slide.insert'; at: number; slide: SlideEntry; html: string; notes?: string }
  | { t: 'slide.remove'; id: SlideId }
  | { t: 'slide.move'; id: SlideId; to: number }
  | { t: 'slide.setHtml'; id: SlideId; html: string }
  /** `null` removes the notes file *and* the manifest's reference to it. */
  | { t: 'slide.setNotes'; id: SlideId; notes: string | null }
  /**
   * Replace the whole theme. `path` sets `manifest.theme` explicitly (`null` deletes it); when
   * omitted, a non-null theme defaults the path to `DEFAULT_THEME_PATH` and a null theme clears
   * it — because a manifest pointing at theme bytes that do not exist is a warning on every
   * subsequent open (see `readDeck`), and theme bytes with no manifest path refuse to save at all.
   */
  | { t: 'deck.setTheme'; theme: Theme | null; path?: string | null }
  | { t: 'deck.setThemeTokens'; patch: ThemeTokenPatch }
  | { t: 'deck.setMeta'; meta: DeckMetaPatch }

export type DocCommandType = DocCommand['t']

/* -------------------------------------------------------------------------------------------- *
 * Errors
 * -------------------------------------------------------------------------------------------- */

export type CommandErrorCode =
  /** No such slide in this deck (or an id that only resolves through `Object.prototype`). */
  | 'slide-not-found'
  | 'duplicate-slide-id'
  | 'index-out-of-range'
  /**
   * The deck's manifest lists a slide whose body this document does not carry. Loud rather than
   * repaired: a remove whose inverse cannot carry the HTML back is an undo that loses the slide.
   */
  | 'missing-slide-html'
  /** A `slide.insert` entry that the slide schema rejects (bad id, mismatched `file` path, …). */
  | 'invalid-slide-entry'
  /** `deck.setThemeTokens` against a deck that has no theme to patch. */
  | 'no-theme'
  /** The patched theme is no longer schema-valid (a required color deleted, a non-hex value, …). */
  | 'invalid-theme'
  /** The patched manifest is no longer schema-valid (an empty title, a 300-char subtitle, …). */
  | 'invalid-meta'
  /** `slide.insert` carrying notes text for a slide entry with no notes path, or vice versa. */
  | 'notes-mismatch'
  /**
   * A command carrying something `structuredClone` refuses (a function, a class instance). Not
   * reachable from any real producer — every command arrives as JSON — but the copy boundary must
   * fail as a value rather than throw a `DOMException` into an IPC handler.
   */
  | 'not-cloneable'

export type CommandError = {
  code: CommandErrorCode
  message: string
  /** Schema detail, in the shape `readDeck` already returns for a bad manifest. */
  issues?: ManifestIssue[]
  /** Which command in a batch failed. Absent for single-command calls. */
  index?: number
}

export type CommandResult<D> = { ok: true; doc: D } | { ok: false; error: CommandError }

export type InvertResult = { ok: true; command: DocCommand } | { ok: false; error: CommandError }

export type BatchResult<D> =
  { ok: true; doc: D; inverse: DocCommand[] } | { ok: false; error: CommandError }

function err(code: CommandErrorCode, message: string, extra: Partial<CommandError> = {}) {
  return { ok: false as const, error: { code, message, ...extra } }
}

/* -------------------------------------------------------------------------------------------- *
 * Prototype-safe maps (same discipline as store.ts)
 * -------------------------------------------------------------------------------------------- */

function emptyMap<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>
}

function copyMap<T>(source: Readonly<Record<string, T>>): Record<string, T> {
  const map = emptyMap<T>()
  for (const key of Object.keys(source)) map[key] = source[key]!
  return map
}

function get<T>(map: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.hasOwn(map, key) ? map[key] : undefined
}

export type CloneResult<T> = { ok: true; value: T } | { ok: false; message: string }

/**
 * `structuredClone`, made total.
 *
 * The clone is what keeps caller-owned objects out of the document (see the file header), but
 * `structuredClone` *throws* a `DataCloneError` on a function or any other non-cloneable value,
 * and "errors are values, never throws" is this layer's contract — a `DOMException` surfacing in
 * an IPC handler would arrive with no error code at all. No real producer can reach it (every
 * command source is JSON: an IPC payload, an agent tool call, or `.sloodge` bytes), so this is a
 * contract guard rather than a hot path.
 */
function clone<T>(value: T): CloneResult<T> {
  try {
    return { ok: true, value: structuredClone(value) }
  } catch {
    return { ok: false, message: 'is not structured-cloneable' }
  }
}

/**
 * `{ ...doc, ...next }` widens to `D & Partial<DeckDoc>`, which TypeScript will not narrow back to
 * `D`. The cast is sound because every key we overwrite is declared on `DeckDoc` and `D extends
 * DeckDoc`: extra members (a bundle's `extras`) ride through the spread untouched, which is the
 * whole point of the generic.
 */
function withDoc<D extends DeckDoc>(doc: D, next: Partial<DeckDoc>): D {
  return { ...doc, ...next } as D
}

function issuesOf(issues: ManifestIssue[]): string {
  return issues.map((issue) => `${issue.path}: ${issue.message}`).join('; ')
}

/* -------------------------------------------------------------------------------------------- *
 * Reads that every command shares
 * -------------------------------------------------------------------------------------------- */

/**
 * The notes text of a slide, or `null` when it has none.
 *
 * A manifest entry carrying a `notes` path with no text in the document is *not* a third state:
 * only a repaired open can produce it (`readDeck` warns "missing notes file" and leaves the key
 * out), and it is reported here as "no notes" so that undo normalizes the dangling reference away
 * rather than preserving an inconsistency the format cannot represent.
 */
function notesOf(doc: DeckDoc, id: SlideId): string | null {
  return get(doc.notes, id) ?? null
}

/**
 * Swap one slide entry for another, keeping the order and the null-prototype slide map. The one
 * thing `updateSlide` cannot express: *removing* an optional key (see `slide.setNotes`).
 */
function replaceEntry(manifest: DeckManifest, entry: SlideEntry): DeckManifest {
  const slides = copyMap(manifest.slides)
  slides[entry.id] = entry
  return { ...manifest, slides }
}

/** Map a throw out of deck.ts onto this module's error values. deck.ts is the only thrower. */
function fromDeckError(error: unknown) {
  if (error instanceof DeckError) {
    const code: CommandErrorCode =
      error.code === 'not-a-permutation' ? 'index-out-of-range' : error.code
    return err(code, error.message)
  }
  throw error
}

/* -------------------------------------------------------------------------------------------- *
 * apply
 * -------------------------------------------------------------------------------------------- */

function applySlideInsert<D extends DeckDoc>(doc: D, command: DocCommand & { t: 'slide.insert' }) {
  // Copied, not referenced: everything a command stores in the document is deep-copied at this
  // boundary (see the file header). Without it, a caller that keeps editing the `SlideEntry` it
  // just inserted edits the live deck behind the funnel's back — no revision, no history entry.
  //
  // Cloned *before* validation, not after: validating the caller's object and then copying it
  // leaves a TOCTOU window where a getter returns something different the second time.
  const cloned = clone(command.slide)
  if (!cloned.ok) return err('invalid-slide-entry', `slide.insert entry ${cloned.message}`)
  const entry = cloned.value
  const parsed = SlideEntrySchema.safeParse(entry)
  if (!parsed.success) {
    return err('invalid-slide-entry', `slide.insert entry failed validation`, {
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.map(String).join('.'),
        message: issue.message,
      })),
    })
  }
  // No `entry.file` check here: `SlideEntrySchema.superRefine` already rejects any entry whose
  // `file` is not `slides/<id>.html` (types.ts), so a second guard is dead code that reads as
  // though the schema were weaker than it is.
  const wantsNotes = entry.notes !== undefined
  if (wantsNotes !== (command.notes !== undefined)) {
    return err(
      'notes-mismatch',
      `slide.insert for ${entry.id} ${wantsNotes ? 'declares a notes file but carries no notes text' : 'carries notes text but declares no notes file'}`,
    )
  }
  // A body with no manifest entry is invisible to every reader but would be silently overwritten
  // here, so it is a duplicate too — the manifest is not the only place a slide id can exist.
  if (Object.hasOwn(doc.slides, entry.id)) {
    return err('duplicate-slide-id', `document already holds HTML for slide ${entry.id}`)
  }

  let manifest: DeckManifest
  try {
    manifest = addSlide(doc.manifest, entry, command.at)
  } catch (error) {
    return fromDeckError(error)
  }

  const slides = copyMap(doc.slides)
  slides[entry.id] = command.html
  const notes = copyMap(doc.notes)
  if (command.notes !== undefined) notes[entry.id] = command.notes
  return { ok: true as const, doc: withDoc(doc, { manifest, slides, notes }) }
}

function applySlideRemove<D extends DeckDoc>(doc: D, command: DocCommand & { t: 'slide.remove' }) {
  let manifest: DeckManifest
  try {
    manifest = removeSlide(doc.manifest, command.id)
  } catch (error) {
    return fromDeckError(error)
  }
  const slides = copyMap(doc.slides)
  delete slides[command.id]
  const notes = copyMap(doc.notes)
  delete notes[command.id]
  return { ok: true as const, doc: withDoc(doc, { manifest, slides, notes }) }
}

function applySlideMove<D extends DeckDoc>(doc: D, command: DocCommand & { t: 'slide.move' }) {
  try {
    return {
      ok: true as const,
      doc: withDoc(doc, { manifest: moveSlide(doc.manifest, command.id, command.to) }),
    }
  } catch (error) {
    return fromDeckError(error)
  }
}

function applySlideSetHtml<D extends DeckDoc>(
  doc: D,
  command: DocCommand & { t: 'slide.setHtml' },
) {
  if (!hasSlide(doc.manifest, command.id)) {
    return err('slide-not-found', `no slide ${command.id} in deck ${doc.manifest.id}`)
  }
  const slides = copyMap(doc.slides)
  slides[command.id] = command.html
  return { ok: true as const, doc: withDoc(doc, { slides }) }
}

function applySlideSetNotes<D extends DeckDoc>(
  doc: D,
  command: DocCommand & { t: 'slide.setNotes' },
) {
  const entry = getSlide(doc.manifest, command.id)
  if (!entry) return err('slide-not-found', `no slide ${command.id} in deck ${doc.manifest.id}`)

  const notes = copyMap(doc.notes)
  let manifest = doc.manifest
  try {
    if (command.notes === null) {
      delete notes[command.id]
      // `updateSlide` shallow-*merges*, so it can set a key but never remove one — and a
      // `notes: undefined` left on the entry would serialize as an absent key while comparing
      // unequal to one under `toStrictEqual`. Rebuild the entry without the key instead.
      if (entry.notes !== undefined) {
        const { notes: _dropped, ...rest } = entry
        manifest = replaceEntry(doc.manifest, rest)
      }
    } else {
      notes[command.id] = command.notes
      if (entry.notes === undefined) {
        manifest = updateSlide(doc.manifest, command.id, { notes: notesFilePath(command.id) })
      }
    }
  } catch (error) {
    return fromDeckError(error)
  }
  return { ok: true as const, doc: withDoc(doc, { manifest, notes }) }
}

/** Resolve the `manifest.theme` path a `deck.setTheme` implies (see the command's docblock). */
function themePathFor(
  command: DocCommand & { t: 'deck.setTheme' },
  current: DeckManifest,
): string | null {
  if (command.path !== undefined) return command.path
  if (command.theme === null) return null
  return current.theme ?? DEFAULT_THEME_PATH
}

function applyDeckSetTheme<D extends DeckDoc>(
  doc: D,
  command: DocCommand & { t: 'deck.setTheme' },
) {
  // Copied for the same reason as `slide.insert`'s entry: a caller that retints the `Theme` object
  // it handed us would otherwise be retinting the live document.
  let theme: Theme | null = null
  if (command.theme !== null) {
    const cloned = clone(command.theme)
    if (!cloned.ok) return err('invalid-theme', `theme ${cloned.message}`)
    theme = cloned.value
  }
  if (theme !== null) {
    const parsed = parseTheme(theme)
    if (!parsed.ok) {
      return err('invalid-theme', `theme failed validation — ${issuesOf(parsed.issues)}`, {
        issues: parsed.issues,
      })
    }
  }
  const path = themePathFor(command, doc.manifest)
  const manifest = { ...doc.manifest }
  if (path === null) delete manifest.theme
  else manifest.theme = path
  return { ok: true as const, doc: withDoc(doc, { manifest, theme }) }
}

/**
 * Merge one `{ token: value | null }` group into its current object. `null` deletes.
 *
 * Null-prototype, like every other map in this file: `next['__proto__'] = '#fff'` on an ordinary
 * object hits the prototype *setter* and is silently discarded, so a patch naming a token
 * `__proto__` would return `{ ok: true }` having changed nothing — the "succeeded while doing
 * nothing" failure this layer exists to prevent. On a null-prototype object it is an ordinary own
 * key, which `parseTheme` then rejects outright (`__proto__ is not a permitted key`), so the
 * caller gets a loud `invalid-theme` instead.
 */
function mergeGroup<V extends string | number>(
  current: Readonly<Record<string, unknown>>,
  patch: Readonly<Record<string, V | null>>,
): Record<string, unknown> {
  const next = copyMap(current)
  for (const key of Object.keys(patch)) {
    const value = patch[key]
    if (value === null || value === undefined) delete next[key]
    else next[key] = value
  }
  return next
}

function applyDeckSetThemeTokens<D extends DeckDoc>(
  doc: D,
  command: DocCommand & { t: 'deck.setThemeTokens' },
) {
  if (doc.theme === null) {
    return err('no-theme', `deck ${doc.manifest.id} has no theme to patch`)
  }
  const { patch } = command
  const tokens = { ...doc.theme.tokens } as Record<string, unknown>
  if (patch.color) tokens['color'] = mergeGroup(doc.theme.tokens.color, patch.color)
  if (patch.font) tokens['font'] = mergeGroup(doc.theme.tokens.font, patch.font)
  if (patch.size) tokens['size'] = mergeGroup(doc.theme.tokens.size, patch.size)
  if (patch.space) tokens['space'] = mergeGroup(doc.theme.tokens.space, patch.space)
  if (patch.series !== undefined) {
    if (patch.series === null) delete tokens['series']
    else tokens['series'] = [...patch.series]
  }

  const theme: Theme = { ...doc.theme, tokens: tokens as unknown as ThemeTokens }
  // Validated, not trusted: the patch is the one place a caller can hand us a value the schema
  // has an opinion about (a non-hex color, a 12 px body size, a 2-entry series palette). We keep
  // the object we built rather than zod's output so the round-trip is exact by construction.
  const parsed = parseTheme(theme)
  if (!parsed.ok) {
    return err('invalid-theme', `theme tokens failed validation — ${issuesOf(parsed.issues)}`, {
      issues: parsed.issues,
    })
  }
  return { ok: true as const, doc: withDoc(doc, { theme }) }
}

function applyDeckSetMeta<D extends DeckDoc>(doc: D, command: DocCommand & { t: 'deck.setMeta' }) {
  const { meta } = command
  const manifest = { ...doc.manifest }
  if (meta.title !== undefined) manifest.title = meta.title
  if (meta.subtitle !== undefined) {
    if (meta.subtitle === null) delete manifest.subtitle
    else manifest.subtitle = meta.subtitle
  }
  if (meta.authors !== undefined) {
    if (meta.authors === null) delete manifest.authors
    else manifest.authors = [...meta.authors]
  }
  const parsed = parseManifest(manifest)
  if (!parsed.ok) {
    return err('invalid-meta', `deck metadata failed validation — ${issuesOf(parsed.issues)}`, {
      issues: parsed.issues,
    })
  }
  return { ok: true as const, doc: withDoc(doc, { manifest }) }
}

/**
 * Apply one command. Never throws, never mutates: on failure the caller's document is returned
 * untouched (by reference), and on success every object the command did not need is shared.
 */
export function applyCommand<D extends DeckDoc>(doc: D, command: DocCommand): CommandResult<D> {
  switch (command.t) {
    case 'slide.insert':
      return applySlideInsert(doc, command)
    case 'slide.remove':
      return applySlideRemove(doc, command)
    case 'slide.move':
      return applySlideMove(doc, command)
    case 'slide.setHtml':
      return applySlideSetHtml(doc, command)
    case 'slide.setNotes':
      return applySlideSetNotes(doc, command)
    case 'deck.setTheme':
      return applyDeckSetTheme(doc, command)
    case 'deck.setThemeTokens':
      return applyDeckSetThemeTokens(doc, command)
    case 'deck.setMeta':
      return applyDeckSetMeta(doc, command)
  }
}

/* -------------------------------------------------------------------------------------------- *
 * invert
 * -------------------------------------------------------------------------------------------- */

/**
 * The previous value of every token in one group, `null` where the token was absent — which is
 * what makes "this token did not exist before" survive an undo instead of leaving dead keys
 * behind in `theme.json`.
 */
function invertGroup<V extends string | number>(
  current: Readonly<Record<string, unknown>>,
  forward: Readonly<Record<string, V | null>>,
): Record<string, V | null> {
  // Null-prototype for uniformity with `mergeGroup` and every other map in this file, not because
  // anything observable depends on it here: `applyBatch` inverts before it applies, and a forward
  // patch naming a `__proto__` token is rejected by `parseTheme`, so a batch carrying one aborts
  // before its inverse is ever stacked.
  const out = emptyMap<V | null>()
  for (const key of Object.keys(forward)) {
    out[key] = Object.hasOwn(current, key) ? (current[key] as V) : null
  }
  return out
}

/** The previous value of every group/token a patch touches. */
function invertTokenPatch(tokens: ThemeTokens, patch: ThemeTokenPatch): ThemeTokenPatch {
  const inverse: ThemeTokenPatch = {}
  if (patch.color) inverse.color = invertGroup<string>(tokens.color, patch.color)
  if (patch.font) inverse.font = invertGroup<string>(tokens.font, patch.font)
  if (patch.size) inverse.size = invertGroup<number>(tokens.size, patch.size)
  if (patch.space) inverse.space = invertGroup<number>(tokens.space, patch.space)
  if (patch.series !== undefined) inverse.series = tokens.series ? [...tokens.series] : null
  return inverse
}

/** The previous value of every deck-meta key a patch touches, `null` where the key was absent. */
function invertMetaPatch(manifest: DeckManifest, meta: DeckMetaPatch): DeckMetaPatch {
  const inverse: DeckMetaPatch = {}
  if (meta.title !== undefined) inverse.title = manifest.title
  if (meta.subtitle !== undefined) inverse.subtitle = manifest.subtitle ?? null
  if (meta.authors !== undefined) inverse.authors = manifest.authors ? [...manifest.authors] : null
  return inverse
}

/**
 * The command that undoes `command`, computed against the document as it stands **before**
 * `command` runs. Every command type has a total inverse — that totality is what lets history.ts
 * treat undo as "apply the inverse batch" with no per-type special cases.
 *
 * A command that could not be applied has no meaningful inverse, so the preconditions checked
 * here are the same ones `applyCommand` checks; `applyBatch` runs the two together.
 */
export function invertCommand(doc: DeckDoc, command: DocCommand): InvertResult {
  switch (command.t) {
    case 'slide.insert':
      return { ok: true, command: { t: 'slide.remove', id: command.slide.id } }

    case 'slide.remove': {
      const entry = getSlide(doc.manifest, command.id)
      if (!entry) return err('slide-not-found', `no slide ${command.id} in deck ${doc.manifest.id}`)
      const html = get(doc.slides, command.id)
      if (html === undefined) {
        // Refusing here is the point: a remove whose inverse cannot carry the body back is an
        // undo that silently loses the slide's HTML.
        return err('missing-slide-html', `document holds no HTML for slide ${command.id}`)
      }
      const at = indexOfSlide(doc.manifest, command.id)
      if (at === -1) {
        return err('slide-not-found', `slide ${command.id} is not in the order of this deck`)
      }
      const notes = notesOf(doc, command.id)
      const inverse: DocCommand = { t: 'slide.insert', at, slide: entry, html }
      if (notes !== null) inverse.notes = notes
      // See `notesOf`: a dangling `entry.notes` path with no text is normalized away rather than
      // restored, because `slide.insert` would reject the pair as a `notes-mismatch`.
      if (notes === null && entry.notes !== undefined) {
        const { notes: _dropped, ...rest } = entry
        inverse.slide = rest
      }
      return { ok: true, command: inverse }
    }

    case 'slide.move': {
      const from = indexOfSlide(doc.manifest, command.id)
      if (from === -1) {
        return err('slide-not-found', `no slide ${command.id} in deck ${doc.manifest.id}`)
      }
      return { ok: true, command: { t: 'slide.move', id: command.id, to: from } }
    }

    case 'slide.setHtml': {
      if (!hasSlide(doc.manifest, command.id)) {
        return err('slide-not-found', `no slide ${command.id} in deck ${doc.manifest.id}`)
      }
      const html = get(doc.slides, command.id)
      if (html === undefined) {
        return err('missing-slide-html', `document holds no HTML for slide ${command.id}`)
      }
      return { ok: true, command: { t: 'slide.setHtml', id: command.id, html } }
    }

    case 'slide.setNotes': {
      if (!hasSlide(doc.manifest, command.id)) {
        return err('slide-not-found', `no slide ${command.id} in deck ${doc.manifest.id}`)
      }
      return {
        ok: true,
        command: { t: 'slide.setNotes', id: command.id, notes: notesOf(doc, command.id) },
      }
    }

    case 'deck.setTheme':
      return {
        ok: true,
        command: { t: 'deck.setTheme', theme: doc.theme, path: doc.manifest.theme ?? null },
      }

    case 'deck.setThemeTokens': {
      if (doc.theme === null)
        return err('no-theme', `deck ${doc.manifest.id} has no theme to patch`)
      return {
        ok: true,
        command: {
          t: 'deck.setThemeTokens',
          patch: invertTokenPatch(doc.theme.tokens, command.patch),
        },
      }
    }

    case 'deck.setMeta':
      return {
        ok: true,
        command: { t: 'deck.setMeta', meta: invertMetaPatch(doc.manifest, command.meta) },
      }
  }
}

/* -------------------------------------------------------------------------------------------- *
 * batches
 * -------------------------------------------------------------------------------------------- */

/**
 * Apply a batch and return its inverse batch. All-or-nothing: the first failure aborts and the
 * caller's document comes back untouched (§5 step 1 — "unknown slide id → reject the whole
 * batch"). The inverse is in reverse order, so applying it undoes the batch step by step.
 */
export function applyBatch<D extends DeckDoc>(
  doc: D,
  commands: readonly DocCommand[],
): BatchResult<D> {
  let current = doc
  const inverse: DocCommand[] = []
  for (const [index, command] of commands.entries()) {
    const inverted = invertCommand(current, command)
    if (!inverted.ok) return { ok: false, error: { ...inverted.error, index } }
    const applied = applyCommand(current, command)
    if (!applied.ok) return { ok: false, error: { ...applied.error, index } }
    current = applied.doc
    inverse.unshift(inverted.command)
  }
  return { ok: true, doc: current, inverse }
}

/**
 * Deep-copy a command. Used by `history.ts` before a batch is applied and stacked, so that a
 * caller mutating the object it passed to `apply` cannot change what `redo()` replays.
 *
 * **Deep, not shallow, and that depth is the mechanism.** A `slide.setHtml` carries nothing but
 * strings, which a spread protects just as well — but a `slide.insert` carries a `SlideEntry` and
 * a `deck.setTheme` a whole `Theme`, so `{ ...command }` would put the caller's nested object back
 * on the redo stack and hand it to the document on the next redo. There is a test on exactly that
 * path (history.test.ts, "replays the nested payload it recorded").
 *
 * `structuredClone` rather than a JSON round-trip: commands *are* JSON-pure data (that is what
 * lets the §6 recovery journal replay them), but `structuredClone` says so without silently
 * dropping a key the way `JSON.stringify` would if that ever stopped being true.
 *
 * Cost, measured: ~2.8 ms per `apply` of a 2 MB `slide.setHtml`, essentially all of it copying a
 * string that is immutable and needs no copy at all. Left uniform because nothing edits at that
 * rate yet — design mode's coalescing (40-design-mode.md) is the consumer that would care, and it
 * is deferred. The honest optimization when it lands is a per-variant copy (spread for the
 * string-only variants, `clone` for the four that carry objects); the depth test above is what
 * makes that a safe change rather than a silent revert of this one.
 */
export function cloneCommand(command: DocCommand): CloneResult<DocCommand> {
  return clone(command)
}

/**
 * An estimated retained cost for a command, used by history.ts's soft memory cap. It counts the
 * fields that are actually unbounded — slide HTML, notes, a serialized slide entry or theme — and
 * folds everything else into a small constant.
 *
 * Deliberately an estimate, and it under-counts in two known ways: string lengths are UTF-16 code
 * units rather than UTF-8 bytes (so non-Latin decks cost more than this reports), and the small
 * constant stands in for object overhead that a real heap walk would charge more for. The cap it
 * feeds is a soft one whose job is to stop a hundred rewrites of a 2 MB slide from pinning 400 MB,
 * not to be an allocator.
 */
export function commandBytes(command: DocCommand): number {
  const overhead = 128
  switch (command.t) {
    case 'slide.insert':
      // The entry rides in the command too, and a `slide.remove`'s inverse is a `slide.insert` —
      // so leaving it out under-reported the cost of every delete.
      return (
        overhead +
        command.html.length +
        (command.notes?.length ?? 0) +
        JSON.stringify(command.slide).length
      )
    case 'slide.setHtml':
      return overhead + command.html.length
    case 'slide.setNotes':
      return overhead + (command.notes?.length ?? 0)
    case 'deck.setTheme':
      return overhead + (command.theme === null ? 0 : JSON.stringify(command.theme).length)
    default:
      return overhead
  }
}
