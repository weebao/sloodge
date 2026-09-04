# Claude Agent SDK (TypeScript) — Research for Embedding an Agentic Chat Loop in an Electron Slide Editor

Researched 2026-07-31 against the live docs at `code.claude.com/docs/en/agent-sdk/*` (the canonical location — `platform.claude.com/docs/en/agent-sdk/*` 307-redirects there). Each section cites its source page.

Context for this project ("sloodge"): a PowerPoint-like Electron desktop app where a chat box drives slide generation/editing via Claude. The SDK runs in the **Electron main process** (Node runtime), streams messages to the renderer over IPC, and exposes slide operations as **custom in-process MCP tools**.

---

## 1. What the Agent SDK is (and is not)

- The Agent SDK is **Claude Code packaged as a library**: the full agent harness — agent loop, built-in tools (Read/Write/Edit/Bash/Glob/Grep/WebSearch/WebFetch), context management, prompt caching, permissions, hooks, sessions, subagents, MCP — programmable from Python and TypeScript. You call `query()` and consume a message stream; the SDK handles orchestration, tool execution, and retries.
- It is **not** the plain Anthropic API client (`@anthropic-ai/sdk`), not the API "Tool Runner", and not Managed Agents (a hosted REST product). If you want batteries-included agent behavior in your own process, this is the right product.
- Architecture: `query()` **spawns a `claude` CLI subprocess** (a native binary bundled with the npm package) and talks to it over stdio. One session = one subprocess, which owns a shell, a working directory, and JSONL transcript files on disk. This subprocess model drives most of the Electron-specific caveats in §14.

Sources:
- https://code.claude.com/docs/en/agent-sdk/overview
- https://code.claude.com/docs/en/agent-sdk/hosting (subprocess model)

> **Licensing/branding note (important for a shipped product):** Anthropic does **not** allow third-party products to offer claude.ai login or claude.ai rate limits — use API-key auth. Branding: "Claude Agent" / "Powered by Claude" is allowed; "Claude Code" branding is not. Use is governed by Anthropic's Commercial Terms. (overview page)

---

## 2. Installation

```bash
npm install @anthropic-ai/claude-agent-sdk
# dev convenience for running .ts directly:
npm install --save-dev tsx
```

- **Node.js 18+** required.
- The package bundles a **native Claude Code binary as a platform-specific optional dependency** (e.g. `@anthropic-ai/claude-agent-sdk-darwin-arm64`, `...-linux-x64`). No separate Claude Code install is needed. If optional dependencies are skipped by your package manager or your bundler drops them, set `options.pathToClaudeCodeExecutable` to the binary path explicitly.
- The bundled binary is pinned to the SDK version — updating the SDK is how you update the CLI/harness.
- For `bun build --compile` there's an official embed-and-extract helper (`@anthropic-ai/claude-agent-sdk/extract` → `extractFromBunfs`). This same "extract the binary to a real path, then pass `pathToClaudeCodeExecutable`" pattern is the model for Electron asar packaging (§14).

Sources:
- https://code.claude.com/docs/en/agent-sdk/quickstart
- https://code.claude.com/docs/en/agent-sdk/typescript (Installation section)

---

## 3. Authentication

The subprocess reads credentials from **its environment** (which you control via `options.env`):

