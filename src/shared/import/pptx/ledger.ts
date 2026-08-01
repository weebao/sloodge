/**
 * The per-part edit ledger (M4.5) and the round-trip planner it exists to drive (M4.6).
 *
 * ## The problem retention solves
 *
 * Converting a `.pptx` slide to contract HTML is lossy — it must be, because the target is a
 * 1280x720 HTML document with a system font stack and the source is DrawingML with themes,
 * masters, layouts, effects, embedded fonts, SmartArt and OLE. Converting *back* is lossy again.
 * So "import then export unchanged" through a conversion can never reproduce the input, and any
 * claim that it does is a claim about how small the loss is, not about identity.
 *
 * M4.5 therefore does not try. The original archive is retained **verbatim** inside the deck
 * (`import/original.pptx`), the conversion is treated as a *view* of it, and export re-emits the
 * retained bytes for anything the user did not touch. That turns an unbounded fidelity problem
 * into a bounded bookkeeping one — which parts did an edit invalidate? — and this module is the
 * bookkeeping.
 *
 * ## Why the ledger is derived, not maintained
 *
 * The obvious design is a mutable dirty-set that edit handlers mark. That design has one failure
 * mode and it is silent: an edit path that forgets to mark produces an export that re-emits stale
 * original bytes over the user's change, i.e. data loss that looks like success. Every future edit
 * path is a chance to forget.
 *
 * So nothing marks anything. The ledger records, at import time, the hash of the HTML each slide
 * was converted *to*; dirtiness is recomputed at export time by hashing the current HTML and
 * comparing. A slide is dirty because its bytes differ, not because someone remembered to say so.
 * An edit path that does not exist yet is covered the day it lands. The mutation test for this is
 * correspondingly direct: break the comparison and the edited-round-trip test goes red.
 *
 * ## The three modes
 *
 * `planRoundTrip` classifies an export into exactly one of:
 *
 *  - **`identity`** — no slide's HTML changed and the slide set is unchanged. The retained archive
 *    is re-emitted byte for byte. This is the mode M4.6's hash assertion covers.
 *  - **`patched`** — some slides changed, but every change is expressible as text substitution on
 *    the original slide part (see `rewrite.ts`), and the slide set is unchanged. Exactly those
 *    slide parts are rewritten; every other part is copied byte-for-byte out of the retained
 *    archive. This is the mode M4.6's part-level passthrough assertion covers.
 *  - **`rebuild`** — a structural change (a slide added, removed or reordered) or an edit that
 *    cannot be expressed as a text substitution. Retention buys nothing here and pretending
 *    otherwise would be the dishonest option, so the plan says `rebuild` and the caller falls back
 *    to M4.3's structured export. **No passthrough is claimed in this mode**, and the report says
 *    so.
 *
 * Reordering is deliberately in `rebuild` rather than `patched` even though it is, in principle,
 * an edit to one part (`ppt/presentation.xml`'s `sldIdLst`). Rewriting that part correctly means
 * re-serializing XML this codebase only ever *reads*, and a round-trip that silently produced a
 * subtly wrong presentation part would be worse than one that honestly rebuilt. It is a real
 * candidate for a later milestone; it is not a gap in the identity claim, because the identity
 * claim is about the unedited case.
 */

/** Bumped when the ledger's own shape changes; a ledger from the future is ignored, not guessed at. */
export const LEDGER_VERSION = 1

/** Where the retained archive and its ledger live inside the `.sloodge` container. */
export const ORIGINAL_ARCHIVE_ENTRY = 'import/original.pptx'
export const LEDGER_ENTRY = 'import/ledger.json'

/** Hex sha256 of a string or byte array. Injected because `src/shared` has no Node types. */
export type Hasher = (input: string | Uint8Array) => string

export type ImportSourceFormat = 'pptx' | 'potx'

export type LedgerPartRecord = {
  /** Hex sha256 of the part's inflated bytes at import time. */
  readonly sha256: string
  readonly bytes: number
}

export type ImportLedger = {
  readonly version: number
  readonly source: {
    readonly format: ImportSourceFormat
    /** Hex sha256 of the whole retained archive — what the identity assertion compares against. */
    readonly sha256: string
    readonly bytes: number
    readonly importedAt: string
    /** The file name the user opened, for the report. Never used as a path. */
    readonly fileName: string
  }
  /** Every OPC part in the retained archive → its hash and size at import time. */
  readonly parts: Readonly<Record<string, LedgerPartRecord>>
  /** Slide id → the OPC part that slide was converted from. */
  readonly slidePart: Readonly<Record<string, string>>
  /** Slide id → sha256 of the contract HTML the importer produced. Divergence means dirty. */
  readonly slideHtml: Readonly<Record<string, string>>
  /** Slide ids in import order. A different order or set is a structural edit. */
  readonly slideOrder: readonly string[]
}

function emptyMap<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>
}

