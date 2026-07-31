/**
 * The undo/redo stacks of §5 of 10-architecture.md, as a pure, transport-free object.
 *
 * `DocumentHistory` owns the *current document* and two stacks of `HistoryEntry`. Every mutation
 * — human, design-mode or agent — goes through `apply(commands, origin)`, which is the funnel the
 * architecture doc requires: validate the batch, compute its inverse against the pre-state, apply
 * it forward, bump `rev`, push one entry, clear the redo stack.
 *
 * Undo applies the entry's *inverse* batch and moves the entry to the redo stack; redo applies the
 * *forward* batch again. Neither pushes a new entry, and both bump `rev`, so a replica that
 * follows revisions sees undo and redo as ordinary document changes with no special-case code.
 *
 * Why this class holds the document instead of just the stacks: the two are one invariant. An
 * entry's inverse is only valid against the exact state its forward batch produced, so a design
 * that let a caller mutate the document beside the history would make every stacked inverse a
 * guess. `DocumentSession` (main) will wrap this with IPC, autosave and patch emission; this
 * module stays free of Node, Electron and any notion of a window, which is what makes the
 * behaviour below testable without a browser.
 *
 * ## Transactions
 *
 * `beginTransaction(label)` / `commit()` / `abort()` exist for one reason: **a full agent turn is
 * a single Ctrl+Z**. A prompt that rewrites three slides and retints the theme applies several
 * batches; while a transaction is open they are appended to the open entry rather than pushed as
 * separate ones. Per §5: a turn that errors or is interrupted is *committed*, not aborted —
 * partial work is kept and remains undoable — and `abort()` is reserved for tool-level validation
 * failures, where it rolls the document back by applying everything accumulated so far in reverse.
 *
 * Undo and redo are refused while a transaction is open: the open entry has no inverse yet that
 * anyone else may rely on, and interleaving would leave the stacks describing a state the document
 * never had.
 *
 * ## Bounds
 *
 * Capped at `maxEntries` (200 by default, per §5) *and* at a soft `maxBytes` of retained command
 * payload (64 MB by default), because the entry count alone bounds nothing when one entry can
 * carry two copies of a 2 MB slide. Eviction is FIFO — the oldest entry is dropped first, so undo
 * always reaches as far back as the budget allows. The newest entry is never evicted even if it
 * exceeds the byte cap on its own: dropping it would make the edit the user just made
 * un-undoable, which is a worse outcome than briefly exceeding a soft cap. `#push` spells out
 * what that exemption costs — in short, the real bound is `maxBytes` plus one agent turn.
 *
 * History is per document, is cleared by `reset()` on `doc:open`, and is deliberately *not*
 * persisted in v1 (§11) — the recovery journal covers crash survival, not history survival.
 */

import {
  applyBatch,
  cloneCommand,
  commandBytes,
  type CommandError,
  type CommandErrorCode,
  type DeckDoc,
  type DocCommand,
} from './commands'

/** §5. `label` is what the Edit menu shows: "Delete slide", `AI: "make it more corporate"`. */
export type CommandOrigin =
  | { kind: 'user'; label: string }
  | { kind: 'design'; label: string; elementId: string }
  | { kind: 'agent'; turnId: string; toolUseId: string }

export type HistoryEntry = {
  forward: DocCommand[]
  /** Reverse order, so applying it undoes `forward` step by step. */
  inverse: DocCommand[]
  origin: CommandOrigin
  label: string
  /** The document revision this entry produced. */
  rev: number
  ts: number
  /** Estimated retained payload of `forward` + `inverse`, for the soft memory cap. */
  bytes: number
}

export type HistoryErrorCode =
  | CommandErrorCode
  | 'nothing-to-undo'
  | 'nothing-to-redo'
  | 'transaction-open'
  | 'no-open-transaction'

export type HistoryError = Omit<CommandError, 'code'> & { code: HistoryErrorCode }

export type HistoryResult<D> =
  { ok: true; doc: D; rev: number } | { ok: false; error: HistoryError }