| Method | How |
|---|---|
| **Anthropic API key** (recommended for products) | `ANTHROPIC_API_KEY` env var. The SDK does **not** load `.env` files — set the variable on the process (or pass via `options.env`) yourself. |
| Amazon Bedrock | `CLAUDE_CODE_USE_BEDROCK=1` + AWS credentials |
| Claude Platform on AWS | `CLAUDE_CODE_USE_ANTHROPIC_AWS=1` + `ANTHROPIC_AWS_WORKSPACE_ID` + AWS credentials |
| Google Cloud (Vertex / Agent Platform) | `CLAUDE_CODE_USE_VERTEX=1` + GCP credentials |
| Microsoft Foundry | `CLAUDE_CODE_USE_FOUNDRY=1` + Azure credentials |
| Claude Code login / claude.ai subscription | Works for *personal/dev* use (the CLI's stored OAuth credentials in `~/.claude` are picked up by the subprocess), **but Anthropic explicitly prohibits shipping products that use claude.ai login/rate limits without prior approval.** For a distributed app, require the user's own API key (or your backend-proxied key). |
| Proxy pattern | Set `ANTHROPIC_BASE_URL` to route model calls through your own proxy that injects the key server-side, so no key lives on the client (hosting page, "Auth and secrets"). |

Electron practicalities: collect the user's API key in your UI, store it with `safeStorage`, and pass it per-query as `options.env = { ...process.env, ANTHROPIC_API_KEY: key }` (note: in TypeScript, `env` **replaces** the subprocess environment, so always spread `process.env` to keep `PATH` etc.).

Sources:
- https://code.claude.com/docs/en/agent-sdk/quickstart (Setup step 3)
- https://code.claude.com/docs/en/agent-sdk/overview (claude.ai login prohibition)
- https://code.claude.com/docs/en/agent-sdk/hosting (auth & secrets)

---

## 4. Core API: `query()`

```typescript
import { query } from "@anthropic-ai/claude-agent-sdk";

function query({ prompt, options }: {
  prompt: string | AsyncIterable<SDKUserMessage>;
  options?: Options;
}): Query;   // Query extends AsyncGenerator<SDKMessage, void>
```

Minimal loop (from the quickstart):

```typescript
for await (const message of query({
  prompt: "Review utils.py for bugs that would cause crashes. Fix any issues you find.",
  options: {
    allowedTools: ["Read", "Edit", "Glob"],
    permissionMode: "acceptEdits",
  },
})) {
  if (message.type === "assistant" && message.message?.content) {
    for (const block of message.message.content) {
      if ("text" in block) console.log(block.text);
      else if ("name" in block) console.log(`Tool: ${block.name}`);
    }
  } else if (message.type === "result") {
    console.log(`Done: ${message.subtype}`);
  }
}
```

There is also `startup()` which **pre-warms the CLI subprocess** to cut first-prompt latency — very relevant for a desktop app's perceived responsiveness:

```typescript
import { startup } from "@anthropic-ai/claude-agent-sdk";
const warm = await startup({ options: { /* ... */ } });
for await (const message of warm.query("Generate a title slide")) { /* ... */ }
```

### The `Query` object (control methods)

`query()` returns a `Query` (async generator + control surface). Key methods:

| Method | Purpose |
|---|---|
| `interrupt()` | Stop the current turn (streaming-input mode only). Your "Stop generating" button. |
| `setPermissionMode(mode)` | Change permission mode mid-session (streaming mode only) |
| `setModel(model?)` | Switch model mid-session (`undefined`/`"default"` resets) |
| `applyFlagSettings(settings)` | Merge/clear settings at runtime (model, effort, permissions, hooks, skill overrides…) |
| `supportedCommands()` / `supportedModels()` / `supportedAgents()` | Introspection |
| `mcpServerStatus()` / `setMcpServers()` / `toggleMcpServer()` / `reconnectMcpServer()` | MCP management |
| `getContextUsage()` | Context-window usage breakdown (by category/skill/tool) — good for a context meter UI |
| `accountInfo()` | Account info for the active credentials |
| `streamInput(stream)` | Feed more `SDKUserMessage`s into an active session |
| `rewindFiles(userMessageId)` | Restore files to a checkpoint (requires `enableFileCheckpointing: true`) — potential undo mechanism for agent edits |
| `stopTask(taskId)` | Stop a background subagent task |
| `close()` | Tear down the subprocess |

> **Note on `ClaudeSDKClient`:** that class is **Python-only**. In TypeScript there is no session-holding client object; the equivalents are (a) a long-lived `query()` with an AsyncIterable prompt (streaming input mode) or (b) repeated `query()` calls with `continue: true` / `resume`. An experimental "V2 session API" (`createSession()` with send/stream) existed but was **removed in TS SDK 0.3.142** — don't build on it.

Sources:
- https://code.claude.com/docs/en/agent-sdk/typescript
- https://code.claude.com/docs/en/agent-sdk/sessions (V2 removal note)

---

## 5. `Options` reference (the ones that matter here)

From the TypeScript reference page; grouped by concern.

**Core**
- `model: string` — model alias or full ID.
- `cwd: string` — working directory for the agent (its filesystem root for tools; also determines session-transcript location). Point it at your app's per-deck workspace directory.
- `abortController: AbortController` — cancellation.
- `maxTurns: number` — bound the agentic loop (there is **no built-in wall-clock timeout**; this is the documented mitigation).
- `maxBudgetUsd: number` — stop when the client-side cost estimate hits this.
- `effort: 'low'|'medium'|'high'|'xhigh'|'max'`, `thinking: { type: 'adaptive' } | { type: 'off' } | { type: 'enabled', budget_tokens }`.
- `env: Record<string,string>` — subprocess env (**replaces**; spread `process.env`).
- `executable: 'bun'|'deno'|'node'`, `pathToClaudeCodeExecutable: string` — runtime/binary overrides (Electron packaging lever).
- `stderr: (data: string) => void` — capture subprocess stderr for logging.
- `debug` / `debugFile`.

**Tools & permissions**
- `tools: string[] | { type:'preset', preset:'claude_code' }` — which built-ins exist at all (`tools: []` removes all built-ins → Claude can only use your MCP tools; ideal for a pure slide-editing agent).
- `allowedTools: string[]` — auto-approve list (supports scoped rules like `"Bash(npm *)"`).
- `disallowedTools: string[]` — bare name removes tool from context; scoped rule denies matching calls.
- `permissionMode: 'default'|'dontAsk'|'acceptEdits'|'plan'|'auto'|'bypassPermissions'`.
- `canUseTool: CanUseTool` — runtime approval callback (§10).
- `hooks` — §9. `includeHookEvents: boolean` surfaces hook lifecycle messages in the stream.

**MCP / custom tools**
- `mcpServers: Record<string, McpServerConfig>` — external (stdio/HTTP/SSE) or in-process SDK servers (§8).
- `strictMcpConfig: boolean` — ignore project `.mcp.json`, use only what you pass.

**Sessions**
- `resume: string` (session ID), `continue: boolean`, `forkSession: boolean`, `sessionId: string` (pin a UUID), `persistSession: boolean` (TS-only; `false` = in-memory only), `sessionStore: SessionStore` (mirror transcripts to S3/Redis/Postgres/your own), `title: string`, `enableFileCheckpointing`.

**Prompting & config**
- `systemPrompt: string | { type:'preset', preset:'claude_code', append?: string, excludeDynamicSections?: boolean }` — a raw string **replaces** the Claude Code system prompt; the preset+`append` form keeps the harness prompt and adds your domain instructions (recommended for tool-using agents). `excludeDynamicSections: true` improves prompt-cache reuse.
- `settingSources: ('user'|'project'|'local')[]` — which filesystem settings/skills/CLAUDE.md/agents load (§11).
- `settings` / `managedSettings` / `serverManagedSettings` — inline settings objects.
- `skills: string[] | 'all' | []` — skill filter (§12).
- `agent: string`, `agents: Record<string, AgentDefinition>` — subagents (§13). `agentProgressSummaries`, `forwardSubagentText`.
- `outputFormat: { type:'json_schema', schema }` — structured final output.
- `includePartialMessages: boolean` — token-level streaming events (§7).
- `taskBudget: { total: number }` — API-side token budget.

**Timeout env vars** (pass via `options.env`): `API_TIMEOUT_MS` (default 600000), `CLAUDE_CODE_MAX_RETRIES` (default 10, cap 15), `CLAUDE_STREAM_IDLE_TIMEOUT_MS` (default 300000), `CLAUDE_ASYNC_AGENT_STALL_TIMEOUT_MS`.

Source: https://code.claude.com/docs/en/agent-sdk/typescript

---

## 6. Message stream (`SDKMessage` variants)

The generator yields, in rough order per turn:

- `{ type: "system", subtype: "init", session_id, ... }` — first message; carries session ID, tool list, loaded `skills` array, capabilities. Use it to confirm skills/tools loaded.
- `{ type: "assistant", message: { id, content: Block[], usage }, parent_tool_use_id? }` — Claude's turns. **TS nests the API message under `message.message`** — content blocks are `message.message.content` (`text`, `tool_use`, `thinking` blocks). `parent_tool_use_id` set ⇒ this message came from inside a subagent.
- `{ type: "user", ... }` — echoed user turns / tool results.
- `{ type: "stream_event" / partial }` — only when `includePartialMessages: true` (raw API stream events for token-level UI).
- `{ type: "task_progress", task_id, summary }` — background-subagent progress (with `agentProgressSummaries`).
- `{ type: "system", subtype: "mirror_error" }` — SessionStore mirror failure (alert if durability matters).
- `{ type: "result", subtype: "success" | "error_max_turns" | "error_max_budget_usd" | ..., result, session_id, total_cost_usd, usage, modelUsage, permission_denials }` — exactly one per `query()` call, on success **and** error.

Error behavior: a single-shot `query()` **throws after yielding an error result** (e.g. `error_max_turns`) — wrap the loop in try/catch; the result message (with `session_id` and cost) has already been yielded when the throw happens. In streaming-input mode, if your input generator itself throws, the surfaced error is the misleading `"Claude Code process aborted by user"` — check your generator first.

Sources:
- https://code.claude.com/docs/en/agent-sdk/typescript
- https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode
- https://code.claude.com/docs/en/agent-sdk/cost-tracking

---

## 7. Streaming input vs single-message mode

**Streaming input mode (recommended, and the right shape for a chat box):** pass an `AsyncIterable<SDKUserMessage>` as `prompt`. The agent becomes a long-lived process that accepts queued user messages, supports `interrupt()`, `setPermissionMode()`, image attachments, and keeps context naturally across turns.

```typescript
import { query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

// Bridge: chat-box submissions (from renderer IPC) -> async generator
function createChatBridge() {
  const queue: SDKUserMessage[] = [];
  let wake: (() => void) | null = null;
  let closed = false;
  return {
    send(text: string, images?: { media_type: string; data: string }[]) {
      const content = images?.length
        ? [{ type: "text" as const, text },
           ...images.map(img => ({ type: "image" as const, source: { type: "base64" as const, ...img } }))]
        : text;
      queue.push({ type: "user", message: { role: "user", content }, parent_tool_use_id: null });
      wake?.();
    },
    close() { closed = true; wake?.(); },
    async *stream(): AsyncGenerator<SDKUserMessage> {
      while (!closed) {
        while (queue.length) yield queue.shift()!;
        await new Promise<void>(r => (wake = r));
      }
    },
  };
}

const bridge = createChatBridge();
const q = query({ prompt: bridge.stream(), options: { /* ... */ } });
// bridge.send("Make slide 2's title bigger") from your IPC handler
// q.interrupt() for the stop button
for await (const message of q) { mainWindow.webContents.send("agent:message", message); }
```

Image attachments (e.g. "make a slide like this screenshot") use content blocks: `{ type: "image", source: { type: "base64", media_type: "image/png", data } }`.

**Single message mode:** `prompt: string`. Simpler, but no images, no interrupt, no mid-session control; multi-turn only via `continue: true` / `resume` (a new subprocess per call). Fine for one-shot background jobs.

**Token-level output streaming:** independent of input mode, set `includePartialMessages: true` to receive `stream_event` messages (raw `content_block_delta` etc.) so the renderer can show text appearing token by token.

Source: https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode

---

## 8. Custom tools: `tool()` + `createSdkMcpServer()` — the slide-editing surface

Custom tools run as an **in-process MCP server** inside your Node/Electron main process — no subprocess, no network. This is how the chat loop mutates your slide model.

```typescript
import { query, tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

const addSlide = tool(
  "add_slide",
  "Add a new slide to the deck. Call when the user asks to create/insert a slide.",
  {
    layout: z.enum(["title", "title-body", "two-column", "image-full"]).describe("Slide layout"),
    title: z.string().describe("Slide title text"),
    body: z.string().optional().describe("Body content, markdown"),
    position: z.number().int().optional().describe("1-based insert position; append if omitted"),
  },
  async (args) => {
    const slide = deckStore.addSlide(args);            // your app's state
    mainWindow.webContents.send("deck:updated", deckStore.serialize()); // live UI update
    return {
      content: [{ type: "text", text: `Created slide ${slide.index}: "${args.title}"` }],
      structuredContent: { slideId: slide.id, index: slide.index },  // machine-readable
    };
  },
  { annotations: { readOnlyHint: false } }
);

const getDeck = tool(
  "get_deck", "Return the current deck as JSON (slides, elements, styles).",
  {},
  async () => ({ content: [{ type: "text", text: JSON.stringify(deckStore.serialize()) }] }),
  { annotations: { readOnlyHint: true } }  // read-only tools can run in parallel
);

const slidesServer = createSdkMcpServer({
  name: "slides",
  version: "1.0.0",
  tools: [addSlide, getDeck /* edit_slide, delete_slide, set_theme, reorder, render_thumbnail... */],
});

const q = query({
  prompt: bridge.stream(),
  options: {
    mcpServers: { slides: slidesServer },
    tools: [],                                   // strip all built-ins -> slide tools only
    allowedTools: ["mcp__slides__*"],            // auto-approve every slides tool
    permissionMode: "dontAsk",
    systemPrompt: { type: "preset", preset: "claude_code",
      append: "You are a presentation-design assistant inside a slide editor. Use the slides tools to inspect and modify the deck. Never invent slide IDs — call get_deck first." },
  },
});
```

Key mechanics:
- **Naming:** tools surface to Claude as `mcp__{server_key}__{tool_name}` (`mcp__slides__add_slide`). The key in `mcpServers` is the server segment. Wildcard `mcp__slides__*` in `allowedTools` covers the whole server.
- **Handler return shape:** `{ content: Block[], structuredContent?, isError? }`. `content` blocks: `text`, `image` (base64 `data` + `mimeType` — e.g. return a rendered slide thumbnail so Claude can *see* the slide), `audio`, `resource` (inline content addressed by a URI label), `resource_link`.
- **`structuredContent`:** when set, Claude gets the JSON + any image/resource blocks; text blocks are dropped as presumed duplicates.
- **Errors:** an uncaught throw is converted into an error result (agent loop continues); prefer catching and returning `isError: true` with a message Claude can act on.
- **Annotations:** `readOnlyHint: true` enables parallel batching with other read-only tools; `destructiveHint`, `idempotentHint`, `openWorldHint` are informational.
- **Tool search:** on by default; SDK MCP tool schemas are deferred and loaded on demand (Claude sees names in a compact list). Use `alwaysLoad: true` (on `tool()` extras or `createSdkMcpServer`) to keep a critical tool's schema in the initial prompt.
- External MCP servers (stdio commands, HTTP/SSE URLs) also go in `mcpServers`; `strictMcpConfig: true` prevents picking up a project `.mcp.json`.

Source: https://code.claude.com/docs/en/agent-sdk/custom-tools (all examples verbatim from docs, adapted)

---

## 9. Hooks

Callbacks that run at lifecycle points; registered under `options.hooks` as `{ [HookEvent]: [{ matcher?, hooks: [callback], timeout? }] }`.

**Events:** `PreToolUse` (can block/modify), `PostToolUse`, `PostToolUseFailure`, `UserPromptSubmit` (inject context), `Stop`, `StopFailure`, `SubagentStart`, `SubagentStop`, `PreCompact`, `PermissionRequest`, `SessionStart`, `SessionEnd`, `Notification`, `FileChanged`, `MessageDisplay`.

**Matchers:** exact-string with `|`/`,` alternatives (`"Write|Edit"`), or unanchored regex when other characters appear (`^mcp__slides__`). Omitted/`*` = all. Matchers filter by tool name only — filter by path/args inside the callback.

**Callback:** receives a typed input (`PreToolUseHookInput` has `tool_name`, `tool_input`, `hook_event_name`, plus `agent_id`/`agent_type` inside subagents) and a `tool_use_id`; returns a `HookJSONOutput`. Example — block writes to protected files:

```typescript
import { query, HookCallback, PreToolUseHookInput } from "@anthropic-ai/claude-agent-sdk";

const protectEnvFiles: HookCallback = async (input) => {
  const pre = input as PreToolUseHookInput;
  const path = (pre.tool_input as any)?.file_path ?? "";
  if (path.endsWith(".env")) {
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",           // "allow" | "deny" | "ask" | "defer"
        permissionDecisionReason: "Env files are protected",
      },
    };
  }
  return {};
};

query({ prompt, options: {
  hooks: { PreToolUse: [{ matcher: "Write|Edit", hooks: [protectEnvFiles] }] },
}});
```

- `PreToolUse` hooks can also return `updatedInput` (rewrite the call) or `"defer"` (end the query; resume later from the persisted session — useful for approvals that outlive the process).
- `PostToolUse` can set `additionalContext` or `updatedToolOutput` (replace what Claude sees).
- Multiple matching hooks run **in parallel**; most restrictive decision wins (one `deny` blocks).
- Hooks run **before every other permission step** and apply even in `bypassPermissions` — the right place for hard security invariants (vs `canUseTool`, which auto-approved tools skip).
- `includeHookEvents: true` streams hook lifecycle messages for observability.
- Shell-command hooks from settings files also run if the corresponding `settingSources` are enabled.

Source: https://code.claude.com/docs/en/agent-sdk/hooks

---

## 10. Permissions

**Evaluation order** (per tool call): 1) hooks → 2) deny rules (`disallowedTools` + settings.json; apply even in `bypassPermissions`) → 3) ask rules (settings.json; force a `canUseTool` prompt even in bypass) → 4) permission mode → 5) allow rules (`allowedTools` + settings.json) → 6) `canUseTool` callback (skipped and denied in `dontAsk`).

