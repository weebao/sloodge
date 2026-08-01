/**
 * The hardened zip reader — extracted verbatim from `store.ts` (M1.1) in M4.5 so that a second
 * untrusted-zip consumer (PPTX import) reuses *this* parser rather than growing a second one.
 *
 * ## Why extract rather than add a reader
 *
 * A `.pptx` is a zip from anywhere on the internet: every hazard M1.1 spent eight review rounds on
 * — zip-slip, symlink members, decompression bombs, ZIP64 divergence between our caps and fflate's
 * arithmetic, prototype-pollution part names, entry-count floods, aliased local headers — applies
 * to it identically. Writing a second reader would mean re-deriving all eight rounds and then
 * maintaining the two in lockstep forever; the failure mode of that is well known (M4.3's
 * `SafePptxDeck` docblock names it: an invariant maintained by vigilance). So the archive layer
 * moved down here unchanged and `store.ts` now layers `.sloodge` semantics (manifest, slides,
 * notes, theme, extras) on top of it, while `src/main/import/pptx-import.ts` layers OPC semantics
 * on the same bytes. One parser, one set of caps, one set of tests.
 *
 * Everything below is M1.1's code and M1.1's reasoning; the only edits are the removal of the
 * deck-specific tail (manifest parsing) and the addition of `readArchiveBytes`, which exists
 * because the retained `import/original.pptx` arrives as bytes already inflated out of the
 * enclosing `.sloodge` and must be re-validated through the same gates before its parts are
 * trusted — a nested archive is not more trustworthy for having been nested.
 *
 * Zip library: **fflate** (0.8.x). Chosen over `jszip` (unmaintained-ish, ~3x slower, pulls in a
 * Promise-heavy API for what is a synchronous byte job), `adm-zip` (no per-entry compression
 * control, historically a source of zip-slip CVEs) and `archiver`/`yauzl` (stream-first, two
 * different libraries for read vs. write). fflate is dependency-free, ~8 kB, ships its own types,
 * and — the load-bearing bit — lets us set `level: 0` on a single entry so `mimetype` can be
 * STORED first, OPC-style, while everything else deflates.
 *
 * **This module does not use fflate's asynchronous API, and that is deliberate.** `unzip` fans out
 * every member in one `for` loop with no queue and no concurrency limit (lib/index.cjs:2632-2640),
 * spawning a `worker_threads` Worker per member over 512 kB, so peak memory is the *sum* of every
 * member's buffers plus one V8 isolate and one structured-clone copy of its input each. Measured
 * at ~21x the declared inflated size — a 185 kB archive costing 3 GB of RSS and a 1.2 MB archive
 * killing the host process. No per-entry or total cap can bound that, because the quantity the
 * caps measure (the total) is not the quantity that has to fit in memory (the peak).
 *
 * So extraction is driven by *our own* validated central-directory scan, one member at a time: for
 * each member we locate its local header at the offset the scan validated, feed its compressed
 * range through fflate's streaming `Inflate` in small pushes, and count the bytes it actually
 * produces against the size the member declared. Peak allocation is therefore `largest single
 * allowed member + ~2 MB` (see `inflateMember`) regardless of how many members the archive has,
 * and a member whose stream produces more bytes than it declared is aborted mid-inflate rather
 * than trusted. This also removes the second parser entirely: fflate's `Unzip` push API walks
 * *local* headers, which is a different directory from the one we validate, and reconciling two
 * parsers is exactly the class of bug that produced four rounds of findings.
 *
 * **Prototype-key discipline.** Archive entry names are attacker-controlled strings that we use as
 * object keys. Every name-keyed map here is `Object.create(null)` and every lookup goes through
 * `Object.hasOwn`; never `entries[name]` on a plain object and never `name in map`. A file named
 * `constructor` is legal and round-trips; `__proto__` is rejected by `isSafeArchivePath` because it
 * is a pollution vector rather than a file name.
 *
 * Guarantees this module upholds:
 *  - **Zip-slip is rejected outright**: any entry name — file *or* directory marker — that is
 *    absolute, contains `..`, uses backslashes or a drive letter fails the whole read, and so does
 *    any entry whose zip metadata marks it a symlink.
 *  - **Bounded resources**: file size, entry count, per-entry and total *compressed* size and
 *    per-entry and total *inflated* size are all capped before a single byte is inflated, and
 *    members are then inflated strictly one at a time against a shrinking budget of *actual* bytes,
 *    so a zip bomb is a `too-large` error value rather than an OOM kill of the main process — and
 *    the caps bound the *peak*, not merely the total. Both sizes matter: for a STORED member
 *    (method 0) fflate ignores the declared inflated size and hands back a copy of `compressedSize`
 *    bytes, so caps that only look at `originalSize` are no cap at all — and because nothing forces
 *    distinct central-directory entries to point at distinct local headers, N entries aliasing one
 *    big STORED member multiply that by N. The sum of declared compressed sizes is therefore
 *    checked against both an injectable cap and the actual file length, which is what catches
 *    aliasing. And because a cap is only a cap if it measures the same bytes the inflater will,
 *    every place where fflate could resolve a size differently than we do is treated as malformed
 *    rather than reconciled: the ZIP64 locator must point at a real record, a per-entry ZIP64 extra
 *    field is honoured only when that record exists, and the ZIP64 entry count must agree with the
 *    16-bit EOCD count about being zero and must fit in 32 bits.
 *  - **The read always settles.** Every path returns a value, and the extraction phase runs under
 *    an injectable deadline (`extractionTimeoutMs`, 30 s by default) enforced both between members
 *    and by a racing timer, so no parser edge case can leave the main process holding a promise
 *    that never resolves.
 */

