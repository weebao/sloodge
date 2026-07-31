/**
 * The Claude Agent SDK facade — the **only** file in the repo that imports
 * `@anthropic-ai/claude-agent-sdk` (11-tech-stack.md R3). Everything else depends on the
 * `AgentQueryFn` seam in `query-contract.ts`, so an SDK breaking change is a single-file fix and the
 * orchestration stays testable without the SDK.
 *
 * This is where the isolation levers of 50-agent-integration.md §5 are applied — the app must not
 * inherit the user's ambient `~/.claude` config, skills, hooks, or credentials.
 */

import { query, type Options } from '@anthropic-ai/claude-agent-sdk'
import { app } from 'electron'
import path from 'node:path'
import type { AgentQueryFn, AgentQueryHandle, AgentQueryOptions } from './query-contract'

/**
 * Kept short on purpose — the craft knowledge lives in the bundled skills (M2.2), not here
 * (50-agent-integration.md §2). Referenced tools land with the slide MCP server in M2.2.
 */
const SLOODGE_SYSTEM_APPEND =
  'You are a presentation-design assistant embedded in Sloodge, a slide editor. A deck is an ' +
  'ordered list of slides; every slide is one self-contained 1280x720 HTML document. Do not write ' +
  'files directly; slide changes are persisted through the slide tools.'

/**
 * App-owned paths for a session (50-agent-integration.md §5, §12). The cwd is under `userData`,
 * never inside a user's git repo, and CLAUDE_CONFIG_DIR is steered away from `~/.claude` so a
 * developer's personal OAuth credentials can't leak in. M2.1 uses one shared workspace; M2.x derives
 * a per-deck path from the deck's stable UUID (resume requires an identical cwd).
 */
export function defaultAgentPaths(): { cwd: string; configDir: string } {
  const userData = app.getPath('userData')
  return {
    cwd: path.join(userData, 'agent', 'workspace'),
    configDir: path.join(userData, 'agent', 'claude'),
  }
}

/**
 * Translate Sloodge's narrow options into the SDK's full `Options`. Exported so a unit test can
 * assert the isolation invariants (`settingSources: ['project']`, `strictMcpConfig`,
 * auto-memory off, the ambient config redirected, the denied-tool set) without importing the SDK's
 * runtime.
 */
export function buildSdkOptions(o: AgentQueryOptions): Options {
  return {
    cwd: o.cwd,

    // --- isolation (§5): the user's ambient Claude config must not leak in ---
    settingSources: ['project'],
    strictMcpConfig: true,
    env: {
      // `env` REPLACES the subprocess environment in the TS SDK — always spread `process.env`, or
      // the subprocess loses PATH/HOME (§4, §16).
      ...process.env,
      ANTHROPIC_API_KEY: o.apiKey,
      CLAUDE_CONFIG_DIR: o.configDir,
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
    },

    // --- tool surface (§7): a complete, minimal mutation surface. mcp__slides__* lands in M2.2. ---
    tools: ['Read', 'Skill'],
    allowedTools: ['Read', 'Skill'],
    disallowedTools: ['Bash', 'Write', 'Edit', 'WebSearch', 'WebFetch', 'Agent', 'Task'],
    permissionMode: 'default',

    // --- prompting ---
    systemPrompt: {
      type: 'preset',
      preset: 'claude_code',
      append: SLOODGE_SYSTEM_APPEND,
      excludeDynamicSections: true,
    },

    // --- model & streaming ---
    model: o.model,
    includePartialMessages: true,
    persistSession: true,
    ...(o.resumeSessionId !== undefined ? { resume: o.resumeSessionId } : {}),
  }
}

/**
 * The real `AgentQueryFn` — opens a streaming-input `query()` and hands back the live handle. The
 * only runtime use of the SDK in the codebase.
 */
export const realQuery: AgentQueryFn = ({ prompt, options }) => {
  const handle = query({ prompt, options: buildSdkOptions(options) })
  return handle as AgentQueryHandle
}
