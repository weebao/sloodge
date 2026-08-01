# 11 — Tech Stack

Concrete dependency list for Sloodge v1, with pinned majors, justifications, the Node/Electron
matrix, what we borrow from t3code's Vite+ stack and what we deliberately skip, the
monorepo decision, and a risk register with fallbacks.

All versions verified against the npm registry on **2026-07-31**. Pin policy: **exact for the
runtime spine** (electron, electron-builder, TypeScript, the Agent SDK), **caret for leaf
libraries**. Everything shared lives in a pnpm **catalog** so there is one place to bump.

---

## 1. Stack in one paragraph

Sloodge is a **single-package pnpm project**: Electron 43 (Node 24 / Chromium 150) built by
**electron-vite 5** over **Vite 7**, packaged by **electron-builder 26** with **electron-updater 6**.
The renderer shell is **React 19 + TypeScript 7 (strict) + Tailwind CSS v4 + shadcn/ui + Zustand 5**.
The agent runtime is the **Claude Agent SDK** in the main process, exposing slide CRUD as in-process
MCP tools (**zod 4** schemas). Export is **pptxgenjs 4** (PPTX) + Electron `printToPDF` merged with
**pdf-lib 1** (PDF). Tests are **Vitest 4** (unit, CI) and **Playwright 1.62** (Electron E2E + visual,
local only). Lint is **oxlint 1**, format is **Prettier 3**.

---

## 2. Dependency table

### 2.1 Runtime `dependencies` (shipped inside the app)

