/**
 * `.sloodge` container I/O — the read/write half of §1.1 and §5.2 of 30-slide-format.md.
 *
 * **The zip layer lives in [`archive.ts`](archive.ts), not here.** M1.1 hardened it over eight
 * review rounds — zip-slip, symlink members, decompression bombs, ZIP64 divergence from fflate's
 * own arithmetic, aliased local headers, entry-count floods, prototype-pollution names — and M4.5
 * moved it down one level unchanged so PPTX import reads untrusted archives through *that* parser
 * instead of a second one. This module is now the `.sloodge` semantics on top: manifest, slides,
 * notes, theme, extras, and the atomic write. Every archive-level guarantee (bounded peak
 * allocation, a read that always settles, entry-name safety) is documented and tested there.
 *
 * Writing still happens here, and uses `zipSync` deliberately. fflate's asynchronous `zip` starts
 * *every* member in one `for` loop with no queue and no concurrency limit (lib/index.cjs:2280-2284),
 * spawning a `worker_threads` Worker per member over 160 kB, so peak memory is the sum of every
 * member's buffers plus one V8 isolate and one structured-clone copy of its input each — measured
 * at ~11 MB of RSS per member, i.e. +1.7 GB to save a 240 kB deck. `zipSync` on the same input
 * grows RSS by nothing and runs ~12x faster; there is no trade here. Deflation is therefore
 * synchronous on the calling thread, bounded by `maxEntries`/`maxTotalBytes`: a bounded stall is
 * recoverable, an OOM kill of the main process is not.
 *
 * **Prototype-key discipline.** Archive entry names are attacker-controlled strings that we use
 * as object keys. Every name-keyed map in this file is `Object.create(null)` and every lookup
 * goes through `Object.hasOwn`; never `entries[name]` on a plain object and never `name in map`.
 * A file named `constructor` is legal and round-trips; `__proto__` is rejected by
 * `isSafeArchivePath` because it is a pollution vector rather than a file name.
 *
 * Guarantees this module upholds:
 *  - **Saving is bounded** (`maxEntries`, `maxTotalBytes`): `extras` round-trips verbatim, so an
 *    unbounded save is an unbounded read one step later.
 *  - **Unknown entries and unknown manifest keys survive a round-trip** (§5.2): entries we do
 *    not consume are carried in `bundle.extras` and re-emitted verbatim; unknown JSON keys ride
 *    along because every manifest object is a zod *loose* object.
 *  - **Reader < writer is an error, not a crash** (§5.2): the format version is probed before
 *    the manifest is schema-checked.
 *  - **Saves are atomic** (§1.1): build a unique `<path>.<pid>.<rand>.tmp`, `fsync`, `rename`.
 *    A crash mid-save can never truncate the user's deck, and the tmp file never survives a
 *    failure.
 *
 * Deliberately *not* done here, with reasons:
 *  - **No fsync of the containing directory after `rename`.** The rename is atomic on every
 *    platform we ship, but its *durability* across power loss is not guaranteed without an
 *    fsync on the parent directory — which Node cannot do portably (`fs.open(dir)` fails on
 *    Windows) and which costs a full metadata flush on every keystroke-triggered autosave. The
 *    exposure is "a save from the last few hundred ms is lost after a hard power cut", not
 *    corruption: the old deck or the new deck is always intact. Revisit with autosave (M1.4).
 *  - **No `MIGRATIONS` chain (§5.3).** At `MAX_FORMAT_VERSION === 1` an upgrade chain has zero
 *    entries and no test can exercise it, so it would be untested scaffolding. It lands with
 *    the first v2 field, in M1.x.
 *  - **No garbage collection of orphan `thumbs/<id>.webp`.** Thumbnails do not exist yet
 *    (nothing writes them); orphans ride in `extras` and round-trip harmlessly. GC belongs to
 *    the milestone that generates them.
 */

