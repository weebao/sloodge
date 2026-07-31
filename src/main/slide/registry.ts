import {
  createSlideDocumentId,
  isSlideDocumentId,
  MAX_SLIDE_HTML_BYTES,
} from '../../shared/slide-protocol'

/**
 * The in-memory store behind `slide://`.
 *
 * It is a `Map<id, html>` and it is meant to stay one. The `slide://` handler serves whatever this
 * returns and nothing else — it never touches the filesystem, never resolves a path, never joins a
 * user-controlled segment onto a root directory. That is not an optimisation; it is the reason the
 * scheme has no path-traversal surface to review. A handler that mapped `slide://x/foo.html` onto
 * `slides/foo.html` on disk would need a normalizer, a root check, a symlink check and a
 * case-folding check, and would be wrong on one platform. This needs none of them.
 *
 * Nothing here imports `electron`, so the semantics are testable in plain Node; `protocol.ts` and
 * `ipc.ts` own the wiring.
 */

/**
 * Failure modes a publish can have, as a discriminated result rather than an exception type.
 *
 * The IPC layer turns a refusal into a rejected `invoke`, which is what the renderer sees; keeping
 * the reason machine-readable here means the tests assert on a tag instead of on message prose.
 */
export type SlidePublishRefusal =
  | { reason: 'not-a-string' }
  | { reason: 'too-large'; bytes: number; limit: number }
  | { reason: 'too-many-documents'; limit: number }
  | { reason: 'registry-full'; bytes: number; limit: number }

export type SlidePublishResult =
  { ok: true; id: string } | { ok: false; refusal: SlidePublishRefusal }

export type SlideRegistryLimits = {
  /** UTF-8 bytes in any single document. */
  maxDocumentBytes: number
  /** How many documents may be live at once. */
  maxDocuments: number
  /** UTF-8 bytes across every live document. */
  maxTotalBytes: number
}

/**
 * Sized against the document model, because the registry holds the same objects the document model
 * holds: at most one deck's worth of slide HTML, one member at a time.
 * `maxDocumentBytes`/`maxDocuments`/`maxTotalBytes` mirror `DEFAULT_ARCHIVE_LIMITS`'
 * `maxEntryBytes`/`maxEntries`/`maxTotalBytes` in `../document/store.ts`, and a unit test pins them
 * together so a future tightening of one cannot quietly leave the other wide open.
 *
 * The aggregate caps exist because publish is driven by a React effect, once per mounted frame.
 * Every one of them is paired with a revoke today, but "every one of them is paired with a revoke"
 * is a property of renderer code that will keep changing — a leak there is a main-process memory
 * leak, and an unbounded one is an OOM in the process that owns the window. These caps turn that
 * class of bug from a crash into a slide that fails to render.
 */
export const DEFAULT_SLIDE_REGISTRY_LIMITS: SlideRegistryLimits = {
  maxDocumentBytes: MAX_SLIDE_HTML_BYTES,
  maxDocuments: 10_000,
  maxTotalBytes: 256 * 1024 * 1024,
}

/**
 * Measures a string's UTF-8 length without encoding a copy of it.
 *
 * Injectable only so the byte-cap tests need not allocate 64 MB to reach the limit; production
 * always uses `Buffer.byteLength`, which walks the string and counts.
 */
export type ByteLengthFn = (value: string) => number

const utf8ByteLength: ByteLengthFn = (value) => Buffer.byteLength(value, 'utf8')

export type SlideRegistryOptions = {
  limits?: Partial<SlideRegistryLimits>
  byteLength?: ByteLengthFn
  /** Injectable id source; production uses the shared CSPRNG generator. */
  createId?: () => string
}

/**
 * A published document, with the bookkeeping needed to release it.
 *
 * `owner` is the id of the `WebContents` that published it. Documents are normally released one by
 * one by the renderer's per-frame effect cleanups, but a renderer that *disappears* — a reload, an
 * HMR full refresh, a crashed render process — never runs those cleanups, and every document it
 * published would otherwise sit in main's heap for the life of the app. Grouping by owner is what
 * lets the whole set be dropped when its renderer goes away. See `trackPublisher` in `protocol.ts`.
 */
type SlideDocument = {
  html: string
  bytes: number
  owner: number
}

/** The owner recorded for a publish that did not come from a `WebContents` (tests, direct calls). */
export const UNOWNED = -1

