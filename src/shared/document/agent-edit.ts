/**
 * The agent-edit ↔ renderer-deck reconciliation contract (M2.6) — the milestone that closes the
 * chat→generate loop.
 *
 * The shipped app is **renderer-authoritative**: the single `DocumentHistory` lives in the renderer's
 * `deckStore` (M1.3/M1.4), and the native Edit menu's Undo/Redo drive *that* history. An agent tool
 * edit (M2.2) is built in main, so for the loop to be real the command must reach the renderer's
 * history — not a second deck main holds, and not the full-snapshot `deck:updated`/`history.reset`
 * path (which would wipe the user's undo stack, see `deck-update.ts`).
 *
 * So this module defines a tiny request/response protocol that crosses one IPC hop:
 *
 *   main tool handler → `AgentEditRequest` → renderer applies via `history.apply` → `AgentEditResponse`
 *
 * The **undo-parity invariant** (50-agent-integration.md §6, 10-architecture.md §5) is achieved by
 * `applyAgentCommandsToHistory`: it dispatches the agent's `DocCommand`s through the *same*
 * `DocumentHistory.apply` a manual edit uses, tagged `origin: { kind: 'agent' }`. One tool call is
 * one `apply` call is exactly one undo entry — so the standard Ctrl/⌘+Z reverses an agent edit in one
 * step, with no change to the undo path. `update_slide`'s two commands (setHtml + setNotes) ride a
 * single `apply`, so they collapse to one entry, not two.
 *
 * Dependency-free like the rest of `src/shared`: it re-uses the document types and `DocumentHistory`
 * (also pure), and imports no zod parser and no Electron. Both ends of the hop shape-gate the message
 * they receive — `isAgentEditRequest` on the renderer, `isAgentEditResponse` on main — so neither
 * switches on a discriminant it merely hopes is one of ours.
 */

import type { DeckDoc, DocCommand } from './commands'
import type { CommandOrigin, DocumentHistory } from './history'
import type { DeckManifest } from './types'

/* -------------------------------------------------------------------------------------------- *
 * Snapshot + result shapes
 * -------------------------------------------------------------------------------------------- */

/**
 * A serializable read of the authoritative deck, enough to resolve reads (`read_slide`,
 * `screenshot_slide`) and to compute a created/edited slide's 1-based index. Carried back on every
 * successful apply so the tool host never needs a second round-trip to report the result.
 */
export type AgentDeckSnapshot = {
  readonly manifest: DeckManifest
  /** Slide HTML by id — every id in `manifest.slideOrder` has an entry. */
  readonly slides: Readonly<Record<string, string>>
  /** Speaker notes by id; an absent key means the slide has no notes. */
  readonly notes: Readonly<Record<string, string>>
}

/**
 * Stable-enough-to-branch-on codes for a failed edit. `renderer-unavailable` is the M2.1 lifecycle
 * case: the deck window went away mid-call, so the tool returns this rather than hanging.
 */
export type AgentEditErrorCode =
  'slide-not-found' | 'index-out-of-range' | 'invalid' | 'renderer-unavailable' | 'internal'

export type AgentApplyResult =
  | { readonly ok: true; readonly rev: number; readonly snapshot: AgentDeckSnapshot }
  | { readonly ok: false; readonly code: AgentEditErrorCode; readonly message: string }

export type AgentSnapshotResult =
  | { readonly ok: true; readonly snapshot: AgentDeckSnapshot }
  | { readonly ok: false; readonly code: AgentEditErrorCode; readonly message: string }

/* -------------------------------------------------------------------------------------------- *
 * The IPC messages (main ↔ renderer)
 * -------------------------------------------------------------------------------------------- */

/** Main → renderer. `snapshot` reads the authoritative deck; `apply` mutates it through the history. */
export type AgentEditRequest =
  | { readonly requestId: string; readonly op: 'snapshot' }
  | {
      readonly requestId: string
      readonly op: 'apply'
      readonly commands: readonly DocCommand[]
      /** Recorded on the history entry's `origin` (§5): the turn and tool that produced the edit. */
      readonly turnId: string
      readonly toolUseId: string
    }

