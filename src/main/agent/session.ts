/**
 * One `AgentSession` per open deck window: it owns exactly one live `query()` and the input bridge
 * feeding it (50-agent-integration.md §1). This is the turn state machine — it starts the query
 * lazily on the first message, streams SDK messages out as `AgentEvent`s, and tears down cleanly.
 *
 * It depends only on the `AgentQueryFn` seam, so tests drive the whole lifecycle with a fake that
 * yields a scripted message sequence — no key, no subprocess, no network.
 */

import type { AgentEvent } from '../../shared/agent/types'
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
   * Which query generation is live. Incremented by the fallback restart so the outgoing query's
   * remaining messages are dropped instead of interleaving with the replacement's — without it, the
   * old subprocess's `result` and the new one's `ready` would both reach the renderer and the chat
   * would show one turn ending twice.
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
   * At most one entry in practice — the composer refuses to send while a turn is streaming — but
   * kept as a list so a queued second send is not lost either.
   */
  private pendingTexts: string[] = []
  /**
   * The `maxBudgetUsd` handed to the next query opened (§10). Seeded from the session's options and
   * refreshed by `AgentService` on every send, so a cap raised in Settings reaches the SDK.
   */
  private budgetCeiling: number | undefined
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
    this.budgetCeiling = deps.options.maxBudgetUsd
  }

  /** Client-side cost estimate accumulated across this session's turns. */
  get estimatedSpendUsd(): number {
    return this.cost.totalUsd
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
   * Set the in-flight spend ceiling for the **next** query this session opens (§10).
   *
   * Load-bearing after a budget stop: that ends the query, `retireQuery` re-arms the session, and
   * the next send opens a *fresh* query — which must be given the cap the user just raised, not the
   * one that stopped it. `AgentService` recomputes this on every send, so the ceiling is never
   * staler than the last thing the user saved in Settings.
   */
  setBudgetCeiling(maxBudgetUsd: number | undefined): void {
    this.budgetCeiling = maxBudgetUsd
  }

  /** The session's options with the current ceiling applied; omitted entirely when uncapped. */
  private queryOptions(extra?: Partial<AgentQueryOptions>): AgentQueryOptions {
    const { maxBudgetUsd: _ignored, ...rest } = this.deps.options
    return {
      ...rest,
      ...extra,
      ...(this.budgetCeiling !== undefined ? { maxBudgetUsd: this.budgetCeiling } : {}),
    }
  }

  private start(): void {
    if (this.queryFinished) {
      // Re-arming after a terminated query. The old bridge's stream generator belongs to the dead
      // query and nothing will ever drain it again, so the replacement gets a fresh one — the same
      // repair `restartWithFallback` performs, for the same reason.
      this.bridge.close()
      this.bridge = createChatBridge()
      // Nothing will answer these now; this send is a new turn, not a replay.
      this.pendingTexts = []
      this.queryFinished = false
    }
    this.handle = this.deps.queryFn({ prompt: this.bridge.stream(), options: this.queryOptions() })
    this.consuming = this.consume(this.handle, this.generation)
  }

  private async consume(handle: AgentQueryHandle, generation: number): Promise<void> {
    try {
      for await (const raw of handle) {
        // A superseded query may still yield buffered messages after the restart swapped it out.
        // They describe a session the user is no longer in, so they are dropped — including any
        // residual cost, which at init time (the only moment a restart happens) is zero.
        if (generation !== this.generation) return
        for (const event of mapSdkMessage(raw, this.seenAssistantIds)) {
          if (event.type === 'turn-end') {
            this.cost = foldTurnCost(this.cost, event.costUsd)
            this.pendingTexts = []
          }
          this.deps.emit(event)
          // Handled *after* `ready` is emitted so the renderer has an open session before any
          // notice or status lands.
          if (event.type === 'ready') this.onReady(event.skills, generation)
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
    } finally {
      this.retireQuery(generation)
    }
  }

  /**
   * A query has ended. Drop it and re-arm the session so the **next** send opens a fresh one.
   *
   * Without this the session is permanently wedged, and the guaranteed way to reach that state is
   * the one thing this milestone is about: `maxBudgetUsd` is the whole cap, so the turn that crosses
   * it always terminates the query with `error_max_budget_usd`. `consume` would then exit its loop
   * leaving `handle` non-null and the bridge drained, so every later `send` skipped `start()` and
   * pushed into a queue nothing drains — while `AgentService.send` cheerfully returned
   * `accepted: true`. "Raise the limit in Settings and carry on", which this milestone's own spec
   * promises twice, did nothing at all, and the composer sat in `streaming` forever.
   *
   * Only a *flag* is set here — `handle` deliberately stays put so `close()` can still `return()` it
   * and the "never orphan a subprocess" teardown path (§9) is unchanged. The actual re-arm happens
   * in `start()`, on the next send that needs a query.
   *
   * The open-turn count is deliberately **not** cleared: the renderer's accumulator cannot see this
   * event, so zeroing it here would be the one thing that makes the two ledgers disagree. A turn
   * whose query died without a `result` stays open on both sides, symmetrically.
   */
  private retireQuery(generation: number): void {
    // Superseded by the §8 restart: that path already installed a live handle and bridge.
    if (generation !== this.generation) return
    // `close()` owns teardown; re-arming a session the caller is disposing would resurrect it.
    if (this.closed) return
    this.queryFinished = true
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

    // The replacement inherits what is *left* of the cap, not the original ceiling — otherwise a
    // restart would quietly hand the session a second full budget (§10).
    if (this.budgetCeiling !== undefined) {
      this.budgetCeiling = Math.max(0, this.budgetCeiling - this.cost.totalUsd)
    }
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