| Package | Pin | Where it runs | Why |
|---|---|---|---|
| `electron` | `43.2.0` (exact, devDep by convention but is the runtime) | shell | Only cross-platform Chromium+Node desktop runtime with `printToPDF`, `capturePage`, `safeStorage`, native menus — every v1 requirement leans on one of these. |
| `@anthropic-ai/claude-agent-sdk` | `0.3.220` (exact) | main | The agent harness (loop, tools, skills, MCP, sessions, permissions) as a library; the whole chat surface is one `query()` in streaming-input mode. Pre-1.0 → exact pin. **Added in M2.1** (`pnpm add -E`), the only file importing it is the R3 facade `src/main/agent/client.ts`; excluded from `minimumReleaseAge` (see `pnpm-workspace.yaml`). |
| `zod` | `^4.4` | main | Required peer of the Agent SDK; also the schema language for our `tool()` definitions (slide CRUD) and for validating `.sloodge` documents on load. |
| `@anthropic-ai/sdk` | `^0.115` | main | Required peer of the Agent SDK (transport/types). Not called directly by us. **As of M2.1 this resolves as an auto-installed peer** (`0.115.0`, under `.pnpm`), not a declared `dependencies` entry — M2.1 added only the Agent SDK per its zero-new-deps constraint. Promote to an explicit dep if we ever import it directly. |
| `@modelcontextprotocol/sdk` | `^1.30` | main | Required peer of the Agent SDK; underlies `createSdkMcpServer()` for our in-process slide tools. **As of M2.1 an auto-installed peer** (`1.30.0`), not yet a declared dep — the M2.2 slide MCP server is the point to reconsider promoting it. |
| `pptxgenjs` | `4.0.1` (exact) | main | Only maintained JS library that emits standards-compliant OOXML `.pptx`; gives us both the structured (text/shape/image) path and the raster fallback via `addImage`. **Added in M4.3, pinned exact** (catalog `pptxgenjs: 4.0.1`, not `^4.0`) so a patch cannot change OOXML byte output under us — the OPC-structure tests (`tests/unit/export/pptx-writer.test.ts`) assert on the emitted parts. Pure JS (its deps — jszip, image-size — are pure JS too, no native/Cairo in the installer); `.pptx` bytes are read back via the already-present `fflate` for the slide-count proof (`src/main/export/pptx-opc.ts`). |
| `pdf-lib` | `1.17.1` | main | Merges the per-slide single-page PDFs produced by `printToPDF` into one deck PDF. Pure JS, no native deps, no Cairo/Ghostscript in the installer. **Added in M4.2, pinned exact** (catalog `pdf-lib: 1.17.1`, not `^1.17`) so a patch cannot change PDF byte output under us. Note: 1.17.1's `SaveOptions` has no `updateMetadata` flag and its `save()` always rewrites `/Producer` to pdf-lib's own string — `/Title` and `/CreationDate` survive, `/Producer` is left as the default (cosmetic; see `src/main/export/merge.ts`). |
| `fflate` | `^0.8.3` | main | Zip codec for the `.sloodge` container. Dependency-free, ~8 kB, ships its own types, and lets a single entry be STORED (`level: 0`) so `mimetype` can lead the archive OPC-style. Its *asynchronous* whole-archive API fans every member out concurrently — one `worker_threads` Worker per entry, no queue, no limit, in **both** `unzip` (peak = sum of inflated members) and `zip` (~11 MB RSS per entry deflated) — which no resource cap can bound, so we use neither: read drives its *streaming* `Inflate` from our own validated central-directory scan, write uses `zipSync`. |
| `parse5` | `^8.0` | shared (main + renderer) | Location-aware HTML parser: gives per-element source spans, which is what makes Design Mode's `data-sl-id → source span` patching (Onlook's lesson) possible without re-serializing and destroying formatting. Lives in `src/shared/design/` because the map is built where a slide is loaded (main) and read by the property panel and context bundler (renderer). **Its offsets are UTF-16 code-unit indices into the decoded string, not byte offsets** — an earlier revision of this row said "byte-offset", which is wrong by 1 per surrogate pair and by up to 3 per non-ASCII character; see the offset-semantics docstring in `src/shared/design/types.ts`. |
| `electron-updater` | `^6.8` | main | electron-builder's companion auto-updater; NSIS delta updates on Windows, Squirrel.Mac on macOS, GitHub Releases feed with zero server. |
| `electron-store` | `^11.0` | main | Small JSON-file store for app prefs (recent decks, theme, window bounds). API key does **not** go here — that goes through `safeStorage`. |
| `electron-log` | `^5.4` | main + renderer | File+console logging that survives packaging; needed to capture Agent SDK subprocess `stderr` and export failures from users' machines. |
| `react` | `^19.2` | renderer | Matches t3code; concurrent rendering + `useSyncExternalStore` (what Zustand binds through) + the largest component ecosystem, which shadcn/ui assumes. |
| `react-dom` | `^19.2` | renderer | Paired with React. |
| `zustand` | `^5.0` | renderer (+ shared) | Minimal, unopinionated store; the deck state is a plain object we also need to snapshot for undo/redo — Zustand's transient/vanilla store works identically in main and renderer, unlike a React-only solution. **Not installed as of M1.3** — `src/renderer/src/stores/createStore.ts` is a surface-compatible shim (`create(set, get)` → a hook that is also `getState`/`setState`/`subscribe`, over React's `useSyncExternalStore`, which is the same primitive Zustand v5 binds through). M1.3 needed only one deck and one selection, and shipped under a zero-new-deps constraint. Adopt the real package in M1.4, where the command/undo layer gives a workload to judge its middleware (`subscribeWithSelector`, devtools, persistence) against; the swap is an import change, not a rewrite of call sites. **M1.4 judged it and kept the shim.** The undo workload landed somewhere else entirely: `DocumentHistory` owns the document and the stacks, and the store's job shrank to publishing `history.doc` and a `canUndo`/`canRedo` pair. That needs no middleware — no `subscribeWithSelector` (every subscription is already a stable slice), no `persist` (§5: history is deliberately not persisted; the recovery journal covers crash survival), no `immer` (every layer below is immutable by construction). Revisit at M2.3, when streaming agent edits arrive from main and a transient/vanilla store outside React starts to earn its keep. |
| `immer` | `^11.1` | renderer | Optional but recommended with Zustand: structural sharing makes undo/redo snapshots of the deck cheap instead of deep-cloning slide HTML on every keystroke. |
| `clsx` | `^2.1` | renderer | shadcn/ui's `cn()` helper dependency. |
| `tailwind-merge` | `^3.6` | renderer | Second half of `cn()`; resolves conflicting Tailwind classes when composing shadcn variants. |
| `class-variance-authority` | `^0.7` | renderer | The variant API every shadcn component is written against. |
| `lucide-react` | `^1.28` | renderer | shadcn's default icon set; tree-shakeable, covers the whole PowerPoint-like ribbon/toolbar iconography. |
| `@radix-ui/react-*` | `^1.x` per primitive | renderer | Installed on demand by the shadcn CLI (dropdown-menu, dialog, tooltip, tabs, slider, popover, context-menu). Accessible, unstyled primitives — the menu bar, Design Mode property popovers, and export dialogs all need real focus management. |

