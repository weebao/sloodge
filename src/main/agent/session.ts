/**
 * One `AgentSession` per open deck window: it owns exactly one live `query()` and the input bridge
 * feeding it (50-agent-integration.md §1). This is the turn state machine — it starts the query
 * lazily on the first message, streams SDK messages out as `AgentEvent`s, and tears down cleanly.
 *
 * It depends only on the `AgentQueryFn` seam, so tests drive the whole lifecycle with a fake that
 * yields a scripted message sequence — no key, no subprocess, no network.
 */

import type { AgentEvent } from '../../shared/agent/types'
import type { BudgetCap } from '../../shared/agent/budget'
import {
  beginTurn,
  foldTurnCost,
  INITIAL_COST_STATE,
  type CostState,
} from '../../shared/agent/cost'
import { createChatBridge, type ChatBridge } from './bridge'
import { classifyException, isRecoverable, mapSdkMessage } from './event-mapping'
import { defaultAgentLog, type AgentLog } from './log'
import type { AgentQueryFn, AgentQueryHandle, AgentQueryOptions } from './query-contract'
import { missingSkills, type BundledSkillName } from './skills'

export type AgentSessionDeps = {
  readonly queryFn: AgentQueryFn
  readonly options: AgentQueryOptions
  readonly emit: (event: AgentEvent) => void
  /**
   * §8's fallback material (M2.5): the three SKILL.md bodies composed into a system-prompt append,
   * or `null` when they could not be read. Called at most once, and only after an init has already
   * reported the skills missing — so the bundle read costs nothing on a healthy session.
   *
   * Absent (the dep not supplied at all) means this session cannot self-repair: it reports
   * `unavailable` and keeps M2.4's loud chat notice. Tests use that to exercise both branches.
   */
  readonly loadFallbackPrompt?: () => Promise<string | null>
  /** Diagnostic sink; defaults to `defaultAgentLog`. Injected so a test can read what was logged. */
  readonly log?: AgentLog
}

/**
 * The §8 verification result. `known: false` until the runtime's `system:init` arrives — a consumer
 * must not read "nothing loaded" out of the handshake window.
 *
 * `mode` distinguishes the two healthy shapes: a `skills` session discovered its skills from the
 * workspace, a `fallback` session is running with `skills: []` and the bodies inlined (M2.5). The
 * distinction is load-bearing for `missing`, which is meaningless in fallback mode — an empty
 * `loaded` array is exactly what a fallback session is *supposed* to report.
 */
export type SkillStatus =
  | { readonly known: false }
  | {
      readonly known: true
      readonly mode: SkillMode
      readonly loaded: readonly string[]
      readonly missing: readonly BundledSkillName[]
    }

/** How this session is loading its slide-craft knowledge. See `SkillStatus`. */
export type SkillMode = 'skills' | 'fallback'

/**
 * Result subtypes that end the `query()` itself, not merely the turn.
 *
 * Knowing these lets the session mark itself dead at the *result*, which is strictly earlier than
 * the generator draining. Anything not listed is still caught by the drain (`consume`'s `finally`),
 * so an unlisted terminal subtype degrades to the old timing rather than to a wedged session.
 */
const TERMINAL_RESULT_SUBTYPES: ReadonlySet<string> = new Set([
  'error_max_budget_usd',
  'error_max_turns',
])

/**
 * The `turn-end` subtype main synthesises for a turn whose query ended without answering it. Not an
 * SDK subtype — it marks a zero-cost close that `closeOpenTurns` emitted, so a reader of the event
 * log can tell "the runtime said this turn cost $0" from "we never heard back".
 */
export const QUERY_ENDED_SUBTYPE = 'query_ended'

