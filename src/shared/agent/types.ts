/**
 * The agent wire contract, shared by all three build targets (main owns the SDK, preload validates,
 * renderer renders). Like the rest of `src/shared`, this file is dependency-free: types, constants,
 * and pure guards only — it must not import `electron` or the Agent SDK.
 *
 * M2.1 establishes the streaming/turn/key surface. The slide `mcp__slides__*` tools (M2.2) and the
 * chat UI (M2.3) build on these events without changing them.
 */

/**
 * The model picker (50-agent-integration.md §11). The ids are verified against the current Claude
 * model catalog (claude-api skill, cached 2026-06-24): `claude-opus-5` (best design judgment),
 * `claude-sonnet-5` (balanced), `claude-haiku-4-5` (fast). They are intentionally *not* hardcoded at
 * call sites — the whole set lives here so a catalog bump is a one-file edit.
 */
export const AGENT_MODEL_IDS = ['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5'] as const

export type AgentModelId = (typeof AGENT_MODEL_IDS)[number]

/** The default per 50-agent-integration.md §11: best design judgment and SVG/interactive output. */
export const DEFAULT_AGENT_MODEL: AgentModelId = 'claude-opus-5'

export function isAgentModelId(value: unknown): value is AgentModelId {
  return typeof value === 'string' && (AGENT_MODEL_IDS as readonly string[]).includes(value)
}

/**
 * How a turn failed, surfaced as a typed event rather than a thrown string (50-agent-integration.md
 * §13). The renderer branches on `kind` to choose recovery UX; `message` is human-readable copy.
 *
 * - `auth` — 401/403; the credential is flagged invalid, not deleted.
 * - `no-credential` — no credential is configured at all. Distinct from `auth` because nothing was
 *   authenticated and nothing failed, and the two need opposite remedies: "check the one you have"
 *   versus "add one". Folding them told a subscription user to check an API key they never had.
 * - `rate-limit` / `overloaded` — 429 / 529; the SDK retries internally, so this only surfaces once
 *   it has given up.
 * - `network` — DNS/offline; the deck stays editable offline.
 * - `budget` — `error_max_budget_usd`.
 * - `max-turns` — `error_max_turns`.
 * - `interrupted` — the user pressed Stop.
 * - `runtime-missing` — the bundled `claude` binary could not be resolved (packaging fault).
 * - `unknown` — anything unclassified, including `error_during_execution`.
 */
export const AGENT_ERROR_KINDS = [
  'auth',
  'no-credential',
  'rate-limit',
  'overloaded',
  'network',
  'budget',
  'slash-command',
  'max-turns',
  'interrupted',
  'runtime-missing',
  'unknown',
] as const

export type AgentErrorKind = (typeof AGENT_ERROR_KINDS)[number]

/**
 * How the session is carrying Sloodge's slide-craft knowledge (M2.5, 50-agent-integration.md §8).
 *
 * - `ok` — the three bundled skills loaded from the workspace. Progressive disclosure: ~100 tokens
 *   per skill until one is relevant. Nothing is shown in the status bar; this is the design working.
 * - `fallback` — the skills did not load, so the session restarted **once** with `skills: []` and the
 *   three SKILL.md bodies inlined into the system prompt. Same output quality, higher token cost per
 *   turn. The status bar reads `skills: fallback` so a support case can spot it.
 * - `unavailable` — the skills did not load and the fallback could not be built either (the bundled
 *   SKILL.md files are unreadable). The agent answers without the craft knowledge; the chat panel
 *   says so.
 *
 * `unknown` is not a member: the status is only reported once a session has resolved an init, and
 * "not yet known" is the *absence* of this event rather than a value of it. The renderer's store
 * carries its own idle state.
 */
export type SkillsStatus = 'ok' | 'fallback' | 'unavailable'

/**
 * Token usage for one assistant message or turn. Deliberately a subset of the SDK's `usage` object —
 * `cacheReadTokens` is the main cost lever on long sessions (50-agent-integration.md §10) and the
 * only cache field M2.1 forwards.
 */
export type AgentUsage = {
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cacheReadTokens: number
}

/**
 * The one-way main -> renderer event stream (`agent:event`). A discriminated union so the renderer
 * reducer is exhaustive; every member is structured-clone-safe (no functions, no class instances).
 *
 * `assistant-delta` carries token-level text (SDK `includePartialMessages`); `assistant-message` is
 * the finalized, usage-bearing message, deduplicated by the SDK message id so parallel tool calls
 * don't double-count (50-agent-integration.md §10, §16).
 */
