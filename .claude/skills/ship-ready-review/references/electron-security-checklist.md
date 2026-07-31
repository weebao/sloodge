# Electron & Slide-HTML Security Checklist (sloodge)

Read this when a changeset touches the main process, preload, IPC, the slide iframe, the
slide HTML pipeline, file I/O, export, or the agent runtime.

Derived from Electron's official security recommendations and mapped onto sloodge's
actual architecture (`src/main`, `src/preload`, `src/shared/ipc-contract.ts`,
`.claude/plans/init/30-slide-format.md`, `40-design-mode.md`).

## Contents

- [1. Process configuration](#1-process-configuration)
- [2. IPC boundary](#2-ipc-boundary)
- [3. Preload surface](#3-preload-surface)
- [4. Navigation and external URLs](#4-navigation-and-external-urls)
- [5. The slide iframe](#5-the-slide-iframe)
- [6. Injection into slide HTML](#6-injection-into-slide-html)
- [7. Filesystem and archives](#7-filesystem-and-archives)
- [8. Secrets and logging](#8-secrets-and-logging)
- [9. Agent-runtime specifics](#9-agent-runtime-specifics)
- [10. Severity guide for this file](#10-severity-guide-for-this-file)

---

## 1. Process configuration

Current baseline in `src/main/index.ts` — every one of these is load-bearing:

```ts
webPreferences: {
  preload: preloadPath,
  sandbox: true,
  contextIsolation: true,
  nodeIntegration: false,
  webviewTag: false,
}
```

- Any diff that flips one of these, or adds a second `BrowserWindow` /
  `WebContentsView` without them, is a **blocker** unless justified in writing.
- Never `webSecurity: false`, `allowRunningInsecureContent: true`,
  `experimentalFeatures: true`, or `enableBlinkFeatures`.
- `nodeIntegrationInSubFrames` must stay off — the slide iframes are subframes.
- Set a session permission handler rather than letting requests auto-approve; a local
  slide deck needs no camera, mic, geolocation, or notifications.

## 2. IPC boundary

- Every channel must exist in the runtime allow-lists `IPC_REQUEST_CHANNELS` /
  `IPC_EVENT_CHANNELS` in `src/shared/ipc-contract.ts`. Those arrays are load-bearing,
  not documentation — the preload helpers refuse anything absent from them.
- **Types are not validation.** Every `ipcMain.handle` argument must be parsed with a
  `zod` schema before use. The renderer is the untrusted side of this boundary: it runs
  slide-adjacent content and, one XSS away, attacker-controlled JS.
- Validate the sender for anything privileged: `event.senderFrame` should be the main
  frame of the app window, not a slide subframe.
- Prefer `ipcRenderer.invoke`/`handle` (request-response) over `send`/`on`. One-way
  `webContents.send` is for main→renderer events only.
- Never expose a generic "run this channel with these args" bridge — that re-creates
  `remote` and defeats the allow-list.
- Handlers must not return raw filesystem paths, `Buffer`s of unrelated files, or
  internal error objects with stack traces to the renderer.

## 3. Preload surface

- The preload exposes exactly one frozen object via `contextBridge.exposeInMainWorld`.
  Adding a capability means adding a named, narrow method — never passing `ipcRenderer`,
  `electron`, `require`, `process`, or a `fs` handle across the bridge.
- Functions crossing `contextBridge` lose their prototype chain; passing class instances
  or objects with methods is a source of subtle bugs — pass plain data.
- The preload runs with `sandbox: true`, so it has only the polyfilled subset of Node.
  A diff that needs full Node in preload is asking to disable the sandbox: reject it and
  move the work to main.

## 4. Navigation and external URLs

- `setWindowOpenHandler` must return `{ action: 'deny' }` for everything.
- **Do not pass an arbitrary URL to `shell.openExternal`.** Check the scheme against an
  allow-list (`https:`, and `http:` only if genuinely needed) before opening. Schemes like
  `file:`, `smb:`, `ms-msdt:`, and other OS protocol handlers turn "open a link" into
  arbitrary command execution. The current handler in `src/main/index.ts` opens whatever
  URL it is given — any diff that keeps or extends that path should carry the scheme check.
- Add a `will-navigate` handler that cancels navigation away from the app origin. A slide
  or a stray anchor should never be able to replace the shell.
- The app loads only local content (`loadFile`, or the dev server URL). Any diff that
  loads a remote origin into a window with the preload attached is a blocker.

## 5. The slide iframe

Slides are self-contained HTML rendered in an opaque-origin sandboxed iframe:

```html
<iframe sandbox="allow-scripts" srcdoc="...instrumented slide HTML..."></iframe>
```

- `allow-scripts` and nothing else. Adding `allow-same-origin` collapses the whole model
  (it re-grants same-origin privileges and, combined with `allow-scripts`, lets the frame
  remove its own sandbox). `allow-popups`, `allow-modals`, `allow-forms`, and
  `allow-top-navigation` are equally forbidden.
- Because the frame is opaque-origin, `event.origin` is the string `"null"` — it proves
  nothing. Parent-side `message` handlers **must** check
  `event.source === iframe.contentWindow`.
- Treat every message from the frame as hostile input: validate the message shape with
  `zod` before acting, and never let a frame message name a filesystem path, an IPC
  channel, or another slide's id without re-authorization in the parent.
- The parent must never read `iframe.contentDocument` — it can't, by design; a diff that
  makes it possible has weakened the sandbox somewhere.
- A slide's own CSP must stay `default-src 'none'` with only `data:` images and inline
  style/script; `connect-src 'none'` is what guarantees zero network egress from slide
  content.

## 6. Injection into slide HTML

The slide pipeline concatenates strings into a document that then executes script. Treat
it as a templating engine with no auto-escaping, because that is what it is.

- Escape per context, not generically: text content (`& < >`), attribute values (plus
  quotes), `<style>` bodies, and `<script>` bodies each need different handling. A single
  `escapeHtml()` applied everywhere is itself a defect.
- Never interpolate raw agent output, user text, filenames, or theme values into a
  `<script>` or `<style>` block. Serialize data as JSON into a `data-` attribute or a
  `<script type="application/json">` block and parse it inside the slide.
- `data-sl-id` is injection-only (it exists in the HTML handed to the iframe, never in the
  saved document). It must be attribute-escaped and must be generated, not taken verbatim
  from untrusted input.
- Enforce the slide contract's zero-external-subresource rule: no `<script src>`,
  `<link rel=stylesheet>`, `@import`, or `url()` pointing at `http(s)://` or `//`. A diff
  that introduces one is a blocker even though CSP would also block it — defense in depth,
  and the linter rules `SL-S01`/`SL-I02` exist for this.
- `dangerouslySetInnerHTML` anywhere in `src/renderer` is a blocker unless the input is
  provably generated by us and escaped; the renderer is _not_ sandboxed.

## 7. Filesystem and archives

- Any path derived from renderer input, a `.sloodge` document, or an agent tool call must
  be resolved and confined:

  ```ts
  const target = path.resolve(root, candidate)
  if (target !== root && !target.startsWith(root + path.sep)) throw new Error('escape')
  ```

  Checking for `..` by substring is not sufficient (encoding, symlinks, absolute paths).

- **Zip-slip:** `.sloodge` is an archive read with `fflate`. Every entry name must be
  confined the same way before writing. Entry names are attacker-controlled in a shared
  deck file.
- Reject absolute paths and drive-letter/UNC prefixes from document fields on Windows.
- Writes should be atomic (temp file + rename) so a crash mid-save cannot corrupt a deck.
- Never resolve a user-supplied path into `app.getPath('userData')` or the app resources
  directory.

## 8. Secrets and logging

- The Anthropic API key lives in Electron `safeStorage`, never in `electron-store`, never
  in a plain JSON pref file, never in an env var written to disk.
- Never log the key, a request body containing it, or full error objects from the agent
  SDK that may embed it. Redact before `electron-log`.
- Error messages returned to the renderer must not include absolute filesystem paths or
  stack traces.

## 9. Agent-runtime specifics

- Agent tool inputs are untrusted: the model can be steered by slide content, a pasted
  document, or a fetched URL. Every in-process MCP tool must `zod`-parse its input and
  re-authorize the action against the same rules a renderer IPC call would face.
- Tools must not accept a filesystem path or shell command as a free-form parameter.
  Expose intent-shaped operations (`insertSlide`, `setSlideHtml`) with confined effects.
- Skills and resources loaded from `resources/skills/**` are executable instructions.
  Review any change to them with the same scrutiny as source code — a modified skill can
  redirect tool use.
- Content fetched from the network and fed to the agent can carry injected instructions;
  it must never be concatenated into a system prompt or trusted to name a target file.

## 10. Severity guide for this file

**Blocker** — weakened `webPreferences`; `allow-same-origin` (or any extra sandbox token)
on a slide iframe; unvalidated IPC payload at a privileged handler; unescaped
interpolation into slide HTML/script/style; unconfined path from document or renderer
input; zip-slip; `shell.openExternal` on an unchecked scheme; secret written to disk or
logged; remote content loaded into a window carrying the preload.

**Major** — missing sender validation on a privileged handler; missing `will-navigate`
guard; missing session permission handler; non-atomic deck writes; error responses leaking
absolute paths; agent tool that takes a path-shaped parameter.

**Minor** — defense-in-depth suggestions where a stronger control already blocks the
attack (e.g. an additional runtime assertion behind an existing CSP guarantee).