export class AgentSession {
  private readonly deps: AgentSessionDeps
  /**
   * Not `readonly`: the §8 fallback restart replaces it. The old bridge's stream generator is owned
   * by the query being torn down and cannot be handed to a second one, so a restart needs a fresh
   * queue as well as a fresh query.
   */
  private bridge: ChatBridge
  private handle: AgentQueryHandle | null = null
  private consuming: Promise<void> | null = null
  private closed = false
  /** Assistant-id dedup set, held for the session's whole lifetime (§10, §16). */
  private readonly seenAssistantIds = new Set<string>()
  /**
   * Client-side estimate, folded by the shared rule in `shared/agent/cost.ts` — the same function
   * the renderer's transcript uses, so the status bar cannot drift from what main recorded (§10).
   * Never billed off.
   */
  private cost: CostState = INITIAL_COST_STATE
  /**
   * Which query generation is live. Incremented whenever a query is replaced — the §8 fallback
   * restart, and the re-arm after a query ends — so the outgoing query's residual messages and its
   * drain-time retirement are ignored instead of interleaving with the replacement's. Without it the
   * old subprocess's `result` and the new one's `ready` would both reach the renderer, and a query
   * draining *after* its replacement opened would mark the replacement finished.
   *
   * A bump is only ever taken for a query that has nothing left to bill: the fallback restart happens
   * at `system:init` (spend zero, pending turns replayed) and the re-arm happens after a terminal
   * `result` or a drain (every open turn closed by `closeOpenTurns` first). A live query is never
   * replaced — that was round 3's undercount.
   */
  private generation = 0
  /** See `SkillMode`. Flips exactly once, when the fallback restart opens the replacement query. */
  private skillMode: SkillMode = 'skills'
  /**
   * The §8 restart-once guard. Set **before** the restart's first `await`, so a second init that
   * also reports missing skills cannot start a third query — a session that restarts on every init
   * would spawn subprocesses in a loop, and a loop of `query()` spawns against a broken workspace is
   * the worst possible response to a degraded one. Fallback is a single attempt by construction.
   */
  private restartAttempted = false
  /**
   * The generation whose init has already been announced, so a runtime that re-inits mid-session
   * does not re-announce a degradation the user was told about (M2.4's "announce once"). Keyed on
   * the generation rather than a bare boolean because the fallback restart genuinely *is* a new
   * announcement — the whole point is that the shape changed.
   */
  private reportedGeneration: number | null = null
  /**
   * Turns sent but not yet ended. The restart replays these into the replacement query: by the time
   * `system:init` arrives the SDK has already consumed the user's message off the bridge, so a
   * restart that did not replay would silently swallow the very turn that triggered it.
   *
   * Usually one entry — the composer refuses to send while a turn is streaming — but a list, because
   * Stop → retype → Send opens a second turn before the first has ended.
   */
  private pendingTexts: string[] = []
  /**
   * The user's configured spend cap (§10), or `null` for no limit. `AgentService` sets it before every
   * send and whenever Settings saves a new one, so it is never staler than the last thing the user
   * chose. It is the **absolute** cap — see `setBudgetCap` for how it is enforced and why the SDK's
   * per-query ceiling is only a backstop.
   */
  private capUsd: BudgetCap
  /**
   * A cap-triggered interrupt is in flight and its `result` has not folded yet. Stops a second cap
   * edit, or the fold that follows, from interrupting the same turn twice and telling the user twice.
   */
  private budgetInterruptPending = false
  /**
   * The most recent `session_id` the runtime reported. Used to `resume` when we have to reopen a
   * query mid-session, so replacing it for budget reasons does not also wipe the conversation.
   */
  private lastSessionId: string | null = null
  /**
   * The live query has ended (the SDK's `maxBudgetUsd` ceiling, `maxTurns`, or a fatal error) and the
   * session needs a new one before it can carry another turn. See `retireQuery`.
   */
  private queryFinished = false
  /**
   * What the runtime reported loading on `system:init`, or `null` before the first `ready` (M2.4,
   * §8). `null` rather than `[]` on purpose: "not yet known" and "none loaded" must be
   * distinguishable, or a consumer that reads this during the handshake shows a spurious
   * degradation notice for a session that is about to report all three skills.
   */
  private loadedSkills: readonly string[] | null = null

  constructor(deps: AgentSessionDeps) {
    this.deps = deps
    this.bridge = createChatBridge()
    this.capUsd = deps.options.maxBudgetUsd ?? null
  }

  /** Client-side cost estimate accumulated across this session's turns. */
  get estimatedSpendUsd(): number {
    return this.cost.totalUsd
  }

  /**
   * Turns opened and not yet folded — the other half of the ledger. The renderer derives the same
   * count from the events this session emits, and the agreement matrix asserts the two are equal.
   */
  get openTurns(): number {
    return this.cost.openTurns
  }