export class SlideRegistry {
  readonly #documents = new Map<string, SlideDocument>()
  readonly #limits: SlideRegistryLimits
  readonly #byteLength: ByteLengthFn
  readonly #createId: () => string
  #totalBytes = 0

  constructor(options: SlideRegistryOptions = {}) {
    this.#limits = { ...DEFAULT_SLIDE_REGISTRY_LIMITS, ...options.limits }
    this.#byteLength = options.byteLength ?? utf8ByteLength
    this.#createId = options.createId ?? createSlideDocumentId
  }

  /** Documents currently live. */
  get size(): number {
    return this.#documents.size
  }

  /** UTF-8 bytes currently held. */
  get totalBytes(): number {
    return this.#totalBytes
  }

  /**
   * Store a document and return its fresh id.
   *
   * Validation happens here even though the preload already screened the same value, because the
   * preload is renderer-side code: it runs in a process that model-generated content executes in,
   * and a compromised or merely buggy renderer can call `ipcRenderer.invoke` directly with anything
   * at all. Main is the only side whose checks are worth anything, and this is the exact check —
   * real UTF-8 bytes, not the preload's conservative UTF-16 screen.
   */
  publish(html: unknown, owner: number = UNOWNED): SlidePublishResult {
    if (typeof html !== 'string') {
      return { ok: false, refusal: { reason: 'not-a-string' } }
    }

    const bytes = this.#byteLength(html)
    if (bytes > this.#limits.maxDocumentBytes) {
      return {
        ok: false,
        refusal: { reason: 'too-large', bytes, limit: this.#limits.maxDocumentBytes },
      }
    }
    if (this.#documents.size >= this.#limits.maxDocuments) {
      return {
        ok: false,
        refusal: { reason: 'too-many-documents', limit: this.#limits.maxDocuments },
      }
    }
    if (this.#totalBytes + bytes > this.#limits.maxTotalBytes) {
      return {
        ok: false,
        refusal: { reason: 'registry-full', bytes, limit: this.#limits.maxTotalBytes },
      }
    }

    // A collision is a ~2^-128 event, but the loop costs nothing and the alternative is silently
    // overwriting a live slide's document with a different slide's content.
    let id = this.#createId()
    while (this.#documents.has(id)) {
      id = this.#createId()
    }

    this.#documents.set(id, { html, bytes, owner })
    this.#totalBytes += bytes
    return { ok: true, id }
  }

  /**
   * The document for an id, or `undefined` — which the handler turns into a 404.
   *
   * The id is re-validated rather than trusted, because this one arrives off a URL the *renderer*
   * chose: an unmodified `Map.get` with an attacker-chosen key is a prototype-pollution read on a
   * plain object and merely a miss on a `Map`, but the shape check also keeps the handler's
   * accepted-input surface identical to the publish side's issued-output surface, which is the
   * property a reviewer can check by eye.
   */
  get(id: unknown): string | undefined {
    return isSlideDocumentId(id) ? this.#documents.get(id)?.html : undefined
  }

  /** Drop a document. `false` when the id was not live — a double-revoke, not an error. */
  revoke(id: unknown): boolean {
    if (!isSlideDocumentId(id)) return false
    const document = this.#documents.get(id)
    if (document === undefined) return false
    this.#documents.delete(id)
    this.#totalBytes -= document.bytes
    return true
  }

  /**
   * Drop every document published by one renderer, returning how many went.
   *
   * This is the reclamation path for the case the per-frame revokes never arrive: a reload, an HMR
   * full refresh, or a crashed render process all destroy the renderer without running a single
   * effect cleanup. Without it, a dev loop of a few dozen reloads on a 60-slide deck walks the
   * aggregate byte budget up to `maxTotalBytes` and every subsequent publish is refused — which
   * surfaces as slides silently rendering blank, the least debuggable failure this design has.
   */
  revokeOwner(owner: number): number {
    let dropped = 0
    for (const [id, document] of this.#documents) {
      if (document.owner !== owner) continue
      this.#documents.delete(id)
      this.#totalBytes -= document.bytes
      dropped += 1
    }
    return dropped
  }

  /** Drop everything. For app teardown, where not even the owner hooks will fire. */
  clear(): void {
    this.#documents.clear()
    this.#totalBytes = 0
  }
}
