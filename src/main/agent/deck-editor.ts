/**
 * The main-side `DeckEditor` — the async seam the `mcp__slides__*` tool host reads and writes the
 * *authoritative renderer deck* through (M2.6).
 *
 * The deck lives in the renderer (renderer-authoritative, M1.3/M1.4), so from main every read and
 * write is a round-trip: `createRendererDeckEditor` sends an `AgentEditRequest` over a transport and
 * awaits the matching `AgentEditResponse`, correlated by `requestId`. It is `electron`-free and
 * injectable — the transport is `{ isAlive, send }` and responses are fed in via `deliver` — so the
 * whole tool→IPC→history→result orchestration is unit-testable with fakes on both sides.
 *
 * ## No hang, ever (M2.1 lifecycle discipline)
 *
 * Every method **resolves** with a typed result; none reject. A renderer that has gone away
 * (`isAlive()` false), a `send` that throws, or a reply that never arrives within `timeoutMs` all
 * resolve to `renderer-unavailable`, so the agent gets an actionable error instead of a stuck tool
 * call. `rejectAll` fails every in-flight request at teardown for the same reason.
 *
 * `createLocalDeckEditor` is the in-process variant over a `DocumentHistory` — used where main and
 * the deck share a process (the unit tests, and a future headless mode). It routes through the same
 * `applyAgentCommandsToHistory`, so the undo-parity behaviour it exercises is the real one.
 */

import type { DeckDoc, DocCommand } from '../../shared/document/commands'
import type { DocumentHistory } from '../../shared/document/history'
import {
  applyAgentCommandsToHistory,
  snapshotOfDoc,
  type AgentApplyResult,
  type AgentEditRequest,
  type AgentEditResponse,
  type AgentSnapshotResult,
} from '../../shared/document/agent-edit'

/** The read/write seam the tool host depends on. Both operations are async and never throw. */
export type DeckEditor = {
  snapshot(): Promise<AgentSnapshotResult>
  apply(
    commands: readonly DocCommand[],
    turnId: string,
    toolUseId: string,
  ): Promise<AgentApplyResult>
}

/** The one-way channel to a renderer. `send` must not throw; if it can, the editor guards it anyway. */
export type DeckEditorTransport = {
  /** True while the target renderer can still receive a request. */
  isAlive(): boolean
  /** Fire a request at the renderer (`webContents.send` in production). */
  send(request: AgentEditRequest): void
}

export type DeckEditorOptions = {
  /** How long to wait for a reply before giving up with `renderer-unavailable`. */
  timeoutMs?: number
}

/** §9's worst case is an orphaned wait; 10s is generous for an in-process IPC hop yet still bounded. */
export const DEFAULT_DECK_EDIT_TIMEOUT_MS = 10_000

/**
 * A renderer-backed editor plus the two hooks the IPC glue needs: `deliver` routes a response to its
 * pending request, and `rejectAll` fails everything in flight when the renderer is torn down.
 */
export type RendererDeckEditor = DeckEditor & {
  deliver(response: AgentEditResponse): void
  rejectAll(message?: string): void
}

type PendingSnapshot = { op: 'snapshot'; settle: (result: AgentSnapshotResult) => void }
type PendingApply = { op: 'apply'; settle: (result: AgentApplyResult) => void }
type Pending = (PendingSnapshot | PendingApply) & { timer: ReturnType<typeof setTimeout> }

function unavailableApply(message: string): AgentApplyResult {
  return { ok: false, code: 'renderer-unavailable', message }
}

function unavailableSnapshot(message: string): AgentSnapshotResult {
  return { ok: false, code: 'renderer-unavailable', message }
}

export function createRendererDeckEditor(
  transport: DeckEditorTransport,
  options: DeckEditorOptions = {},
): RendererDeckEditor {
  const timeoutMs = options.timeoutMs ?? DEFAULT_DECK_EDIT_TIMEOUT_MS
  const pending = new Map<string, Pending>()
  let counter = 0

  const finish = (requestId: string): Pending | undefined => {
    const entry = pending.get(requestId)
    if (entry === undefined) return undefined
    clearTimeout(entry.timer)
    pending.delete(requestId)
    return entry
  }

  return {
    snapshot() {
      return new Promise<AgentSnapshotResult>((resolve) => {
        const message = 'the deck editor window is not available'
        if (!transport.isAlive()) {
          resolve(unavailableSnapshot(message))
          return
        }
        counter += 1
        const requestId = `de_${String(counter)}`
        const timer = setTimeout(() => {
          pending.delete(requestId)
          resolve(unavailableSnapshot('the deck editor did not respond in time'))
        }, timeoutMs)
        pending.set(requestId, { op: 'snapshot', settle: resolve, timer })
        try {
          transport.send({ requestId, op: 'snapshot' })
        } catch {
          finish(requestId)
          resolve(unavailableSnapshot(message))
        }
      })
    },

    apply(commands, turnId, toolUseId) {
      return new Promise<AgentApplyResult>((resolve) => {
        const message = 'the deck editor window is not available'
        if (!transport.isAlive()) {
          resolve(unavailableApply(message))
          return
        }
        counter += 1
        const requestId = `de_${String(counter)}`
        const timer = setTimeout(() => {
          pending.delete(requestId)
          resolve(unavailableApply('the deck editor did not respond in time'))
        }, timeoutMs)
        pending.set(requestId, { op: 'apply', settle: resolve, timer })
        try {
          transport.send({ requestId, op: 'apply', commands, turnId, toolUseId })
        } catch {
          finish(requestId)
          resolve(unavailableApply(message))
        }
      })
    },

    deliver(response) {
      const entry = finish(response.requestId)
      if (entry === undefined) return
      // An op mismatch means a bug on the other end; fail the caller rather than mis-type the result.
      if (entry.op === 'apply' && response.op === 'apply') entry.settle(response.result)
      else if (entry.op === 'snapshot' && response.op === 'snapshot') entry.settle(response.result)
      else if (entry.op === 'apply') entry.settle(unavailableApply('mismatched editor response'))
      else entry.settle(unavailableSnapshot('mismatched editor response'))
    },

    rejectAll(message = 'the deck editor window was closed') {
      for (const [, entry] of pending) {
        clearTimeout(entry.timer)
        if (entry.op === 'apply') entry.settle(unavailableApply(message))
        else entry.settle(unavailableSnapshot(message))
      }
      pending.clear()
    },
  }
}

/**
 * An in-process editor over a `DocumentHistory`. For where main and the deck share a process — the
 * unit tests, and a future headless mode. Routes through the same undo-parity funnel as the renderer.
 */
export function createLocalDeckEditor(history: DocumentHistory<DeckDoc>): DeckEditor {
  return {
    snapshot: () => Promise.resolve({ ok: true, snapshot: snapshotOfDoc(history.doc) }),
    apply: (commands, turnId, toolUseId) =>
      Promise.resolve(applyAgentCommandsToHistory(history, commands, turnId, toolUseId)),
  }
}