**Modes:** `default` (unmatched calls hit `canUseTool`), `dontAsk` (deny instead of prompt — locked-down headless), `acceptEdits` (auto-approve file edits + fs commands within cwd), `plan` (read-only; edits always prompt), `auto` (model classifier decides), `bypassPermissions` (approve everything reaching step 4; TS additionally requires `allowDangerouslySkipPermissions: true`; `allowedTools` does **not** constrain it — use `disallowedTools` to carve out blocks).

**`canUseTool` (the user-approval UI hook):**

```typescript
canUseTool: async (toolName, input, { signal, suggestions = [] }) => {
  if (toolName === "AskUserQuestion") return handleClarifyingQuestions(input); // see below
  const approved = await showApprovalDialog(toolName, input);   // IPC to renderer modal
  if (approved.always) {
    return { behavior: "allow", updatedInput: input,
             updatedPermissions: suggestions.filter(s => s.destination === "localSettings") };
  }
  if (approved.once) return { behavior: "allow", updatedInput: input };
  return { behavior: "deny", message: "User declined this action" };
}
```

- Return shape: `{ behavior: "allow", updatedInput, updatedPermissions? }` or `{ behavior: "deny", message }`. You may modify `updatedInput` before execution (sanitize paths, scope commands). A deny `message` is read by Claude and steers it ("archive instead of delete").
- **Auto-approved tools never reach `canUseTool`** — enforce must-run checks in a `PreToolUse` hook instead. Exceptions that always reach it: `AskUserQuestion`, MCP tools with `_meta["anthropic/requiresUserInteraction"]`, org-`ask` connector tools.
- The callback can stay pending indefinitely (execution pauses); for very long waits use the hook `defer` decision + session resume.
- **`AskUserQuestion`:** Claude's structured clarifying-question tool (1–4 questions, 2–4 options each, `multiSelect`, optional HTML/markdown `preview` via `toolConfig.askUserQuestion.previewFormat`). Answer by returning `behavior:"allow"` with `updatedInput: { questions, answers: { [questionText]: label } }`. Perfect for a native question card in the chat UI (e.g. "Which theme: Minimal / Bold / Corporate?").

