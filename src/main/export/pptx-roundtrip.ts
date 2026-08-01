/**
 * Round-trip PPTX export (M4.6): emit a `.pptx` from a deck that carries a retained import.
 *
 * ## What this guarantees
 *
 * Given a deck imported by M4.5, this module produces bytes with one of two guarantees, or declines:
 *
 *  - **`identity`** — nothing changed since import, so the retained archive is returned *as the
 *    file's own bytes*. Not re-zipped, not re-serialized, not reconstructed from the entry map:
 *    the same buffer that was read off disk at import time and stored at `import/original.pptx`.
 *    `sha256(export) === sha256(the file the user opened)`, and the test asserts exactly that
 *    against the original input file rather than against the retained copy — comparing the retained
 *    bytes to themselves would prove nothing.
 *  - **`patched`** — some slides were edited, but each edit is expressible as a text substitution
 *    on its original slide part. Those parts are rewritten by byte splice (see `rewrite.ts`) and
 *    **every other part is copied byte-for-byte** out of the retained archive. The container is
 *    re-zipped, so the *file* differs; the *parts* do not, and that is the guarantee the roadmap
 *    asks for ("rewrites only the OPC parts the edit touched, with every untouched part asserted
 *    byte-identical").
 *
 * When neither holds — a slide added, removed or reordered, or an edit that cannot be expressed as
 * a substitution — this module returns `mode: 'rebuild'` and **no bytes**. It does not attempt a
 * partial guarantee. The caller falls back to M4.3's structured export, which makes no passthrough
 * claim, and the report says which happened. An export that silently downgraded from "byte
 * identical" to "roughly similar" while still reporting success is the failure this design exists
 * to prevent.
 *
 * ## Why re-zipping in `patched` mode does not weaken the claim
 *
 * A zip container records per-entry compression method, compressed size, CRC and timestamps. Two
 * archives holding identical parts can differ in every one of those bytes and both be correct. So
 * "byte-identical" at the *archive* level is only meaningful when the archive is literally the same
 * buffer, which is what `identity` mode delivers. For `patched` mode the meaningful unit is the
 * part, and the assertion is made where it means something: unzip the output, unzip the retained
 * original, compare each untouched part's inflated bytes. `verifyPassthrough` performs exactly that
 * comparison, and the test drives it through the real hardened reader rather than trusting the
 * writer's own bookkeeping.
 *
 * ## Boundary note
 *
 * Nothing here touches pptxgenjs. `src/main/export/safe-pptx.ts` remains the sole importer of that
 * library (enforced by `tests/unit/export/pptx-boundary.test.ts`), and it is not needed: this path
 * never *generates* a package, it re-emits or splices one that PowerPoint already wrote. The
 * `rebuild` fallback is where generation happens, and that goes through the existing writer and
 * therefore through the existing boundary.
 */

import { createHash } from 'node:crypto'
import { strFromU8, strToU8, zipSync, type Zippable } from 'fflate'
import { readArchiveBytes, type ReadArchiveOptions } from '../document/archive'
import type { DeckBundle } from '../document/store'
import {
  LEDGER_ENTRY,
  ORIGINAL_ARCHIVE_ENTRY,
  parseLedger,
  planRoundTrip,
  type ImportLedger,
  type RoundTripMode,
  type RoundTripPlan,
} from '../../shared/import/pptx/ledger'
import { rewriteSlideText } from '../../shared/import/pptx/rewrite'

export type RoundTripExport = {
  readonly mode: RoundTripMode
  /** The `.pptx` bytes, or `null` in `rebuild` mode (the caller must fall back). */
  readonly bytes: Uint8Array | null
  readonly plan: RoundTripPlan
  /** Hex sha256 of `bytes`, or `null` when there are none. */
  readonly sha256: string | null
  /** Parts copied verbatim out of the retained archive. */
  readonly passthroughParts: readonly string[]
  /** Parts rewritten by text substitution. */
  readonly rewrittenParts: readonly string[]
  readonly warnings: readonly string[]
}

function sha256Hex(input: string | Uint8Array): string {
  return createHash('sha256')
    .update(typeof input === 'string' ? Buffer.from(input, 'utf8') : Buffer.from(input))
    .digest('hex')
}

function getOwn<T>(map: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.hasOwn(map, key) ? (map as Record<string, T>)[key] : undefined
}