import { readFile, stat } from 'node:fs/promises'
import { setImmediate as yieldToEventLoop } from 'node:timers'
import { Inflate, strFromU8 } from 'fflate'
import { isSafeArchivePath } from '../../shared/document/types'

/**
 * Resource ceilings applied to an untrusted archive *before* anything is inflated (M2).
 * A deck is a few MB of HTML plus images; these are three orders of magnitude of headroom.
 * Injectable so tests can prove the guard with a small crafted file instead of a 200 MB one.
 *
 * The same type bounds the *write* path in `store.ts` (`packDeck`), where `maxEntries` and
 * `maxTotalBytes` are checked against the bytes about to be serialized. `extras` round-trips
 * verbatim by design (§5.2), so open-then-save hands whatever an untrusted deck contained straight
 * back to the zipper: a save that is not bounded is a read that is not bounded, one step later.
 */
export type ArchiveLimits = {
  /** Bytes of the archive file itself, checked by `stat` before it is read. */
  maxCompressedBytes: number
  /** Central-directory entry count, directory markers included. Also caps entries on write. */
  maxEntries: number
  /** Declared inflated size of any single member — and its declared *compressed* size too. */
  maxEntryBytes: number
  /** Declared inflated size of the whole archive. Also caps the bytes `packDeck` will serialize. */
  maxTotalBytes: number
  /**
   * Sum of the declared compressed sizes of every member. Distinct from `maxCompressedBytes`
   * (the file's own length) because central-directory entries may alias one local header: forty
   * entries pointing at the same 20 MB STORED member declare 800 MB of compressed data inside a
   * 20 MB file. Also cross-checked against the real file length, which no honest archive exceeds.
   */
  maxTotalCompressedBytes: number
}

/**
 * `maxEntryBytes` is also the peak-allocation ceiling now that members are inflated one at a time,
 * and `maxTotalBytes` is what the finished entry map costs — every inflated member is retained.
 */
export const DEFAULT_ARCHIVE_LIMITS: ArchiveLimits = {
  maxCompressedBytes: 200 * 1024 * 1024,
  maxEntries: 10_000,
  maxEntryBytes: 64 * 1024 * 1024,
  maxTotalBytes: 256 * 1024 * 1024,
  maxTotalCompressedBytes: 200 * 1024 * 1024,
}

/** 30 s: three orders of magnitude over a real deck's read, short enough to be a UI error. */
export const DEFAULT_EXTRACTION_TIMEOUT_MS = 30_000

/**
 * Diagnostic hook over the extraction phase. Exists so the *structural* memory guarantee —
 * exactly one member inflated at a time — is assertable by a test, which an RSS measurement is too
 * flaky to do. `onMemberEnd` always fires for a member whose `onMemberStart` fired, including when
 * that member is rejected mid-stream.
 */
export type ExtractionObserver = {
  onMemberStart?: (name: string, allowedBytes: number) => void
  onMemberEnd?: (name: string, actualBytes: number) => void
}

export type ReadArchiveOptions = {
  /** Partial overrides of `DEFAULT_ARCHIVE_LIMITS`. */
  limits?: Partial<ArchiveLimits>
  /**
   * Wall-clock ceiling on the extraction phase. Injectable so a test can prove the settle
   * guarantee in milliseconds rather than half a minute.
   */
  extractionTimeoutMs?: number
  observer?: ExtractionObserver
}

export type ArchiveErrorCode =
  | 'not-found'
  | 'not-a-zip'
  | 'unsafe-entry'
  | 'too-large'
  /**
   * The extraction phase blew `extractionTimeoutMs`. Distinct from `not-a-zip` because a large but
   * *honest* archive can trip it, and "this file is not a zip archive" is an unactionable diagnosis
   * for a file that parses fine and is merely slow.
   */
  | 'extraction-timeout'
  | 'io'

