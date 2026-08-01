/**
 * Owns the per-window agent sessions and mediates between the IPC layer and `AgentSession`. It is
 * `electron`-free and fully injectable: tests drive it with a fake `queryFn`, a fake credential loader,
 * and a capturing `emit`, so the whole "unconfigured -> refuse, credential -> stream, teardown" flow
 * runs with no subprocess and no keychain.
 *
 * One `AgentSession` per renderer `WebContents` id (50-agent-integration.md §1): Sloodge is
 * single-deck-focused, so this is normally a map of one.
 */

import { DEFAULT_AGENT_MODEL, type AgentEvent, type AgentModelId } from '../../shared/agent/types'
import {
  canStartTurn,
  evaluateBudget,
  remainingBudgetUsd,
  type BudgetCap,
} from '../../shared/agent/budget'
import type { AgentInterruptResponse, AgentSendResponse } from '../../shared/ipc-contract'
import type { AgentCredential } from './auth-env'
import { defaultAgentLog, type AgentLog } from './log'
import { AgentSession } from './session'
import type { AgentQueryFn } from './query-contract'

export type AgentServiceDeps = {
  readonly queryFn: AgentQueryFn
  /**
   * Resolves the session's credential from the vault — a subscription token if one is stored, else
   * an API key (M2.7). `null` means nothing is configured and the turn must be refused.
   */
  readonly loadCredential: () => Promise<AgentCredential | null>
  /** App-owned cwd + CLAUDE_CONFIG_DIR for a session (isolation, §5). */
  readonly resolvePaths: () => { cwd: string; configDir: string }
  readonly defaultModel?: AgentModelId
  /**
   * The in-process MCP servers to attach to a session — `{ slides: slidesServer }` for the
   * `mcp__slides__*` tools (M2.2). Resolved per session so the tool handlers can be bound to that
   * session's live deck host. Returns `undefined` when no deck is open, in which case the agent runs
   * with the read-only surface. Kept opaque here (the seam is SDK-free — see query-contract.ts).
   */
  readonly resolveMcpServers?: (senderId: number) => Readonly<Record<string, unknown>> | undefined
  /**
   * Prepare the app-owned workspace before the query opens — in practice `materializeSkills`, which
   * copies the three bundled skills into `<cwd>/.claude/skills` and writes the workspace's own
   * `settings.json` (M2.4, 50-agent-integration.md §8). Skills are filesystem-only, so this must
   * complete *before* `queryFn` runs or the subprocess starts with nothing to discover.
   *
   * It is deliberately allowed to fail: a rejection is swallowed and the session still starts, with
   * the agent degraded to its no-skill behaviour rather than the chat box being dead. `materializeSkills`
   * already reports per-skill trouble in its result instead of throwing — and both that result and a
   * rejection are logged here, because a copy that quietly did nothing is indistinguishable from a
   * healthy session otherwise.
   */
  readonly prepareWorkspace?: (cwd: string) => Promise<WorkspacePreparation | void>
  /**
   * §8's fallback material (M2.5), handed to each session so it can self-repair a skill-less start.
   * Resolved lazily *inside* the session — a healthy session never reads the bundle.
   */
  readonly loadFallbackPrompt?: () => Promise<string | null>
  /**
   * The user's configured spend cap (§10, M2.5), read fresh on every send so a change in Settings
   * takes effect on the next turn rather than the next app launch. `undefined` (dep absent) and
   * `null` (no limit) both mean "do not cap".
   */
  readonly loadBudgetCap?: () => Promise<BudgetCap>
  /** Diagnostic sink; defaults to `defaultAgentLog`. Injected so a test can read what was logged. */
  readonly log?: AgentLog
}

/** The part of `MaterializeSkillsResult` the service reports on. Structural, so the seam stays thin. */
export type WorkspacePreparation = {
  readonly installed: readonly string[]
  readonly failures: readonly string[]
}

