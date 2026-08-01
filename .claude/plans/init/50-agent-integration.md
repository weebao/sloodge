# 50 — Agent Integration (Claude Agent SDK)

How Sloodge's chat box becomes a slide-editing agent. Everything here runs in the **Electron main process**; the renderer never sees an API key, never spawns a process, and never talks to `api.anthropic.com`.

Source of truth for SDK behavior: [research/claude-agent-sdk.md](research/claude-agent-sdk.md). Source of truth for skill authoring: [research/agent-skills-best-practices.md](research/agent-skills-best-practices.md). The three frozen skills live in [experiments/init/skills/](../../../experiments/init/skills/).

---

## 1. Placement & module layout

The SDK is Claude Code packaged as a library: `query()` spawns a native `claude` binary as a child process and speaks JSONL over stdio. That subprocess model dictates the whole design.

```
src/main/
  agent/
    session.ts        # one AgentSession per open deck; owns the query() generator
    bridge.ts         # chat-box IPC -> AsyncIterable<SDKUserMessage>
    tools.ts          # createSdkMcpServer({ name: "slides", ... })
    skills.ts         # materialize bundled skills into the deck workspace
    hooks.ts          # PreToolUse hard invariants
    budget.ts         # cost accumulation + maxBudgetUsd policy
    binary.ts         # resolve pathToClaudeCodeExecutable (asar-aware)
    auth.ts           # safeStorage-backed API key vault
  ipc/agent.ts        # ipcMain handlers: send, interrupt, setModel, getUsage
```

One `AgentSession` per open deck window. `AgentSession` owns exactly one live `query()` — i.e. exactly one CLI subprocess. Plan ~1 GiB RSS per active session (documented number); Sloodge is single-deck-focused in v1, so one session is the norm and two or three is the ceiling.

---

## 2. Bootstrapping the session

Streaming-input mode is the only shape that fits a chat box: it supports `interrupt()` (the Stop button), `setModel()` (the model picker), image attachments ("make a slide like this screenshot"), and keeps context across turns without respawning the subprocess.

```ts
// src/main/agent/bridge.ts
import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

export function createChatBridge() {
  const queue: SDKUserMessage[] = [];
  let wake: (() => void) | null = null;
  let closed = false;
  return {
    send(text: string, images?: { media_type: string; data: string }[]) {
      const content = images?.length
        ? [
            { type: "text" as const, text },
            ...images.map((img) => ({
              type: "image" as const,
              source: { type: "base64" as const, ...img },
            })),
          ]
        : text;
      queue.push({ type: "user", message: { role: "user", content }, parent_tool_use_id: null });
      wake?.();
    },
    close() { closed = true; wake?.(); },
    async *stream(): AsyncGenerator<SDKUserMessage> {
      while (!closed) {
        while (queue.length) yield queue.shift()!;
        await new Promise<void>((r) => (wake = r));
      }
    },
  };
}
```

**Gotcha:** if the input generator throws, the SDK surfaces the misleading error `"Claude Code process aborted by user"`. The generator above cannot throw — keep it that way; do all validation in `send()` before enqueuing.

```ts
// src/main/agent/session.ts (abridged)
import { query, type Options } from "@anthropic-ai/claude-agent-sdk";
import { app } from "electron";
import path from "node:path";

const options: Options = {
  // --- runtime / packaging ---
  pathToClaudeCodeExecutable: resolveClaudeBinary(),   // §3
  cwd: deckWorkspaceDir,                               // per-deck, app-controlled

  // --- isolation (§5) ---
  settingSources: ["project"],                         // skills only; NOT user/local
  strictMcpConfig: true,                               // ignore any .mcp.json
  env: {
    ...process.env,                                    // TS `env` REPLACES — always spread
    ANTHROPIC_API_KEY: apiKey,                         // from safeStorage (§4)
    CLAUDE_CONFIG_DIR: path.join(app.getPath("userData"), "claude"),
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
  },

  // --- tools & permissions (§7) ---
  tools: ["Read", "Skill"],                            // no Bash/Write/Edit/WebFetch
  mcpServers: { slides: slidesServer },                // §6
  allowedTools: ["mcp__slides__*", "Skill", "Read"],
  disallowedTools: ["Bash", "Write", "Edit", "WebSearch", "WebFetch", "Agent", "Task"],
  permissionMode: "default",
  canUseTool,                                          // handles AskUserQuestion only
  hooks: { PreToolUse: [{ matcher: "*", hooks: [workspaceJail] }] },

  // --- skills (§8) ---
  skills: ["slide-deck", "svg-animation", "interactive-graph"],

  // --- prompting ---
  systemPrompt: {
    type: "preset",
    preset: "claude_code",
    append: SLOODGE_SYSTEM_APPEND,
    excludeDynamicSections: true,                      // better prompt-cache reuse
  },

  // --- model & budget (§10, §11) ---
  model: deck.settings.model ?? "claude-opus-5",
  effort: "high",
  maxTurns: 40,
  maxBudgetUsd: deck.settings.budgetUsd ?? 2.0,
  abortController,

  // --- streaming & sessions ---
  includePartialMessages: true,                        // token-level chat streaming
  resume: deck.agentSessionId,                         // §12
  persistSession: true,
  stderr: (d) => log.debug("[claude]", d),
};

const q = query({ prompt: bridge.stream(), options });
```

`SLOODGE_SYSTEM_APPEND` (kept short — the skills carry the craft knowledge):

> You are a presentation-design assistant embedded in Sloodge, a slide editor. A deck is an ordered list of slides; every slide is one self-contained 1280×720 HTML document. Use the `mcp__slides__*` tools to inspect and modify the deck — never guess a slide ID, call `mcp__slides__read_slide` or `mcp__slides__get_deck_theme` first. When you write or rewrite slide HTML, follow the loaded slide skills. After writing a slide, call `mcp__slides__screenshot_slide` and look at the result before telling the user you are done. Do not write files; the slide tools are the only way to persist changes.

### Pre-warming