export type ArchiveError = { code: ArchiveErrorCode; message: string }

/** Entry names → inflated bytes. Always a null-prototype map (see the prototype-key note above). */
export type ArchiveEntries = Record<string, Uint8Array>

export type ReadArchiveResult =
  | {
      ok: true
      entries: ArchiveEntries
      /**
       * The container's own bytes, exactly as they were read. Distinct from `entries`, which holds
       * the *inflated members*: PPTX import retains the container verbatim (M4.5), and re-zipping
       * the members to reconstruct it would change compression, entry order and timestamps — which
       * is precisely the byte-identity guarantee M4.6 asserts. Exposed here so a caller never has
       * to read the same file twice to get both.
       */
      bytes: Uint8Array
    }
  | { ok: false; error: ArchiveError }

const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04]
const EOCD_SIG = 0x0605_4b50
const ZIP64_LOCATOR_SIG = 0x0706_4b50
const ZIP64_EOCD_SIG = 0x0606_4b50
const CENTRAL_HEADER_SIG = 0x0201_4b50
const LOCAL_HEADER_SIG = 0x0403_4b50
const UINT32_MAX = 0xffff_ffff
const UINT32_MAX_BIG = 0xffff_ffffn
const METHOD_STORED = 0
const METHOD_DEFLATE = 8
/** S_IFMT / S_IFLNK from `<sys/stat.h>`, the unix mode carried in a zip's external attributes. */
const S_IFMT = 0xf000
const S_IFLNK = 0xa000

/** `version made by` high byte: 3 = UNIX, 19 = OS X (Darwin). Only these carry a unix mode. */
const UNIX_HOST_SYSTEMS = new Set([3, 19])

function fail(code: ArchiveErrorCode, message: string): { ok: false; error: ArchiveError } {
  return { ok: false as const, error: { code, message } }
}

export function looksLikeZip(bytes: Uint8Array): boolean {
  return ZIP_MAGIC.every((byte, index) => bytes[index] === byte)
}

/** A name-keyed map that cannot be reached through `Object.prototype`. */
export function emptyNameMap<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>
}

/** The only sanctioned read of a name-keyed map: own properties, never the prototype chain. */
export function getOwn<T>(map: Record<string, T>, key: string): T | undefined {
  return Object.hasOwn(map, key) ? map[key] : undefined
}

/* -------------------------------------------------------------------------------------------- *
 * Central-directory scan
 *
 * fflate's `UnzipFileInfo` exposes name/compression/sizes but *not* `version made by` or the
 * external attributes, so symlink entries are invisible through its API. We therefore read the
 * central directory ourselves — it is ~60 lines, it is read-only, and it also gives us every
 * declared size up front, which is exactly what the caps need to reject a zip bomb before a byte
 * is inflated.
 * -------------------------------------------------------------------------------------------- */

type CentralEntry = {
  name: string
  compressedSize: number
  originalSize: number
  /** 0 = STORED, 8 = DEFLATE. Load-bearing: a STORED member allocates `compressedSize`. */
  compressionMethod: number
  isSymlink: boolean
  /** Where this member's local header sits. The extractor reads its bytes from here. */
  localHeaderOffset: number
}

class ZipScanError extends Error {}

/**
 * Distinct from `ZipScanError` because it is a *cap* rejection (`too-large`), not a malformed
 * archive (`not-a-zip`). Thrown from inside the central-directory loop so a hostile entry count
 * never gets to allocate the entry objects the cap exists to prevent.
 */
class ZipEntryLimitError extends ZipScanError {}

function u16(view: DataView, offset: number): number {
  return view.getUint16(offset, true)
}

function u32(view: DataView, offset: number): number {
  return view.getUint32(offset, true)
}

function need(view: DataView, offset: number, length: number): void {
  if (offset < 0 || offset + length > view.byteLength) {
    throw new ZipScanError('central directory runs past the end of the file')
  }
}

/**
 * Resolve the ZIP64 extended-information extra field (id 0x0001) for sizes stored as 0xffffffff.
 *
 * **`hasZip64` gates the whole thing, and that gate is the security control.** fflate resolves the
 * per-entry extra field only when it found a valid ZIP64 end-of-central-directory record — its
 * `z64hs` helper (lib/index.cjs:1846-1865) is called only under the `z` flag that `unzip` sets at
 * index.cjs:2589-2597. A central header declaring `compressedSize = originalSize = 0xffffffff`
 * plus a 0x0001 extra field claiming a few bytes, in an archive with *no* ZIP64 EOCD, therefore
 * reads as tiny to us and as 4294967295/4294967295 to fflate — our caps wave it through and fflate
 * allocates 4 GB. Two parsers, two answers, and the caps applied to the wrong one.
 *
 * So when `hasZip64` is false we do not look at the extra field at all: a 0xffffffff size has no
 * record to explain it and is treated as unbounded (`+Infinity`), which every cap rejects. That is
 * strictly safer than mirroring fflate's arithmetic — the archive is malformed either way.
 */