export class AgentService {
  private readonly deps: AgentServiceDeps
  private readonly model: AgentModelId
  private readonly sessions = new Map<number, AgentSession>()
  /**
   * In-flight session creations, keyed by senderId. Session creation spans an `await loadCredential()`,
   * so two concurrent sends for one sender would otherwise both see no session and both spawn a
   * `query()` subprocess — orphaning one (§9's worst case) the moment the M2.3 chat UI can fire a
   * double send. Caching the creation promise makes the second send await the first's result instead
   * of racing it, so a sender ends up with exactly one session and one subprocess.
   */
  private readonly creating = new Map<number, Promise<AgentSession | null>>()

  constructor(deps: AgentServiceDeps) {
    this.deps = deps
    this.model = deps.defaultModel ?? DEFAULT_AGENT_MODEL
  }

  /**
   * Send a user turn for one renderer. Creates the session lazily on first use, but only if a credential
   * is configured — none means `{ accepted: false, reason: 'no-credential' }`, which the renderer renders
   * as the composer's "Set up authentication" link into Settings (M2.7, 50-agent-integration.md §4).
   *
   * The budget check (§10, M2.5) runs against the session that **already exists**, which is read
   * synchronously before anything is awaited. Creation is kicked off first but only *awaited* after
   * the check, so a blocked send never spawns a subprocess — and a first turn is never refused on
   * budget, because a session with no spend cannot have exhausted a positive cap.
   *
   * This is the *authoritative* turn-admission check. The renderer performs the same one so the
   * composer can explain itself without a round trip, but a guard that only exists in the renderer is
   * a guard a renderer bug can walk past — and the number both sides compare against is the same one,
   * because the cost accumulators are the same function (`shared/agent/cost.ts`).
   */
  async send(
    senderId: number,
    text: string,
    emit: (event: AgentEvent) => void,
  ): Promise<AgentSendResponse> {
    const existing = this.sessions.get(senderId)
    // When there is no session yet, creation must be kicked off **synchronously**: two racing sends
    // dedupe on the `creating` map, and awaiting anything before this would let both observe "no
    // session" and spawn a subprocess each (§9's worst case). The cap resolves alongside it.
    const creating = existing === undefined ? this.ensureSession(senderId, emit) : null
    // Read once per send, so a cap changed in Settings takes effect on the very next turn — both for
    // the admission check and for the ceiling handed to the SDK.
    const capUsd = (await this.deps.loadBudgetCap?.()) ?? null
    if (
      existing !== undefined &&
      !canStartTurn(evaluateBudget(existing.estimatedSpendUsd, capUsd))
    ) {
      return { accepted: false, reason: 'budget' }
    }
    const session = existing ?? (await creating)
    if (session === null || session === undefined) {
      return { accepted: false, reason: 'no-credential' }
    }
    // Re-arm the in-flight ceiling for whatever query this send opens. After a budget stop the SDK
    // has terminated the query and the session re-arms itself, so the next send opens a *new* one —
    // which must carry the cap the user just raised, not the one that stopped it. Without this,
    // "raise the limit in Settings and carry on" would start a query that instantly stops again.
    session.setBudgetCeiling(remainingBudgetUsd(session.estimatedSpendUsd, capUsd))
    session.send(text)
    return { accepted: true }
  }

  /**
   * Resolve the sender's session, creating exactly one even under concurrent sends. The creation
   * promise is shared between racing callers and cleared once it settles; a `null` result (nothing
   * configured) is not cached, so a later send retries once a credential is added in Settings.
   */
  private ensureSession(
    senderId: number,
    emit: (event: AgentEvent) => void,
  ): Promise<AgentSession | null> {
    const existing = this.sessions.get(senderId)
    if (existing !== undefined) return Promise.resolve(existing)

    const inFlight = this.creating.get(senderId)
    if (inFlight !== undefined) return inFlight

    const creation = this.createSession(senderId, emit)
    this.creating.set(senderId, creation)
    return creation
  }