import { open as fsOpen, readdir, rename, rm } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { strFromU8, strToU8, zipSync, type Zippable } from 'fflate'
import {
  DEFAULT_ARCHIVE_LIMITS,
  emptyNameMap as emptyMap,
  getOwn as get,
  readArchiveFile,
  type ArchiveErrorCode,
  type ArchiveLimits,
  type ReadArchiveOptions,
} from './archive'
import {
  DECK_MIMETYPE,
  MANIFEST_ENTRY,
  MAX_FORMAT_VERSION,
  MIMETYPE_ENTRY,
  isSafeArchivePath,
  parseManifest,
  parseTheme,
  probeFormatVersion,
  type DeckManifest,
  type ManifestIssue,
  type Theme,
} from '../../shared/document/types'

/** Everything a `.sloodge` file holds, split into the parts the app edits and the parts it keeps. */
export type DeckBundle = {
  manifest: DeckManifest
  /** Slide HTML, keyed by slide id. */
  slides: Record<string, string>
  /** Speaker notes markdown, keyed by slide id. Absent key = no notes. */
  notes: Record<string, string>
  /**
   * The parsed, schema-valid `theme/theme.json` (§4.2), or null when the deck has no theme file
   * or its theme failed validation. An *invalid* theme is never silently dropped: its raw bytes
   * are moved into `extras` under the manifest's theme path, so a save round-trips it verbatim
   * and a future build that understands it can still read it.
   */
  theme: Theme | null
  /** Entries this build does not understand (thumbs, assets, theme.css, future dirs). */
  extras: Record<string, Uint8Array>
}

/**
 * Every way a read can fail: the archive-level codes (`not-found`, `not-a-zip`, `unsafe-entry`,
 * `too-large`, `extraction-timeout`, `io` — see `archive.ts`) plus the three that only a `.sloodge`
 * has.
 */
export type DeckReadErrorCode =
  ArchiveErrorCode | 'manifest-missing' | 'manifest-invalid' | 'format-too-new'

export type DeckReadError = {
  code: DeckReadErrorCode
  message: string
  issues?: ManifestIssue[]
  fileFormatVersion?: number
  maxFormatVersion?: number
}

export type ReadDeckResult =
  { ok: true; bundle: DeckBundle; warnings: string[] } | { ok: false; error: DeckReadError }

export type WriteDeckErrorCode =
  'manifest-invalid' | 'unsafe-entry' | 'incomplete-bundle' | 'too-large' | 'io'

export type WriteDeckError = { code: WriteDeckErrorCode; message: string }

export type WriteDeckResult = { ok: true; path: string } | { ok: false; error: WriteDeckError }

/**
 * The archive-level knobs live in `archive.ts` and are re-exported here because `.sloodge`
 * callers (and the M1.1 test suite) have always reached for them through the store. The same
 * `ArchiveLimits` bounds the *write* path below, where `maxEntries` and `maxTotalBytes` are
 * checked against the bytes about to be serialized: `extras` round-trips verbatim by design
 * (§5.2), so open-then-save hands whatever an untrusted deck contained straight back to the
 * zipper, and a save that is not bounded is a read that is not bounded one step later.
 */
export {
  DEFAULT_ARCHIVE_LIMITS,
  DEFAULT_EXTRACTION_TIMEOUT_MS,
  type ArchiveLimits,
  type ExtractionObserver,
} from './archive'

/** Archive read options plus nothing deck-specific — the shape `readArchiveFile` already takes. */
export type ReadDeckOptions = ReadArchiveOptions

/** A distinct tmp name per process *and* per attempt: two concurrent saves cannot collide. */
const TMP_SUFFIX = '.tmp'

function tmpPathFor(target: string): string {
  // Padded so the name is always exactly 8 base36 chars: `Math.random()` occasionally stringifies
  // short (0.5 -> "0.5"), and `isTmpFor` recognizes our own files by that fixed shape.
  const random = `${Math.random().toString(36).slice(2)}00000000`.slice(0, 8)
  const unique = `${String(process.pid)}.${random}`
  return join(dirname(target), `${basename(target)}.${unique}${TMP_SUFFIX}`)
}

/**
 * Only names `tmpPathFor` could have produced count as ours: `<deck>.<pid>.<8 base36>.tmp`.
 * A loose `<deck>.*.tmp` match would report an unrelated `deck.sloodge.backup.tmp` as a crashed
 * save and drive a recovery prompt for a file we never wrote.
 */