function getOwn<T>(map: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.hasOwn(map, key) ? (map as Record<string, T>)[key] : undefined
}

export type BuildLedgerArgs = {
  readonly format: ImportSourceFormat
  readonly fileName: string
  readonly archiveBytes: Uint8Array
  /** The retained archive's parts, exactly as the hardened reader inflated them. */
  readonly parts: Readonly<Record<string, Uint8Array>>
  /** Slide id → the OPC part it came from, in presentation order. */
  readonly slides: readonly {
    readonly slideId: string
    readonly part: string
    readonly html: string
  }[]
  readonly importedAt: string
  readonly hash: Hasher
}

export function buildLedger(args: BuildLedgerArgs): ImportLedger {
  const parts = emptyMap<LedgerPartRecord>()
  for (const [name, bytes] of Object.entries(args.parts)) {
    parts[name] = { sha256: args.hash(bytes), bytes: bytes.length }
  }

  const slidePart = emptyMap<string>()
  const slideHtml = emptyMap<string>()
  const slideOrder: string[] = []
  for (const slide of args.slides) {
    slidePart[slide.slideId] = slide.part
    slideHtml[slide.slideId] = args.hash(slide.html)
    slideOrder.push(slide.slideId)
  }

  return {
    version: LEDGER_VERSION,
    source: {
      format: args.format,
      sha256: args.hash(args.archiveBytes),
      bytes: args.archiveBytes.length,
      importedAt: args.importedAt,
      fileName: args.fileName,
    },
    parts,
    slidePart,
    slideHtml,
    slideOrder,
  }
}

export type RoundTripMode = 'identity' | 'patched' | 'rebuild'

export type RoundTripPlan = {
  readonly mode: RoundTripMode
  /** Slides whose HTML differs from the hash recorded at import. */
  readonly dirtySlideIds: readonly string[]
  /**
   * OPC parts the export must rewrite. Empty in `identity` mode. In `rebuild` mode this is empty
   * too, because a rebuild does not rewrite parts — it replaces the package.
   */
  readonly rewriteParts: readonly string[]
  /**
   * OPC parts the export must copy byte-for-byte out of the retained archive. This is the list
   * M4.6 asserts over: every name here must come out of the export bit-identical to the retained
   * original. Empty in `rebuild` mode — no passthrough is claimed there.
   */
  readonly passthroughParts: readonly string[]
  /** Human-readable justifications, surfaced in the export report. */
  readonly reasons: readonly string[]
}

export type CurrentDeckState = {
  /** Slide ids in their current presentation order. */
  readonly slideOrder: readonly string[]
  /** Slide id → its current contract HTML. */
  readonly slideHtml: Readonly<Record<string, string>>
}

/**
 * Decide how an export should be produced from a deck that carries a retained import.
 *
 * `patchable` reports, per slide id, whether the *shape* of the edit is expressible as text
 * substitution on the original part — that question needs the HTML and the original XML together,
 * so it is answered by `rewrite.ts` and handed in here rather than recomputed. A slide that is
 * dirty and not patchable forces `rebuild` for the whole deck: a package half-rewritten and
 * half-rebuilt would satisfy neither guarantee.
 */