  private async createSession(
    senderId: number,
    emit: (event: AgentEvent) => void,
  ): Promise<AgentSession | null> {
    try {
      const credential = await this.deps.loadCredential()
      if (credential === null) return null
      const { cwd, configDir } = this.deps.resolvePaths()
      // Skills are discovered from disk when the subprocess starts, so the copy has to land first.
      // A failure here must not cost the user their chat box — see `prepareWorkspace`'s docstring.
      // The *session* reports the user-visible degradation, on the runtime's own loaded-skill list
      // (which is the truth); this log is the main-process half, and the only place a partial copy
      // names the file that failed.
      const log = this.deps.log ?? defaultAgentLog
      try {
        const prepared = await this.deps.prepareWorkspace?.(cwd)
        if (prepared) {
          log(
            `[agent] workspace skills installed: [${prepared.installed.join(', ')}]` +
              (prepared.failures.length > 0 ? ` — failed: ${prepared.failures.join('; ')}` : ''),
          )
        }
      } catch (error) {
        // Degraded (no skills), not broken: the session below still opens.
        log(`[agent] workspace preparation failed: ${String(error)}`)
      }
      const mcpServers = this.deps.resolveMcpServers?.(senderId)
      // §10's in-flight ceiling, seeded here so a session is never briefly uncapped. `send` re-arms
      // it before every turn (so a cap raised in Settings reaches the next query) and the session
      // recomputes what remains if it restarts into the §8 fallback.
      const maxBudgetUsd = remainingBudgetUsd(0, (await this.deps.loadBudgetCap?.()) ?? null)
      const session = new AgentSession({
        queryFn: this.deps.queryFn,
        log,
        ...(this.deps.loadFallbackPrompt !== undefined
          ? { loadFallbackPrompt: this.deps.loadFallbackPrompt }
          : {}),
        options: {
          credential,
          model: this.model,
          cwd,
          configDir,
          ...(mcpServers !== undefined ? { mcpServers } : {}),
          ...(maxBudgetUsd !== undefined ? { maxBudgetUsd } : {}),
        },
        emit,
      })
      this.sessions.set(senderId, session)
      return session
    } finally {
      this.creating.delete(senderId)
    }
  }

  /** Interrupt the in-flight turn for one renderer (the Stop button). */
  async interrupt(senderId: number): Promise<AgentInterruptResponse> {
    const session = this.sessions.get(senderId)
    if (session === undefined) return { interrupted: false }
    return { interrupted: await session.interrupt() }
  }

  /**
   * Tear down one renderer's session — call on `destroyed` / `render-process-gone`.
   *
   * Mirror of the send-side race: `createSession` only stores the session *after* `await
   * loadApiKey()`, so a dispose that arrives mid-creation would read no session, no-op, and let the
   * creation install a live session/subprocess for an already-gone renderer (§9's worst case). We
   * wait for the in-flight creation to settle, then close whatever it produced — and we swallow a
   * *rejecting* creation so teardown still runs and this never throws (it is floated from the
   * WebContents event handler).
   *
   * Known edge, deliberately un-guarded: a send that arrives *after* the `sessions.delete` below but
   * before `close()` resolves would build a fresh session (starts=2/returns=1). It is unreachable in
   * production — dispose fires only on terminal WebContents events and app before-quit, after which
   * that renderer cannot invoke `agent:send` (its sender is gone, and the send handler also guards
   * `event.sender.isDestroyed()`). If a non-terminal dispose trigger is ever added, gate `send` on a
   * tearing-down-senderId set here — until then the state is not worth carrying.
   */
  async dispose(senderId: number): Promise<void> {
    const inFlight = this.creating.get(senderId)
    if (inFlight !== undefined) {
      try {
        await inFlight
      } catch {
        // The creation rejected; no session was installed for this sender, so there is nothing to
        // close — but teardown must still proceed and dispose must not throw.
      }
    }
    const session = this.sessions.get(senderId)
    if (session === undefined) return
    this.sessions.delete(senderId)
    await session.close()
  }

  /**
   * Tear down every session — call on `app.before-quit`. No orphaned subprocess (§9).
   *
   * disposeAll must **never** throw before every session is closed — a rejection here orphans every
   * live subprocess at quit, the exact failure this method exists to prevent. So both stages use
   * `Promise.allSettled`: a rejecting in-flight creation cannot abort the sweep, and neither can a
   * misbehaving `close()`. `allSettled` drains its iterator synchronously, before any creation's
   * `finally` clears its `creating` entry, so passing it directly is safe.
   */
  async disposeAll(): Promise<void> {
    await Promise.allSettled(this.creating.values())
    const all = [...this.sessions.values()]
    this.sessions.clear()
    await Promise.allSettled(all.map((session) => session.close()))
  }
}