For sloodge, a sensible policy: `tools: []` (or a small read-only set), all slide tools in `allowedTools`, `permissionMode: "dontAsk"`, plus `canUseTool` handling `AskUserQuestion`. If you later enable `Bash`/`Write` for export features, gate them via `canUseTool` + a renderer approval modal.

Sources:
- https://code.claude.com/docs/en/agent-sdk/permissions
- https://code.claude.com/docs/en/agent-sdk/user-input

---

## 11. Settings sources & precedence

`settingSources: ('user'|'project'|'local')[]` controls which **filesystem** configuration loads:
- `user` → `~/.claude/` (settings, skills, agents, CLAUDE.md)
- `project` → `<cwd>/.claude/` and parents up to repo root (+ `.mcp.json`, project CLAUDE.md)
- `local` → `.claude/settings.local.json`

Defaults for `query()` load user+project (matching CLI behavior). Precedence (high→low): server-managed settings → managed (policy) settings → flag settings (programmatic `Options`) → local → project → user → CLI defaults. `applyFlagSettings()` edits the flag layer at runtime; setting a key to `null` clears the override.

**For a desktop app**, the hosting docs' multi-tenant guidance applies almost verbatim, because you don't want a user's personal `~/.claude` config leaking into your product's agent:

```typescript
options: {
  settingSources: [],                       // no filesystem settings — deterministic behavior
  cwd: appWorkspaceDir,                     // per-deck/app-controlled dir
  env: {
    ...process.env,
    CLAUDE_CONFIG_DIR: path.join(app.getPath("userData"), "claude"), // isolate config + transcripts
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",   // auto-memory loads regardless of settingSources
  },
}
```