function isTmpFor(target: string, candidate: string): boolean {
  const base = basename(target)
  if (!candidate.startsWith(`${base}.`) || !candidate.endsWith(TMP_SUFFIX)) return false
  const middle = candidate.slice(base.length + 1, candidate.length - TMP_SUFFIX.length)
  return /^\d+\.[0-9a-z]{8}$/.test(middle)
}

function fail(code: DeckReadErrorCode, message: string, extra: Partial<DeckReadError> = {}) {
  return { ok: false as const, error: { code, message, ...extra } }
}

/* -------------------------------------------------------------------------------------------- */

/** Read and validate a `.sloodge` file. Never throws for bad input — errors are values. */
export async function readDeck(
  path: string,
  options: ReadDeckOptions = {},
): Promise<ReadDeckResult> {
  // Every archive-level gate — size, entry count, entry-name safety, symlinks, decompression
  // bombs, ZIP64 divergence — lives in `archive.ts` and applies here unchanged. What is left in
  // this function is the `.sloodge` semantics on top of the extracted entry map.
  const archive = await readArchiveFile(path, options)
  if (!archive.ok) return fail(archive.error.code, archive.error.message)

  // Null-prototype by construction: `readArchiveBytes` builds its map with `emptyNameMap`, and
  // every lookup below goes through `get`/`Object.hasOwn`, so `entries[String(x)]` cannot resolve
  // up the prototype chain and hand us a function instead of `undefined` (B1).
  const entries = archive.entries

  const manifestBytes = get(entries, MANIFEST_ENTRY)
  if (!manifestBytes) return fail('manifest-missing', `${path} has no ${MANIFEST_ENTRY}`)

  let manifestJson: unknown
  try {
    manifestJson = JSON.parse(strFromU8(manifestBytes))
  } catch (error) {
    return fail('manifest-invalid', `${MANIFEST_ENTRY} is not valid JSON: ${String(error)}`)
  }

  const fileVersion = probeFormatVersion(manifestJson)
  if (fileVersion === null) {
    return fail('manifest-invalid', `${MANIFEST_ENTRY} has no usable formatVersion`)
  }
  if (fileVersion > MAX_FORMAT_VERSION) {
    return fail('format-too-new', 'This deck was saved by a newer version of Sloodge.', {
      fileFormatVersion: fileVersion,
      maxFormatVersion: MAX_FORMAT_VERSION,
    })
  }

  const parsed = parseManifest(manifestJson)
  if (!parsed.ok) {
    return fail('manifest-invalid', `${MANIFEST_ENTRY} failed validation`, {
      issues: parsed.issues,
    })
  }
  const manifest = parsed.manifest

  const warnings: string[] = []
  const consumed = new Set<string>([MANIFEST_ENTRY, MIMETYPE_ENTRY])
  const slides = emptyMap<string>()
  const notes = emptyMap<string>()

  for (const id of manifest.slideOrder) {
    // Unreachable: invariant 1 makes slideOrder a permutation of Object.keys(slides), so a parsed
    // manifest always resolves here. Kept as a guard rather than a `!` so a future schema change
    // degrades to "one slide missing" instead of a crash in the main process.
    const slide = get(manifest.slides, id)
    if (!slide) continue
    consumed.add(slide.file)
    const html = get(entries, slide.file)
    if (html === undefined) {
      // §2.2 invariant 3: a missing slide file is repaired with an empty document and flagged.
      warnings.push(`missing slide file ${slide.file}; opened as an empty slide`)
      slides[id] = ''
    } else {
      slides[id] = strFromU8(html)
    }
    if (slide.notes !== undefined) {
      consumed.add(slide.notes)
      const md = get(entries, slide.notes)
      if (md === undefined) {
        warnings.push(`missing notes file ${slide.notes}`)
      } else {
        notes[id] = strFromU8(md)
      }
    }
  }

  // §4.2. A theme that fails validation is a warning, not a failed open — the deck still renders
  // with built-in defaults. Its bytes stay unconsumed so they land in `extras` and round-trip.
  let theme: Theme | null = null
  if (manifest.theme !== undefined) {
    const themeBytes = get(entries, manifest.theme)
    if (themeBytes === undefined) {
      consumed.add(manifest.theme)
      warnings.push(`missing theme file ${manifest.theme}`)
    } else {
      let themeJson: unknown
      try {
        themeJson = JSON.parse(strFromU8(themeBytes))
      } catch (error) {
        themeJson = undefined
        warnings.push(`${manifest.theme} is not valid JSON: ${String(error)}`)
      }
      if (themeJson !== undefined) {
        const parsedTheme = parseTheme(themeJson)
        if (parsedTheme.ok) {
          consumed.add(manifest.theme)
          theme = parsedTheme.theme
        } else {
          const detail = parsedTheme.issues
            .map((issue) => `${issue.path}: ${issue.message}`)
            .join('; ')
          warnings.push(`${manifest.theme} failed validation, using defaults — ${detail}`)
        }
      }
    }
  }

  const extras = emptyMap<Uint8Array>()
  for (const [name, data] of Object.entries(entries)) {
    if (consumed.has(name)) continue
    extras[name] = data
  }

  return { ok: true, bundle: { manifest, slides, notes, theme, extras }, warnings }
}