function resolveZip64Sizes(
  view: DataView,
  extraStart: number,
  extraLength: number,
  compressedSize: number,
  originalSize: number,
  hasZip64: boolean,
): { compressedSize: number; originalSize: number } {
  if (originalSize !== UINT32_MAX && compressedSize !== UINT32_MAX) {
    return { compressedSize, originalSize }
  }
  if (!hasZip64) return unboundedSizes(compressedSize, originalSize)
  let offset = extraStart
  const end = extraStart + extraLength
  while (offset + 4 <= end) {
    const id = u16(view, offset)
    const size = u16(view, offset + 2)
    let field = offset + 4
    if (id === 0x0001) {
      let resolvedOriginal = originalSize
      let resolvedCompressed = compressedSize
      if (originalSize === UINT32_MAX && field + 8 <= end) {
        resolvedOriginal = Number(view.getBigUint64(field, true))
        field += 8
      }
      if (compressedSize === UINT32_MAX && field + 8 <= end) {
        resolvedCompressed = Number(view.getBigUint64(field, true))
      }
      return { compressedSize: resolvedCompressed, originalSize: resolvedOriginal }
    }
    offset += 4 + size
  }
  // Declared 0xffffffff with no 0x0001 field to explain it: unbounded, so the caps reject it.
  return unboundedSizes(compressedSize, originalSize)
}

/** A 0xffffffff size we are not allowed to resolve is `+Infinity` — over every cap, by design. */
function unboundedSizes(
  compressedSize: number,
  originalSize: number,
): { compressedSize: number; originalSize: number } {
  return {
    compressedSize: compressedSize === UINT32_MAX ? Number.POSITIVE_INFINITY : compressedSize,
    originalSize: originalSize === UINT32_MAX ? Number.POSITIVE_INFINITY : originalSize,
  }
}