Caveat: `settingSources: []` also disables filesystem **skills** discovery — see §12 for how to keep skills while isolating settings (ship them into a controlled `project` dir, or load via `plugins`).

Sources:
- https://code.claude.com/docs/en/agent-sdk/typescript (SettingSource, precedence)
- https://code.claude.com/docs/en/agent-sdk/hosting (multi-tenant isolation)

---

## 12. Loading Agent Skills (folder-based, SKILL.md)

Skills are **filesystem-only** — there is no programmatic registration API (unlike subagents). Each skill is a directory with a `SKILL.md` (YAML frontmatter with `name` + `description`, then markdown instructions, plus optional supporting files). Claude reads the description at startup and loads full content on demand (model-invoked).

**Locations & discovery:**
- Project: `<cwd>/.claude/skills/<name>/SKILL.md` (and any parent dir of `cwd` up to the repo root) — loaded when `settingSources` includes `"project"`.
- User: `~/.claude/skills/<name>/SKILL.md` — loaded with `"user"`.
- Plugins: bundled with plugins loaded via the `plugins` option (load skills from an arbitrary path — the escape hatch when you set `settingSources: []`).
- With default options (no explicit `settingSources`), user+project skills load automatically.

**The `skills` option** filters what's enabled: `"all"`, `["pdf","docx"]` (names from frontmatter or dir name; `plugin:skill` for plugin skills), or `[]` to disable. When you set `skills`, the SDK auto-adds the `Skill` tool to `allowedTools`; if you pass an explicit `tools` array, include `"Skill"` in it. The init system message's `skills` array confirms what loaded.

