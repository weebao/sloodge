/**
 * The injection seam between Sloodge's agent orchestration and the Claude Agent SDK.
 *
 * The SDK is pre-1.0 and has removed APIs mid-minor (11-tech-stack.md R3), and every one of its
 * calls hits `api.anthropic.com` through a spawned `claude` subprocess. Both facts point the same
 * way: the orchestration (turn state machine, event mapping, error classification) must depend on a
 * *narrow local interface*, not on the SDK. That interface is here.
 *
 * - `client.ts` is the only file that imports `@anthropic-ai/claude-agent-sdk` and adapts the real
 *   `query()` to `AgentQueryFn` (the R3 facade).
 * - Unit tests supply a fake `AgentQueryFn` that yields a scripted message sequence, so the whole
 *   turn lifecycle is exercised with no key and no network.
 *
 * The message shapes below are a deliberately small subset of the SDK's ~40 `SDKMessage` variants —
 * only the fields the mapper reads. `mapSdkMessage` treats everything as `unknown` and re-narrows, so
 * a shape drift in the SDK degrades to "ignored message", never a crash.
 */

import type { AgentModelId } from '../../shared/agent/types'
import type { AgentCredential } from './auth-env'

/**
 * One queued user turn. Structurally a subset of the SDK's `SDKUserMessage`, so the facade can hand
 * the bridge's stream straight to `query()` without a copy. The generator that yields these **must
 * never throw** — the SDK reports an input-generator throw as the misleading
 * "Claude Code process aborted by user" (50-agent-integration.md §2), so all validation happens
 * before enqueue.
 */
export type AgentUserMessage = {
  readonly type: 'user'
  readonly message: { readonly role: 'user'; readonly content: string }
  readonly parent_tool_use_id: null
}

/**
 * The options the facade needs to build the SDK's full `Options` object. The isolation levers
 * (settingSources, CLAUDE_CONFIG_DIR, CLAUDE_CODE_DISABLE_AUTO_MEMORY, strictMcpConfig) are applied
 * inside `client.ts` and are not represented here — they are invariant, not per-call.
 */
export type AgentQueryOptions = {
  /**
   * The resolved credential for this session (M2.7) — an API key or a `claude setup-token`
   * subscription token. Which environment variable it becomes, and which conflicting ones get
   * deleted, is `buildAuthEnv`'s job; the orchestration never touches the value.
   */
  readonly credential: AgentCredential
  readonly model: AgentModelId
  readonly cwd: string
  readonly configDir: string
  /** Resume a prior conversation for this deck; omitted starts fresh (50-agent-integration.md §12). */
  readonly resumeSessionId?: string
  /**
   * In-process MCP servers (M2.2 — `{ slides: slidesServer }` for the `mcp__slides__*` tools).
   * Typed `unknown` on purpose: the seam stays SDK-free, so the SDK's server-config type is not
   * imported here. `client.ts` — the sole SDK importer — casts it back to the SDK shape when
   * building `Options`, and the orchestration only ever passes the value straight through.
   */
  readonly mcpServers?: Readonly<Record<string, unknown>>
  /**
   * §8's fallback (M2.5). When present, this session runs with `skills: []` and this text appended to
   * `systemPrompt.append` instead of discovering the bundled skills from the filesystem. Set only by
   * `AgentSession`'s one-shot restart, after an init reported the skills missing — it is the *shape*
   * of the degraded session, so it lives in the options rather than as a flag someone could set
   * independently of the prompt it implies.
   */
  readonly skillFallbackPrompt?: string
  /**
   * The SDK's per-query spend ceiling (§10): the user's absolute cap, set once when the query opens.
   * The CLI compares its own running total against it (`vS() >= maxBudgetUsd` in 2.1.220 — the same
   * total every `result` reports as `total_cost_usd`) and ends the query with
   * `result.subtype === 'error_max_budget_usd'` when it is reached.
   *
   * A backstop against one runaway query, not the enforcement mechanism: the cap is enforced by
   * `AgentService.send` (admission) and `AgentSession.setBudgetCap` (stopping an open turn once the
   * folded total meets a lowered cap). It is never a decaying remainder — see `setBudgetCap` for why.
   * `undefined` means the user has configured no cap.
   */
  readonly maxBudgetUsd?: number
}

/**
 * The live handle over one `query()`. Extends the async generator of SDK messages with the two
 * streaming-input control methods M2.1 uses: `interrupt()` (Stop) and `setModel()` (picker). The
 * yield type is `unknown` on purpose — see the module docstring.
 */
export interface AgentQueryHandle extends AsyncGenerator<unknown, void, unknown> {
  interrupt(): Promise<unknown>
  setModel(model?: string): Promise<void>
}

/** The single function the orchestration depends on. `client.ts` provides the real one. */
export type AgentQueryFn = (params: {
  prompt: AsyncIterable<AgentUserMessage>
  options: AgentQueryOptions
}) => AgentQueryHandle