> **shadcn/ui is not a dependency.** It is a CLI that vendors component source into
> `src/renderer/components/ui/`. What we actually install is the Radix + cva + tailwind-merge +
> clsx + lucide set above. This is deliberate: we will restyle heavily to look like PowerPoint,
> and owning the source beats fighting a component library's theme API.

### 2.2 Build & tooling `devDependencies`

| Package | Pin | Why |
|---|---|---|
| `electron-vite` | `5.0.0` (exact) | One config, three builds (main/preload/renderer) with renderer HMR and main-process restart-on-change. The public, stable equivalent of what Vite+'s `pack` block does for t3code — see §4. |
| `vite` | `7.3.6` (exact) | Pinned to 7.x because **electron-vite 5's peer range is `^5 \|\| ^6 \|\| ^7`** — Vite 8 is not yet supported. See risk R1. |
| `@vitejs/plugin-react` | `^5.2` | Deliberately **5.2.x, not 6.x**: 5.2 declares `vite: ^7 \|\| ^8`, so the eventual Vite 8 move is a one-line change instead of a coordinated plugin bump. |
| `@tailwindcss/vite` | `^4.3` | Tailwind v4's native Vite plugin — no PostCSS config, no `tailwind.config.js`, CSS-first `@theme` tokens. Same choice as t3code. |
| `tailwindcss` | `^4.3` | v4 engine (Oxide/Rust). Faster builds and, more importantly, the `@theme` token model maps cleanly onto a PowerPoint-like design system we control. |
| `typescript` | `7.0.2` (exact) | **TypeScript 7 is the GA of the Go-native compiler** that t3code was pre-adopting as `@typescript/native-preview`/`tsgo`. We get the speed without running a dev-preview build. Same strict flag set as t3code (§5). Risk R2. |
| `@types/node` | `~24.13` | **Pinned to 24.x, not latest (26.x)** — it must match Electron 43's bundled Node 24.18 runtime, or main-process code type-checks against APIs that don't exist at runtime. |
| `@types/react` / `@types/react-dom` | `^19.2` | React 19 typings. |
| `electron-builder` | `26.15.3` (exact) | NSIS (Windows) + dmg/zip (macOS) installers, code signing, notarization hook, and the `latest.yml` metadata `electron-updater` consumes. `asarUnpack` is what makes the Agent SDK's native binary executable — see §6. |
| `vitest` | `^4.1` | Shares the Vite pipeline and config, so unit tests resolve the same aliases/TS settings as the app with zero extra config. This is the only test runner CI executes. |
| `@vitest/coverage-v8` | `^4.1` | V8 coverage, no instrumentation step. |
| `happy-dom` | `^20.11` | DOM environment for renderer-side unit tests (Design Mode hit-testing, source-span patching). ~3x faster than jsdom and sufficient — real browser behavior is covered by Playwright instead. |
| `@testing-library/react` | `^16.3` | Behaviour-oriented component tests for the shell UI. |
| `playwright` + `@playwright/test` | `1.62.1` (exact) | Playwright's `_electron` API launches the packaged app for E2E (create deck → chat → design-mode edit → present → export) and for visual regression on rendered slides. Exact pin because browser binaries are version-locked. **Local/nightly only — not on PR CI** (per overview: GitHub minutes are limited). |
| `oxlint` | `^1.76` | See §3 — the lint decision. |
| `oxlint-tsgolint` | `^7.0` | Optional type-aware rule pass for oxlint, run in the local `check` script only (slower than the base pass). |
| `prettier` | `^3.9` | Formatting. See §3. |
| `cross-env` | `^10.1` | Windows/macOS parity in npm scripts (channel flags, `NODE_ENV`). |
| `electron-devtools-installer` | `^4.0` | React DevTools in the dev shell; dev-only, excluded from the packaged build. |

### 2.3 Package manager