  /**
   * The §8 skill assertion, readable once a turn has started: what the runtime actually loaded and
   * which bundled skills are missing. In `skills` mode, `missing` non-empty means the materialized
   * `SKILL.md` files were not discovered. In `fallback` mode it is reported as empty regardless of
   * what the runtime listed, because a fallback session runs with `skills: []` deliberately — the
   * knowledge is in the system prompt, and reading its empty init as a degradation would be wrong.
   */
  get skillStatus(): SkillStatus {
    const loaded = this.loadedSkills
    if (loaded === null) return { known: false }
    const mode = this.skillMode
    return { known: true, mode, loaded, missing: mode === 'fallback' ? [] : missingSkills(loaded) }
  }

  /**
   * Enqueue a user turn, starting the query on first use. Validation happens before this is ever
   * called (IPC + preload), and the bridge cannot throw, so the input generator stays throw-free.
   */
  send(text: string): void {
    if (this.closed) return
    if (this.handle === null || this.queryFinished) this.start()
    // Opens the cost turn on the same event the renderer opens its own on, which is what makes the
    // two accumulators agree rather than merely resemble each other (shared/agent/cost.ts).
    this.cost = beginTurn(this.cost)
    this.pendingTexts.push(text)
    this.bridge.send(text)
  }

  /**
   * Apply the user's cap (§10). `AgentService` calls this before every send and on every Settings
   * save, so a change binds without waiting for the next turn.
   *
   * **The cap is enforced by this class, not by the SDK.** `maxBudgetUsd` is per-query cumulative and
   * cannot be changed on a running query, so it is handed to each query as the *absolute* cap and
   * treated as a backstop against one runaway query — never as the session ledger. Round 3 tried to
   * make the SDK enforce a lowered cap by replacing the live query, and the replacement is what lost
   * an in-flight `result` and a user's accepted message; a decaying "remaining" ceiling also made
   * every ordinary send look like a lowering. Neither mechanism exists any more. Three rules remain:
   *
   * 1. **Admission**: `AgentService.send` refuses a turn once `estimatedSpendUsd >= cap`. This is the
   *    primary gate, and the only one needed for the common path.
   * 2. **Lowered below spend while a turn is open** (`enforceCap`): the open turn is `interrupt()`ed
   *    — the same path the Stop button takes, whose `result` folds like any other — and the chat
   *    shows the budget error. No new query, no generation bump, nothing dropped.
   * 3. **Anything else** — raised, or lowered but still above spend — changes nothing about the live
   *    query. The next send sees the new cap; a query the SDK backstop stops re-arms with it.
   *
   * What this bounds: the session cannot *start* a turn past the cap, and a turn already running is
   * stopped as soon as main can see that the folded total has reached the cap. What it does not
   * bound is the spend of the turn currently streaming — cost only reaches us on its `result` — which
   * is what the per-query SDK ceiling is for.
   */
  setBudgetCap(capUsd: BudgetCap): void {
    this.capUsd = capUsd
    this.enforceCap()
  }

  /**
   * Rule 2 of `setBudgetCap`, also run after every fold so an overlapping second turn (Stop → retype
   * → Send) is stopped the moment the first turn's `result` carries the total past the cap.
   *
   * Reads only the *folded* total: the SDK gives no mid-turn price, and pricing tokens locally is what
   * §10 forbids. Skipped for a query that has already ended — its turns close via `closeOpenTurns`.
   */
  private enforceCap(): void {
    if (this.capUsd === null || this.handle === null || this.queryFinished || this.closed) return
    if (this.cost.openTurns === 0 || this.cost.totalUsd < this.capUsd) return
    if (this.budgetInterruptPending) return
    this.budgetInterruptPending = true
    void this.interrupt()
    // Empty message on purpose: the renderer's copy table owns the budget sentence (transcript.ts).
    this.deps.emit({ type: 'error', kind: 'budget', message: '', recoverable: true })
  }

  /** The session's options with the cap applied as the SDK backstop; omitted entirely when uncapped. */
  private queryOptions(extra?: Partial<AgentQueryOptions>): AgentQueryOptions {
    const { maxBudgetUsd: _ignored, ...rest } = this.deps.options
    return {
      ...rest,
      ...extra,
      ...(this.capUsd !== null ? { maxBudgetUsd: this.capUsd } : {}),
    }
  }

