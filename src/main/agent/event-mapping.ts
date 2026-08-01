/**
 * Pure translation from SDK messages to Sloodge's `AgentEvent` wire union, plus error
 * classification. No SDK import, no I/O — this is the file that carries the milestone's behavioural
 * contract and gets the densest tests.
 *
 * Two SDK sharp edges are enforced here (50-agent-integration.md §10, §16):
 *  - assistant content is nested at `message.message.content`, never `message.content`;
 *  - assistant usage must be deduplicated by `message.message.id`, because parallel tool calls emit
 *    several assistant messages sharing one id with identical usage.
 */

import type { AgentErrorKind, AgentEvent, AgentUsage } from '../../shared/agent/types'

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

/** Every string in an array value, dropping non-strings; anything else reads as an empty list. */
function asStringArray(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : []
}

function asFiniteNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/**
 * Map the SDK's `SDKAssistantMessage.error` enum to a Sloodge error kind. The enum values are the
 * SDK's, quoted from its type declaration; anything unrecognised is `unknown`.
 */
export function classifyAssistantError(error: string): AgentErrorKind {
  switch (error) {
    case 'authentication_failed':
    case 'oauth_org_not_allowed':
    case 'billing_error':
      return 'auth'
    case 'rate_limit':
      return 'rate-limit'
    case 'overloaded':
      return 'overloaded'
    case 'max_output_tokens':
      return 'max-turns'
    default:
      return 'unknown'
  }
}

/**
 * Map an error `result.subtype` to a kind, or `null` for `subtype: "success"` and any non-error
 * subtype (the turn still ended; we emit `turn-end`, not `error`).
 *
 * Anything the SDK prefixes `error_` that we do not recognise is `unknown` rather than `null`. The
 * old `default: null` rendered an unrecognised failure as a clean successful turn — and M2.5 made
 * that costlier, since a future `error_max_budget_*` variant would bill the user and show success.
 * An unfamiliar error is still an error.
 */
export function classifyResultSubtype(subtype: string): AgentErrorKind | null {
  switch (subtype) {
    case 'error_max_budget_usd':
      return 'budget'
    case 'error_max_turns':
      return 'max-turns'
    case 'error_during_execution':
    case 'error_max_structured_output_retries':
      return 'unknown'
    default:
      return subtype.startsWith('error') ? 'unknown' : null
  }
}

/**
 * Classify a thrown error (network/DNS, or the runtime-missing case). `query()` also throws *after*
 * yielding an error `result` (50-agent-integration.md §13); by then the `result` has already been
 * mapped, so this is the residual signal — usually a genuine transport failure.
 */
export function classifyException(error: unknown): { kind: AgentErrorKind; message: string } {
  const rec = asRecord(error)
  const name = rec ? asString(rec['name']) : null
  const rawMessage = rec ? asString(rec['message']) : null
  const message = rawMessage ?? (typeof error === 'string' ? error : 'The agent turn failed.')
  const haystack = `${name ?? ''} ${message}`.toLowerCase()

  if (/runtime|executable|not found|enoent/.test(haystack)) {
    return { kind: 'runtime-missing', message }
  }
  if (/401|403|auth|unauthor|forbidden|api key/.test(haystack)) {
    return { kind: 'auth', message }
  }
  if (/429|rate.?limit/.test(haystack)) {
    return { kind: 'rate-limit', message }
  }
  if (/econn|enotfound|network|dns|offline|fetch failed|timeout|etimedout/.test(haystack)) {
    return { kind: 'network', message }
  }
  return { kind: 'unknown', message }
}

/** Whether a failure kind is worth offering a Retry rather than a dead end. */
export function isRecoverable(kind: AgentErrorKind): boolean {
  return kind !== 'auth' && kind !== 'runtime-missing'
}

function extractUsage(usage: Record<string, unknown> | null): AgentUsage {
  return {
    inputTokens: asFiniteNumber(usage?.['input_tokens']),
    outputTokens: asFiniteNumber(usage?.['output_tokens']),
    cacheReadTokens: asFiniteNumber(usage?.['cache_read_input_tokens']),
  }
}