`startup()` pre-warms the CLI subprocess. Call it on `deck:opened` (before the user's first message) so the first chat turn doesn't pay subprocess boot. It also doubles as our binary health check — a failure here means `pathToClaudeCodeExecutable` is wrong, and we surface a specific "Claude runtime missing — reinstall Sloodge" dialog rather than a mysterious first-message error.

---

## 3. Packaging: asar unpack + `pathToClaudeCodeExecutable`

The SDK ships the `claude` CLI as a **platform-specific optional npm dependency** containing a native binary. Two consequences:

1. **Binaries cannot execute from inside `app.asar`.** electron-builder config:

```jsonc
{
  "asar": true,
  "asarUnpack": [
    "**/node_modules/@anthropic-ai/claude-agent-sdk/**",
    "**/node_modules/@anthropic-ai/claude-agent-sdk-*/**"   // platform packages
  ]
}
```

2. **Only the current platform's optional dep installs.** Build per-platform (macOS on macOS, Windows on Windows, via separate CI/local jobs) — never copy a `node_modules` tree across platforms. This is already implied by [70-testing-ci.md](70-testing-ci.md)'s "no packaging in CI" stance: packaging happens locally per target.

Resolution helper:

```ts
// src/main/agent/binary.ts
import { app } from "electron";
import fs from "node:fs";
import path from "node:path";

export function resolveClaudeBinary(): string {
  const exe = process.platform === "win32" ? "claude.exe" : "claude";
  const roots = app.isPackaged
    ? [path.join(process.resourcesPath, "app.asar.unpacked", "node_modules")]
    : [path.join(app.getAppPath(), "node_modules")];
  for (const root of roots) {
    const hit = findBinary(root, exe);            // walk @anthropic-ai/claude-agent-sdk*
    if (hit && fs.existsSync(hit)) return hit;
  }
  throw new AgentRuntimeMissingError(
    "The Claude runtime binary was not found. Reinstall Sloodge."
  );
}
```

Signing/AV notes:
- **macOS:** the unpacked binary must be signed and notarized with the app. electron-builder signs unpacked binaries by default — verify with `codesign -dv --verbose=4` on the unpacked path before shipping, and confirm the hardened-runtime entitlements permit spawning a child process.
- **Windows:** keep the binary inside the installed app directory (`%LOCALAPPDATA%\Programs\Sloodge\...`). AV heuristics dislike apps spawning unsigned EXEs from user-writable temp paths; never copy the binary to `%TEMP%`.

---

## 4. Auth: subscription token or API key, both in the OS keychain

**Updated by M2.7.** Through M2.6 this section said "API key only". That is no longer the whole
story: a Pro/Max subscriber can now authenticate without ever handling an API key. What changed is
*not* that we drive a login — it is that the CLI exposes a mintable long-lived token we can store
exactly like a key.

### Verified surface (bundled CLI 2.1.220 / SDK 0.3.220, probed 2026-08-01)

Findings recorded here rather than guessed, per the M2.7 roadmap row. The SDK ships **no `bin`**; it
resolves a native `claude` binary from a per-platform sibling package
(`@anthropic-ai/claude-agent-sdk-<platform>-<arch>`, listed in the SDK's own `manifest.json`) and
spawns it. Everything below was read from that binary's own `--help` output, run against a throwaway
`CLAUDE_CONFIG_DIR`. **No login was ever completed and no real credential was read.**

| Command | Verified behaviour |
|---|---|
| `claude setup-token` | Exists. Help text: *"Set up a long-lived authentication token (requires Claude subscription)."* Prints a token the user can paste elsewhere. **This is the path we use.** |
| `claude auth login [--claudeai\|--console\|--sso\|--email]` | Exists; `--claudeai` (subscription) is the default. With no TTY it prints an OSC-8-wrapped PKCE authorize URL (`claude.com/cai/oauth/authorize?…code_challenge_method=S256`, redirect `platform.claude.com/oauth/code/callback`) and then **blocks on stdin** at `Paste code here if prompted >`. |
| `claude auth status [--json\|--text]` | Exists. **JSON is the default**: `{"loggedIn":false,"authMethod":"none","apiProvider":"firstParty"}`. `authMethod:"oauth"` once signed in. |
| `claude auth logout` | Exists. |
| Credential storage | `.credentials.json` under `CLAUDE_CONFIG_DIR` — the isolated dir genuinely receives its own `.claude.json`, so §5's redirect works for config. **Caveat below.** |
| Consumption | `CLAUDE_CODE_OAUTH_TOKEN` is a first-class credential source in the binary, alongside `apiKeyHelper` / `ANTHROPIC_AUTH_TOKEN` / `none`. The binary carries an explicit warning string about a shell-set `CLAUDE_CODE_OAUTH_TOKEN` belonging to a different account. |

### Decision: paste a minted token, do not drive a browser login

Sloodge asks the user to run `claude setup-token` in their own terminal and paste the result into
**Settings ▸ Auth**. We store it in the same `safeStorage` vault as the API key and inject it as
`CLAUDE_CODE_OAUTH_TOKEN`.

Why not the `auth login` flow, even though it is technically drivable:

- **No supported programmatic login exists.** The flow above is an interactive TUI contract, not an
  API. Scraping a URL out of its stdout and feeding a code back through stdin is a screen-scrape of
  an unversioned surface that can change in any patch release.
- **The reference implementation deliberately does not do it.** t3code — the most-scrutinised
  third-party Electron wrapper around this CLI — contains no OAuth flow at all: no authorize URL, no
  PKCE, no token exchange. It has the user authenticate out of band and consumes the result.
- **A minted token is strictly better for us than t3code's ambient-credential approach.** The secret
  lands in *our* encrypted vault rather than in machine-global state, so there is nothing to isolate,
  nothing of the user's to clobber, and no platform-specific credential-store behaviour to get right.

Known limits of a `setup-token` token, none of which affect Sloodge: it cannot establish Remote
Control sessions or fetch claude.ai connectors, and `--bare` mode ignores it.

**Distribution caveat, unresolved.** The earlier version of this section recorded that consuming
claude.ai subscription capacity from a *distributed third-party product* requires prior approval from
Anthropic. That constraint is about entitlement, not mechanism, so it applies to a pasted
subscription token as much as it would to a driven login. Nothing in M2.7 resolves it. The feature
ships because the user chose it explicitly; **confirm entitlement before distributing broadly.** The
API-key path is unaffected either way.

Branding rules are unchanged: "Powered by Claude" / "Claude Agent" is permitted; "Claude Code"
branding is not. The chat panel says **"Powered by Claude"** in the footer, nowhere else.

### Credential precedence — the trap this milestone had to close

The CLI resolves credentials in this order:

```
Bedrock/Vertex/Foundry -> ANTHROPIC_AUTH_TOKEN -> ANTHROPIC_API_KEY -> apiKeyHelper
  -> CLAUDE_CODE_OAUTH_TOKEN -> interactive subscription login
```

**`ANTHROPIC_API_KEY` outranks `CLAUDE_CODE_OAUTH_TOKEN`.** M2.1 spreads `process.env` into the
subprocess — which it must, or the child loses `PATH` and `HOME` (§16) — so a developer's ambient key,
or one left in a user's shell profile, would silently outrank a token the user deliberately pasted,
billing their console account while the UI reads "using your Claude subscription".

So `buildAuthEnv` (`src/main/agent/auth-env.ts`) **deletes** two distinct classes of variable and
then sets exactly one credential:

1. **Credential variables** — `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, the two
   `*_FILE_DESCRIPTOR` variants, and `ANTHROPIC_CUSTOM_HEADERS` (which is parsed into outbound
   request headers and is named by the CLI's own retry message as a carrier of the gateway token, so
   it can inject an `Authorization` header behind our back).
2. **Provider-selection variables** — see the next subsection.

Deleting, not merely declining to set, is the whole point; it is pinned by a test that puts an
ambient `ANTHROPIC_API_KEY` in the base environment and asserts it is absent from the result.

### Sloodge pins the firstParty provider

Credential precedence is only the *second* decision the CLI makes. Provider selection runs first, and
it is env-only:

```js
function Hn(){ if(Cy()) return "gateway";
  return Z.CLAUDE_CODE_USE_BEDROCK ? "bedrock"
       : Z.CLAUDE_CODE_USE_FOUNDRY ? "foundry"
       : Z.CLAUDE_CODE_USE_ANTHROPIC_AWS ? "anthropicAws"
       : Z.CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD ? "anthropicGoogleCloud"
       : Z.CLAUDE_CODE_USE_MANTLE ? "mantle"
       : Z.CLAUDE_CODE_USE_VERTEX ? "vertex" : "firstParty" }
function Dc(){ return Hn() === "firstParty" }   // gates the OAuth path
```

Nothing in it consults `CLAUDE_CODE_OAUTH_TOKEN`, and `Dc()` forces the OAuth path **off** under any
third-party provider — the Bedrock branch nulls `Authorization` outright and authenticates with AWS
credentials instead. So a user with `CLAUDE_CODE_USE_BEDROCK=1` in their shell profile (a standard
enterprise Claude Code setup) could paste a subscription token into Settings, see "Using your Claude
subscription", and have that token never used: their AWS account billed, or an opaque failure.

**`buildAuthEnv` therefore deletes all six switches**, pinning `firstParty`. This is a product
decision, not just a code detail: a user's ambient third-party provider config is completely
invisible from inside Sloodge — we render no UI that reveals it — so if we did not pin, the app could
silently disagree with its own Settings screen and the user would have no way to see why.

- The six names are the CLI's own exported `THIRD_PARTY_PROVIDER_ENV_VARS` map, not a guess.
- `gateway` needs no entry: its predicate is `Cy(){return Ot.gatewayAuth}` — in-memory login state,
  not an environment variable — so ambient config cannot select it.
- The per-provider `CLAUDE_CODE_SKIP_*_AUTH` flags and third-party base URLs
  (`ANTHROPIC_BEDROCK_BASE_URL`, `ANTHROPIC_VERTEX_BASE_URL`, …) are cleared on the same pass. With
  the provider pinned they are inert; leaving inert credential-adjacent state around is what invited
  this bug in the first place.
- **Deletion, not `"0"`.** The switches are zod-coerced booleans accepting only `1/true/yes/on`, so
  `"0"` would work today — but deletion does not depend on that parser staying as it is, and it
  matches the CLI's own sibling-disabling helper, which uses `void 0`.

### `ANTHROPIC_BASE_URL` is surfaced, not stripped

`ANTHROPIC_BASE_URL` is the one redirecting variable deliberately left in place. It decides *where*
the credential is sent — the CLI resolves the firstParty endpoint as
`process.env.ANTHROPIC_BASE_URL || BASE_API_URL` and attaches the bearer token with no host
allow-list — so a stale value from a LiteLLM proxy or corporate gateway would receive a long-lived
subscription token.

Stripping it is the obvious reflex and it is wrong: corporate-gateway routing is a deployment shape
this section plans for, and deleting the variable would turn a working enterprise setup into an
opaque connection failure with no way to re-enable it from our UI — trading a visible risk for an
invisible breakage.

The real defect was that the passthrough was *invisible* while the Auth tab promised, at the moment
of credential entry, that credentials "never leave this machine except as requests to Anthropic".
That sentence was false under a custom base URL. So:

- main reads the variable on every status read (never cached — the subprocess reads the live
  environment too) and reports it as a masked `EndpointInfo` (`src/shared/agent/endpoint.ts`);
- the value is reduced to an **origin**, because a base URL may legitimately carry userinfo
  (`https://user:pass@proxy/`) and echoing that into the renderer would leak a credential through the
  very channel this milestone exists to keep clean;
- the Auth tab renders a warning naming the host **above both credential inputs**, so it is read
  before anything is pasted, not after;
- the footnote now says credentials "leave this machine only as requests to the configured Anthropic
  endpoint" — true in both configurations.

### Storage

Two slots, one rule. `src/main/agent/vault.ts`:

| Slot | File under `userData` | Injected as |
|---|---|---|
| API key | `anthropic.key.enc` | `ANTHROPIC_API_KEY` |
| Subscription token | `claude.oauth.enc` | `CLAUDE_CODE_OAUTH_TOKEN` |

Separate files rather than one blob so clearing one cannot corrupt or race the other, and a decrypt
failure on one degrades to "that credential is absent" instead of losing both.

- `safeStorage` backs onto **Keychain** (macOS) and **DPAPI** (Windows); the ciphertext is bound to
  the OS user account.
- **Neither credential ever crosses IPC toward the renderer.** Settings sends a secret *in* via
  `agent:setKey` / `agent:setSubscriptionToken` and can only read back a masked `AuthStatus`
  (`{ mode, apiKey: { configured, last4 }, subscription: { configured, last4 } }`). There is
  deliberately no channel that returns a stored credential.
- The preload bridge **re-derives** `mode` from the two masked slots rather than trusting the wire, so
  a main-process bug cannot make the UI claim a subscription is active when no token is stored.
- If `safeStorage.isEncryptionAvailable()` is false (rare Linux dev case), we refuse to persist.

### macOS isolation caveat — unverified, needs a Mac

Anthropic's documentation describes the `CLAUDE_CONFIG_DIR`-relative `.credentials.json` as applying
"on Linux or Windows"; macOS is conspicuously absent, because the Keychain lookup is keyed off `HOME`
rather than the config dir. **Strong inference, not empirically verified — no Mac was available:** on
macOS `CLAUDE_CONFIG_DIR` may not isolate *credentials*, so an in-app login and the user's own
ambient login could share a Keychain entry and clobber each other.

Sloodge's chosen design sidesteps this entirely — we never write to the CLI's credential store, we
inject a token via the environment. Recorded here because it constrains any future milestone that
reconsiders driving `claude auth login`.

Related, if that ever happens: set `CLAUDE_CONFIG_DIR`, **never `HOME`**. Overriding `HOME` relocates
the macOS Keychain lookup so the spawned CLI cannot find its own OAuth credentials and reports "Not
logged in" — a bug t3code hit and fixed.

### Windows executable resolution — for whoever wires the CLI directly

Not needed by M2.7 (we spawn nothing), but load-bearing for any milestone that does: the SDK spawns
`pathToClaudeCodeExecutable` **without a shell** and without `PATH`/`PATHEXT` resolution, so a bare
`claude` fails, and an npm `claude.cmd` shim fails with `spawn EINVAL` on Node >= 20.12. Resolve
through to the real `claude.exe`. A packaged Electron app is *more* likely to hit this than a dev CLI.
`package.json` already `asarUnpack`s the platform packages; a resolved path still needs the
`app.asar` -> `app.asar.unpacked` rewrite, since nothing can be spawned from inside an archive.

### Failure UX

| Condition | UI |
|---|---|
| Nothing configured | Composer disabled with an inline **"Set up authentication"** card linking to Settings ▸ Auth |
| 401 from API | Typed `auth` error in the transcript pointing at Settings; the credential is marked invalid, not deleted |
| Offline / DNS failure | Chat message bubble: "Can't reach Claude. Slides and Design Mode still work offline." |
| No OS encryption backend | The vault's own error surfaces verbatim in the Auth tab; nothing is persisted |

Future (not v1): `ANTHROPIC_BASE_URL` proxy mode so a team can route through their own server and no
credential lives on the client.

---

## 5. Isolation: `settingSources`, `CLAUDE_CONFIG_DIR`, cwd

Sloodge runs on arbitrary user machines, some of which have Claude Code installed with their own `~/.claude/settings.json`, personal skills, agents, hooks, and CLAUDE.md. **None of that may leak into Sloodge's agent** — it would produce nondeterministic behavior we cannot support and, worse, could grant tools we deliberately denied.

| Lever | Value | Why |
|---|---|---|
| `settingSources` | `["project"]` | Loads only `<cwd>/.claude/…` — our own, app-written workspace. `user` and `local` stay off, so `~/.claude` is invisible. |
| `cwd` | `<userData>/decks/<deckId>/workspace` | App-controlled dir we create and own. Also the session-transcript key (§12). |
| `CLAUDE_CONFIG_DIR` | `<userData>/claude` | Config + `projects/*.jsonl` transcripts live in Sloodge's data dir, not `~/.claude`. Avoids colliding with a user's real Claude Code install and its credentials. |
| `CLAUDE_CODE_DISABLE_AUTO_MEMORY` | `"1"` | Auto-memory loads *regardless* of `settingSources` — this is the only way off. |
| `strictMcpConfig` | `true` | Ignore any `.mcp.json` discovered on disk; only `options.mcpServers` counts. |

**Sharp edge with `settingSources: ["project"]`:** project discovery walks `<cwd>/.claude/` **and parent directories up to the repo root**, plus project CLAUDE.md. Mitigations:

1. The workspace dir is under `app.getPath("userData")` — never inside a user's git repo.
2. It is **not** a git repo, and we do not create one, so there is no "repo root" to walk toward beyond `userData`.
3. We write `<workspace>/.claude/settings.json` ourselves with an empty/locked-down object, so even the project layer is fully known.
4. Startup assertion: the `system:init` message reports the loaded `skills` array and tool list — we compare it against the expected set and log loudly (dev) / fall back to system-prompt injection (prod, §8) on mismatch.

Workspace layout:

```
<userData>/decks/<deckId>/workspace/
  .claude/
    settings.json            # written by us; empty permissions object
    skills/
      slide-deck/SKILL.md
      svg-animation/SKILL.md
      interactive-graph/SKILL.md
  slides/                    # read-only mirror of slide HTML for the Read tool
    01.html … NN.html
```

The `slides/` mirror exists so `Read` (the one built-in file tool we keep) can be used for large-slide inspection without stuffing full HTML through a tool result. It is written by the main process on every deck mutation and is **never** the source of truth — the `.sloodge` document ([30-slide-format.md](30-slide-format.md)) is.

---

## 6. In-process MCP tools — `mcp__slides__*`

Custom tools run as an **in-process MCP server inside the Electron main process** — no extra subprocess, no socket, no network. Handlers mutate the live deck store and push updates to the renderer in the same tick, which is what makes thumbnails update mid-turn (§9).

Tools surface to Claude as `mcp__{serverKey}__{toolName}`; the key in `mcpServers` is the server segment, so `{ slides: slidesServer }` yields `mcp__slides__create_slide`.

```ts
// src/main/agent/tools.ts
import { tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

const SlideHtml = z
  .string()
  .describe(
    "A complete, self-contained HTML document for one slide. Root element must be " +
      "<div class=\"slide\"> at exactly 1280x720 with overflow:hidden. No external " +
      "resources: no CDN scripts, no web fonts, no remote images — inline everything."
  );

const create_slide = tool(
  "create_slide",
  "Create a new slide and insert it into the deck. Use when the user asks to add, insert, or generate a slide.",
  {
    html: SlideHtml,
    title: z.string().describe("Short human-readable slide title for the thumbnail rail"),
    position: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe("1-based insert position; appends to the end if omitted"),
    notes: z.string().optional().describe("Speaker notes, plain text"),
  },
  async (args) => {
    const slide = await deck.createSlide(args);
    return {
      content: [{ type: "text", text: `Created slide ${slide.index}: "${slide.title}"` }],
      structuredContent: { slideId: slide.id, index: slide.index },
    };
  },
  { annotations: { readOnlyHint: false }, alwaysLoad: true }
);

const update_slide = tool(
  "update_slide",
  "Replace the HTML and/or metadata of an existing slide. Use for any edit to an existing slide. Call read_slide first if you do not already have the current HTML.",
  {
    slideId: z.string().describe("Slide ID from read_slide / get_deck_theme / create_slide"),
    html: SlideHtml.optional().describe("Full replacement HTML. Omit to change metadata only."),
    title: z.string().optional(),
    notes: z.string().optional(),
  },
  async (args) => {
    const slide = await deck.updateSlide(args);   // pushes an undo entry
    return {
      content: [{ type: "text", text: `Updated slide ${slide.index}.` }],
      structuredContent: { slideId: slide.id, index: slide.index, revision: slide.revision },
    };
  },
  { annotations: { readOnlyHint: false }, alwaysLoad: true }
);

const read_slide = tool(
  "read_slide",
  "Return one slide's full HTML, title, notes and index. Use before editing a slide, and to inspect what is already on a slide.",
  {
    slideId: z.string().optional().describe("Slide ID. Provide this or index."),
    index: z.number().int().min(1).optional().describe("1-based slide index."),
  },
  async ({ slideId, index }) => {
    const s = deck.resolve({ slideId, index });
    if (!s) return { content: [{ type: "text", text: "No such slide." }], isError: true };
    return {
      content: [{ type: "text", text: s.html }],
      structuredContent: { slideId: s.id, index: s.index, title: s.title, notes: s.notes },
    };
  },
  { annotations: { readOnlyHint: true }, alwaysLoad: true }
);

const reorder = tool(
  "reorder",
  "Move a slide to a new position in the deck. Use when the user asks to move, reorder, or resequence slides.",
  {
    slideId: z.string(),
    toPosition: z.number().int().min(1).describe("1-based target position"),
  },
  async (a) => {
    const order = await deck.reorder(a);
    return {
      content: [{ type: "text", text: `Moved to position ${a.toPosition}.` }],
      structuredContent: { order },
    };
  },
  { annotations: { readOnlyHint: false } }
);

const delete_slide = tool(
  "delete",
  "Delete a slide from the deck. Only call when the user has clearly asked to remove a slide.",
  { slideId: z.string() },
  async ({ slideId }) => {
    const removed = await deck.deleteSlide(slideId);   // undoable
    return {
      content: [{ type: "text", text: `Deleted slide ${removed.index}: "${removed.title}".` }],
      structuredContent: { slideId, remaining: deck.count() },
    };
  },
  { annotations: { readOnlyHint: false, destructiveHint: true } }
);

const get_deck_theme = tool(
  "get_deck_theme",
  "Return the deck's theme (palette, fonts, type scale, aspect) plus the slide list (id, index, title). Call this first when creating or restyling slides so new slides match the deck.",
  {},
  async () => ({
    content: [{ type: "text", text: JSON.stringify(deck.themeAndIndex(), null, 2) }],
    structuredContent: deck.themeAndIndex(),
  }),
  { annotations: { readOnlyHint: true }, alwaysLoad: true }
);

const screenshot_slide = tool(
  "screenshot_slide",
  "Render a slide and return a PNG image of it. Use to visually verify a slide you just created or edited before reporting done, and to inspect a slide the user is describing visually.",
  {
    slideId: z.string(),
    atMs: z
      .number()
      .int()
      .min(0)
      .max(10000)
      .optional()
      .describe("For animated slides, capture this many ms after load. Default 0."),
  },
  async ({ slideId, atMs = 0 }) => {
    const png = await renderer.captureSlide(slideId, atMs);   // offscreen BrowserWindow
    return {
      content: [{ type: "image", data: png.toString("base64"), mimeType: "image/png" }],
    };
  },
  { annotations: { readOnlyHint: true } }
);

export const slidesServer = createSdkMcpServer({
  name: "slides",
  version: "1.0.0",
  tools: [
    create_slide, update_slide, read_slide, reorder,
    delete_slide, get_deck_theme, screenshot_slide,
  ],
});
```

Mechanics worth pinning down:

- **`alwaysLoad: true`** on the five tools that drive every turn. Tool search is on by default and defers MCP schemas until Claude asks for them; for a seven-tool server that deferral costs a round trip and buys nothing. `reorder`, `delete`, and `screenshot_slide` stay deferred (rarer, and `delete` benefits from not being top-of-mind).
- **`readOnlyHint: true`** on `read_slide`, `get_deck_theme`, `screenshot_slide` lets the harness batch them in parallel — a "look at slides 2–5" turn resolves in one round.
- **Return shape.** `{ content, structuredContent?, isError? }`. When `structuredContent` is set, Claude receives the JSON plus any image/resource blocks; **text blocks are dropped as presumed duplicates**. So `screenshot_slide` deliberately returns *no* `structuredContent` — otherwise the image would survive but the text wouldn't, and we'd be relying on undefined-feeling behavior. Conversely `read_slide` returns HTML as `content` text *and* metadata as `structuredContent`; the HTML is dropped from Claude's view in favor of the JSON, so metadata JSON also carries an `html` field. (Simplest rule for implementers: **if you set `structuredContent`, put everything Claude needs in it.**)
- **Errors.** Catch and return `{ isError: true }` with an actionable message ("No slide at index 9; the deck has 5 slides") rather than throwing. An uncaught throw is converted to an error result anyway and the loop continues, but a hand-written message steers Claude to a correct retry.
- **Undo integration.** Every mutating handler pushes onto the same undo stack the UI uses ([10-architecture.md](10-architecture.md)), tagged `source: "agent"`, so Ctrl+Z reverses an agent edit exactly like a manual one. We do **not** use the SDK's `enableFileCheckpointing`/`rewindFiles()` — our document model already has transactional undo and the SDK's file checkpointing operates on the agent's filesystem, which is not our source of truth.

---

## 7. Permission model

Evaluation order per tool call: **hooks → deny rules → ask rules → permission mode → allow rules → `canUseTool`**. Two consequences drive the design: hooks run *before everything and apply even in bypass mode*, and **auto-approved tools never reach `canUseTool`**. So hard invariants go in hooks; UI prompts go in `canUseTool`.

### Tool surface

```ts
tools: ["Read", "Skill"],
allowedTools: ["mcp__slides__*", "Skill", "Read"],
disallowedTools: ["Bash", "Write", "Edit", "WebSearch", "WebFetch", "Agent", "Task"],
permissionMode: "default",
```

- `tools` restricts which built-ins exist *at all*. We keep `Read` (workspace slide mirror + user-attached files) and `Skill` (required — when you pass `skills`, the SDK auto-adds `Skill` to `allowedTools`, but with an explicit `tools` array you must list it yourself).
- `Bash`, `Write`, `Edit` are **off in v1.** The slide tools are a complete mutation surface; a shell would be pure blast radius. This also sidesteps the macOS-GUI-minimal-`PATH` problem entirely.
- `WebSearch`/`WebFetch` off in v1 — "research this topic then make slides" is a v2 feature that needs its own consent UX. Listed in `disallowedTools` (bare name = removed from context) as belt-and-braces alongside their absence from `tools`.
- `Agent`/`Task` denied — see §14.
- `permissionMode: "default"` (not `dontAsk`): unmatched calls reach `canUseTool`, which is where `AskUserQuestion` must land. `dontAsk` would deny it silently.

### `canUseTool` — clarifying questions only

Everything Sloodge permits is on the allow list, so in practice `canUseTool` fires for exactly one thing: `AskUserQuestion`, Claude's structured clarifying-question tool (1–4 questions, 2–4 options each, optional `multiSelect`, optional HTML/markdown `preview`). It always reaches `canUseTool` even when auto-approved elsewhere. We render it as a native question card in the chat panel — "Which theme: Minimal / Bold / Corporate?" with clickable options — which is a far better first-run experience than Claude guessing.

```ts
const canUseTool: CanUseTool = async (toolName, input, { signal }) => {
  if (toolName === "AskUserQuestion") {
    const answers = await ipcAskRenderer(input, signal);   // may stay pending indefinitely
    return { behavior: "allow", updatedInput: { ...input, answers } };
  }
  return { behavior: "deny", message: `${toolName} is not available in Sloodge.` };
};
```

The deny `message` is read by Claude and steers it ("that tool isn't available — use the slide tools instead"), which is why we write a sentence rather than returning bare `false`.

### `PreToolUse` hook — the hard invariant

Hooks run before every other permission step and **cannot be skipped by allow rules**, which makes them the only correct place for a must-run check. Ours confines `Read` to the workspace:

```ts
const workspaceJail: HookCallback = async (input) => {
  const pre = input as PreToolUseHookInput;
  const p = (pre.tool_input as any)?.file_path;
  if (!p) return {};
  const resolved = path.resolve(p);
  if (!resolved.startsWith(workspaceDir + path.sep)) {
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason:
          "Sloodge's agent can only read files inside the deck workspace.",
      },
    };
  }
  return {};
};
```

Set `includeHookEvents: true` in dev builds so hook lifecycle messages appear in the debug log.

---

## 8. Loading the three skills

Skills are **filesystem-only** — there is no programmatic registration API. Each is a directory with a `SKILL.md` (YAML frontmatter `name` + `description`, then markdown). Claude reads the ~100-token description at startup and loads the body on demand.

### Decision: bundled skill dir + `settingSources: ["project"]`

**Chosen.** At app start (and on deck open, if the workspace is new or the app version changed), copy `resources/skills/**` from the app bundle into `<workspace>/.claude/skills/`, then run with `settingSources: ["project"]` and `skills: ["slide-deck","svg-animation","interactive-graph"]`.

Rejected alternatives:

| Option | Verdict |
|---|---|
| **System-prompt injection** (concatenate all three SKILL.md bodies into `systemPrompt.append`) | Rejected as primary. The three bodies total ~99 lines / roughly 3–4k tokens, and they'd be resident on *every* turn including "make the title bigger". Progressive disclosure is the whole point of the skill mechanism: ~100 tokens per skill until relevant. It also loses the ability to attach reference files or scripts later without a token cliff. **Kept as a fallback** — see below. |
| **Plugins** (`plugins` option, loads skills from an arbitrary path, works with `settingSources: []`) | Rejected for v1. It is the documented escape hatch when settings sources must be fully off, and it avoids the parent-directory-walk caveat entirely — but it adds a plugin manifest layer we don't otherwise need, and our workspace is already under `userData` where the walk is harmless. **Revisit if the project-discovery walk ever bites us.** |
| **`settingSources: []`** | Not viable on its own: it also disables filesystem skill discovery. |

Why `["project"]` is safe here despite loading a settings layer: the cwd is a directory Sloodge creates under `userData`, is not a git repo, and gets a Sloodge-written `.claude/settings.json`. `user` and `local` remain off, so the end user's own config cannot alter agent behavior. See §5.

### Verification + fallback

The first `system:init` message carries the loaded `skills` array. `AgentSession` asserts all three are present:

- **Present** → normal operation.
- **Missing** → log the discrepancy, and transparently restart the query with `skills: []` and the three SKILL.md bodies appended to `systemPrompt.append` instead. Degraded on token cost, identical on output quality. A one-line status appears in the bottom bar (`skills: fallback`) so support can spot it.

This makes system-prompt injection the *fallback*, not the design — we get progressive disclosure when the filesystem cooperates and correctness when it doesn't.

**Shipped in M2.4 vs deferred.** M2.4 built the bundling, the materialization into `<workspace>/.claude/skills`, the `skills: [...]` context filter, and the *detection* half of this section: `system:init`'s `skills` array is read into `AgentSession.skillStatus`, every session start logs what loaded, and a missing skill raises a `skills-degraded` event that the chat panel renders as a visible notice ("Slide skills unavailable (…) — slides may not follow Sloodge's design rules").

Two pieces of this section are **not shipped**, and both are deferred to **[M2.5](80-roadmap.md)** — whose row names them explicitly, so the deferral is written into the receiving milestone and not only here:

| Deferred piece | Why M2.5 |
|---|---|
| The bottom-bar `skills: fallback` indicator | M2.5 *is* the status-bar milestone (cost meter + budget guard). The status bar does not exist before it, so no earlier milestone can host the indicator. |
| The automatic fallback restart — re-running the query with `skills: []` and the three SKILL.md bodies appended to `systemPrompt.append` | It is `AgentSession` behaviour rather than status-bar work, but it is the other half of the same degradation story and is invisible without the indicator: a session that silently restarts itself with a different prompt shape, and says so nowhere, is worse than the loud non-healing state we ship today. Shipping the pair together in M2.5 keeps the restart observable from the moment it exists. |

Until M2.5, a degraded session is **loud but not self-healing**: the user is told in the chat panel, the main process logs it, and the agent still answers without the craft knowledge. Do not read the paragraphs above as describing shipped behaviour for the restart or the status line.

### Caveats carried from the research

- SKILL.md `allowed-tools` frontmatter is **CLI-only** and does nothing under the SDK. Tool restriction lives entirely in `allowedTools`/`disallowedTools` (§7). The three frozen skills don't use it, but don't add it.
- The `skills` option is a *context filter*, not a sandbox.
- This is the **Agent SDK** skills surface, not the Messages API `container.skills` feature — different product, don't cross the streams.
- The skills are frozen at the versions validated to 100% adversarial confidence in [90-experiments.md](90-experiments.md). Any edit re-runs the eval harness before shipping.

---

## 9. Streaming UX: tool calls → live thumbnails

Every `SDKMessage` is forwarded to the renderer over `webContents.send("agent:message", msg)`; the renderer's Zustand store reduces it into chat state. With `includePartialMessages: true` we also get `stream_event` messages carrying raw `content_block_delta`s, so assistant text types out token by token.

Message → UI mapping:

| SDK message | Chat panel | Elsewhere |
|---|---|---|
| `system` / `init` | — | Store `session_id`; assert skills; enable input |
| `stream_event` (text delta) | Append to the streaming assistant bubble | — |
| `assistant` w/ `thinking` block | Collapsed "Thinking…" disclosure | — |
| `assistant` w/ `tool_use` block | Inline chip: **⚙ Creating slide 3…** | Thumbnail rail shows a pending placeholder |
| `user` (tool result echo) | Chip resolves to ✓ or ✗ + one-line result | — |
| `deck:updated` (our own IPC, from the tool handler) | — | **Thumbnail rerenders now**, canvas follows if that slide is selected |
| `result` | Turn ends; cost/usage folded into bottom bar | Persist `session_id` |

**The thumbnail updates before the turn ends.** That falls out of the in-process MCP design: `update_slide`'s handler mutates the deck store and emits `deck:updated` synchronously, long before Claude has finished narrating. The user watches slides appear as they're written — the single most important perceived-quality property of the whole feature.

Human-readable labels for tool chips are derived in the main process (`mcp__slides__update_slide` + `{ slideId }` → "Editing slide 3"), never shown raw. Chips are one line, collapsed by default, expandable to show arguments in dev builds.

**Stop button** → `q.interrupt()` (streaming-input mode only). Also wire `abortController.abort()` on window close and `app.before-quit`, and always call `q.close()` — an orphaned CLI subprocess outliving the app is the worst failure mode here.

---

## 10. Cost tracking & budget guard

Displayed in the bottom status bar alongside deck info and the Present button ([20-ui-wireframes.md](20-ui-wireframes.md)):

```
 Deck: Q3 Review · 7 slides            claude-opus-5 ▾   $0.34 / $2.00 ▓▓▓░░░░░   [ Present ▶ ]
```

Rules, straight from the cost-tracking research:

- **`total_cost_usd` on the `result` message** is a client-side estimate from a bundled price table — **not billing truth.** We label the bottom bar "≈" and the settings copy says "estimated". Never bill or hard-account off it.
- **Deduplicate assistant usage by `message.message.id`.** Parallel tool calls emit multiple assistant messages sharing one id with identical usage; naive summing double-counts.
- **There is no session-level total.** Accumulate `total_cost_usd` per `query()` yourself and persist per deck.
- **Error results also carry cost** — a `result` message is emitted on failure too, so the accumulator must not be gated on `subtype === "success"`.
- **`modelUsage`** gives per-model breakdown including subagents; plain `usage` excludes subagents. We display `modelUsage` when the model picker has been used mid-session.

```ts
const seenAssistantIds = new Set<string>();
for await (const m of q) {
  if (m.type === "assistant" && !seenAssistantIds.has(m.message.id)) {
    seenAssistantIds.add(m.message.id);
    live.inputTokens += m.message.usage.input_tokens;
    live.outputTokens += m.message.usage.output_tokens;
    live.cacheRead += m.message.usage.cache_read_input_tokens ?? 0;
  }
  if (m.type === "result") {
    deck.spendUsd += m.total_cost_usd ?? 0;
    persistDeckUsage(deck);
  }
  win.webContents.send("agent:message", m);
}
```

### Budget guard

`maxBudgetUsd` stops a query when the client-side estimate hits a ceiling; the run ends with `result.subtype === "error_max_budget_usd"`.

- **Per-turn ceiling:** `maxBudgetUsd = remaining deck budget`, recomputed each turn.
- **Per-deck budget:** default **$2.00**, editable in Settings, persisted in the `.sloodge` file's settings block.
- At 80% the bar turns amber; on `error_max_budget_usd` the chat shows *"Budget reached for this deck ($2.00). Raise the limit in Settings to continue."* with a one-click "+$2" action that bumps the budget and re-sends the last user message.
- `maxTurns: 40` is the companion guard — **there is no built-in wall-clock timeout**; `maxTurns` + `maxBudgetUsd` + the Stop button are the three brakes.
- **Prompt caching is automatic**, no config. We surface `cache_read_input_tokens` in the dev-only usage panel because it's the main lever on cost for long deck sessions. If sessions turn out to be spaced further apart than 5 minutes in real use, set `ENABLE_PROMPT_CACHING_1H=1` via `options.env` for a 1-hour TTL.

---

## 11. Model picker

A dropdown in the bottom bar, persisted per deck.

| Label | ID | When |
|---|---|---|
| **Best (default)** | `claude-opus-5` | Default. Best design judgment and SVG/interactive output. |
| Balanced | `claude-sonnet-5` | Long editing sessions, cost-sensitive users. |
| Fast | `claude-haiku-4-5` | Trivial edits ("make the title bigger"), lowest latency. |

- Set initially via `options.model`; changed mid-session via `q.setModel(id)` (**streaming-input mode only** — another reason we're not in single-message mode). `setModel(undefined)` resets to default.
- `q.supportedModels()` is called once at session start; any ID the runtime doesn't report is hidden from the dropdown rather than offered and failing.
- Switching models mid-conversation invalidates the prompt cache (caches are model-scoped) — the picker's tooltip says "switching models restarts caching; the next message costs a bit more."
- **Effort** is not user-exposed in v1. We run `effort: "high"` for Opus/Sonnet. If we later expose it, it belongs next to the model picker, not in a settings page.

---

## 12. Session persistence & resume

Transcripts are JSONL under `$CLAUDE_CONFIG_DIR/projects/<encoded-cwd>/<session-id>.jsonl`, where `<encoded-cwd>` is the absolute cwd with non-alphanumerics replaced by `-`.

- **`session_id`** is captured from the `system:init` message (and confirmed on `result`, which always carries it) and stored in the `.sloodge` document's sidecar settings — one conversation per deck.
- **Reopening a deck** passes `resume: deck.agentSessionId`. **Resume requires the identical `cwd`** — a mismatched cwd silently starts a *fresh* session with no error. Therefore the deck workspace path is derived deterministically from the deck's stable UUID (`<userData>/decks/<deckId>/workspace`) and is **never** derived from the `.sloodge` file's location on disk, which the user can move at will.
- **Moving/renaming the `.sloodge` file** does not change `deckId`, so history survives. **Copying a deck** (Save As) mints a new `deckId` and therefore starts a fresh conversation — which is the correct semantic, and the chat panel says so once.
- `continue: true` is not used — it picks "most recent session in the cwd", which is ambiguous the moment a user has two decks.
- **Long sessions leak memory** (documented: RSS grows with session length, ~1 GiB baseline). After 150 turns or 6 hours, `AgentSession` transparently recycles: `q.close()`, then reopen with `resume: sessionId`. Context is preserved; RSS is not.
- **"New conversation"** menu item: clear `deck.agentSessionId` and start fresh. The old JSONL stays on disk (a future "conversation history" picker can be built directly on `listSessions()`/`getSessionInfo()`/`getSessionMessages()`).
- `forkSession: true` + `resume` is noted for a future "try a different visual direction" branch feature. Not v1. Note that forking branches the *conversation*, not the deck — the deck is versioned by our own undo stack.
- `sessionStore` (S3/Redis/Postgres mirrors) is irrelevant to a local app. `persistSession: true` (the default) is what we want; local disk is authoritative.

---

## 13. Error handling & retry

| Failure | Detection | Response |
|---|---|---|
| **`query()` throws after yielding an error result** | try/catch around the `for await` | The `result` message (with `session_id` and cost) was **already yielded** — fold in its cost, then show the error. Never lose the session ID here. |
| `error_max_turns` | `result.subtype` | "This got complicated — I stopped after 40 steps." + Continue button (re-sends "continue"). |
| `error_max_budget_usd` | `result.subtype` | Budget UI, §10. |
| Network / DNS | thrown error, no `result` | "Can't reach Claude." Retry button. Deck editing continues offline. |
| 401 / 403 | stderr + thrown error | Settings deep link; key flagged invalid. |
| 429 / overloaded | SDK retries internally (`CLAUDE_CODE_MAX_RETRIES`, default 10, cap 15) | Show "Claude is busy, retrying…" after the first 10s with no output; only surface an error if the SDK gives up. |
| Binary missing | `startup()` fails | Modal: "The Claude runtime is missing. Reinstall Sloodge." Chat disabled, editor fully usable. |
| Stalled turn | `CLAUDE_STREAM_IDLE_TIMEOUT_MS` (default 300000) | Watchdog surfaces "No response for 5 minutes" with a Stop button. |
| Tool handler throws | caught in the handler | Return `isError: true` with an actionable message; the loop continues and Claude usually self-corrects. |
| Input-generator exception | error text `"Claude Code process aborted by user"` | **Check the bridge first** — that message is the SDK's misleading surface for a generator throw, not a real user abort. Distinguish by whether we actually called `interrupt()`. |
| Renderer crash mid-turn | `render-process-gone` | `abortController.abort()` + `q.close()`; no orphan subprocess. |

Retry policy: **no automatic re-prompting.** Every retry is a user click. An agent that silently re-runs a failed slide generation burns budget the user didn't authorize and can duplicate slides. Timeouts are tuned via `options.env` (`API_TIMEOUT_MS`, `CLAUDE_CODE_MAX_RETRIES`, `CLAUDE_STREAM_IDLE_TIMEOUT_MS`) rather than hand-rolled.

---

## 14. Subagents: none in v1

The SDK supports subagents via the programmatic `agents` option and the `Agent` tool (renamed from `Task` in v2.1.63 — match both names when detecting). **We ship none, and `Agent`/`Task` are in `disallowedTools`.** The justification:

1. **No fan-out to exploit.** The plausible v1 subagents are a *researcher* (needs `WebSearch`/`WebFetch`, both off in v1) and a *deck critic* (would read a deck we can hand to the main agent for a fraction of the cost). Neither has a workload the parent can't do in-line.
2. **Context isolation works against us.** Subagents start fresh; only the Agent-tool prompt string goes down and only the final message comes back. The main loop's accumulated knowledge of *this deck's* theme and voice — the thing that makes slides look coherent — would not transfer, so the subagent would produce off-key slides.
3. **Cost and accounting get muddier.** Subagents run **in the background by default** since v2.1.198 and inherit the parent's permission mode (bypass/acceptEdits/auto can't be overridden per-subagent). Whole-tree accounting requires `modelUsage` rather than `usage`, and `total_cost_usd` silently absorbs the subtree — worse UX for a per-deck budget the user is watching tick.
4. **Streaming UX degrades.** Messages from inside a subagent carry `parent_tool_use_id`; surfacing them as one flat chat log is confusing, and building a nested view is scope we don't need. Progress would rely on `task_progress` + `agentProgressSummaries`.
5. **Windows has a real footgun.** Long subagent prompts can exceed the 8191-character command-line limit — an obscure, platform-specific failure for zero v1 benefit.

**When we'd revisit:** if v2 adds web research ("build me a deck on X"), a `deck-researcher` on `haiku` with `tools: ["WebSearch","WebFetch"]` becomes genuinely worth the isolation — that's exactly the fan-out case subagents are for. A `deck-critic` on `model: "inherit"` with `tools: ["mcp__slides__get_deck_theme","mcp__slides__read_slide"]` is the second candidate. Both would need the nested chat UI first.

---

## 15. Sequence diagram — one round-trip editing slide 3

User types *"make slide 3's chart interactive with hover tooltips"* and presses Enter.

```
 Renderer (chat panel)        Main process                    claude subprocess          Anthropic API
        │                          │                                 │                        │
   [Enter]                         │                                 │                        │
        │  ipcRenderer.invoke      │                                 │                        │
        │  "agent:send" {text}     │                                 │                        │
        ├─────────────────────────►│                                 │                        │
        │                          │ bridge.send(text)               │                        │
        │                          │  → queue → generator yields     │                        │
        │                          ├────────────────────────────────►│                        │
        │                          │        SDKUserMessage (stdio)   │                        │
        │                          │                                 ├───────────────────────►│
        │                          │                                 │   messages.create      │
        │                          │                                 │   (skills metadata,    │
        │                          │                                 │    mcp__slides__* )    │
        │                          │                                 │◄───────────────────────┤
        │  "agent:message"         │◄────────────────────────────────┤  stream_event deltas   │
        │◄─────────────────────────┤   stream_event / assistant      │                        │
   ┌────┴────┐                     │                                 │                        │
   │ "Let me │  (types out)        │                                 │                        │
   │  look…" │                     │                                 │                        │
   └────┬────┘                     │                                 │                        │
        │                          │◄────────────────────────────────┤  tool_use:             │
        │  "agent:message"         │   assistant + tool_use          │  mcp__slides__read_    │
        │◄─────────────────────────┤                                 │  slide {index:3}       │
   ┌────┴──────────────┐           │                                 │                        │
   │ ⚙ Reading slide 3 │           │ ── in-process MCP handler ──    │                        │
   └────┬──────────────┘           │    deck.resolve({index:3})      │                        │
        │                          │    (no subprocess, no network)  │                        │
        │                          ├────────────────────────────────►│ tool_result: html+meta │
        │                          │                                 ├───────────────────────►│
        │                          │                                 │                        │
        │                          │                                 │◄───────────────────────┤
        │                          │◄────────────────────────────────┤  Skill(interactive-    │
        │  "agent:message"         │   tool_use: Skill               │  graph)  ← loaded on   │
        │◄─────────────────────────┤                                 │    demand, ~100 tok    │
   ┌────┴──────────────────┐       │                                 │    until now           │
   │ ⚙ Using interactive-  │       │                                 │                        │
   │   graph skill         │       │                                 │                        │
   └────┬──────────────────┘       │                                 │                        │
        │                          │                                 │  (writes new HTML:     │
        │                          │◄────────────────────────────────┤   inline SVG chart,    │
        │  "agent:message"         │   tool_use: mcp__slides__       │   data-hover-target,   │
        │◄─────────────────────────┤   update_slide {slideId, html}  │   vanilla JS tooltip)  │
   ┌────┴──────────────────┐       │                                 │                        │
   │ ⚙ Editing slide 3     │       │ ── MCP handler ──               │                        │
   └────┬──────────────────┘       │  deck.updateSlide()             │                        │
        │                          │  ├─ push undo entry             │                        │
        │  "deck:updated"          │  ├─ write slides/03.html mirror │                        │
        │◄─────────────────────────┤  └─ send("deck:updated")        │                        │
   ┌────┴──────────────────────┐   │                                 │                        │
   │ THUMBNAIL 3 RERENDERS     │   │                                 │                        │
   │ canvas updates (selected) │   │  ← happens MID-TURN, before     │                        │
   └────┬──────────────────────┘   │    Claude has finished          │                        │
        │                          ├────────────────────────────────►│ tool_result: "Updated" │
        │                          │                                 ├───────────────────────►│
        │                          │                                 │                        │
        │                          │                                 │◄───────────────────────┤
        │                          │◄────────────────────────────────┤  tool_use: mcp__slides │
        │  "agent:message"         │                                 │  __screenshot_slide    │
        │◄─────────────────────────┤                                 │                        │
   ┌────┴──────────────────┐       │ ── MCP handler ──               │                        │
   │ ⚙ Checking the result │       │  offscreen BrowserWindow        │                        │
   └────┬──────────────────┘       │  → webContents.capturePage()    │                        │
        │                          ├────────────────────────────────►│ tool_result: image/png │
        │                          │                                 ├───────────────────────►│
        │                          │                                 │   (vision: verifies    │
        │                          │                                 │    no overflow, axis   │
        │                          │                                 │    labels legible)     │
        │                          │                                 │◄───────────────────────┤
        │  "agent:message"         │◄────────────────────────────────┤  assistant text        │
        │◄─────────────────────────┤                                 │                        │
   ┌────┴────────────────────────┐ │                                 │                        │
   │ "Slide 3's chart is now     │ │                                 │                        │
   │  interactive — hovering a   │ │                                 │                        │
   │  bar shows its exact value."│ │                                 │                        │
   └────┬────────────────────────┘ │                                 │                        │
        │                          │◄────────────────────────────────┤  result:               │
        │  "agent:usage"           │   result {subtype:"success",    │  total_cost_usd 0.041  │
        │◄─────────────────────────┤     total_cost_usd, session_id} │                        │
   ┌────┴──────────────────┐       │  deck.spendUsd += 0.041         │                        │
   │ bottom bar:           │       │  persist session_id             │                        │
   │ ≈$0.38 / $2.00 ▓▓▓░░░ │       │  (generator stays open —        │                        │
   └───────────────────────┘       │   same subprocess next turn)    │                        │
```

Three things this diagram is meant to make obvious:

1. **Tool execution never leaves the main process.** `read_slide`, `update_slide`, and `screenshot_slide` are function calls against the live deck store. There is no second subprocess, no socket, no localhost server.
2. **The thumbnail updates before the turn ends** — the `deck:updated` push happens inside the `update_slide` handler.
3. **The screenshot round-trip closes the loop.** The agent *looks* at what it built (exploiting vision, as the skills best-practices research recommends) before claiming success — which is exactly the validator→fix→repeat feedback loop that carried the skills to 100% adversarial confidence.

---

## 16. Consolidated gotcha checklist

Pin these in code review; each one is a documented SDK sharp edge:

- [ ] `options.env` **replaces** the subprocess env in TS — always spread `process.env`.
- [ ] Assistant content is nested: `message.message.content`, not `message.content`.
- [ ] Deduplicate assistant usage by `message.message.id` (parallel tool calls duplicate it).
- [ ] `total_cost_usd` is an estimate; `usage` excludes subagents, `modelUsage` doesn't.
- [ ] `query()` throws **after** yielding the error `result` — catch, and keep the yielded cost/session_id.
- [ ] Auto-approved tools skip `canUseTool`; must-run checks belong in `PreToolUse` hooks.
- [ ] `resume` silently starts fresh if `cwd` differs — derive cwd from the stable deck UUID.
- [ ] Skills need `user`/`project` setting sources (or plugins); SKILL.md `allowed-tools` is ignored by the SDK.
- [ ] `interrupt()`, `setModel()`, and image attachments are **streaming-input mode only**.
- [ ] No wall-clock timeout exists — `maxTurns` + `maxBudgetUsd` + Stop button are the brakes.
- [ ] The CLI binary is an optional dependency; asar/bundlers strip it — `pathToClaudeCodeExecutable` is the fix.
- [ ] claude.ai login is contractually off-limits for shipped products — API key only; "Claude Code" branding is not permitted.
- [ ] `Task` → `Agent` rename (v2.1.63): match both names when inspecting `tool_use` blocks.
- [ ] Call `q.close()` on window close *and* `app.before-quit` — no orphaned CLI processes.
- [ ] `ClaudeSDKClient` is Python-only; the TS V2 session API was removed in 0.3.142 — don't build on either.

---

## 17. Open questions for implementation

1. **Offscreen capture cost.** `screenshot_slide` spins an offscreen `BrowserWindow` per call. Measure; if it's slow, keep one warm capture window per deck session and reuse it.
2. **Design Mode ↔ agent handoff.** [40-design-mode.md](40-design-mode.md) sends an element context bundle (element HTML + computed styles + screenshot crop) to the agent for element-scoped edits. That likely wants its own tool — `mcp__slides__update_element` operating on `data-sl-id` byte spans — rather than routing through full-slide `update_slide`. Decide when Design Mode lands.
3. **Attachment size.** Base64 images in `SDKUserMessage` content go through stdio. Cap user attachments (suggest ≤2 MB / 1568px long edge) and downscale in the renderer before sending.
4. **`Read` on the slide mirror** may be redundant once `read_slide` proves adequate. If telemetry shows `Read` is never used, drop it from `tools` in a patch release and shrink the surface further.