  private start(): void {
    if (this.queryFinished) {
      // Re-arming after a query ended (the SDK's ceiling, `maxTurns`, or a drain). Whatever that
      // query left open it will never answer, so both ledgers close those turns *before* this send
      // opens its own — and the generation moves on so the dead query's drain, which may still be in
      // progress, cannot retire the replacement. The old bridge's stream generator belongs to the
      // dead query and nothing will drain it again, so the replacement gets a fresh one — the same
      // repair `restartWithFallback` performs, for the same reason.
      // Only reachable with turns open inside the terminal-result-to-drain window, where the
      // terminal result's own error has already explained the stop.
      this.closeOpenTurns(true)
      this.generation += 1
      const dead = this.handle
      if (dead !== null) void dead.return(undefined).catch(() => undefined)
      this.bridge.close()
      this.bridge = createChatBridge()
      this.pendingTexts = []
      this.queryFinished = false
    }

    // Reopening mid-session: carry the conversation across rather than making a budget stop cost the
    // user their chat history. Best effort — if the runtime cannot resume, the session continues
    // without prior context; the cap is enforced here regardless. The §8 fallback restart
    // deliberately does NOT resume: it replays the pending turn itself, and resuming would deliver
    // that message twice.
    const resume = this.lastSessionId
    this.handle = this.deps.queryFn({
      prompt: this.bridge.stream(),
      options: this.queryOptions(resume === null ? undefined : { resumeSessionId: resume }),
    })
    this.consuming = this.consume(this.handle, this.generation)
  }

  private async consume(handle: AgentQueryHandle, generation: number): Promise<void> {
    // Whether the user has already been told why this query ended — a terminal result's own error,
    // or the typed error below — so `closeOpenTurns` does not add a second bubble on top of it.
    let explained = false
    try {
      for await (const raw of handle) {
        // A superseded query may still yield buffered messages after it was swapped out. They
        // describe a session the user is no longer in, so they are dropped. Safe only because a query
        // is never superseded while it has a billable turn outstanding — see `generation`.
        if (generation !== this.generation) return
        for (const event of mapSdkMessage(raw, this.seenAssistantIds)) {
          if (event.type === 'turn-end') {
            this.cost = foldTurnCost(this.cost, event.costUsd)
            this.pendingTexts.shift()
            this.budgetInterruptPending = false
            // Mark the query dead the moment its *terminating* result is seen, rather than waiting
            // for the generator to drain. Those are different instants, and a send landing between
            // them used to be pushed into the dying bridge and silently swallowed while
            // `AgentService.send` returned `accepted: true`.
            if (TERMINAL_RESULT_SUBTYPES.has(event.subtype)) {
              this.queryFinished = true
              explained = true
            }
          }
          this.deps.emit(event)
          // After the emit, so the renderer folds the result before any budget error lands.
          if (event.type === 'turn-end') this.enforceCap()
          if (event.type === 'ready') {
            // Kept so a query we have to reopen mid-session can resume the conversation.
            this.lastSessionId = event.sessionId
            // Handled *after* `ready` is emitted so the renderer has an open session before any
            // notice or status lands.
            this.onReady(event.skills, generation)
          }
        }
      }
    } catch (error) {
      // `query()` can throw *after* yielding its error `result` (§13). The result's cost/session_id
      // were already folded in above; here we surface the residual (usually a transport failure) as
      // a typed event, never a raw string. A deliberate interrupt is not an error, and neither is a
      // query we ourselves tore down to restart.
      if (this.closed || generation !== this.generation) return
      const { kind, message } = classifyException(error)
      this.deps.emit({ type: 'error', kind, message, recoverable: isRecoverable(kind) })
      explained = true
    } finally {
      this.retireQuery(generation, explained)
    }
  }

  /**
   * A query has ended. Flag it so the **next** send opens a fresh one, and close whatever it left open.
   *
   * Without the flag the session is permanently wedged, and the guaranteed way to reach that state
   * is the one thing this milestone is about: the turn that crosses `maxBudgetUsd` always terminates
   * the query with `error_max_budget_usd`. `consume` would then exit its loop leaving `handle`
   * non-null and the bridge drained, so every later `send` skipped `start()` and pushed into a queue
   * nothing drains — while `AgentService.send` cheerfully returned `accepted: true`.
   *
   * Only a *flag* is set for the handle — it deliberately stays put so `close()` can still `return()`
   * it and the "never orphan a subprocess" teardown path (§9) is unchanged. The actual re-arm happens
   * in `start()`, on the next send that needs a query.
   *
   * This runs when the generator *drains*, which is strictly later than the moment the query decided
   * to stop. For the terminating results we can name (`TERMINAL_RESULT_SUBTYPES`) `consume` sets the
   * flag at the `result` itself; a send that lands between that result and this drain re-arms in
   * `start()`, which bumps the generation so this late retirement is ignored.
   */
  private retireQuery(generation: number, explained: boolean): void {
    // Superseded by the §8 restart or a re-arm: that path installed a live handle.
    if (generation !== this.generation) return
    // `close()` owns teardown; re-arming a session the caller is disposing would resurrect it.
    if (this.closed) return
    this.queryFinished = true
    this.closeOpenTurns(explained)
  }