function extractDeltaText(streamEvent: Record<string, unknown> | null): string | null {
  // stream_event -> event (BetaRawMessageStreamEvent) -> delta.text for a text_delta.
  const event = asRecord(streamEvent?.['event'])
  if (!event || event['type'] !== 'content_block_delta') return null
  const delta = asRecord(event['delta'])
  if (!delta || delta['type'] !== 'text_delta') return null
  return asString(delta['text'])
}

function mapAssistant(message: Record<string, unknown>, seen: Set<string>): AgentEvent[] {
  const inner = asRecord(message['message'])
  const events: AgentEvent[] = []

  // Errors ride the wrapper, not `message.content`, and are not deduplicated — surface each.
  const errorEnum = asString(message['error'])
  if (errorEnum !== null) {
    const kind = classifyAssistantError(errorEnum)
    events.push({ type: 'error', kind, message: errorEnum, recoverable: isRecoverable(kind) })
    return events
  }

  if (!inner) return events

  const id = asString(inner['id'])
  // Dedup by message id: parallel tool calls repeat the same id with identical usage (§10, §16).
  if (id !== null && seen.has(id)) return events
  if (id !== null) seen.add(id)

  const content = inner['content']
  const blocks = Array.isArray(content) ? content : []
  const textParts: string[] = []
  for (const block of blocks) {
    const rec = asRecord(block)
    if (!rec) continue
    if (rec['type'] === 'text') {
      const text = asString(rec['text'])
      if (text !== null) textParts.push(text)
    } else if (rec['type'] === 'tool_use') {
      const toolUseId = asString(rec['id'])
      const name = asString(rec['name'])
      if (toolUseId !== null && name !== null) {
        events.push({ type: 'tool-use', toolUseId, label: toolChipLabel(name) })
      }
    }
  }

  const joined = textParts.join('')
  if (joined.length > 0) {
    events.push({
      type: 'assistant-message',
      text: joined,
      usage: extractUsage(asRecord(inner['usage'])),
    })
  }
  return events
}

/**
 * Human label for a tool chip, derived in main and never shown raw (50-agent-integration.md §9).
 * M2.1 has no slide tools yet, so `mcp__slides__update_slide` becomes "update slide"; M2.2 refines
 * these with slide indices.
 */
export function toolChipLabel(toolName: string): string {
  const bare = toolName.startsWith('mcp__') ? (toolName.split('__').pop() ?? toolName) : toolName
  return bare.replace(/_/g, ' ')
}

/**
 * Translate one SDK message into zero or more `AgentEvent`s. `seen` carries the assistant-id dedup
 * set across a turn — pass the same Set for the whole `for await` loop. Unrecognised messages map to
 * `[]`, which is how the ~30 SDK message types M2.1 ignores are handled.
 */
export function mapSdkMessage(raw: unknown, seen: Set<string>): AgentEvent[] {
  const message = asRecord(raw)
  if (!message) return []
  const type = message['type']

  if (type === 'system' && message['subtype'] === 'init') {
    const sessionId = asString(message['session_id'])
    const model = asString(message['model'])
    if (sessionId === null || model === null) return []
    // The loaded-skill list is advisory: an older/newer runtime that omits it must still produce a
    // usable `ready` (the session is fine without it), so a missing or malformed array reads as [].
    const skills = asStringArray(message['skills'])
    return [{ type: 'ready', sessionId, model, skills }]
  }

  if (type === 'stream_event') {
    const text = extractDeltaText(message)
    return text !== null && text.length > 0 ? [{ type: 'assistant-delta', text }] : []
  }

  if (type === 'assistant') {
    return mapAssistant(message, seen)
  }

  if (type === 'result') {
    const subtype = asString(message['subtype']) ?? 'unknown'
    const costUsd = asFiniteNumber(message['total_cost_usd'])
    const events: AgentEvent[] = [{ type: 'turn-end', costUsd, subtype }]
    const kind = classifyResultSubtype(subtype)
    if (kind !== null) {
      events.push({
        type: 'error',
        kind,
        // Only `unknown` carries the raw subtype. For kinds the renderer has calibrated copy for,
        // the copy table owns the wording and this must stay empty — `errorCopy` prefers a non-empty
        // message, so a diagnostic string here would put "Turn ended: error_max_budget_usd" on
        // screen instead of the sentence written for that case (M2.5).
        message: kind === 'unknown' ? `Turn ended: ${subtype}` : '',
        recoverable: isRecoverable(kind),
      })
    }
    return events
  }

  return []
}