export type AgentEvent =
  /**
   * `skills` is the SDK's own list of what the session loaded, straight off `system:init`. It is the
   * only observable answer to "did the bundled skills actually reach the model?" (M2.4,
   * 50-agent-integration.md §8) — the SKILL.md files are discovered from disk inside the subprocess,
   * so nothing on our side of the boundary can otherwise tell success from a silent miss.
   */
  | {
      readonly type: 'ready'
      readonly sessionId: string
      readonly model: string
      readonly skills: readonly string[]
    }
  /**
   * The bundled skills did not load for this session **and could not be recovered**
   * (50-agent-integration.md §8). Emitted at most once per session, right after `ready`, and only
   * once M2.5's fallback restart has been ruled out — the agent still works, but without the craft
   * knowledge the skills carry, so this is a visible degradation notice rather than an error. A
   * silent skill-less session is the failure M2.4 exists to prevent.
   *
   * A session that *was* repaired by the fallback restart does not emit this: nagging about a
   * condition that has been fixed teaches users to ignore the notice. It reports `skills-status:
   * fallback` instead, which the status bar shows quietly.
   */
  | { readonly type: 'skills-degraded'; readonly missing: readonly string[] }
  /**
   * How the session's slide-craft knowledge is being loaded (M2.5, §8) — the status bar's
   * `skills: fallback` indicator. Emitted whenever the session resolves an init, so a restart is
   * never invisible: §8 pairs the automatic fallback restart with this indicator precisely because
   * "a session that silently restarts itself with a different prompt shape, and says so nowhere, is
   * worse than the loud non-healing state".
   */
  | { readonly type: 'skills-status'; readonly status: SkillsStatus }
  | { readonly type: 'assistant-delta'; readonly text: string }
  | { readonly type: 'assistant-message'; readonly text: string; readonly usage: AgentUsage }
  | { readonly type: 'tool-use'; readonly toolUseId: string; readonly label: string }
  /**
   * A `result` arrived (or main closed a turn its query never answered). `snapshotUsd` is the SDK's
   * `total_cost_usd` — the reporting subprocess's **running total**, not this turn's price — and
   * `generation` names that subprocess, so the shared fold (`shared/agent/cost.ts`) can take the
   * maximum within a generation and bank the total when a new one starts.
   */
  | {
      readonly type: 'turn-end'
      readonly snapshotUsd: number
      readonly generation: number
      readonly subtype: string
    }
  | {
      readonly type: 'error'
      readonly kind: AgentErrorKind
      readonly message: string
      readonly recoverable: boolean
    }

/**
 * A masked view of the stored API key. The plaintext key **never** crosses IPC toward the renderer
 * (50-agent-integration.md §4); the renderer sees only whether one is configured and its last four
 * characters, enough to render "…aXY9" in Settings.
 */
export type ApiKeyStatus = {
  readonly configured: boolean
  readonly last4: string | null
}

/** `agent:setKey` request — the plaintext key travels renderer -> main only, never back. */
export type ApiKeySetRequest = { readonly key: string }

/** `agent:send` request — one user turn. Images are M2.x; text-only for M2.1. */
export type AgentSendRequest = { readonly text: string }

/**
 * The longest key we will accept. A real Anthropic key is ~108 chars; the ceiling exists so a
 * pathological renderer can't hand `safeStorage` a multi-megabyte "key" to encrypt.
 */
export const MAX_API_KEY_LENGTH = 512

const AGENT_EVENT_TYPES = [
  'ready',
  'skills-degraded',
  'skills-status',
  'assistant-delta',
  'assistant-message',
  'tool-use',
  'turn-end',
  'error',
] as const

/**
 * Shape gate for an event arriving over IPC. The renderer must not switch on a `type` it merely
 * hopes is one of ours — this checks the discriminant so the reducer can trust it. It is a
 * discriminant check, not a full structural validation of every member (main is the trusted sender).
 */
export function isAgentEvent(value: unknown): value is AgentEvent {
  return (
    typeof value === 'object' &&
    value !== null &&
    (AGENT_EVENT_TYPES as readonly string[]).includes((value as { type?: unknown }).type as string)
  )
}

export function isApiKeySetRequest(value: unknown): value is ApiKeySetRequest {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { key?: unknown }).key === 'string'
  )
}

export function isAgentSendRequest(value: unknown): value is AgentSendRequest {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { text?: unknown }).text === 'string'
  )
}