function scanCentralDirectory(
  bytes: Uint8Array,
  view: DataView,
  maxEntries: number,
): CentralEntry[] {
  // End of central directory: fixed 22-byte record, optionally followed by a <=65535-byte comment.
  let eocd = bytes.length - 22
  for (; eocd >= 0 && u32(view, eocd) !== EOCD_SIG; eocd -= 1) {
    if (bytes.length - eocd > 65_558) throw new ZipScanError('no end-of-central-directory record')
  }
  if (eocd < 0) throw new ZipScanError('no end-of-central-directory record')

  const eocd16Count = u16(view, eocd + 8)
  let count = eocd16Count
  let offset = u32(view, eocd + 16)

  // ZIP64: the locator sits immediately before the EOCD and points at the real record.
  //
  // **Our scan is authoritative, so a locator we cannot honour is fatal.** fflate performs no
  // bounds check here (index.cjs:2589), so a locator whose target sits in the last few bytes of
  // the file would have us fall back to the 16-bit EOCD while fflate reads its count/offset from
  // a record we never validated — two parsers, two directories, and the caps applied to only one
  // of them. Rather than try to mirror another library's arithmetic, we reject any archive where
  // the two could diverge: a well-formed ZIP64 file always has a complete, correctly signed
  // record where its locator says.
  //
  // The resulting `hasZip64` is also what licenses per-entry 0x0001 extra fields below — same flag,
  // same source of truth as fflate's `z`, so the two parsers cannot disagree about a member's size.
  let hasZip64 = false
  if (eocd >= 20 && u32(view, eocd - 20) === ZIP64_LOCATOR_SIG) {
    const zip64Eocd = u32(view, eocd - 12)
    const zip64EocdHigh = u32(view, eocd - 8)
    if (
      zip64EocdHigh !== 0 ||
      zip64Eocd + 56 > bytes.length ||
      u32(view, zip64Eocd) !== ZIP64_EOCD_SIG
    ) {
      throw new ZipScanError('zip64 locator does not point at a zip64 end-of-central-directory')
    }
    hasZip64 = true

    // The *count* axis of the same divergence. fflate reads the ZIP64 total-entries and
    // central-directory-offset fields as 32-bit (`b4`, index.cjs:2593) where we read all 64 bits,
    // and — the part that bites — it gates its entire per-entry loop on the *16-bit* EOCD count
    // *before* overwriting that variable with the 32-bit ZIP64 count (index.cjs:2577-2593). A
    // 16-bit count of 1 with a ZIP64 count of 0 therefore makes fflate enter the loop, run it zero
    // times, and never reach the countdown that fires its callback: the callback is never invoked
    // at all. Rather than mirror that arithmetic, reject every archive where the three readings
    // could disagree — a well-formed ZIP64 file has none of these shapes.
    const zip64Count = view.getBigUint64(zip64Eocd + 32, true)
    const zip64Offset = view.getBigUint64(zip64Eocd + 48, true)
    if (zip64Count > UINT32_MAX_BIG || zip64Offset > UINT32_MAX_BIG) {
      throw new ZipScanError('zip64 entry count or directory offset does not fit in 32 bits')
    }
    count = Number(zip64Count)
    offset = Number(zip64Offset)
    if ((count === 0) !== (eocd16Count === 0)) {
      throw new ZipScanError(
        `zip64 record declares ${String(count)} entries but the end-of-central-directory declares ${String(eocd16Count)}`,
      )
    }
  }

  // Checked here rather than on the finished array: a ZIP64 record can declare an arbitrary count,
  // and a 200 MB archive of 46-byte headers would otherwise build ~4.5 M entry objects before the
  // cap that exists to prevent exactly that got a look at them. (A 16-bit EOCD is self-limiting at
  // 65535, but the record is not, and the array is still the allocation we are trying to avoid.)
  if (count > maxEntries) {
    throw new ZipEntryLimitError(
      `archive declares ${String(count)} entries, over the ${String(maxEntries)} limit`,
    )
  }

  const entries: CentralEntry[] = []
  for (let index = 0; index < count; index += 1) {
    need(view, offset, 46)
    if (u32(view, offset) !== CENTRAL_HEADER_SIG) {
      throw new ZipScanError(`bad central directory header at byte ${String(offset)}`)
    }
    const versionMadeBy = u16(view, offset + 4)
    const flags = u16(view, offset + 8)
    const compressionMethod = u16(view, offset + 10)
    const nameLength = u16(view, offset + 28)
    const extraLength = u16(view, offset + 30)
    const commentLength = u16(view, offset + 32)
    const externalAttributes = u32(view, offset + 38)
    need(view, offset, 46 + nameLength + extraLength + commentLength)

    // fflate decodes names as UTF-8 only when the general-purpose bit 11 is set; match it exactly
    // so the names we validate are the same strings that key the unzipped map.
    const name = strFromU8(
      bytes.subarray(offset + 46, offset + 46 + nameLength),
      (flags & 2048) === 0,
    )
    const sizes = resolveZip64Sizes(
      view,
      offset + 46 + nameLength,
      extraLength,
      u32(view, offset + 20),
      u32(view, offset + 24),
      hasZip64,
    )

    const hostSystem = versionMadeBy >> 8
    const unixMode = externalAttributes >>> 16
    const isSymlink =
      UNIX_HOST_SYSTEMS.has(hostSystem) && unixMode !== 0 && (unixMode & S_IFMT) === S_IFLNK

    entries.push({
      name,
      compressionMethod,
      isSymlink,
      localHeaderOffset: u32(view, offset + 42),
      ...sizes,
    })
    offset += 46 + nameLength + extraLength + commentLength
  }
  return entries
}

/* -------------------------------------------------------------------------------------------- *
 * Bounded, sequential extraction
 *
 * Driven entirely by the `CentralEntry[]` the scan above validated: no second parser, one member
 * in flight at a time, and every member measured by the bytes it *actually* produces rather than
 * the bytes it claims it will.
 * -------------------------------------------------------------------------------------------- */

/** A cap rejection during extraction (`too-large`), as opposed to a malformed archive. */
class ZipTooLargeError extends Error {}
/** A structurally broken member (`not-a-zip`). */
class ZipExtractError extends Error {}
/**
 * A blown extraction deadline (`extraction-timeout`), whether it was noticed between members, mid
 * member, or by the racing timer. Separate from `ZipExtractError` because a slow read is not a
 * malformed file and a UI branching on `error.code` must be able to tell them apart.
 */
class ZipTimeoutError extends ZipExtractError {}

/**
 * RFC 1951's worst case: a stored block's 5-byte header is the floor and a single length/distance
 * pair can emit 258 bytes, so DEFLATE cannot expand by more than ~1032x. Used only to size the
 * pushes below, which is what turns "abort when it overshoots" into a real memory bound: a push of
 * `n` compressed bytes can produce at most `1032n` before we get to look at the counter again.
 */
