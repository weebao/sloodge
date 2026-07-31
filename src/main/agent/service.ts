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
    let session = this.sessions.get(senderId)
    if (session === undefined) {
      const apiKey = await this.deps.loadApiKey()
      if (apiKey === null) return { accepted: false }
      const { cwd, configDir } = this.deps.resolvePaths()
      session = new AgentSession({
        queryFn: this.deps.queryFn,
        options: { apiKey, model: this.model, cwd, configDir },
        emit,
      })
      this.sessions.set(senderId, session)
    }
    session.send(text)
    return { accepted: true }
  }

  /** Interrupt the in-flight turn for one renderer (the Stop button). */
  async interrupt(senderId: number): Promise<AgentInterruptResponse> {
    const session = this.sessions.get(senderId)
    if (session === undefined) return { interrupted: false }
    return { interrupted: await session.interrupt() }
  }

  /** Tear down one renderer's session — call on `destroyed` / `render-process-gone`. */
  async dispose(senderId: number): Promise<void> {
    const session = this.sessions.get(senderId)
    if (session === undefined) return
    this.sessions.delete(senderId)
    await session.close()
  }

  /** Tear down every session — call on `app.before-quit`. No orphaned subprocess (§9). */
  async disposeAll(): Promise<void> {
    const all = [...this.sessions.values()]
    this.sessions.clear()
    await Promise.all(all.map((session) => session.close()))
  }
}