/** Renderer → main. `requestId` correlates a response to its pending request. */
export type AgentEditResponse =
  | { readonly requestId: string; readonly op: 'snapshot'; readonly result: AgentSnapshotResult }
  | { readonly requestId: string; readonly op: 'apply'; readonly result: AgentApplyResult }

/**
 * Shape gate for a request arriving at the renderer. Main is the trusted sender, but the renderer
 * must not switch on an `op` it merely hopes is ours. Prototype-safe: never indexes an
 * attacker-influenced key.
 */
export function isAgentEditRequest(value: unknown): value is AgentEditRequest {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  if (typeof record['requestId'] !== 'string') return false
  const op = record['op']
  if (op === 'snapshot') return true
  return op === 'apply' && Array.isArray(record['commands'])
}

/** Shape gate for a response arriving at main. Same posture, opposite direction. */
export function isAgentEditResponse(value: unknown): value is AgentEditResponse {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  if (typeof record['requestId'] !== 'string') return false
  const op = record['op']
  if (op !== 'snapshot' && op !== 'apply') return false
  const result = record['result']
  return (
    typeof result === 'object' &&
    result !== null &&
    typeof (result as { ok?: unknown }).ok === 'boolean'
  )
}

/* -------------------------------------------------------------------------------------------- *
 * Pure reconciliation core — the undo-parity guarantee lives here
 * -------------------------------------------------------------------------------------------- */

/** Build a serializable snapshot from a live document. Null-prototype maps, faithful to the doc. */
export function snapshotOfDoc(doc: DeckDoc): AgentDeckSnapshot {
  const slides = Object.create(null) as Record<string, string>
  for (const id of Object.keys(doc.slides)) slides[id] = doc.slides[id] ?? ''
  const notes = Object.create(null) as Record<string, string>
  for (const id of Object.keys(doc.notes)) notes[id] = doc.notes[id] ?? ''
  return { manifest: doc.manifest, slides, notes }
}

function mapHistoryErrorCode(code: string): AgentEditErrorCode {
  if (code === 'slide-not-found') return 'slide-not-found'
  if (code === 'index-out-of-range') return 'index-out-of-range'
  return 'invalid'
}

/**
 * **The undo-parity funnel.** Dispatches the agent's commands through `DocumentHistory.apply` with an
 * `agent` origin — the *same* method a manual edit uses — so the edit lands on the one undo stack the
 * Edit menu drives. A single `apply` records exactly one entry, so one tool call is one Ctrl/⌘+Z.
 *
 * Routing this batch through `history.reset` (the snapshot path) instead would clear the undo stack
 * and the edit would not be reversible: that is the mutation the headline undo-parity test guards.
 */
export function applyAgentCommandsToHistory(
  history: DocumentHistory<DeckDoc>,
  commands: readonly DocCommand[],
  turnId: string,
  toolUseId: string,
): AgentApplyResult {
  const origin: CommandOrigin = { kind: 'agent', turnId, toolUseId }
  const result = history.apply(commands, origin)
  if (!result.ok) {
    return {
      ok: false,
      code: mapHistoryErrorCode(result.error.code),
      message: result.error.message,
    }
  }
  return { ok: true, rev: result.rev, snapshot: snapshotOfDoc(history.doc) }
}

/* -------------------------------------------------------------------------------------------- *
 * The renderer-side dispatcher — the half that answers requests
 * -------------------------------------------------------------------------------------------- */

/**
 * The seam the renderer implements (the `deckStore`) so the request handler stays testable without a
 * store: apply commands through the authoritative history, or read a snapshot of it.
 */
export type AgentDeckTarget = {
  applyAgentCommands(
    commands: readonly DocCommand[],
    turnId: string,
    toolUseId: string,
  ): AgentApplyResult
  snapshotForAgent(): AgentDeckSnapshot
}

/** Map a request onto the deck target and shape the response. Pure — the IPC glue is separate. */
export function handleAgentEditRequest(
  target: AgentDeckTarget,
  request: AgentEditRequest,
): AgentEditResponse {
  if (request.op === 'snapshot') {
    return {
      requestId: request.requestId,
      op: 'snapshot',
      result: { ok: true, snapshot: target.snapshotForAgent() },
    }
  }
  const result = target.applyAgentCommands(request.commands, request.turnId, request.toolUseId)
  return { requestId: request.requestId, op: 'apply', result }
}