const MAX_DEFLATE_RATIO = 1032
const MIN_FEED_BYTES = 1024
const MAX_FEED_BYTES = 16 * 1024

/**
 * Locate a member's compressed bytes from its *local* header, cross-checked against the central
 * header we validated. Everything that could make the two disagree — a bad signature, a different
 * name, a different compression method, a range running off the end of the file — is malformed,
 * because the central directory is what the caps were applied to.
 */
function memberDataRange(bytes: Uint8Array, view: DataView, entry: CentralEntry): Uint8Array {
  const at = entry.localHeaderOffset
  need(view, at, 30)
  if (u32(view, at) !== LOCAL_HEADER_SIG) {
    throw new ZipExtractError(`entry ${entry.name} has no local header at ${String(at)}`)
  }
  const flags = u16(view, at + 6)
  const method = u16(view, at + 8)
  const nameLength = u16(view, at + 26)
  const extraLength = u16(view, at + 28)
  need(view, at, 30 + nameLength + extraLength)
  const localName = strFromU8(bytes.subarray(at + 30, at + 30 + nameLength), (flags & 2048) === 0)
  if (localName !== entry.name) {
    throw new ZipExtractError(`entry ${entry.name} has a local header naming ${localName}`)
  }
  if (method !== entry.compressionMethod) {
    throw new ZipExtractError(`entry ${entry.name} disagrees with its local header about method`)
  }
  const start = at + 30 + nameLength + extraLength
  const end = start + entry.compressedSize
  if (end > bytes.length) {
    throw new ZipExtractError(`entry ${entry.name} runs past the end of the file`)
  }
  return bytes.subarray(start, end)
}

/**
 * Inflate one member into a buffer of exactly `allowed` bytes, aborting the moment the stream
 * produces more than that. `allowed` is the size the archive declared and the caps approved, so
 * this is the point where a declared size that lies about a bomb stops being trusted: fflate's
 * one-shot `inflate` would happily hand back whatever the stream contained.
 *
 * Compressed input is pushed in small slices sized so a single push cannot inflate to much more
 * than the allowance that is left. Peak allocation is therefore `allowed` plus at most ~2 MB of
 * transient push output: a push is only inspected after it returns, so one push can hand the
 * callback up to `MIN_FEED_BYTES * MAX_DEFLATE_RATIO` (~1.06 MB) before the overflow check sees it,
 * and fflate's internal output buffer doubles, so briefly ~2x that. Plus the inflater's 32 kB
 * window. Megabytes, not bytes — size `maxEntryBytes` against a memory budget accordingly.
 *
 * For DEFLATE the declared inflated size is exact, so *under*-delivery is malformed too: a member
 * that produces fewer bytes than it declared (`compressedSize: 0` being the degenerate case, where
 * the push loop never runs at all) would otherwise become a silently empty part that re-saves as an
 * empty file. Every other size disagreement in this file is fatal; so is this one.
 */
function inflateMember(source: Uint8Array, allowed: number, name: string, deadline: number) {
  const out = new Uint8Array(allowed)
  let produced = 0
  let overflowed = false
  const stream = new Inflate((chunk) => {
    if (produced + chunk.length > allowed) {
      overflowed = true
      return
    }
    out.set(chunk, produced)
    produced += chunk.length
  })

  let at = 0
  while (at < source.length) {
    if (Date.now() > deadline) throw new ZipTimeoutError(`timed out inflating ${name}`)
    const headroom = Math.ceil((allowed - produced + 1) / MAX_DEFLATE_RATIO)
    const feed = Math.min(MAX_FEED_BYTES, Math.max(MIN_FEED_BYTES, headroom), source.length - at)
    stream.push(source.subarray(at, at + feed), at + feed >= source.length)
    at += feed
    if (overflowed) break
  }
  if (overflowed) {
    throw new ZipTooLargeError(
      `archive entry ${name} inflates past the ${String(allowed)} bytes it declared`,
    )
  }
  if (produced !== allowed) {
    throw new ZipExtractError(
      `archive entry ${name} produced ${String(produced)} bytes but declared ${String(allowed)}`,
    )
  }
  return out
}

/**
 * Extract the validated members, strictly one at a time, against a budget of *actual* inflated
 * bytes. A member is only started if the size it declared still fits, so the budget is spent
 * before the allocation rather than audited after it.
 */