| Tool | Pin | Why |
|---|---|---|
| `pnpm` | `11.18.0` via `packageManager` field | Strict node_modules (no phantom deps — matters because Electron packaging silently ships whatever it can resolve), content-addressed store (Electron's ~250MB binary is stored once across projects), **catalogs** for single-point version pinning, and `allowBuilds` to explicitly allow-list install scripts. Same choice and major as t3code. |

`pnpm-workspace.yaml` (present from day 1 even as a single package — see §6):

```yaml
packages:
  - .

# Single source of truth for versions; package.json references them as "catalog:"
catalog:
  react: ^19.2.8
  react-dom: ^19.2.8
  "@types/react": ^19.2.18
  "@types/react-dom": ^19.2.4
  typescript: 7.0.2
  vite: 7.3.6
  vitest: ^4.1.10
  fflate: ^0.8.3
  zod: ^4.4.3
  tailwindcss: ^4.3.3
  "@tailwindcss/vite": ^4.3.3

# Only these may run postinstall scripts (pnpm 11 replaces onlyBuiltDependencies)
allowBuilds:
  electron: true
  esbuild: true
  "@tailwindcss/oxide": true

# Supply-chain guard: don't adopt an npm publish younger than 3 days
minimumReleaseAge: 4320
minimumReleaseAgeExclude:
  - "@anthropic-ai/claude-agent-sdk"
  - "@anthropic-ai/claude-agent-sdk-*"
```

---

## 3. The two contested picks, decided

### oxlint, **not** ESLint

**Decision: `oxlint` 1.76 as the only linter.**

- **Speed is the whole point at our size.** oxlint is Rust and lints a repo this size in
  tens of milliseconds; a pre-commit hook that costs nothing gets kept. ESLint 10 + `typescript-eslint`
  needs a TS program per run and turns lint into a multi-second step we will start skipping.
- **We have zero custom rules.** t3code needs `oxlint-plugin-t3code` because Effect-TS imposes
  idioms a linter must police (`no-global-process-runtime`, `no-manual-effect-runtime-in-tests`).
  Sloodge has no such paradigm; the built-in `correctness` + `react` + `react-hooks` +
  `typescript` + `unicorn` rule sets are the entire requirement.
- **Type-checking is TypeScript's job, not the linter's.** We copy t3code's split exactly:
  `typeAware: false` in lint, `tsc --noEmit` for types. That removes the single biggest reason
  people keep `typescript-eslint`.
- **Zero-config.** One `.oxlintrc.json`; no flat-config migration, no plugin version matrix.

*Fallback (R6):* if a rule we genuinely need has no oxlint equivalent (most likely candidate: a
niche `eslint-plugin-jsx-a11y` rule), add ESLint 10 + `typescript-eslint` 8 as a **second,
narrowly-scoped** pass over `src/renderer` only. oxlint and ESLint coexist fine; oxlint even
ships `--disable-eslint-rules`-style interop. We do not start there.

### Prettier 3, **not** oxfmt/Biome

**Decision: `prettier` 3.9 for formatting.**

t3code formats with Vite+'s bundled formatter, whose standalone equivalent is `oxfmt` — currently
**0.61.0, pre-1.0**. Formatting churn is uniquely annoying (it touches every file and poisons every
diff), so this is the one place we take the boring, frozen-since-2023 option. Prettier also formats
the HTML/CSS inside our slide templates and the Markdown in `.claude/skills/`, which matters more
here than in a pure-TS repo. Revisit when oxfmt hits 1.0; the swap is mechanical and one commit.

---

## 4. What we mirror from t3code / Vite+ — and what we skip

### Mirror

| From t3code | What we take | Why it transfers |
|---|---|---|
| pnpm workspace + **catalogs** + `allowBuilds` + `minimumReleaseAge` | Verbatim | Version pinning and supply-chain hygiene are free and independent of app size. |
| **React 19 + Tailwind v4 (`@tailwindcss/vite`) + shadcn/ui (cva + tailwind-merge + lucide)** | Verbatim | Proven Electron-renderer combination; shadcn's vendored-source model suits a heavily custom PowerPoint-like skin. |
| **Extremely strict tsconfig** — `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`, `verbatimModuleSyntax`, `erasableSyntaxOnly`, `module/moduleResolution: NodeNext` | Verbatim, minus the `@effect/language-service` plugin | These catch exactly the bugs an IPC + file-format app generates (optional fields, index access on slide arrays). `erasableSyntaxOnly` keeps us on type-strippable TS, which keeps the main-process build trivial. |
| Native TypeScript compiler | Via **TypeScript 7 GA**, not `@typescript/native-preview`/`tsgo` | Same compiler, shipped release instead of a dated dev build. |
| **Oxlint-based linting**, type-aware checks decoupled | Verbatim (as `oxlint` directly) | See §3. |
| **electron-builder 26 + electron-updater 6**, NSIS/dmg, GitHub Releases, per-platform release matrix | Verbatim | t3code validated this exact packaging path for a Claude-Agent-SDK-bearing Electron app on all three OSes. |
| `electron-store` + Electron `safeStorage` wrapper for secrets | Verbatim | The API key handling pattern we need, one-for-one. |
| **`@anthropic-ai/claude-agent-sdk` in a Node process, streamed to clients** | Same library, simpler topology (main process, IPC instead of WebSocket RPC) | Validates the SDK is production-viable in a shipped Electron app. |
| `react-grab` as prior art for element picking | **Ideas only, not the dependency** | react-grab reads the React fiber tree via bippy. Our slides are plain HTML with no fiber tree; we own `data-sl-id` at "compile" time, so `elementFromPoint` + our own span table is strictly simpler and more robust. |

### Skip

| Skipped | Why |
|---|---|
| **Vite+ / `vp` / `@voidzero-dev/vite-plus-core`** | Not a public GA product. `vite` is *aliased* to a voidzero package and `vp` replaces the task runner, linter, formatter, and bundler simultaneously — a single vendor dependency across our entire toolchain, at `0.2.x`. **electron-vite 5 + Vite 7 + oxlint + Prettier gives the same DX with independently-replaceable, stable parts.** Revisit at Vite+ GA (R1). |
| **Effect-TS (v4 beta) and `@effect/*`** | t3code needs Effect because it is an event-sourced multi-tenant server with WebSocket RPC, drainable workers, and SQL projections. Sloodge is a local single-user app whose "backend" is one `query()` loop, an in-memory deck store, and file I/O. Effect would add a beta-version runtime paradigm, a TS language-service plugin, ~20 Layer definitions in the main process, and a steep contributor ramp — to solve concurrency problems we do not have. Plain async/TS + Zustand covers it. **Revisit only if the main process grows genuine concurrent-resource lifecycles.** |
| **`@typescript/native-preview` / `tsgo`** | Superseded: this shipped as TypeScript 7. Using the dated dev-build channel now would be strictly worse. |
| **Clerk (`@clerk/electron`, passkeys)** | Sloodge has **no accounts**. Auth is a single user-supplied Anthropic API key in `safeStorage`. An identity provider would be pure liability (network dependency, privacy surface, licensing) for a local-first app. |
| **Effect RPC / WebSocket transport, `apps/server`** | We have no server. Renderer ↔ main is Electron IPC (`ipcRenderer.invoke` + `webContents.send`) with a hand-written typed channel map in `src/shared/ipc.ts`. |
| **TanStack Router** | The app is a single window with panes, not routes. A router would model state we already hold in Zustand. |
| **React Compiler + Babel + `@rolldown/plugin-babel`** | Adds a Babel pass to every renderer build for a memoization win that a deck-of-slides UI does not need. Zustand selectors + `React.memo` on the thumbnail rail is enough. Revisit if profiling shows renderer jank. |
| **`node-pty`, `@xterm/*`, SSH/WSL, Tailscale, Rust `resource-monitor`** | Native modules and remote-environment machinery for a product that supervises agent CLIs. Sloodge runs no terminals. Every native module avoided is one less cross-compilation and code-signing problem. |
| **Expo/React Native, Astro marketing, Vercel** | Out of v1 scope (desktop only). |
| **SQLite / `@effect/sql-*`** | The `.sloodge` file **is** the database. Prefs go in `electron-store`; agent transcripts are the SDK's own JSONL under a pinned `CLAUDE_CONFIG_DIR`. |
| **`<webview>` tag, `WebContentsView` for the editor grid** | Per Electron's current guidance, sandboxed `<iframe sandbox="allow-scripts">` for canvas + thumbnails. A `WebContentsView` is held in reserve for Present/export only (R7). |
| **reveal.js / Slidev as runtime dependencies** | We borrow reveal.js's DOM *contract* (self-contained slide, `data-*` build indices) and Slidev's headless-rasterization *pattern*, but embedding either runtime fights WYSIWYG editing (reveal.js owns slide transforms) or requires a Vue compiler (Slidev). Zero slide-framework dependencies ship. |

---

## 5. Node / Electron / TypeScript version matrix

| Layer | Version | Notes |
|---|---|---|
| **Electron** | `43.2.0` | Latest stable. `printToPDF` returns a `Buffer` promise with `preferCSSPageSize`; `capturePage`, `safeStorage`, `WebContentsView` all present. |
| ↳ bundled **Node** | `24.18.0` | The runtime for main + preload. All main-process code must target this. |
| ↳ bundled **Chromium** | `150.0.7871.129` | The renderer *and* the slide-rendering engine. Renderer build target: `chrome150`. Slide HTML may freely use anything Chromium 150 supports — this is a closed platform, no cross-browser matrix. |
| **Dev Node** (local + CI) | `24.x` (`>=24.13`, pinned in `.nvmrc` / `engines`) | Match Electron's Node major so native rebuilds and `@types/node` agree. `engines.node: "^22.12.0 \|\| >=24.13.0"` — 22.12 is electron-vite 5's floor and keeps the door open for a contributor on 22 LTS. |
| **`@types/node`** | `~24.13` | **Must not float to 26.x.** |
| **TypeScript** | `7.0.2` | Go-native compiler, GA. `tsc --noEmit` for typecheck; no emit — electron-vite/esbuild does transpilation. |
| **Vite** | `7.3.6` | Capped by electron-vite 5's peer range. |
| **electron-vite** | `5.0.0` | `engines.node: ^20.19.0 \|\| >=22.12.0`. |
| **Agent SDK** | `0.3.220` | `engines.node: >=18` — satisfied. Ships a platform-specific native binary as an **optionalDependency** (`@anthropic-ai/claude-agent-sdk-{darwin,win32,linux}-{x64,arm64}`), not a `bin` entry. |
| **Playwright** | `1.62.1` | Drives the built Electron app via `_electron.launch()`; does not need its own Chromium download for E2E. |
| **pnpm** | `11.18.0` | |

**Build targets** (`electron.vite.config.ts`):

```ts
main:     { build: { target: 'node24', rollupOptions: { external: ['electron'] } } }
preload:  { build: { target: 'node24' } }
renderer: { build: { target: 'chrome150' } }
```

**Supported OS matrix for v1:** Windows 10/11 x64 + arm64 (NSIS), macOS 12+ arm64 + x64 (dmg + zip).
Linux builds work but are unsupported/untested in v1.

---

## 6. Monorepo? — **No. Single package, workspace-ready layout.**

**Decision: one `package.json` at the repo root, one pnpm workspace containing only `.`.**

Rationale:

1. **There is nothing to share yet.** A monorepo pays off when ≥2 deployables consume common
   packages. Sloodge v1 has exactly one deployable. t3code needs `packages/contracts` because a
   web app, a mobile app, a desktop shell, and a server must agree on wire types across process and
   network boundaries; our main↔renderer contract is one file (`src/shared/ipc.ts`) compiled into
   both halves of the same build.
2. **electron-vite already provides the split** that a monorepo would otherwise impose: three
   independent build targets (main / preload / renderer) from one config, with correct
   externalization per target. The isolation benefit is had without the workspace tax.
3. **The tax is real at this size**: cross-package TS project references, `workspace:*` resolution
   inside `app.asar` (t3code has to force-inline every `@t3tools/*` package into its bundles
   precisely because workspace deps can't resolve at runtime from an ASAR), a task runner, and N
   tsconfigs — all of it before the first slide renders.

**But make splitting cheap.** Two concrete moves:

- Ship `pnpm-workspace.yaml` with `packages: [.]` **from commit one**. This is what unlocks
  `catalog:` pinning today, and turning it into `packages: [apps/*, packages/*]` later is a
  one-line diff.
- Enforce a directory layout whose folders are already package-shaped, with a **strict dependency
  direction** (`main → shared ← renderer`; renderer never imports from `main/`, main never imports
  React) policed by an oxlint `no-restricted-imports` rule:

```
sloodge/
├── package.json                  # the only one
├── pnpm-workspace.yaml           # packages: [.] + catalog
├── electron.vite.config.ts
├── tsconfig.json                 # references the three below
├── tsconfig.node.json            # main + preload (node24 lib)
├── tsconfig.web.json             # renderer (dom lib)
├── tsconfig.shared.json
├── src/
│   ├── main/                     # → apps/desktop-main
│   │   ├── agent/                #   Agent SDK query loop, MCP slide tools, hooks
│   │   ├── deck/                 #   .sloodge document model, load/save, undo stack
│   │   ├── export/               #   pptx | pdf | html
│   │   └── ipc/
│   ├── preload/                  # → the contextBridge surface
│   ├── renderer/                 # → apps/desktop-ui
│   │   ├── components/ui/        #   shadcn-vendored
│   │   ├── features/{chat,canvas,design-mode,thumbnails,ribbon,present}/
│   │   └── store/                #   zustand
│   └── shared/                   # → packages/contracts  (types + zod schemas ONLY, no runtime deps)
├── resources/
│   └── skills/                   # slide-deck, svg-animation, interactive-graph  (copied to workspace at runtime)
└── tests/{unit,e2e}/
```

**Trigger to actually split:** a second deployable (a headless `sloodge-render` CLI for CI export,
or a web viewer). Not before.

### Packaging notes that constrain the layout

- `resources/skills/**` ships as an **extraResource**, not inside `src` — the Agent SDK discovers
  skills from the filesystem (`settingSources: ["project"]`), so they must exist as real
  directories at runtime, which ASAR-packed files are not.
- The Agent SDK's native binary **cannot execute from inside `app.asar`**. Required
  `electron-builder` config:

```jsonc
"asarUnpack": ["**/node_modules/@anthropic-ai/claude-agent-sdk*/**"],
"extraResources": [{ "from": "resources/skills", "to": "skills" }]
```
  plus a startup probe that calls `startup()` and, on failure, points
  `options.pathToClaudeCodeExecutable` at the unpacked path explicitly.
- Because the binary is a **platform-specific optionalDependency**, each OS must build on its own
  runner. Never copy `node_modules` across platforms in the release workflow.

---

## 7. Risk register

| # | Risk | Likelihood | Impact | Mitigation / fallback |
|---|---|---|---|---|
| **R1** | **Vite+ reaches GA** and becomes the obvious stack, or **electron-vite 5 blocks us on Vite 7** while the ecosystem moves to 8 (`@vitejs/plugin-react` 6 already requires Vite 8). | High | Low–Med | We already pin `@vitejs/plugin-react` **5.2.x**, which spans Vite 7 *and* 8, so the migration is: bump `vite` → 8, `electron-vite` → 6 (currently `6.0.0-beta.1`), done. Migration path to Vite+ if it GAs: `vp` subsumes electron-vite's role via its `pack` block — one config rewrite, no source changes, because nothing in `src/` imports build tooling. **Revisit trigger: electron-vite 6 GA, or Vite+ 1.0.** |
| **R2** | **TypeScript 7 (native compiler) GA regressions** — a `.d.ts` in our tree fails to check, or editor tooling lags. | Med | Low | TS 7 is syntax-compatible with 6; fallback is `pnpm add -D typescript@6.0.3` and nothing else changes (our tsconfig uses no TS7-only flags). Verify at scaffold time by running `tsc --noEmit` against the full dep graph before writing app code. |
| **R3** | **Agent SDK is pre-1.0 (`0.3.x`)** and has already removed APIs mid-minor (the V2 session API vanished in 0.3.142). | High | High | Exact-pin the version; exclude it from `minimumReleaseAge`; **wrap it behind one internal facade** (`src/main/agent/client.ts` — the only file in the repo that imports `@anthropic-ai/claude-agent-sdk`) so a breaking change is a single-file fix. Use only documented, stable surface: streaming-input `query()`, `createSdkMcpServer`, hooks, `canUseTool`. Pin the three peers too. |
| **R4** | **PPTX fidelity gap** — pptxgenjs has no layout engine, no arbitrary SVG paths, no font embedding, so complex AI-generated slides can't round-trip as editable shapes. | Certain | Med | Ship the **raster fallback as the default** (full-slide PNG via `capturePage` + `addImage`), with structured text/shape conversion as an opt-in "editable export" for simple slides. Surface the tradeoff in the export dialog. This is a product decision, not a dependency problem — no library fixes it. |
| **R5** | **Electron 43 → 44+ upgrade** breaks `printToPDF` options or iframe sandbox behaviour mid-project. | Med | Med | Exact-pin Electron; upgrade deliberately behind the Playwright export-fidelity snapshots (byte-compare page count + visual diff of rendered PDF pages). Electron's ~8-week cadence means we take at most one upgrade during v1. |
| **R6** | **oxlint lacks a rule we need** (most likely a11y or an exotic TS rule). | Med | Low | Add ESLint 10 + `typescript-eslint` 8 as a second pass scoped to `src/renderer`, keeping oxlint as the fast default. Coexistence is supported; cost is one extra script. |
| **R7** | **Sandboxed iframes prove insufficient** for slide JS — heavy WebGL/canvas slides jank the shell UI, or a slide crashes the renderer process and takes the whole app with it. | Med | Med | Promote the *active/presenting* slide to a `WebContentsView` (separate OS process, crash-isolated) while thumbnails stay iframes. Zero new dependencies — Electron built-in. Keep the slide-rendering surface behind one component so the swap is local. |
| **R8** | **Tailwind v4 churn** (`@theme`/CSS-first config is still young; v4 has shipped breaking-ish minors). | Low | Low | Caret-pin within v4 and keep our design tokens in one `theme.css`. Nothing in component source depends on config-file shape. |
| **R9** | **electron-builder code signing** — Windows SmartScreen reputation and macOS notarization are the classic release-day blockers. | High | Med | Ship **unsigned** artifacts for v1 alpha (documented in the README), exactly as t3code does when credentials are absent. Wire the signing config (Azure Trusted Signing for Windows, Developer ID + `@electron/notarize` `afterSign` for macOS) but make it conditional on secrets being present, so the release pipeline is correct before certificates exist. |
| **R10** | **Native-module creep** — one dependency pulling in a native addon reintroduces per-platform rebuilds and signing of unpacked binaries. | Low | Med | Hard rule: **no native modules in v1.** Every pick above is pure JS except Electron itself and the Agent SDK's binary. `parse5`, `pdf-lib`, `pptxgenjs` were all chosen partly for this. Enforce by reviewing `allowBuilds` on every dependency addition. |
| **R11** | **Playwright + Electron E2E flake / cost**, tempting us to run it on PR CI and burn the minute budget. | Med | Low | Per overview decision 7: **CI runs Vitest only on the development path** (the M9.0 release workflow packages, but only on a `v*` tag — 70-testing-ci.md §6.5). Playwright runs locally and on a nightly/pre-release job. Keep E2E to a handful of golden-path specs so it stays runnable on a laptop. |

---

## 8. Scripts

```jsonc
{
  "packageManager": "pnpm@11.18.0",
  "engines": { "node": "^22.12.0 || >=24.13.0" },
  "scripts": {
    "dev":        "electron-vite dev --watch",
    "build":      "pnpm typecheck && electron-vite build",
    "preview":    "electron-vite preview",
    "typecheck":  "tsc --noEmit -p tsconfig.json",
    "lint":       "oxlint --type-aware .",
    "format":     "prettier --write .",
    "check":      "prettier --check . && oxlint . && pnpm typecheck",
    "test":       "vitest run",              // <- the only thing CI runs on a PR or push
                                             //    (a v* tag also runs pack:win:release; §6.5)
    "test:watch": "vitest",
    "test:e2e":   "playwright test",         // local / nightly only
    "dist:win":   "pnpm build && electron-builder --win nsis",
    "dist:mac":   "pnpm build && electron-builder --mac dmg zip"
  }
}
```

---

## 9. Revisit triggers (put these in the roadmap, not in someone's head)

- **electron-vite 6 GA** → Vite 8 + `@vitejs/plugin-react` 6.
- **Vite+ 1.0 GA** → evaluate replacing electron-vite + oxlint + Prettier with `vp`.
- **Agent SDK 1.0** → relax the exact pin, re-audit the facade in `src/main/agent/client.ts`.
- **oxfmt 1.0** → replace Prettier.
- **A second deployable exists** → convert `packages: [.]` to a real workspace.
- **Renderer profiling shows jank** → React Compiler.
- **Main process grows concurrent resource lifecycles** → reconsider Effect-TS (and only then).