class PackError extends Error {
  readonly code: WriteDeckErrorCode

  constructor(code: WriteDeckErrorCode, message: string) {
    super(message)
    this.name = 'PackError'
    this.code = code
  }
}

export type PackDeckOptions = {
  /** Partial overrides of `DEFAULT_ARCHIVE_LIMITS`; only `maxEntries`/`maxTotalBytes` apply here. */
  limits?: Partial<ArchiveLimits>
}

/**
 * Serialize a bundle to zip bytes, `mimetype` STORED first (OPC-style). Insertion order into the
 * map is the order fflate writes, so the STORED `mimetype` really is the first local header.
 *
 * `async` for the caller's benefit only — the deflate itself is `zipSync`. fflate's asynchronous
 * `zip` spawns a Worker per entry over 160 kB with no concurrency limit (see the module docblock);
 * on a 150-member deck that was +1.7 GB of RSS and 7 s, against no measurable growth and 0.6 s
 * here. Keeping the signature a promise means this can move onto one worker thread later without
 * touching a caller.
 *
 * Bounded like the read path: `extras` round-trips verbatim, so the bytes handed to the zipper are
 * ultimately attacker-controlled, and a save is refused rather than attempted when they exceed
 * `maxEntries` or `maxTotalBytes`.
 */
export async function packDeck(
  bundle: DeckBundle,
  options: PackDeckOptions = {},
): Promise<Uint8Array> {
  const limits: ArchiveLimits = { ...DEFAULT_ARCHIVE_LIMITS, ...options.limits }
  // Null-prototype so `Object.hasOwn` below is the only reachability question and an extra named
  // `toString` is a normal entry rather than a collision with `Object.prototype.toString` (M1).
  const zippable = emptyMap<Uint8Array | [Uint8Array, { level: 0 }]>()
  zippable[MIMETYPE_ENTRY] = [strToU8(DECK_MIMETYPE), { level: 0 }]
  zippable[MANIFEST_ENTRY] = strToU8(`${JSON.stringify(bundle.manifest, null, 2)}\n`)

  const claim = (name: string, data: Uint8Array): void => {
    if (!isSafeArchivePath(name)) {
      throw new PackError('unsafe-entry', `refusing to write unsafe archive entry: ${name}`)
    }
    if (Object.hasOwn(zippable, name)) {
      const existing = zippable[name]
      // Two writers, one archive path. Dropping the loser silently is the same class of bug the
      // missing-slide-body and orphan-theme cases below refuse: `manifest.theme` is a free-form
      // `archivePath`, so a manifest pointing `theme` at `slides/<id>.html` would make the theme
      // claim win and the slide's HTML vanish from the saved file without a word. Identical bytes
      // are a no-op (the entry is already there); differing bytes are data loss, so they throw.
      const bytes = existing instanceof Uint8Array ? existing : (existing?.[0] ?? new Uint8Array(0))
      if (bytes.length === data.length && bytes.every((byte, index) => byte === data[index])) return
      throw new PackError(
        'incomplete-bundle',
        `two different payloads claim the archive entry ${name}`,
      )
    }
    zippable[name] = data
  }

  if (bundle.theme !== null) {
    // §4.3: the theme file exists because the manifest points at it. A bundle carrying theme
    // *data* with no `manifest.theme` path has nowhere to write it, and writing it to the default
    // path anyway would produce a file the manifest does not reference — an orphan the reader
    // would file under `extras`. Same reasoning as the missing-slide-body case: refuse, do not
    // silently drop the user's theme.
    if (bundle.manifest.theme === undefined) {
      throw new PackError('incomplete-bundle', 'bundle has a theme but manifest.theme is unset')
    }
    claim(bundle.manifest.theme, strToU8(`${JSON.stringify(bundle.theme, null, 2)}\n`))
  }

  for (const id of bundle.manifest.slideOrder) {
    const slide = get(bundle.manifest.slides, id)
    if (!slide) continue
    const html = get(bundle.slides, id)
    if (html === undefined) {
      // Not a repairable condition on the *write* side: readDeck already substitutes an empty
      // document for a missing slide file and warns, so a bundle that reaches here without HTML
      // is a caller bug. Writing '' silently would turn that bug into permanent data loss.
      throw new PackError('incomplete-bundle', `bundle has no HTML for slide ${id}`)
    }
    claim(slide.file, strToU8(html))
    const md = get(bundle.notes, id)
    if (slide.notes !== undefined && md !== undefined) claim(slide.notes, strToU8(md))
  }

  // Forward-compat: unknown entries are copied through verbatim (§5.2).
  for (const [name, data] of Object.entries(bundle.extras)) claim(name, data)

  // Checked against the *uncompressed* bytes we are about to hand fflate, which is what has to be
  // resident while it deflates them, and before `zipSync` allocates its output.
  const names = Object.keys(zippable)
  if (names.length > limits.maxEntries) {
    throw new PackError(
      'too-large',
      `refusing to save ${String(names.length)} entries, over the ${String(limits.maxEntries)} limit`,
    )
  }
  let total = 0
  for (const name of names) {
    const entry = zippable[name]
    total += (entry instanceof Uint8Array ? entry : (entry?.[0] ?? new Uint8Array(0))).length
    if (total > limits.maxTotalBytes) {
      throw new PackError(
        'too-large',
        `refusing to save over the ${String(limits.maxTotalBytes)}-byte limit`,
      )
    }
  }

  return zipSync(zippable as Zippable, { level: 6 })
}