  /**
   * End every turn the dead query left unanswered, on both ledgers at once.
   *
   * A query that ends — the SDK's ceiling with a second turn still queued behind it, a runtime that
   * closes its stream unannounced, a transport failure after the turn was accepted — leaves a turn
   * that no `result` will ever close. Left alone, that turn sat open forever: the renderer's composer
   * stuck on `streaming` with no bubble and no retry, and both open-turn counts one too high, so the
   * next stray `result` would fold into a turn that no longer existed. Main is the side that can see
   * the query end, so main closes the turn: a zero-cost `turn-end` per open turn (both accumulators
   * fold the same `0`, so they stay equal), then one error the user can act on.
   *
   * Zero is the only honest cost. The turn's real `result` never arrived, so nothing was learned
   * about what it spent; the model the matrix test checks against says the same — a turn bills at its
   * first `result`, and this turn had none.
   *
   * `explained` is true when the chat already shows why the query ended (a budget stop, a transport
   * error); then the close is silent rather than stacking a second bubble on the first.
   */
  private closeOpenTurns(explained: boolean): void {
    if (this.cost.openTurns === 0) return
    while (this.cost.openTurns > 0) {
      this.cost = foldTurnCost(this.cost, 0)
      this.deps.emit({ type: 'turn-end', costUsd: 0, subtype: QUERY_ENDED_SUBTYPE })
    }
    this.pendingTexts = []
    if (explained) return
    this.deps.emit({
      type: 'error',
      kind: 'unknown',
      message: 'Claude stopped before replying. Send your message again.',
      recoverable: true,
    })
  }

  /**
   * The §8 assertion, run against the runtime's own loaded-skill list, and the decision that follows
   * from it. Always logs what loaded — a healthy session is worth one line when a support case asks
   * "did it have the skills?" — then takes exactly one of three paths:
   *
   * 1. **Nothing missing** (or this is already a fallback session): report the mode and stop.
   * 2. **Missing, and repairable**: restart once into the system-prompt fallback. No chat notice —
   *    the restart *fixes* the problem, and a notice about a repaired condition trains the user to
   *    ignore notices. The `skills: fallback` status line is what makes it observable, which is
   *    exactly why §8 requires the pair to ship together.
   * 3. **Missing, and not repairable**: M2.4's loud state, unchanged — the status reads
   *    `unavailable` and the chat panel says the slides may not follow Sloodge's design rules.
   */
  private onReady(skills: readonly string[], generation: number): void {
    if (generation !== this.generation) return
    this.loadedSkills = skills
    // Announce once per generation. M2.4's rule ("a resumed/recycled query re-announces, but the
    // user has already been told") still holds within a session shape; a restart is a new shape and
    // does get its own line, which is the entire point of the indicator.
    if (this.reportedGeneration === generation) return
    this.reportedGeneration = generation

    const fallback = this.skillMode === 'fallback'
    const missing = missingSkills(skills)
    const log = this.deps.log ?? defaultAgentLog
    log(
      `[agent] skills loaded: [${skills.join(', ')}]` +
        (fallback ? ' — mode: fallback (system-prompt inlined)' : '') +
        (missing.length > 0 ? ` — MISSING: [${missing.join(', ')}]` : ''),
    )

    if (missing.length === 0) {
      this.deps.emit({ type: 'skills-status', status: fallback ? 'fallback' : 'ok' })
      return
    }

    // Something is missing. Note that a *fallback* session reaches here every time by construction —
    // it runs with `skills: []`, so its init reports all three missing — which is exactly why
    // `restartAttempted` is the load-bearing guard rather than a belt-and-braces one: without it,
    // the restarted session would ask to be restarted again, forever, spawning a CLI subprocess per
    // round. It is checked *first*, and set before `restartWithFallback`'s first `await`.
    if (!this.restartAttempted && this.deps.loadFallbackPrompt !== undefined) {
      this.restartAttempted = true
      void this.restartWithFallback(missing)
      return
    }

    if (fallback) {
      // The expected steady state after a successful repair: nothing loaded from disk because
      // nothing was asked for, and the craft knowledge is resident in the system prompt. Quietly
      // indicated in the status bar, deliberately *not* announced in chat — the problem is fixed.
      this.deps.emit({ type: 'skills-status', status: 'fallback' })
      return
    }

    // M2.4's loud state, now reached only once self-repair has been ruled out.
    this.deps.emit({ type: 'skills-status', status: 'unavailable' })
    this.deps.emit({ type: 'skills-degraded', missing })
  }