```typescript
for await (const message of query({
  prompt: "Turn this outline into a 10-slide deck",
  options: {
    cwd: deckWorkspace,                        // contains .claude/skills/slide-design/SKILL.md
    settingSources: ["project"],               // required for skill discovery
    skills: ["slide-design", "brand-guidelines"],
    allowedTools: ["Read", "mcp__slides__*"],
  },
})) { /* ... */ }
```

For sloodge: ship your own skills (e.g. `slide-design`, `chart-style`, `brand-voice`) inside the app bundle, copy them into the workspace's `.claude/skills/` (or load via `plugins`), and enable `settingSources: ["project"]` — keeping `user`/`local` off so end-user machines can't alter agent behavior.

**Caveats:** `allowed-tools` frontmatter in SKILL.md is CLI-only — it does **not** restrict tools under the SDK (use `allowedTools`). The `skills` filter is a context filter, not a sandbox (files remain readable via Read/Bash). Note this is different from the *Messages API* skills feature (`container.skills` + code-execution beta) — that's a separate surface, not the Agent SDK.

Source: https://code.claude.com/docs/en/agent-sdk/skills

---

## 13. Subagents

Three ways: programmatic `agents` option (recommended for SDK apps), filesystem `.claude/agents/*.md`, and the built-in `general-purpose` agent (always invocable). Claude delegates via the **`Agent` tool** (renamed from `Task` in v2.1.63 — match both names when detecting) — include `"Agent"` in `allowedTools` to auto-approve delegation.

```typescript
options: {
  allowedTools: ["Read", "Grep", "Glob", "Agent", "mcp__slides__*"],
  agents: {
    "deck-researcher": {
      description: "Researches a topic and returns structured bullet points for slides. Use for content gathering.",
      prompt: "You research topics and return concise, sourced bullet points suitable for presentation slides.",
      tools: ["WebSearch", "WebFetch", "Read"],
      model: "haiku",            // cheap model for research fan-out
    },
    "deck-critic": {
      description: "Reviews a finished deck for clarity, flow, and design consistency.",
      prompt: "You are a presentation coach. Critique decks for narrative flow, slide density, and visual consistency.",
      tools: ["Read", "mcp__slides__get_deck"],
      model: "inherit",
    },
  },
}
```

`AgentDefinition` fields: `description` (required — drives automatic delegation), `prompt` (required — the subagent's system prompt), `tools`, `disallowedTools`, `model` (`'fable'|'opus'|'sonnet'|'haiku'|'inherit'` or full ID), `skills` (preload), `memory`, `mcpServers`, `maxTurns`, `background`, `effort`, `permissionMode`, `initialPrompt`.

Behavior notes:
- **Context isolation:** subagents start fresh; only the Agent-tool prompt string passes down, only the final message returns up. Whole-tree token accounting: use `modelUsage` on the result (the plain `usage` field excludes subagents; `total_cost_usd` includes them).
- Since v2.1.198 subagents run **in the background by default**; they inherit the parent's permission mode (bypass/acceptEdits/auto can't be overridden per-subagent). Nesting up to 3 layers (`CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH`).
- Subagents can be **resumed**: capture `session_id` + the `agentId:` trailer from the Agent tool result, then `resume: sessionId` + mention the agent ID in the prompt.
- Detect delegation: `tool_use` blocks named `Agent`/`Task`; messages from inside a subagent carry `parent_tool_use_id`. For big fan-out use the `Workflow` tool (TS SDK ≥ 0.3.149).
- Windows caveat: very long subagent prompts can hit the 8191-char command-line limit.

Source: https://code.claude.com/docs/en/agent-sdk/subagents

---

## 14. Cost & usage tracking