async function extractMembers(
  bytes: Uint8Array,
  view: DataView,
  members: readonly CentralEntry[],
  limits: ArchiveLimits,
  deadline: number,
  observer: ExtractionObserver | undefined,
): Promise<ArchiveEntries> {
  const out = emptyNameMap<Uint8Array>()
  let budget = limits.maxTotalBytes

  for (const entry of members) {
    if (Date.now() > deadline) throw new ZipTimeoutError(`timed out extracting ${entry.name}`)

    const allowed =
      entry.compressionMethod === METHOD_STORED
        ? Math.max(entry.originalSize, entry.compressedSize)
        : entry.originalSize
    // Unreachable from `readArchiveBytes`, deliberately: the scan already refused the archive if
    // the *sum* of declared sizes passed `maxTotalBytes`, and `actual <= allowed` for every member,
    // so this budget can only ever be looser. It is kept because it is what makes this loop correct
    // on its own terms — nothing outside it has to have run for the peak to be bounded — and it is
    // the check that would catch a future caller handing us a member list nobody pre-summed.
    if (allowed > budget) {
      throw new ZipTooLargeError(
        `archive entry ${entry.name} does not fit the remaining ${String(budget)} inflated bytes`,
      )
    }
    const source = memberDataRange(bytes, view, entry)

    observer?.onMemberStart?.(entry.name, allowed)
    let data: Uint8Array
    let actual = 0
    try {
      if (entry.compressionMethod === METHOD_STORED) {
        // STORED: fflate hands back a copy of the compressed range and ignores the declared
        // inflated size, so the *actual* size is `compressedSize` and `allowed` already covers it.
        data = source.slice()
      } else if (entry.compressionMethod === METHOD_DEFLATE) {
        data = inflateMember(source, allowed, entry.name, deadline)
      } else {
        throw new ZipExtractError(
          `archive entry ${entry.name} uses unsupported compression method ${String(entry.compressionMethod)}`,
        )
      }
      actual = data.length
    } finally {
      observer?.onMemberEnd?.(entry.name, actual)
    }

    budget -= actual
    out[entry.name] = data
    // Hand the loop back to the event loop between members so the racing deadline timer can
    // actually fire, and so a long read cannot starve the main process outright. Sequential by
    // construction is the whole point here, so `Promise.all` is not an alternative: running these
    // in parallel is precisely the bug this design exists to remove.
    // oxlint-disable-next-line no-await-in-loop
    await new Promise<void>((resolve) => {
      yieldToEventLoop(resolve)
    })
  }
  return out
}

/**
 * Validate and extract an in-memory zip. `label` only ever appears in error messages — it is the
 * file path when there is one, and a description like `import/original.pptx` when the bytes came
 * out of another archive.
 *
 * Never throws for bad input: errors are values.
 */