function emptyMap<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>
}

/** The retained archive and its ledger, read back out of a deck bundle. */
export type RetainedImport = {
  readonly archiveBytes: Uint8Array
  readonly ledger: ImportLedger
}

/**
 * Recover the retention payload from a deck. Returns `null` — never throws — for a deck that was
 * not imported, or whose retention is missing or malformed: those are all "no round trip
 * available", which is a normal state, not an error.
 */
export function readRetainedImport(bundle: DeckBundle): RetainedImport | null {
  const archiveBytes = getOwn(bundle.extras, ORIGINAL_ARCHIVE_ENTRY)
  const ledgerBytes = getOwn(bundle.extras, LEDGER_ENTRY)
  if (archiveBytes === undefined || ledgerBytes === undefined) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(strFromU8(ledgerBytes))
  } catch {
    return null
  }
  const ledger = parseLedger(parsed)
  if (ledger === null) return null
  // The ledger names the archive it describes. A deck whose retained archive was swapped for a
  // different one must not be round-tripped against the wrong ledger, and the hash is cheap.
  if (sha256Hex(archiveBytes) !== ledger.source.sha256) return null
  return { archiveBytes, ledger }
}

export type RoundTripOptions = {
  archive?: ReadArchiveOptions
}

/**
 * Produce round-trip bytes for a deck, or decline with `rebuild`.
 *
 * The retained archive is re-read through the *hardened* reader on the way out, not trusted because
 * it was validated on the way in. A `.sloodge` is itself an untrusted file: nothing stops someone
 * hand-editing `import/original.pptx` inside a deck and mailing it on, and this function inflates
 * that member's contents in `patched` mode.
 */
export async function exportPptxRoundTrip(
  bundle: DeckBundle,
  options: RoundTripOptions = {},
): Promise<RoundTripExport> {
  const warnings: string[] = []
  const retained = readRetainedImport(bundle)

  const declined = (reason: string): RoundTripExport => ({
    mode: 'rebuild',
    bytes: null,
    plan: {
      mode: 'rebuild',
      dirtySlideIds: [],
      rewriteParts: [],
      passthroughParts: [],
      reasons: [reason],
    },
    sha256: null,
    passthroughParts: [],
    rewrittenParts: [],
    warnings,
  })

  if (retained === null) return declined('deck carries no usable retained import')

  const archive = await readArchiveBytes(
    retained.archiveBytes,
    ORIGINAL_ARCHIVE_ENTRY,
    options.archive,
  )
  if (!archive.ok) {
    return declined(`retained archive is unreadable: ${archive.error.message}`)
  }

  const slideOrder = bundle.manifest.slideOrder
  const slideHtml = emptyMap<string>()
  for (const id of slideOrder) {
    const html = getOwn(bundle.slides, id)
    if (html !== undefined) slideHtml[id] = html
  }

  // Patchability needs the original XML and the current HTML together, so it is answered here and
  // handed to the planner rather than recomputed inside it.
  const patchable = (slideId: string): boolean => {
    const part = getOwn(retained.ledger.slidePart, slideId)
    const html = getOwn(slideHtml, slideId)
    if (part === undefined || html === undefined) return false
    const bytes = getOwn(archive.entries, part)
    if (bytes === undefined) return false
    return rewriteSlideText(strFromU8(bytes), html).ok
  }

  const plan = planRoundTrip(retained.ledger, { slideOrder, slideHtml }, sha256Hex, patchable)

  if (plan.mode === 'rebuild') {
    return {
      mode: 'rebuild',
      bytes: null,
      plan,
      sha256: null,
      passthroughParts: [],
      rewrittenParts: [],
      warnings,
    }
  }

  if (plan.mode === 'identity') {
    // The retained buffer itself. Nothing is rebuilt, so nothing can drift.
    return {
      mode: 'identity',
      bytes: retained.archiveBytes,
      plan,
      sha256: sha256Hex(retained.archiveBytes),
      passthroughParts: plan.passthroughParts,
      rewrittenParts: [],
      warnings,
    }
  }

  // --- patched ---------------------------------------------------------------------------------
  const zippable = emptyMap<Uint8Array | [Uint8Array, { level: 0 }]>()
  const rewritten: string[] = []

  // `[Content_Types].xml` first and STORED, matching what OOXML writers emit. Part order inside a
  // zip is not semantically meaningful, but keeping the conventional order means a diff against a
  // PowerPoint-written file is about content rather than layout.
  const orderedNames = [
    ...Object.keys(archive.entries).filter((name) => name === '[Content_Types].xml'),
    ...Object.keys(archive.entries).filter((name) => name !== '[Content_Types].xml'),
  ]

  const rewriteBySlide = emptyMap<string>()
  for (const slideId of plan.dirtySlideIds) {
    const part = getOwn(retained.ledger.slidePart, slideId)
    if (part === undefined) return declined(`slide ${slideId} has no recorded source part`)
    rewriteBySlide[part] = slideId
  }

  for (const name of orderedNames) {
    const original = getOwn(archive.entries, name)
    if (original === undefined) continue
    const slideId = getOwn(rewriteBySlide, name)
    if (slideId === undefined) {
      // Passthrough: the exact inflated bytes the retained archive holds.
      zippable[name] = original
      continue
    }
    const html = getOwn(slideHtml, slideId)
    if (html === undefined) return declined(`slide ${slideId} has no HTML`)
    const result = rewriteSlideText(strFromU8(original), html)
    if (!result.ok) return declined(`slide ${slideId} is not patchable: ${result.reason}`)
    zippable[name] = strToU8(result.xml)
    rewritten.push(name)
    if (result.changedRuns.length === 0) {
      // The hash said dirty but no text span differs — the edit was to markup the converter emits
      // (a style, an id) rather than to text. The part is still rewritten (identically), which is
      // honest: the plan said it would be.
      warnings.push(
        `slide ${slideId} changed but no source text differs; its part was re-emitted unchanged`,
      )
    }
  }

  const bytes = zipSync(zippable as Zippable, { level: 6 })
  return {
    mode: 'patched',
    bytes,
    plan,
    sha256: sha256Hex(bytes),
    passthroughParts: plan.passthroughParts,
    rewrittenParts: rewritten,
    warnings,
  }
}