- **Per query:** the final `result` message carries `total_cost_usd` (client-side **estimate** from a bundled price table — not billing truth; don't bill users off it), cumulative `usage` (top-level loop only), and `modelUsage` — per-model `{ inputTokens, outputTokens, cacheReadInputTokens, cacheCreationInputTokens, costUSD }` including subagents.
- **Per step:** each assistant message has `message.message.id` + `message.message.usage`. **Parallel tool calls emit multiple assistant messages sharing one id with identical usage — deduplicate by id** or you'll double-count.
- **Across calls:** no session-level total. **Corrected in M2.5 r4:** `total_cost_usd` is the CLI subprocess's *cumulative* total at the moment of that `result` (`Ot.totalCostUSD += e` per API call, `vS()` getter, every result builder writes `total_cost_usd: vS()`, no per-turn reset — bundled CLI 2.1.220), so within one `query()` take the **maximum**, and sum only *across* `query()` calls. Adding successive results together double-counts from the second turn on. Error results also carry (the same running) cost.
- **Budget guard:** `maxBudgetUsd` stops the query at a spend ceiling (result subtype `error_max_budget_usd`).
- **Caching:** prompt caching is automatic (no config). Track `cache_creation_input_tokens` / `cache_read_input_tokens`. Default TTL 5 min with API-key auth; set `ENABLE_PROMPT_CACHING_1H=1` (via `options.env`) for 1-hour TTL if sessions are spaced out.
- Authoritative billing: the platform Usage & Cost API / Console.

```typescript
const seen = new Set<string>();
let inTok = 0, outTok = 0;
for await (const m of q) {
  if (m.type === "assistant" && !seen.has(m.message.id)) {
    seen.add(m.message.id);
    inTok += m.message.usage.input_tokens;
    outTok += m.message.usage.output_tokens;
  }
  // Cumulative per subprocess: max within a query(), never +=. See 50-agent-integration.md §10.
  if (m.type === "result") querySpend = Math.max(querySpend, m.total_cost_usd ?? 0);
}
```

Source: https://code.claude.com/docs/en/agent-sdk/cost-tracking

---

## 15. Sessions: persistence, resume, fork

- Transcripts are JSONL files under `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl` (or `$CLAUDE_CONFIG_DIR/projects/...`); `<encoded-cwd>` is the absolute cwd with non-alphanumerics replaced by `-`. **Resume requires the same `cwd`** — a mismatched cwd silently yields a fresh session. For sloodge, pinning `CLAUDE_CONFIG_DIR` into `app.getPath("userData")` keeps transcripts inside your app's data dir.
- Capture `session_id` from the `result` message (always present) or earlier from the `system:init` message. Persist it per deck/conversation in your app DB.
- `resume: sessionId` — reopen a specific session with full context. `continue: true` — most recent session in the cwd (no ID tracking; fine for a single-conversation app). `forkSession: true` with `resume` — branch: new ID, copied history, original untouched (e.g. "try a different visual direction" without losing the current thread). Note forking branches the **conversation**, not files — use `enableFileCheckpointing` + `rewindFiles()` for file-level undo.
- `persistSession: false` (TS-only) for fully in-memory sessions; `sessionStore` adapter (S3/Redis/Postgres/custom) mirrors transcripts to durable storage (local disk stays authoritative; watch for `mirror_error` system messages).
- Session utilities: `listSessions()`, `getSessionMessages()`, `getSessionInfo()`, `renameSession()`, `tagSession()` — enough to build a "conversation history" picker UI directly on SDK storage.

Source: https://code.claude.com/docs/en/agent-sdk/sessions

---

## 16. Running inside Electron (main process) — architecture & caveats

The docs don't have an Electron page; the authoritative inputs are the subprocess model (hosting page), the packaging notes (typescript reference), and the multi-tenant isolation guidance. Items marked *(inferred)* are standard Electron engineering applied to those documented facts.

**Placement**
- Run the SDK in the **main process** (or a hidden utility process). It is a Node library that spawns a child process over stdio; the renderer sandbox can't do that. *(documented subprocess model + standard Electron)*
- Bridge with IPC: renderer chat box → `ipcMain` handler → `bridge.send(...)` into the streaming-input generator; every `SDKMessage` (and partial stream events) → `webContents.send("agent:message", ...)` → renderer chat transcript. `canUseTool`/`AskUserQuestion` → renderer modal via `ipcRenderer.invoke` round-trip (the callback can stay pending while the user decides). *(pattern; the SDK is agnostic)*

**Packaging (the big one)** *(inferred from documented packaging levers)*
- The CLI is a **native binary in a platform-specific optional npm dependency**. Two consequences for electron-builder/forge:
  1. Binaries cannot execute from inside `app.asar`. Add the SDK's binary package to `asarUnpack` (e.g. `"**/node_modules/@anthropic-ai/claude-agent-sdk*/**"`), or ship the binary as an extraResource and point `pathToClaudeCodeExecutable` at it. The SDK's own bun-compile helper (`extractFromBunfs` + `pathToClaudeCodeExecutable`) confirms "extract to a real path and point at it" is the sanctioned pattern.
  2. Only the current platform's optional dep installs; for cross-platform builds make sure each platform's build resolves its own binary (build per-platform, don't copy node_modules across).
- macOS notarization/Gatekeeper: the unpacked binary must be signed with your app (electron-builder signs unpacked binaries by default; verify). Windows: some AV heuristics dislike apps spawning unknown EXEs from user-writable paths — keep it inside the installed app directory.
- Verify at startup: attempt `startup()` and surface a clear error if the binary is missing (`pathToClaudeCodeExecutable` misconfigured).

**Environment & auth**
- `options.env` **replaces** the subprocess env in TS — always `{ ...process.env, ... }`. macOS GUI apps launch with a minimal `PATH`; that matters if you enable the `Bash` tool (user's CLIs may not resolve). *(documented replace-semantics + known macOS behavior)*
- Store the API key with Electron `safeStorage`; inject per query via `env`. Never expose it to the renderer. Alternatively route through your backend with `ANTHROPIC_BASE_URL`.

**Isolation & state**
- Set `CLAUDE_CONFIG_DIR` under `app.getPath("userData")` so sessions/config live in your app's sandbox, not `~/.claude` (avoids collisions with a user's own Claude Code install and its login credentials).
- `settingSources: []` + `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` for deterministic behavior on arbitrary user machines; load your skills via a controlled workspace dir or `plugins`.
- `cwd` per deck/workspace; the agent's file tools see that directory tree.

**Lifecycle & resources**
- One live `query()` (one subprocess) per open chat is the natural unit; ~1 GiB RAM per active agent session is the documented planning number, and memory grows with session length — recycle long sessions (resume by ID after `close()`).
- No built-in session timeout — set `maxTurns` and `maxBudgetUsd`; wire `abortController`/`interrupt()` to a stop button; call `q.close()` on window close and app `before-quit` so no orphaned CLI processes remain.
- Offline: the subprocess needs outbound HTTPS to `api.anthropic.com` — handle network errors gracefully (result subtypes + thrown errors).
- Windows: long subagent prompts can exceed the 8191-char command-line limit (docs); prefer concise subagent prompts.

**Security**
- Treat the agent as untrusted-input-driven: keep `Bash`/`Write` out of `tools` unless needed; put hard invariants (never touch files outside workspace, never run `rm`) in `PreToolUse` hooks, since hooks run even in `bypassPermissions` and cannot be skipped by allow rules.

Sources:
- https://code.claude.com/docs/en/agent-sdk/hosting
- https://code.claude.com/docs/en/agent-sdk/typescript (packaging, env, executable)
- https://code.claude.com/docs/en/agent-sdk/secure-deployment (referenced for hardening)

---

## 17. Known caveats & gotchas (consolidated)

1. **TS has no `ClaudeSDKClient`** — that's Python. Use streaming-input `query()` for a live chat session; the old V2 `createSession()` API was removed in 0.3.142.
2. `query()` **throws after yielding an error result** — always try/catch around the `for await` loop; you'll still have `session_id` and cost from the yielded result.
3. In streaming mode, an exception inside your input generator surfaces as `"Claude Code process aborted by user"` — check your generator first.
4. `interrupt()`, `setPermissionMode()`, image attachments: **streaming input mode only**.
5. **Assistant content is nested**: `message.message.content` (TS wraps the API message), unlike Python.
6. **Dedup assistant usage by `message.message.id`** — parallel tool calls duplicate usage.
7. `total_cost_usd` is a client-side estimate; result `usage` excludes subagents (use `modelUsage`).
8. **Auto-approved tools skip `canUseTool`** — must-run checks belong in `PreToolUse` hooks. `allowedTools` does not constrain `bypassPermissions`.
9. `resume` silently starts fresh if `cwd` differs (session path is keyed on encoded cwd). Session files are per-machine unless you use a `SessionStore` or ship the JSONL.
10. Skills are filesystem-only; discovery needs `user`/`project` setting sources (or plugins); SKILL.md `allowed-tools` frontmatter is ignored by the SDK.
11. `env` in TS **replaces** the subprocess environment — spread `process.env`.
12. No wall-clock timeout — bound with `maxTurns`/`maxBudgetUsd`; stall/idle watchdogs exist as env vars.
13. The subprocess binary is an optional dependency — bundlers/asar can strip it; `pathToClaudeCodeExecutable` is the fix.
14. claude.ai login / subscription auth is contractually off-limits for shipped third-party products — API key only.
15. Tool rename `Task` → `Agent` (v2.1.63) — match both when inspecting tool_use blocks.
16. Large parallel subagent fan-out can hit API rate limits — batch.

---

## 18. Source index

| Topic | URL |
|---|---|
| Overview / product positioning / branding | https://code.claude.com/docs/en/agent-sdk/overview |
| Quickstart (install, auth) | https://code.claude.com/docs/en/agent-sdk/quickstart |
| TypeScript API reference (query, Options, Query, types) | https://code.claude.com/docs/en/agent-sdk/typescript |
| Streaming input vs single mode | https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode |
| Sessions (resume/fork/continue) | https://code.claude.com/docs/en/agent-sdk/sessions |
| Session storage adapters | https://code.claude.com/docs/en/agent-sdk/session-storage |
| Custom tools (tool / createSdkMcpServer) | https://code.claude.com/docs/en/agent-sdk/custom-tools |
| MCP servers | https://code.claude.com/docs/en/agent-sdk/mcp |
| Permissions | https://code.claude.com/docs/en/agent-sdk/permissions |
| Approvals & AskUserQuestion (canUseTool) | https://code.claude.com/docs/en/agent-sdk/user-input |
| Hooks | https://code.claude.com/docs/en/agent-sdk/hooks |
| Skills | https://code.claude.com/docs/en/agent-sdk/skills |
| Subagents | https://code.claude.com/docs/en/agent-sdk/subagents |
| Cost tracking | https://code.claude.com/docs/en/agent-sdk/cost-tracking |
| Hosting / subprocess model / isolation | https://code.claude.com/docs/en/agent-sdk/hosting |
| Secure deployment | https://code.claude.com/docs/en/agent-sdk/secure-deployment |
| Plugins | https://code.claude.com/docs/en/agent-sdk/plugins |
| File checkpointing | https://code.claude.com/docs/en/agent-sdk/file-checkpointing |
| TS SDK changelog / issues | https://github.com/anthropics/claude-agent-sdk-typescript |
| Demo agents | https://github.com/anthropics/claude-agent-sdk-demos |