/** What the renderer replica keeps of the history (§4): flags and labels, never the stacks. */
export type HistorySummary = {
  rev: number
  canUndo: boolean
  canRedo: boolean
  undoLabel: string | null
  redoLabel: string | null
  undoDepth: number
  redoDepth: number
  retainedBytes: number
  inTransaction: boolean
}

/** §5: "capped at 200 entries". */
export const DEFAULT_MAX_HISTORY_ENTRIES = 200

/** §5: "a soft cap on total retained HTML bytes ~64 MB". */
export const DEFAULT_MAX_HISTORY_BYTES = 64 * 1024 * 1024

export type HistoryOptions = {
  maxEntries?: number
  maxBytes?: number
  /** Injectable clock, so entry timestamps are deterministic in tests. */
  now?: () => number
}

function labelFor(origin: CommandOrigin): string {
  return origin.kind === 'agent' ? 'AI edit' : origin.label
}

function batchBytes(commands: readonly DocCommand[]): number {
  let total = 0
  for (const command of commands) total += commandBytes(command)
  return total
}

type OpenTransaction = {
  label: string
  origin: CommandOrigin | null
  forward: DocCommand[]
  inverse: DocCommand[]
  bytes: number
}

export class DocumentHistory<D extends DeckDoc> {
  #doc: D
  #rev = 0
  #undo: HistoryEntry[] = []
  #redo: HistoryEntry[] = []
  #open: OpenTransaction | null = null
  readonly #maxEntries: number
  readonly #maxBytes: number
  readonly #now: () => number

  constructor(doc: D, options: HistoryOptions = {}) {
    this.#doc = doc
    // A depth of 0 would make every edit un-undoable, which no caller can want; treat a
    // nonsensical option as "use the default" rather than silently disabling undo.
    const maxEntries = options.maxEntries ?? DEFAULT_MAX_HISTORY_ENTRIES
    this.#maxEntries =
      Number.isInteger(maxEntries) && maxEntries > 0 ? maxEntries : DEFAULT_MAX_HISTORY_ENTRIES
    const maxBytes = options.maxBytes ?? DEFAULT_MAX_HISTORY_BYTES
    this.#maxBytes = maxBytes > 0 ? maxBytes : DEFAULT_MAX_HISTORY_BYTES
    this.#now = options.now ?? Date.now
  }

  get doc(): D {
    return this.#doc
  }

  get rev(): number {
    return this.#rev
  }

  get canUndo(): boolean {
    return this.#open === null && this.#undo.length > 0
  }

  get canRedo(): boolean {
    return this.#open === null && this.#redo.length > 0
  }

  get inTransaction(): boolean {
    return this.#open !== null
  }

  get maxEntries(): number {
    return this.#maxEntries
  }

  get maxBytes(): number {
    return this.#maxBytes
  }

  /** Retained payload across *both* stacks — what the process is actually holding. */
  get retainedBytes(): number {
    return this.#stackBytes(this.#undo) + this.#stackBytes(this.#redo) + (this.#open?.bytes ?? 0)
  }