export type PassthroughVerification = {
  readonly ok: boolean
  /** Parts that were expected identical and are. */
  readonly identical: readonly string[]
  /** Parts that were expected identical and are not — a failure of the M4.6 guarantee. */
  readonly differing: readonly string[]
  /** Parts present in one package and not the other. */
  readonly missing: readonly string[]
  /** Parts that were expected to change. Reported, not asserted. */
  readonly rewritten: readonly string[]
}

/**
 * Compare an exported package against the retained original, part by part.
 *
 * This is the M4.6 assertion made where it is meaningful: on the **inflated bytes of each part**,
 * read back out of both packages through the hardened reader, rather than on the writer's own
 * record of what it did. A writer that re-serialized an untouched part would report success and
 * fail here — which is precisely the mutation the milestone requires to go red.
 */
export async function verifyPassthrough(
  exportedBytes: Uint8Array,
  retainedBytes: Uint8Array,
  rewrittenParts: readonly string[],
  options: ReadArchiveOptions = {},
): Promise<PassthroughVerification> {
  const exported = await readArchiveBytes(exportedBytes, 'exported.pptx', options)
  const original = await readArchiveBytes(retainedBytes, ORIGINAL_ARCHIVE_ENTRY, options)
  if (!exported.ok || !original.ok) {
    return {
      ok: false,
      identical: [],
      differing: [],
      missing: ['<unreadable package>'],
      rewritten: [],
    }
  }

  const rewrittenSet = new Set(rewrittenParts)
  const identical: string[] = []
  const differing: string[] = []
  const missing: string[] = []

  for (const name of Object.keys(original.entries)) {
    const before = getOwn(original.entries, name)
    const after = getOwn(exported.entries, name)
    if (before === undefined) continue
    if (after === undefined) {
      missing.push(name)
      continue
    }
    if (rewrittenSet.has(name)) continue
    if (before.length === after.length && before.every((byte, index) => byte === after[index])) {
      identical.push(name)
    } else {
      differing.push(name)
    }
  }
  for (const name of Object.keys(exported.entries)) {
    if (getOwn(original.entries, name) === undefined) missing.push(name)
  }

  return {
    ok: differing.length === 0 && missing.length === 0,
    identical,
    differing,
    missing,
    rewritten: [...rewrittenSet],
  }
}