export function planRoundTrip(
  ledger: ImportLedger,
  current: CurrentDeckState,
  hash: Hasher,
  patchable: (slideId: string) => boolean = () => true,
): RoundTripPlan {
  const reasons: string[] = []
  const allParts = Object.keys(ledger.parts)

  if (ledger.version !== LEDGER_VERSION) {
    return {
      mode: 'rebuild',
      dirtySlideIds: [],
      rewriteParts: [],
      passthroughParts: [],
      reasons: [
        `ledger version ${String(ledger.version)} is not ${String(LEDGER_VERSION)}; cannot reuse the retained archive`,
      ],
    }
  }

  // Structural first: an added, removed or reordered slide invalidates the presentation part and
  // (for add/remove) the content types and relationship graph. Retention cannot express that, so
  // the mode is decided here and no per-slide work is done.
  const sameLength = ledger.slideOrder.length === current.slideOrder.length
  const sameOrder =
    sameLength && ledger.slideOrder.every((id, index) => current.slideOrder[index] === id)
  if (!sameOrder) {
    reasons.push(
      `slide set or order changed since import (${String(ledger.slideOrder.length)} slides imported, ${String(current.slideOrder.length)} now)`,
    )
    return {
      mode: 'rebuild',
      dirtySlideIds: [],
      rewriteParts: [],
      passthroughParts: [],
      reasons,
    }
  }

  const dirtySlideIds: string[] = []
  for (const slideId of ledger.slideOrder) {
    const recorded = getOwn(ledger.slideHtml, slideId)
    const currentHtml = getOwn(current.slideHtml, slideId)
    if (currentHtml === undefined) {
      // Present in `slideOrder` but with no HTML: the caller handed us an inconsistent deck. Treat
      // it as unrepresentable rather than as "unchanged", which would silently emit stale bytes.
      reasons.push(`slide ${slideId} has no HTML in the current deck`)
      return { mode: 'rebuild', dirtySlideIds: [], rewriteParts: [], passthroughParts: [], reasons }
    }
    if (recorded === undefined || hash(currentHtml) !== recorded) dirtySlideIds.push(slideId)
  }

  if (dirtySlideIds.length === 0) {
    reasons.push('no slide changed since import; re-emitting the retained archive verbatim')
    return {
      mode: 'identity',
      dirtySlideIds: [],
      rewriteParts: [],
      // Everything passes through in identity mode — the assertion covers the whole package.
      passthroughParts: allParts,
      reasons,
    }
  }

  const unpatchable = dirtySlideIds.filter((slideId) => !patchable(slideId))
  if (unpatchable.length > 0) {
    reasons.push(
      `edits to ${unpatchable.join(', ')} cannot be expressed as text substitution on the original part`,
    )
    return { mode: 'rebuild', dirtySlideIds, rewriteParts: [], passthroughParts: [], reasons }
  }

  const rewriteParts: string[] = []
  for (const slideId of dirtySlideIds) {
    const part = getOwn(ledger.slidePart, slideId)
    if (part === undefined) {
      reasons.push(`slide ${slideId} has no recorded source part`)
      return { mode: 'rebuild', dirtySlideIds, rewriteParts: [], passthroughParts: [], reasons }
    }
    if (!rewriteParts.includes(part)) rewriteParts.push(part)
  }

  const rewriteSet = new Set(rewriteParts)
  const passthroughParts = allParts.filter((name) => !rewriteSet.has(name))
  reasons.push(
    `${String(dirtySlideIds.length)} slide(s) edited; rewriting ${String(rewriteParts.length)} part(s) and passing ${String(passthroughParts.length)} through verbatim`,
  )
  return { mode: 'patched', dirtySlideIds, rewriteParts, passthroughParts, reasons }
}

/**
 * Validate a ledger read back out of a `.sloodge`. The file is user-supplied, so this is a parse,
 * not a cast: a malformed ledger disables round-trip export (the deck still opens) rather than
 * letting hostile shapes reach the planner.
 */
export function parseLedger(value: unknown): ImportLedger | null {
  if (typeof value !== 'object' || value === null) return null
  const raw = value as Record<string, unknown>
  if (raw['version'] !== LEDGER_VERSION) return null

  const source = raw['source']
  if (typeof source !== 'object' || source === null) return null
  const src = source as Record<string, unknown>
  const format = src['format']
  if (format !== 'pptx' && format !== 'potx') return null
  const sha256 = src['sha256']
  const bytes = src['bytes']
  const importedAt = src['importedAt']
  const fileName = src['fileName']
  if (typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(sha256)) return null
  if (typeof bytes !== 'number' || !Number.isInteger(bytes) || bytes < 0) return null
  if (typeof importedAt !== 'string' || typeof fileName !== 'string') return null

  const parts = emptyMap<LedgerPartRecord>()
  const rawParts = raw['parts']
  if (typeof rawParts !== 'object' || rawParts === null) return null
  for (const [name, record] of Object.entries(rawParts)) {
    if (name === '__proto__') return null
    if (typeof record !== 'object' || record === null) return null
    const entry = record as Record<string, unknown>
    const partHash = entry['sha256']
    const partBytes = entry['bytes']
    if (typeof partHash !== 'string' || !/^[0-9a-f]{64}$/.test(partHash)) return null
    if (typeof partBytes !== 'number' || !Number.isInteger(partBytes) || partBytes < 0) return null
    parts[name] = { sha256: partHash, bytes: partBytes }
  }

  const slidePart = emptyMap<string>()
  const slideHtml = emptyMap<string>()
  const rawSlidePart = raw['slidePart']
  const rawSlideHtml = raw['slideHtml']
  if (typeof rawSlidePart !== 'object' || rawSlidePart === null) return null
  if (typeof rawSlideHtml !== 'object' || rawSlideHtml === null) return null
  for (const [slideId, part] of Object.entries(rawSlidePart)) {
    if (slideId === '__proto__' || typeof part !== 'string') return null
    slidePart[slideId] = part
  }
  for (const [slideId, htmlHash] of Object.entries(rawSlideHtml)) {
    if (slideId === '__proto__' || typeof htmlHash !== 'string') return null
    if (!/^[0-9a-f]{64}$/.test(htmlHash)) return null
    slideHtml[slideId] = htmlHash
  }

  const rawOrder = raw['slideOrder']
  if (!Array.isArray(rawOrder) || rawOrder.some((id) => typeof id !== 'string')) return null

  return {
    version: LEDGER_VERSION,
    source: { format, sha256, bytes, importedAt, fileName },
    parts,
    slidePart,
    slideHtml,
    slideOrder: rawOrder as string[],
  }
}
