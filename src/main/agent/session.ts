/**
 * One `AgentSession` per open deck window: it owns exactly one live `query()` and the input bridge
 * feeding it (50-agent-integration.md §1). This is the turn state machine — it starts the query
 * lazily on the first message, streams SDK messages out as `AgentEvent`s, and tears down cleanly.
 *
 * It depends only on the `AgentQueryFn` seam, so tests drive the whole lifecycle with a fake that
 * yields a scripted message sequence — no key, no subprocess, no network.
 */

import type { AgentEvent } from '../../shared/agent/types'
import { createChatBridge, type ChatBridge } from './bridge'
import { classifyException, isRecoverable, mapSdkMessage } from './event-mapping'
import type { AgentQueryFn, AgentQueryHandle, AgentQueryOptions } from './query-contract'

export type AgentSessionDeps = {
  readonly queryFn: AgentQueryFn
  readonly options: AgentQueryOptions
  readonly emit: (event: AgentEvent) => void
}

export class AgentSession {
  private readonly deps: AgentSessionDeps
  private readonly bridge: ChatBridge
  private handle: AgentQueryHandle | null = null
  private consuming: Promise<void> | null = null
  private closed = false
  /** Assistant-id dedup set, held for the session's whole lifetime (§10, §16). */
  private readonly seenAssistantIds = new Set<string>()
  /** Client-side estimate; accumulated per `result` message, never billed off (§10). */
  private spendUsd = 0

  constructor(deps: AgentSessionDeps) {
    this.deps = deps
    this.bridge = createChatBridge()
  }

  /** Client-side cost estimate accumulated across this session's turns. */
  get estimatedSpendUsd(): number {
    return this.spendUsd
  }

  /**
   * Enqueue a user turn, starting the query on first use. Validation happens before this is ever
   * called (IPC + preload), and the bridge cannot throw, so the input generator stays throw-free.
   */
  send(text: string): void {
    if (this.closed) return
    if (this.handle === null) this.start()
    this.bridge.send(text)
  }

  private start(): void {
    this.handle = this.deps.queryFn({ prompt: this.bridge.stream(), options: this.deps.options })
    this.consuming = this.consume(this.handle)
  }

  private async consume(handle: AgentQueryHandle): Promise<void> {
    try {
      for await (const raw of handle) {
        for (const event of mapSdkMessage(raw, this.seenAssistantIds)) {
          if (event.type === 'turn-end') this.spendUsd += event.costUsd
          this.deps.emit(event)
        }
      }
    } catch (error) {
      // `query()` can throw *after* yielding its error `result` (§13). The result's cost/session_id
      // were already folded in above; here we surface the residual (usually a transport failure) as
      // a typed event, never a raw string. A deliberate interrupt is not an error.
      if (this.closed) return
      const { kind, message } = classifyException(error)
      this.deps.emit({ type: 'error', kind, message, recoverable: isRecoverable(kind) })
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
