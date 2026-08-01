/**
 * The Claude Agent SDK facade — the **only** file in the repo that imports
 * `@anthropic-ai/claude-agent-sdk` (11-tech-stack.md R3). Everything else depends on the
 * `AgentQueryFn` seam in `query-contract.ts`, so an SDK breaking change is a single-file fix and the
 * orchestration stays testable without the SDK.
 *
 * This is where the isolation levers of 50-agent-integration.md §5 are applied — the app must not
 * inherit the user's ambient `~/.claude` config, skills, hooks, or credentials.
 */

import {
  createSdkMcpServer,
  query,
  tool,
  type McpServerConfig,
  type McpSdkServerConfigWithInstance,
  type Options,
} from '@anthropic-ai/claude-agent-sdk'
import { app } from 'electron'
import path from 'node:path'
import { buildAuthEnv } from './auth-env'
import type { AgentQueryFn, AgentQueryHandle, AgentQueryOptions } from './query-contract'
import { BUNDLED_SKILL_NAMES, resolveBundledSkillsDir } from './skills'

/**
 * Re-exported so the in-process `mcp__slides__*` server (`tools.ts`) can build tool definitions
 * without importing `@anthropic-ai/claude-agent-sdk` itself — this file stays the single SDK
 * importer (R3), and the slide tools depend on `./client` rather than the package.
 */
export { createSdkMcpServer, tool }
export type { McpSdkServerConfigWithInstance }

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
 * Where the read-only bundled skill sources live for this build (M2.4). `electron`-touching, so the
 * decision itself lives in the pure `resolveBundledSkillsDir`; this only reads the three app facts.
 */
export function bundledSkillsDir(): string {
  return resolveBundledSkillsDir({
    isPackaged: app.isPackaged,
    appPath: app.getAppPath(),
    resourcesPath: process.resourcesPath,
  })
}

/**
 * Translate Sloodge's narrow options into the SDK's full `Options`. Exported so a unit test can
 * assert the isolation invariants (`settingSources: ['project']`, `strictMcpConfig`,
 * auto-memory off, the ambient config redirected, the denied-tool set) without importing the SDK's
 * runtime.
 */
export function buildSdkOptions(o: AgentQueryOptions): Options {
  // The `slides` server flows through the seam as opaque `unknown` (query-contract.ts keeps the
  // interface SDK-free); it is created by `createSlidesServer` (an `McpSdkServerConfigWithInstance`)
  // and cast back to the SDK's config type only here, the one file that knows the SDK. When present,
  // the deck-mutating tools become the agent's only write surface: `mcp__slides__*` is allowed and
  // Bash/Write/Edit stay denied below (§7).
  const hasSlides = o.mcpServers !== undefined
  return {
    cwd: o.cwd,

    // --- isolation (§5): the user's ambient Claude config must not leak in ---
    settingSources: ['project'],
    strictMcpConfig: true,
    env: {
      // `env` REPLACES the subprocess environment in the TS SDK — `buildAuthEnv` spreads
      // `process.env` so the subprocess keeps PATH/HOME (§4, §16), and *deletes* every credential
      // variable before setting the one this session actually uses. That deletion is the point:
      // `ANTHROPIC_API_KEY` outranks `CLAUDE_CODE_OAUTH_TOKEN` in the CLI's precedence, so an
      // ambient key would otherwise hijack a subscription session (see auth-env.ts).
      ...buildAuthEnv(process.env, o.credential),
      CLAUDE_CONFIG_DIR: o.configDir,
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
    },

    // --- tool surface (§7): a complete, minimal mutation surface. The in-process slide tools are
    // the ONLY way the agent mutates the deck; Bash/Write/Edit are denied so a shell/file write is
    // never a fallback path out of the document sandbox. ---
    tools: ['Read', 'Skill'],
    allowedTools: hasSlides ? ['Read', 'Skill', 'mcp__slides__*'] : ['Read', 'Skill'],
    disallowedTools: ['Bash', 'Write', 'Edit', 'WebSearch', 'WebFetch', 'Agent', 'Task'],
    permissionMode: 'default',
    ...(hasSlides ? { mcpServers: o.mcpServers as Record<string, McpServerConfig> } : {}),

    // --- skills (§8): the three validated slide skills, materialized into `<cwd>/.claude/skills`
    // by `materializeSkills` before the session starts. This list is a *context filter*, not just a
    // convenience: naming ours explicitly means a stray skill in the workspace — or anything the
    // project layer picked up — is never loaded, which is the second half of the §5 isolation that
    // `settingSources: ['project']` starts. The user's `~/.claude/skills` is invisible on both
    // counts. ---
    skills: [...BUNDLED_SKILL_NAMES],

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