/**
 * Atomically write a bundle to `path`: unique `<path>.<pid>.<rand>.tmp` → fsync → rename. The
 * tmp file is removed on every failure path, so a failed save leaves no litter next to the
 * user's deck, and the unique name means two concurrent saves to one path cannot corrupt each
 * other's staging file (the rename itself is last-writer-wins, which is the intended semantic).
 */
export async function writeDeck(
  path: string,
  bundle: DeckBundle,
  options: PackDeckOptions = {},
): Promise<WriteDeckResult> {
  const validated = parseManifest(bundle.manifest)
  if (!validated.ok) {
    const detail = validated.issues.map((issue) => `${issue.path}: ${issue.message}`).join('; ')
    return {
      ok: false,
      error: { code: 'manifest-invalid', message: `refusing to save — ${detail}` },
    }
  }

  let bytes: Uint8Array
  try {
    bytes = await packDeck({ ...bundle, manifest: validated.manifest }, options)
  } catch (error) {
    const code = error instanceof PackError ? error.code : 'io'
    return { ok: false, error: { code, message: String(error) } }
  }

  const tmp = tmpPathFor(path)
  try {
    const handle = await fsOpen(tmp, 'w')
    try {
      await handle.writeFile(bytes)
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(tmp, path)
    return { ok: true, path }
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => undefined)
    return { ok: false, error: { code: 'io', message: `cannot save ${path}: ${String(error)}` } }
  }
}

/**
 * True when a stale `<path>.<pid>.<rand>.tmp` is sitting next to the deck (crash mid-save).
 * Because tmp names are unique per attempt this is a directory scan rather than a single stat.
 */
export async function hasStaleTmp(path: string): Promise<boolean> {
  try {
    const siblings = await readdir(dirname(path))
    return siblings.some((name) => isTmpFor(path, name))
  } catch {
    return false
  }
}