  /** Read-only view of the undo stack, oldest first. Copies the array, not the entries. */
  undoStack(): readonly HistoryEntry[] {
    return [...this.#undo]
  }

  redoStack(): readonly HistoryEntry[] {
    return [...this.#redo]
  }

  summary(): HistorySummary {
    return {
      rev: this.#rev,
      canUndo: this.canUndo,
      canRedo: this.canRedo,
      undoLabel: this.#undo.at(-1)?.label ?? null,
      redoLabel: this.#redo.at(-1)?.label ?? null,
      undoDepth: this.#undo.length,
      redoDepth: this.#redo.length,
      retainedBytes: this.retainedBytes,
      inTransaction: this.#open !== null,
    }
  }

  /**
   * Point the history at a different document and forget everything (`doc:open`, §5). `rev` is
   * *not* reset: a replica that is told to resync must be able to tell the new snapshot from the
   * one it already had, and a revision counter that goes backwards would make that impossible.
   */
  reset(doc: D): void {
    this.#doc = doc
    this.#undo = []
    this.#redo = []
    this.#open = null
    this.#rev += 1
  }

  /**
   * The funnel. Validates and applies the batch atomically, records one undo entry (or extends
   * the open transaction), and clears the redo stack — redoing after a new edit would replay a
   * command against a document that diverged from the one it was computed for.
   */
  apply(commands: readonly DocCommand[], origin: CommandOrigin, label?: string): HistoryResult<D> {
    const applied = applyBatch(this.#doc, commands)
    if (!applied.ok) return { ok: false, error: applied.error }

    this.#doc = applied.doc
    this.#rev += 1
    this.#redo = []

    // Deep-copied, not `[...commands]`: a shallow array copy still holds the caller's command
    // objects, so an `html` mutated after `apply` returned would change what `redo()` replays.
    // The stack has to describe what happened, not what the caller is holding now.
    const forward = commands.map(cloneCommand)
    const bytes = batchBytes(forward) + batchBytes(applied.inverse)
    const open = this.#open
    if (open) {
      open.forward.push(...forward)
      // `unshift`, not `push`: the transaction's inverse is applied front-to-back, so each new
      // batch's inverse has to land *in front* of everything already accumulated. With `push`, a
      // turn whose batches do not commute (a remove followed by two moves) undoes to a different
      // slide order than it started in — silently, and only for multi-batch agent turns.
      open.inverse.unshift(...applied.inverse)
      open.bytes += bytes
      open.origin ??= origin
    } else {
      this.#push({
        forward,
        inverse: applied.inverse,
        origin,
        label: label ?? labelFor(origin),
        rev: this.#rev,
        ts: this.#now(),
        bytes,
      })
    }
    return { ok: true, doc: this.#doc, rev: this.#rev }
  }

  undo(): HistoryResult<D> {
    if (this.#open !== null) {
      return this.#fail('transaction-open', 'cannot undo while a transaction is open')
    }
    const entry = this.#undo.at(-1)
    if (!entry) return this.#fail('nothing-to-undo', 'the undo stack is empty')

    const applied = applyBatch(this.#doc, entry.inverse)
    // Unreachable for entries this class produced: an inverse is computed against the exact state
    // its forward batch was applied to, and that state is the one we are in. Surfaced rather than
    // asserted because the alternative — a half-rolled-back document — is unrecoverable.
    if (!applied.ok) return { ok: false, error: applied.error }

    this.#undo.pop()
    this.#redo.push(entry)
    this.#doc = applied.doc
    this.#rev += 1
    return { ok: true, doc: this.#doc, rev: this.#rev }
  }

  redo(): HistoryResult<D> {
    if (this.#open !== null) {
      return this.#fail('transaction-open', 'cannot redo while a transaction is open')
    }
    const entry = this.#redo.at(-1)
    if (!entry) return this.#fail('nothing-to-redo', 'the redo stack is empty')

    const applied = applyBatch(this.#doc, entry.forward)
    if (!applied.ok) return { ok: false, error: applied.error }

    this.#redo.pop()
    // Re-applying may produce a *different* inverse than the one recorded (a `slide.setHtml`
    // undone and redone inverts against the HTML that undo restored), so the entry is refreshed
    // rather than reused. Same forward batch, same label, new inverse and revision.
    this.#push({ ...entry, inverse: applied.inverse, rev: this.#rev + 1, ts: this.#now() })
    this.#doc = applied.doc
    this.#rev += 1
    return { ok: true, doc: this.#doc, rev: this.#rev }
  }

  /**
   * Open a transaction: every batch applied until `commit`/`abort` collapses into one undo step.
   * One at a time — nesting would need a stack of open entries and a rule for what a nested abort
   * means, and the only producer (one agent turn per session) never nests.
   */
  beginTransaction(label: string): HistoryResult<D> {
    if (this.#open !== null) {
      return this.#fail('transaction-open', 'a transaction is already open')
    }
    this.#open = { label, origin: null, forward: [], inverse: [], bytes: 0 }
    return { ok: true, doc: this.#doc, rev: this.#rev }
  }

  /**
   * Close the transaction and push it as a single entry. A transaction that applied nothing
   * pushes no entry at all — an empty undo step would consume a Ctrl+Z and do nothing visible,
   * which reads as a broken undo.
   */
  commitTransaction(): HistoryResult<D> {
    const open = this.#open
    if (!open) return this.#fail('no-open-transaction', 'no transaction is open')
    this.#open = null
    if (open.forward.length > 0) {
      this.#push({
        forward: open.forward,
        inverse: open.inverse,
        origin: open.origin ?? { kind: 'user', label: open.label },
        label: open.label,
        rev: this.#rev,
        ts: this.#now(),
        bytes: open.bytes,
      })
    }
    return { ok: true, doc: this.#doc, rev: this.#rev }
  }

  /**
   * Roll the transaction back: apply everything it accumulated, in reverse, and push no entry.
   * Reserved for tool-level validation failures where the partial state is invalid (§5) — an
   * interrupted or errored agent turn commits instead, so the user keeps the partial work.
   */
  abortTransaction(): HistoryResult<D> {
    const open = this.#open
    if (!open) return this.#fail('no-open-transaction', 'no transaction is open')
    if (open.forward.length === 0) {
      this.#open = null
      return { ok: true, doc: this.#doc, rev: this.#rev }
    }
    const applied = applyBatch(this.#doc, open.inverse)
    // Leave the transaction *open* on failure: the document is still mid-transaction, and
    // silently closing it would strand the accumulated inverse with no way to retry the rollback.
    //
    // Unreachable by construction, and left unpinned on purpose — the same call the store makes
    // for its `allowed > budget` branch. Every command in `open.inverse` was inverted against the
    // exact state its forward command was applied to, and `abortTransaction` runs from that state,
    // so the only way here is a bug in this file. A test could only reach it by reaching into the
    // private open transaction, which would pin the reach-in rather than the behaviour. The
    // sibling branch in `undo()` *is* reachable (an entry's `inverse` is exposed by `undoStack()`)
    // and is pinned there.
    if (!applied.ok) return { ok: false, error: applied.error }
    this.#open = null
    this.#doc = applied.doc
    this.#rev += 1
    return { ok: true, doc: this.#doc, rev: this.#rev }
  }

  #fail(code: HistoryErrorCode, message: string): HistoryResult<D> {
    return { ok: false, error: { code, message } }
  }

  #stackBytes(stack: readonly HistoryEntry[]): number {
    let total = 0
    for (const entry of stack) total += entry.bytes
    return total
  }

  /**
   * Push and evict, oldest first, under both caps. The newest entry is never evicted.
   *
   * Two honest limits on what the byte cap buys, both consequences of never evicting the newest
   * entry rather than oversights:
   *
   *  - **One entry is always exempt**, and a committed agent turn is *one* entry — the largest
   *    thing this system produces. The cap therefore bounds the stack, not the worst case: a turn
   *    that rewrote forty slides is retained in full, deliberately, because dropping it would make
   *    the edit the user is most likely to want back the one they cannot undo.
   *  - **An open transaction is not measured against the cap at all.** `#push` never runs while
   *    one is open (that is what makes a turn a single entry), so a turn accumulates until it
   *    commits and is only weighed afterwards — at which point it is the newest entry and exempt.
   *
   * The bound this really provides is: `maxBytes` plus the largest single turn. Both `maxTurns`
   * and `maxBudgetUsd` bound that turn upstream in `AgentService` (10-architecture.md §3), which
   * is the layer that can actually stop it.
   */
  #push(entry: HistoryEntry): void {
    this.#undo.push(entry)
    while (this.#undo.length > this.#maxEntries) this.#undo.shift()
    while (this.#undo.length > 1 && this.#stackBytes(this.#undo) > this.#maxBytes) {
      this.#undo.shift()
    }
  }
}