  /**
   * §8's automatic fallback: reopen the query with `skills: []` and the three SKILL.md bodies
   * appended to `systemPrompt.append`, replaying whatever turn was in flight.
   *
   * Ordering matters and is deliberate. The replacement query is built and installed *before* the
   * outgoing one is torn down, so a failure while opening it cannot leave the session with no handle
   * at all; and the generation is bumped first, so nothing the old query emits in the meantime
   * reaches the renderer.
   *
   * Called at most once per session — see `restartAttempted`.
   */
  private async restartWithFallback(missing: readonly BundledSkillName[]): Promise<void> {
    const log = this.deps.log ?? defaultAgentLog
    let prompt: string | null = null
    try {
      prompt = (await this.deps.loadFallbackPrompt?.()) ?? null
    } catch (error) {
      log(`[agent] skills fallback unavailable: ${String(error)}`)
    }
    if (this.closed) return
    if (prompt === null || prompt.trim().length === 0) {
      // The bundle could not be read either. Nothing to restart *into* — a second identical session
      // would just be a wasted subprocess — so fall back to announcing the degradation.
      log('[agent] skills fallback unavailable: no SKILL.md bodies could be read')
      this.deps.emit({ type: 'skills-status', status: 'unavailable' })
      this.deps.emit({ type: 'skills-degraded', missing })
      return
    }

    log(`[agent] restarting session with skills: [] + inlined SKILL.md bodies (§8 fallback)`)
    const superseded = this.handle
    const supersededConsuming = this.consuming
    this.generation += 1
    this.skillMode = 'fallback'
    this.loadedSkills = null
    this.bridge = createChatBridge()
    const replay = this.pendingTexts
    this.pendingTexts = []

    // The replacement carries the same absolute cap as any query (`queryOptions`); admission is what
    // bounds the session, so a restart cannot hand it a second budget (§10, `setBudgetCap`).
    this.handle = this.deps.queryFn({
      prompt: this.bridge.stream(),
      options: this.queryOptions({ skillFallbackPrompt: prompt }),
    })
    this.consuming = this.consume(this.handle, this.generation)
    for (const text of replay) {
      this.pendingTexts.push(text)
      this.bridge.send(text)
    }

    // Tear the old subprocess down last. An orphaned CLI outliving its replacement is §9's worst
    // failure mode, so this is awaited rather than floated, but its outcome cannot affect the live
    // session: the generation guard has already muted it.
    try {
      await superseded?.return(undefined)
      await supersededConsuming
    } catch {
      // Already settled, or settled by erroring — either way the replacement is the live session.
    }
  }

  /** Stop the in-flight turn (the Stop button). Streaming-input mode only. Safe if idle. */
  async interrupt(): Promise<boolean> {
    if (this.handle === null) return false
    try {
      await this.handle.interrupt()
      return true
    } catch {
      // An interrupt that races teardown is not worth surfacing.
      return false
    }
  }

  /** Switch the model mid-session (the picker). `undefined` resets to default (§11). */
  async setModel(model?: string): Promise<void> {
    if (this.handle === null) return
    await this.handle.setModel(model)
  }

  /**
   * Close the input, let the generator finish, and drop the subprocess. Idempotent. An orphaned CLI
   * subprocess outliving the window is the worst failure mode here (§9), so callers must invoke this
   * on window close and `app.before-quit`.
   */
  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.bridge.close()
    if (this.handle !== null) {
      try {
        await this.handle.return(undefined)
      } catch {
        // The generator may already be settled; nothing to clean up.
      }
    }
    if (this.consuming !== null) {
      try {
        await this.consuming
      } catch {
        // consume() already handles its own errors; this is belt-and-braces.
      }
    }
  }
}
