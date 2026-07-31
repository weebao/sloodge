/**
 * Owns the per-window agent sessions and mediates between the IPC layer and `AgentSession`. It is
 * `electron`-free and fully injectable: tests drive it with a fake `queryFn`, a fake key loader, and
 * a capturing `emit`, so the whole "no key -> refuse, key -> stream, teardown" flow runs with no
 * subprocess and no keychain.
 *
 * One `AgentSession` per renderer `WebContents` id (50-agent-integration.md §1): Sloodge is
 * single-deck-focused, so this is normally a map of one.
 */

import { DEFAULT_AGENT_MODEL, type AgentEvent, type AgentModelId } from '../../shared/agent/types'
import type { AgentInterruptResponse, AgentSendResponse } from '../../shared/ipc-contract'
import { AgentSession } from './session'
import type { AgentQueryFn } from './query-contract'

export type AgentServiceDeps = {
  readonly queryFn: AgentQueryFn
  /** Reads the decrypted key from the vault; `null` means "not configured". */
  readonly loadApiKey: () => Promise<string | null>
  /** App-owned cwd + CLAUDE_CONFIG_DIR for a session (isolation, §5). */
  readonly resolvePaths: () => { cwd: string; configDir: string }
  readonly defaultModel?: AgentModelId
}

export class AgentService {
  private readonly deps: AgentServiceDeps
  private readonly model: AgentModelId
  private readonly sessions = new Map<number, AgentSession>()
  /**
   * In-flight session creations, keyed by senderId. Session creation spans an `await loadApiKey()`,
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
   * Send a user turn for one renderer. Creates the session lazily on first use, but only if a key is
   * configured — no key means `{ accepted: false }`, which the renderer renders as the inline
   * "Add your Anthropic API key in Settings" prompt (50-agent-integration.md §4).
   */
  async send(
    senderId: number,
    text: string,
    emit: (event: AgentEvent) => void,
  ): Promise<AgentSendResponse> {
    const session = await this.ensureSession(senderId, emit)
    if (session === null) return { accepted: false }
    session.send(text)
    return { accepted: true }
  }

  /**
   * Resolve the sender's session, creating exactly one even under concurrent sends. The creation
   * promise is shared between racing callers and cleared once it settles; a `null` result (no key
   * configured) is not cached, so a later send retries after the key is added.
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
      const apiKey = await this.deps.loadApiKey()
      if (apiKey === null) return null
      const { cwd, configDir } = this.deps.resolvePaths()
      const session = new AgentSession({
        queryFn: this.deps.queryFn,
        options: { apiKey, model: this.model, cwd, configDir },
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

  /** Tear down one renderer's session — call on `destroyed` / `render-process-gone`. */
  async dispose(senderId: number): Promise<void> {
    // Mirror of the send-side race: `createSession` only stores the session *after*
    // `await loadApiKey()`, so a dispose that arrives mid-creation would read no session, no-op, and
    // let the creation install a live session/subprocess for an already-gone renderer (§9's worst
    // case). Wait for the in-flight creation to settle, then close whatever it produced.
    const inFlight = this.creating.get(senderId)
    if (inFlight !== undefined) await inFlight
    const session = this.sessions.get(senderId)
    if (session === undefined) return
    this.sessions.delete(senderId)
    await session.close()
  }

  /** Tear down every session — call on `app.before-quit`. No orphaned subprocess (§9). */
  async disposeAll(): Promise<void> {
    // In-flight creations aren't in `sessions` yet; wait for them so their subprocesses are closed
    // here, not orphaned past quit. `Promise.all` drains the iterator synchronously, before any
    // creation's `finally` deletes its `creating` entry, so passing it directly is safe.
    await Promise.all(this.creating.values())
    const all = [...this.sessions.values()]
    this.sessions.clear()
    await Promise.all(all.map((session) => session.close()))
  }
}