export async function readArchiveBytes(
  bytes: Uint8Array,
  label: string,
  options: ReadArchiveOptions = {},
): Promise<ReadArchiveResult> {
  const limits: ArchiveLimits = { ...DEFAULT_ARCHIVE_LIMITS, ...options.limits }

  if (bytes.length > limits.maxCompressedBytes) {
    return fail(
      'too-large',
      `${label} is ${String(bytes.length)} bytes, over the ${String(limits.maxCompressedBytes)}-byte limit`,
    )
  }
  if (!looksLikeZip(bytes)) {
    return fail('not-a-zip', `${label} is not a zip archive (bad magic bytes)`)
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let central: CentralEntry[]
  try {
    central = scanCentralDirectory(bytes, view, limits.maxEntries)
  } catch (error) {
    if (error instanceof ZipEntryLimitError) {
      return fail('too-large', `${label} has too many entries: ${error.message}`)
    }
    return fail('not-a-zip', `${label} has an unreadable zip directory: ${String(error)}`)
  }

  // Belt and braces: the scan already refuses a declared count over the cap, but the invariant the
  // rest of this function relies on is about the array it actually returned.
  if (central.length > limits.maxEntries) {
    return fail(
      'too-large',
      `${label} has ${String(central.length)} entries, over the ${String(limits.maxEntries)} limit`,
    )
  }

  // Reject the file outright rather than sanitizing names. Directory markers are validated too
  // (minus their trailing slash) and only *then* skipped: an entry literally named `../../evil/`
  // must not slip through the gate just because it ends in a slash.
  const wanted: CentralEntry[] = []
  let totalInflated = 0
  let totalCompressed = 0
  for (const entry of central) {
    const isDirectory = entry.name.endsWith('/')
    const asFile = isDirectory ? entry.name.slice(0, -1) : entry.name
    if (!isSafeArchivePath(asFile)) {
      return fail('unsafe-entry', `archive entry escapes the archive root: ${entry.name}`)
    }
    if (entry.isSymlink) {
      return fail('unsafe-entry', `archive entry is a symlink: ${entry.name}`)
    }
    if (isDirectory) continue

    // What fflate will actually allocate for this member. STORED (method 0) ignores the declared
    // inflated size entirely and copies `compressedSize` bytes, so an entry declaring
    // `originalSize: 0` over a 20 MB stored payload costs 20 MB, not nothing.
    const allocates =
      entry.compressionMethod === METHOD_STORED
        ? Math.max(entry.originalSize, entry.compressedSize)
        : entry.originalSize

    if (allocates > limits.maxEntryBytes) {
      return fail(
        'too-large',
        `archive entry ${entry.name} inflates to ${String(allocates)} bytes, over the ${String(limits.maxEntryBytes)}-byte limit`,
      )
    }
    if (entry.compressedSize > limits.maxEntryBytes) {
      return fail(
        'too-large',
        `archive entry ${entry.name} holds ${String(entry.compressedSize)} compressed bytes, over the ${String(limits.maxEntryBytes)}-byte limit`,
      )
    }
    totalInflated += allocates
    if (totalInflated > limits.maxTotalBytes) {
      return fail(
        'too-large',
        `${label} inflates to over the ${String(limits.maxTotalBytes)}-byte limit`,
      )
    }

    // Summed *before* anything is inflated, and cross-checked against the archive's own length: the
    // compressed bytes of every member are disjoint ranges inside the file, so an honest archive
    // can never declare more of them than it contains. This is what catches N central entries
    // aliasing a single local header — the shape that turns one 20 MB stored member into N x 20 MB
    // of allocation while every per-entry cap and every inflated-size total stays satisfied.
    totalCompressed += entry.compressedSize
    if (totalCompressed > limits.maxTotalCompressedBytes) {
      return fail(
        'too-large',
        `${label} declares over the ${String(limits.maxTotalCompressedBytes)}-byte compressed-data limit`,
      )
    }
    if (totalCompressed > bytes.length) {
      return fail(
        'too-large',
        `${label} declares ${String(totalCompressed)} compressed bytes but is only ${String(bytes.length)} bytes long`,
      )
    }
    wanted.push(entry)
  }

  // Only members that passed every gate above are inflated, one at a time, and each is aborted the
  // moment its *actual* output passes the size it declared — so the caps above bound peak
  // allocation (`maxEntryBytes + O(1)`) and not merely the sum. The whole phase runs under a
  // deadline, enforced both inside the loop and by a racing timer, because this function's contract
  // is that it settles: a promise that never resolves is strictly worse than an error value.
  const timeoutMs = options.extractionTimeoutMs ?? DEFAULT_EXTRACTION_TIMEOUT_MS
  const deadline = Date.now() + timeoutMs
  let timer: NodeJS.Timeout | undefined
  try {
    const entries = await Promise.race([
      // No members left after the gates above means nothing to inflate; skip the phase entirely.
      wanted.length === 0
        ? Promise.resolve(emptyNameMap<Uint8Array>())
        : extractMembers(bytes, view, wanted, limits, deadline, options.observer),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => {
            reject(new ZipTimeoutError(`extraction exceeded ${String(timeoutMs)} ms`))
          },
          Math.max(0, timeoutMs),
        )
        timer.unref()
      }),
    ])
    return { ok: true, entries, bytes }
  } catch (error) {
    if (error instanceof ZipTooLargeError) return fail('too-large', error.message)
    // Checked before `ZipExtractError`, which it extends: a slow read is not a malformed file.
    if (error instanceof ZipTimeoutError) return fail('extraction-timeout', error.message)
    return fail('not-a-zip', `${label} could not be unzipped: ${String(error)}`)
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/**
 * Read a zip off disk and extract it under the same gates. `stat` runs first: checking the size
 * after `readFile` would enforce the cap only once the allocation it exists to prevent had already
 * happened, and the post-read re-check covers a file that grew in between (TOCTOU) as well as a
 * `stat` on a directory or device, whose reported size says nothing about what `readFile` returns.
 */
export async function readArchiveFile(
  path: string,
  options: ReadArchiveOptions = {},
): Promise<ReadArchiveResult> {
  const limits: ArchiveLimits = { ...DEFAULT_ARCHIVE_LIMITS, ...options.limits }

  let declaredSize: number
  try {
    declaredSize = (await stat(path)).size
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'not-found' : 'io'
    return fail(code, `cannot read ${path}: ${String(error)}`)
  }
  if (declaredSize > limits.maxCompressedBytes) {
    return fail(
      'too-large',
      `${path} is ${String(declaredSize)} bytes, over the ${String(limits.maxCompressedBytes)}-byte limit`,
    )
  }

  let bytes: Uint8Array
  try {
    bytes = new Uint8Array(await readFile(path))
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'not-found' : 'io'
    return fail(code, `cannot read ${path}: ${String(error)}`)
  }

  return readArchiveBytes(bytes, path, options)
}
