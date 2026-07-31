# Research: `pingdotgg/t3code` — what it is, and what "Vite+ stack" means

Repo: https://github.com/pingdotgg/t3code (public, MIT license, org `pingdotgg`, the team behind
`t3.chat` / `create-t3-app`). Homepage: https://t3.codes. Stars: ~16k, forks: ~3.5k, primary
language TypeScript, 246MB repo. Fetched via `gh api`, raw.githubusercontent.com, and the repo's
own docs on 2026-07-31.

## 1. What the project actually is

This is **not** the "T3 Stack" (create-t3-app) web-app boilerplate people usually mean by "t3".
`t3code` is **T3 Code**, an "agent harness control surface" — i.e. a desktop/mobile/web app for
controlling coding-agent CLIs (Claude Code, Codex, Cursor CLI, Grok Build, OpenCode) running on your
machine, from a native macOS/Windows/Linux desktop app, iOS/Android app, or web app. Think
"Claude Desktop / Cursor Glass / Conductor, but open source." From the README:

> T3 Code is an "agent harness control surface". It enables control of the agents on your machine
> with a best-in-class mobile app (iOS, Android), web app (app.t3.codes) and Electron-based desktop
> app (t3.codes). Works with your subscriptions on Claude Code, Codex, Cursor, Grok Build, and
> OpenCode.

Distribution: `npx t3@latest` (headless server + local web UI), desktop app via GitHub Releases /
`winget install T3Tools.T3Code` / `brew install --cask t3-code` / `yay -S t3code-bin` (AUR).

The project is **not accepting outside contributions** beyond small fixes (see `CONTRIBUTING.md`).

## 2. "Vite+" — what "viteplus stack" concretely means

The repo's own README says explicitly:

> T3 Code uses Vite+ so you'll need to install the global `vp` command-line tool.
> `curl -fsSL https://vite.plus | bash` ... Checkout their getting started guide:
> https://viteplus.dev/guide/

So "Vite+" (aka `vite-plus`, CLI binary `vp`) is a **separate, newer meta-build-tool product**
(by voidzero.dev / the Vite core team, branded viteplus.dev) that wraps and extends Vite itself. In
this monorepo:

- `vite-plus` is pinned in the pnpm catalog: `"vite-plus": "0.2.2"`.
- Vite itself is aliased through it: `"vite": "npm:@voidzero-dev/vite-plus-core@0.2.2"` — i.e. the
  actual `vite` package resolves to `@voidzero-dev/vite-plus-core`, not upstream `vite`. This
  confirms Vite+ is a superset/fork-ish distribution of Vite (Vite 8-era, "rolldown" bundler
  references appear in code comments: "Vite 8.1's experimental bundled dev mode").
- `vp` is used as the task runner across the whole monorepo (replacing turbo/nx): `vp run`,
  `vp i` (install), `vp build`, `vp dev`, `vp lint`, `vp fmt`, `vp check`, `vp pack` (bundling/output
  packaging, used for both the CLI binary and the Electron main/preload bundles), `vp test run`.
- `vite.config.ts` at the repo root uses `defineConfig` **from `vite-plus`**, not from `vite`, and
  extends the config surface with monorepo-level concerns Vite doesn't natively have: `staged`
  (lint-staged-style pre-commit formatting), `fmt` (a built-in formatter with `ignorePatterns` /
  `sortPackageJson` / per-file `overrides`), and `lint` (a built-in linter — see below) — i.e. Vite+
  bundles formatting and linting orchestration into the same config, on top of Vite's usual
  `build`/`server`/`resolve`/`test` keys.
- Vite+ also seems to provide a Vitest-compatible `test` config surface directly
  (`vite-plus/test/config`'s `defineProject`), and a `pack` config block used specifically for
  non-web bundle targets (Node CLI binaries, Electron main/preload — see apps/desktop and
  apps/server below), which upstream Vite does not have (that's normally esbuild/tsup/electron-vite
  territory).
- Linting is **not ESLint/Prettier directly** — `vp lint` runs a linter built on **Oxlint**
  (`oxlint-plugin-t3code/` is a custom Oxlint JS-plugin directory; `"@oxlint/plugins": "^1.63.0"` in
  devDependencies; the `lint.plugins` config array in `vite.config.ts` is literally
  `["eslint", "oxc", "react", "unicorn", "typescript"]`, meaning Vite+'s lint runner shims/emulates
  ESLint-plugin-equivalent rule sets on top of Oxlint/oxc for speed). Formatting (`vp fmt`) is also
  Vite+'s own formatter, not Prettier.
- TypeScript type-checking is deliberately **decoupled from lint** (`typeAware: false, typeCheck:
  false` in the lint options) and instead done by `@typescript/native-preview`'s `tsgo`
  (Microsoft's Go-native TS compiler preview) — every package's `typecheck` script is `tsgo
  --noEmit`, and the top-level `vp run -r typecheck` / `tc` alias fans this out across the
  workspace with a concurrency limit. `@effect/tsgo` (a codemod/patch tool for Effect + tsgo
  interop) also runs at `prepare` time via `effect-tsgo patch`.

So concretely, "Vite+ stack" in this repo means: **pnpm workspace + Vite+ (`vp`) as the unified
dev-server/bundler/task-runner/linter/formatter/test-runner, with Vite itself vendored through
`@voidzero-dev/vite-plus-core`, Oxlint-based linting, and Microsoft's `tsgo` native-preview compiler
for type checking** — a fully "post-Node-tooling-fragmentation" stack (no separate Turborepo, no
ESLint+Prettier+tsc trio, no Babel except where React Compiler needs it).

## 3. Repo layout (pnpm workspace, `pnpm-workspace.yaml`)

```
packages:
  - apps/*
  - infra/*
  - oxlint-plugin-t3code
  - packages/*
  - scripts
```

Top level:
```
.agents .claude .codex .cursor .devcontainer .env.example .gitattributes .github
.macroscope .mcp.json .plans .repos .vite-hooks .vscode
AGENTS.md CLAUDE.md CONTRIBUTING.md LICENSE README.md app.json
apps assets docs experiments infra native package.json packages patches
pnpm-lock.yaml pnpm-workspace.yaml scripts t3.json tsconfig.base.json vite.config.ts
```

`apps/`:
| app | package name | role |
|---|---|---|
| `apps/server` | `t3` (bin `t3`) | The published CLI + execution runtime. Orchestration, provider drivers, checkpointing, VCS, terminals, filesystem, auth, HTTP+WS surface. Also serves the built web app. |
| `apps/web` | `@t3tools/web` | React + Vite UI (browser + embedded-in-Electron), routing via TanStack Router, shared client runtime. |
| `apps/desktop` | `@t3tools/desktop` | Electron shell — supervises a desktop-scoped `t3` backend, loads the web bundle over a custom `t3code://` protocol, owns SSH-managed remote environments. |
| `apps/mobile` | `@t3tools/mobile` | Expo/React Native client, same client-runtime composition as web. |
| `apps/marketing` | `@t3tools/marketing` | Astro marketing site (t3.codes homepage). |

`packages/`:
| package | role |
|---|---|
| `contracts` (`@t3tools/contracts`) | Shared **Effect Schema** definitions: RPC group, orchestration commands/events/read model, auth scopes, environment descriptors, settings. |
| `shared` (`@t3tools/shared`) | Framework-agnostic utilities (DrainableWorker, git/source-control helpers, relay auth/signing, DPoP, semver, logging, observability). |
| `client-runtime` (`@t3tools/client-runtime`) | Connection lifecycle, auth, RPC session, environment registry, Atom-based domain state — shared by web + mobile. |
| `ssh` (`@t3tools/ssh`) | SSH config parsing, auth prompts, command execution, tunnel/environment manager for desktop-managed SSH environments. |
| `tailscale` (`@t3tools/tailscale`) | Tailscale CLI wrapper + serve lifecycle. |
| `effect-acp` | Effect implementation of the Agent Client Protocol (used by ACP-speaking provider drivers). |
| `effect-codex-app-server` | Effect client for the `codex app-server` JSON-RPC protocol. |

Other: `native/resource-monitor` (Rust/Cargo, built with `cargo build --release`, used for resource
telemetry), `infra/relay` (`t3code-relay`, the hosted "T3 Connect" relay for environment discovery /
mobile notifications, deployed with **Alchemy**), `oxlint-plugin-t3code` (custom lint rules), `.macroscope`
(unclear tool, likely internal), `.vite-hooks`, `.repos` (synced reference repos via
`scripts/sync-reference-repos.ts`), `experiments/` (throwaway prototypes, not shipped).

## 4. Architecture (from `docs/internals/overview.md`)

T3 Code is a **server runtime** that owns agent sessions, workspaces, and version control, plus thin
clients (web/desktop/mobile) that talk to it over **one authenticated Effect RPC WebSocket**. All
provider process execution, terminals, git ops, and filesystem reads happen server-side, never in
the client.

```
Clients (apps/web, apps/desktop, apps/mobile)
  shared runtime: packages/client-runtime (connection supervisor, RPC session, Atom state)
        │  Effect RPC over WebSocket (/ws); contract: packages/contracts
apps/server
  event-sourced orchestration engine; provider driver registry (5 built-in drivers);
  checkpointing, VCS, terminals, filesystem
        │  per-driver transport
Agent CLIs: Codex, Claude, Cursor, Grok, OpenCode
```

Key architectural facts:
- **RPC layer**: an Effect RPC group (`WS_METHODS` / `WsRpcGroup` in `packages/contracts/src/rpc.ts`),
  not a hand-rolled push protocol. Streaming methods (`orchestration.subscribeShell`,
  `orchestration.subscribeThread`, `terminal.attach`, etc.) replace a broadcast bus — clients
  subscribe only to what they need. `apps/server/src/ws.ts` mounts `GET /ws`, authenticates the
  upgrade (`EnvironmentAuth.authenticateWebSocketUpgrade`), and per-method scopes are enforced via
  `RPC_REQUIRED_SCOPE` + `authorizeEffect`/`authorizeStream`.
- **Orchestration is event-sourced**: clients dispatch typed commands → `OrchestrationEngine.ts`
  serializes them through a single worker fiber (`commandQueue`) → `decider.ts`
  (`decideOrchestrationCommand`, pure) turns command+state into events → events + read-model
  projection + accepted receipt are written in one SQL transaction (`projector.ts`) → committed
  events publish to subscribers.
- **Drainable workers** (`packages/shared/src/DrainableWorker.ts`) run async follow-up work:
  `ProviderRuntimeIngestion` (normalizes provider streams into commands), `ProviderCommandReactor`
  (dispatches provider calls), `CheckpointReactor` (captures/reverts workspace checkpoints).
- **Provider drivers**: 5 built-in (`apps/server/src/provider/builtInDrivers.ts`
  `BUILT_IN_DRIVERS`) — Codex, Claude, Cursor, Grok, OpenCode — each declares a kind + config
  schema and a scoped adapter; `ProviderInstanceRegistry`/`ProviderAdapterRegistry` route by kind.
- **Checkpointing**: each turn bracketed by workspace checkpoints stored as **hidden Git refs**
  (`CheckpointStore`, `VcsCheckpointOps` contract, Git implementation in `GitVcsDriverCore.ts`);
  `CheckpointDiffQuery` answers diff requests; reverting undoes both filesystem and provider
  conversation state.
- **Startup sequence** (`serverRuntimeStartup.ts`): keybindings/settings/reactors →
  welcome → command-readiness signal (logged "Accepting commands") → wait for HTTP listener → ready
  → heartbeat fork → headless output or open browser. Command readiness precedes the HTTP listener.

## 5. Electron handling (apps/desktop)

`apps/desktop/package.json` (`@t3tools/desktop`, v0.0.31, productName **"T3 Code (Alpha)"**):
```json
{
  "main": "dist-electron/main.cjs",
  "dependencies": {
    "@clerk/electron": "catalog:",
    "@clerk/electron-passkeys": "catalog:",
    "@effect/platform-node": "catalog:",
    "@t3tools/client-runtime": "workspace:*",
    "@t3tools/contracts": "workspace:*",
    "@t3tools/shared": "workspace:*",
    "@t3tools/ssh": "workspace:*",
    "@t3tools/tailscale": "workspace:*",
    "effect": "catalog:",
    "electron": "41.5.0",
    "electron-store": "^8.2.0",
    "electron-updater": "^6.6.2",
    "playwright-core": "1.60.0",
    "react-grab": "^0.1.32"
  },
  "devDependencies": {
    "@effect/vitest": "catalog:",
    "@types/node": "catalog:",
    "cross-env": "^10.1.0",
    "electron-builder": "26.15.6",
    "tailwindcss": "^4.0.0",
    "vite-plus": "catalog:"
  }
}
```

Notable points:
- **Not electron-vite / electron-forge** — the Electron main/preload bundles are produced by
  **Vite+'s own `pack` config block** (`apps/desktop/vite.config.ts`), a Node/CJS bundling target
  distinct from Vite's normal browser `build`. Four separate `pack` entries are defined, each
  compiled to CommonJS (`format: "cjs"`, `outExtensions: () => ({ js: ".cjs" })`) into
  `dist-electron/`:
  1. `src/main.ts` — the Electron main process (`dependsOn: ["t3#build"]`, i.e. it waits for the
     server package to build first, and always bundles any `@t3tools/*` package inline since those
     can't be resolved at runtime from inside the packaged ASAR).
  2. `src/preload.ts` — the preload script (also inlines `@clerk/electron` for the same ASAR
     resolution reason).
  3. `src/preview-pick-preload.ts` — inlines `react-grab` (an element-picking/DOM-inspection lib,
     used for an in-app "preview" element picker feature).
  4. `src/preview-pip-preload.ts` — picture-in-picture preview preload.
- **Packaging/distribution** uses **electron-builder** (`"electron-builder": "26.15.6"`), invoked via
  `scripts/build-desktop-artifact.ts` and root scripts `dist:desktop:dmg[:arm64|:x64]`,
  `dist:desktop:linux` (AppImage), `dist:desktop:win[:arm64|:x64]` (nsis).
- **Auto-update**: `electron-updater` (`^6.6.2`) + a `mock-update-server.ts` script and
  `docs/internals/server-updates.md` — release channels (`latest`/`nightly`) baked in via
  `__T3CODE_BUILD_CHANNEL__` define.
- **Auth**: Clerk, via `@clerk/electron` + `@clerk/electron-passkeys` (passkey support inside
  Electron specifically — unusual, most Electron apps punt auth to a webview).
- **Local secrets**: `electron-store` for persisted app settings; Electron's `safeStorage` API is
  wrapped as `ElectronSafeStorage.ts`.
- **The desktop app doesn't reimplement the backend** — it "supervises a desktop-scoped `t3`
  backend" (spawns/manages the same Node.js server package used by the CLI, `apps/server`) and
  loads the built `apps/web` bundle through a custom **`t3code://` protocol** handler
  (`ElectronProtocol.ts`), rather than `file://` or a dev server URL, for CSP/security reasons.
- **Remote/SSH/WSL support**: the desktop app owns SSH-managed remote dev environments
  (`packages/ssh`, `src/ssh/DesktopSshEnvironment.ts`) and WSL backends
  (`src/wsl/DesktopWslBackend.ts`, `DesktopWslEnvironment.ts`) — i.e. it can run/control a `t3`
  backend on a remote machine or inside WSL, not just locally.
- Everything in `apps/desktop/src/main.ts` is composed as **Effect `Layer`s** (`ElectronApp`,
  `ElectronDialog`, `ElectronMenu`, `ElectronPowerMonitor`, `ElectronProtocol`,
  `ElectronSafeStorage`, `ElectronShell`, `ElectronTheme`, `ElectronUpdater`, `ElectronWindow`,
  `DesktopIpc`, plus ~20 more Desktop* layers for settings, backend pool, telemetry, previews,
  etc.) — i.e. even the Electron main process is written in the Effect ecosystem style, not plain
  imperative Node/Electron code.
- `apps/desktop/src/` subfolders: `app/`, `backend/`, `electron/`, `ipc/`, `preview/`, `settings/`,
  `shell/`, `ssh/`, `telemetry/`, `updates/`, `window/`, `wsl/`.

## 6. Web app (apps/web) — full frontend stack

`apps/web/package.json` (`@t3tools/web`, v0.0.31):

Runtime dependencies (selected, with versions from the repo):
- **UI framework**: `react` 19.2.6, `react-dom` 19.2.6
- **Routing**: `@tanstack/react-router` ^1.160.2 (+ devDep `@tanstack/router-plugin` ^1.161.0 —
  file-based routing codegen, `routeTree.gen.ts` is explicitly gitignored/format-excluded)
- **State**: `@effect/atom-react` (catalog, Effect's Atom-based reactive state — this is the "state
  management" layer, not Redux/Zustand as primary, though `zustand` ^5.0.11 is also present)
- **Styling**: **Tailwind CSS v4** (`tailwindcss` ^4.0.0 devDep + `@tailwindcss/vite` ^4.0.0 plugin —
  no PostCSS config file needed, Tailwind v4's native Vite plugin), `tailwind-merge` ^3.4.0,
  `class-variance-authority` ^0.7.1 (cva — classic shadcn/ui pattern)
- **Component system**: `components.json` present → **shadcn/ui**, but using a **custom registry/theme**:
  `"style": "base-mira"`, `baseColor: "zinc"`, custom third-party registries `@coss` and `@spell`
  (`https://coss.com/ui/r/{name}.json`, `https://spell.sh/r/{name}.json`) alongside the default
  shadcn registry. Icons via `lucide-react` ^0.564.0.
- **Auth**: `@clerk/react` (catalog), `@clerk/electron` (shared with desktop for the Electron-embedded case)
- **Editor/rich text**: `lexical` ^0.41.0 + `@lexical/react` ^0.41.0 (Meta's rich text editor
  framework — likely used for the chat/prompt composer)
- **Terminal**: `@xterm/xterm` ^6.0.0 + `@xterm/addon-fit` ^0.11.0 (in-app terminal emulator,
  matches `node-pty` on the server side)
- **Diffs**: `@pierre/diffs` (catalog) + `@pierre/trees` 1.0.0-beta.4 (Pierre.co's diff-rendering
  library — code review / diff viewer UI)
- **Drag & drop**: `@dnd-kit/core` ^6.3.1, `@dnd-kit/modifiers`, `@dnd-kit/sortable`, `@dnd-kit/utilities`
- **Lists/virtualization**: `@legendapp/list` 3.2.0
- **Markdown**: `react-markdown` ^10.1.0, `remark-gfm`, `remark-breaks`, `rehype-raw`, `rehype-sanitize`
- **Misc**: `@formkit/auto-animate` ^0.9.0, `@tanstack/react-pacer` ^0.19.4 (debounce/throttle
  utilities), `jose` (catalog, JWT), fonts via `@fontsource-variable/dm-sans` and
  `@fontsource/jetbrains-mono`
- **Effect ecosystem**: `effect` (catalog), used pervasively (see `@effect/atom-react`)

Dev dependencies of note:
- `@vitejs/plugin-react` ^6.0.0 + `babel-plugin-react-compiler` 1.0.0 + `@rolldown/plugin-babel`
  ^0.2.0 → **React Compiler** is enabled (`reactCompilerPreset()` passed into the babel plugin
  in `vite.config.ts`), and the underlying bundler is confirmed to be **Rolldown** (the
  Rust-based Rollup successor that Vite is migrating to; `@rolldown/plugin-babel` is Rolldown's own
  Babel integration).
- `msw` 2.12.11 (Mock Service Worker, `workerDirectory: "apps/web/public"` declared at the
  monorepo root `package.json`) for API mocking in tests/dev.
- `@vercel/config` ^0.3.0, `vercel.ts` present → the **web app is deployed on Vercel** (hosted
  companion to the desktop app, at `app.t3.codes`).

`apps/web/vite.config.ts` highlights:
```ts
import tailwindcss from "@tailwindcss/vite";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import babel from "@rolldown/plugin-babel";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import { defineConfig } from "vite-plus";
...
export default defineConfig(() => ({
  plugins: [
    tanstackRouter(),
    react(),
    babel({ parserOpts: { plugins: ["typescript", "jsx"] }, presets: [reactCompilerPreset()] }),
    tailwindcss(),
  ],
  ...
}));
```
Also notable: a **single-origin dev proxy** design so the same web build works unmodified over
localhost, Tailscale/LAN, or a phone (`DEV_PROXIED_PATH_PREFIXES`, `allowedHosts: [".ts.net", ...]`
to permit Tailscale MagicDNS hostnames through Vite's Host-header check), and an **experimental
Vite 8.1 "bundled dev mode"** toggle (`T3CODE_BUNDLED_DEV=1`) for faster HMR on large graphs.

## 7. Server (apps/server) — the actual `t3` CLI/runtime

`apps/server/package.json` (name **`t3`**, bin `t3` → `dist/bin.mjs`, v0.0.31, published to npm,
`engines.node: "^22.16 || ^23.11 || >=24.10"`):

```json
"dependencies": {
  "@anthropic-ai/claude-agent-sdk": "^0.3.170",
  "@effect/platform-bun": "catalog:",
  "@effect/platform-node": "catalog:",
  "@effect/platform-node-shared": "catalog:",
  "@effect/sql-sqlite-bun": "catalog:",
  "@ff-labs/fff-node": "0.9.4",
  "@opencode-ai/sdk": "^1.3.15",
  "@pierre/diffs": "catalog:",
  "effect": "catalog:",
  "node-pty": "^1.1.0",
  "yaml": "catalog:"
}
```

- Directly depends on the **official `@anthropic-ai/claude-agent-sdk`** (this is how Claude Code
  integration works) and **`@opencode-ai/sdk`** for OpenCode; Codex/Cursor/Grok integration is via
  `packages/effect-acp` (Agent Client Protocol) and `packages/effect-codex-app-server`
  (Codex's `app-server` JSON-RPC protocol) rather than a published SDK.
  package.json).
- **SQLite** persistence via `@effect/sql-sqlite-bun` — event store + projections live in SQLite.
  (Note: even though it says "sqlite-bun", the actual `npm start` runtime is plain Node — Bun
  platform packages are present for a Bun-targeted build path, `@effect/platform-bun` catalog dep,
  but the shipped CLI runs on Node via `NodeRuntime`/`NodeServices`.)
  `@effect/platform-node-shared` and `@effect/platform-node` are the primary Node integration.
- **PTY/terminal**: `node-pty` ^1.1.0 (native addon) — backs the in-app terminal (`terminal.attach`
  RPC stream) and drives interactive CLI subprocesses.
- The server's own `pack` build (via Vite+ again) bundles `src/bin.ts` to `dist/bin.mjs` with a
  shebang banner (`#!/usr/bin/env node`), bundling all `@t3tools/*`, `@pierre/diffs`, `effect-acp`,
  `effect-codex-app-server` inline (`alwaysBundle`), and its `build` task `dependsOn:
  ["@t3tools/web#build"]` — **the server build embeds/serves the already-built web bundle** (see
  overview.md: "Also serves the built web app").
- Build-time constants baked in via `define`: `__T3CODE_BUILD_CHANNEL__` (latest/nightly based on
  whether the version string contains `-nightly.`), relay URL, Clerk publishable key, Clerk OAuth
  client ID, OTLP tracing endpoint/dataset/token — i.e. telemetry and auth config are compiled in,
  not runtime env-read, for the distributed CLI binary.
- Test config disables file parallelism (`fileParallelism: false`) because the integration tests
  hit real sqlite/git/temp-worktree state, with 120s hook/test timeouts.

## 8. Mobile (apps/mobile) and marketing (apps/marketing)

- Mobile: **Expo/React Native** (root `app.json` has an empty `"expo": {}` block; workspace has
  `expo-modules-jsi`, `@expo/metro-config`, `@react-native-menu/menu`, `@react-navigation/native-stack`,
  `react-native-gesture-handler`, `react-native-keyboard-controller`, `react-native-nitro-modules`,
  `react-native-screens`, `@legendapp/list` — all visible as patched dependencies in
  `pnpm-workspace.yaml`'s `patchedDependencies`). Same `packages/client-runtime` composition as web,
  differing only in the platform layer supplied (background-activity handling) and native UI.
- Marketing: **Astro** (`@t3tools/marketing`, `vp run --filter @t3tools/marketing dev/build/preview`).

## 9. TypeScript configuration

Root `tsconfig.base.json` (every package extends this):
```json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "noEmit": true,
    "allowImportingTsExtensions": true,
    "rewriteRelativeImportExtensions": true,
    "erasableSyntaxOnly": true,
    "verbatimModuleSyntax": true,
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "noImplicitOverride": true,
    "useDefineForClassFields": true,
    "forceConsistentCasingInFileNames": true,
    "skipLibCheck": true,
    "allowSyntheticDefaultImports": true,
    "esModuleInterop": true,
    "resolveJsonModule": true,
    "plugins": [{ "name": "@effect/language-service", "...": "extensive Effect-specific lint rules" }]
  }
}
```
Extremely strict: `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`,
`noImplicitOverride` all on. `erasableSyntaxOnly` + `rewriteRelativeImportExtensions` +
`allowImportingTsExtensions` indicate they write `.ts` extensions in relative imports (Node ESM
style, e.g. `import "./decider.ts"`) and rely on TypeScript's newer "erasable syntax" mode (no
`enum`/parameter-properties/namespaces — the subset of TS that type-strips 1:1 without a real
compiler step), which pairs with running on Node directly via `--experimental-strip-types`/tsx-less
execution. TypeScript version pinned: `typescript: "~6.0.3"` in the catalog, alongside
`@typescript/native-preview: "7.0.0-dev.20260604.1"` — i.e. they're pinned to the **native Go-based
TypeScript compiler preview (tsgo)** for actual type-checking, ahead of general availability. Every
package's `typecheck` script is simply `tsgo --noEmit`.
- `@effect/language-service` plugin encodes ~20 Effect-specific correctness rules as TS plugin
  diagnostics (e.g. `globalConsole`, `globalFetch`, `globalRandom`, `globalTimers` all set to
  `"error"` — meaning direct use of `console`/`fetch`/`Math.random`/`setTimeout` outside Effect's
  wrapped equivalents is a type-level error), reinforcing that **Effect-TS is the dominant runtime
  paradigm across the whole codebase**, not just a dependency.

## 10. Linting, formatting, testing (CI: `.github/workflows/ci.yml`, docs/internals/ci.md)

- **Format**: `vp fmt` (Vite+'s own formatter, config in root `vite.config.ts`'s `fmt` block:
  ignore patterns for generated/vendor files, `sortPackageJson: {}`, and a per-file override for
  `.devcontainer/devcontainer.json` to disable trailing commas). Pre-commit: `staged: { "*": "vp fmt" }`
  (formatter only, no lint/typecheck on commit, per an explicit code comment).
- **Lint**: `vp lint --report-unused-disable-directives`, Oxlint-based (`plugins: ["eslint", "oxc",
  "react", "unicorn", "typescript"]`), plus a repo-local custom plugin
  (`oxlint-plugin-t3code/index.ts`) providing rules like `t3code/no-global-process-runtime`,
  `t3code/no-inline-schema-compile`, `t3code/no-manual-effect-runtime-in-tests`,
  `t3code/namespace-node-imports`. Type-aware linting explicitly disabled
  (`typeAware: false, typeCheck: false`) — type checking is tsgo's job, not the linter's.
- **Typecheck**: `vpr typecheck` (Vite+ "run" across workspace) / root aliases `typecheck`/`tc` →
  `vp run -r --concurrency-limit 2 typecheck`, each package running `tsgo --noEmit`.
- **Test**: Vitest via Vite+'s test integration (`vite-plus/test/config`), root `vp run -r test`;
  per-app Vitest projects (e.g. `apps/web` defines a `unit` project with custom hook/test timeouts
  for websocket/auth-bootstrap tests). `@effect/vitest` (catalog) is the Effect-aware Vitest
  integration used throughout for testing Effect programs.
- **CI** (`.github/workflows/ci.yml`) runs 4 jobs on PRs/pushes to `main`:
  1. **Check** — `vp check` (fmt+lint) then `vpr typecheck`, plus builds the desktop pipeline
     (`vp run build:desktop`) and verifies the preload bundle exists with expected exports.
  2. **Test** — `vp run test` across the workspace.
  3. **Mobile Native Static Analysis** — `vp run lint:mobile` on macOS
     (`scripts/mobile-native-static-check.ts`).
  4. **Release Smoke** — `scripts/release-smoke.ts` exercises release-only steps on every PR so
     release breakage is caught before tag time.
  `.github/workflows/release.yml` builds macOS (arm64+x64), Linux (x64), Windows (x64) desktop
  artifacts from a single `v*.*.*` tag via electron-builder and publishes one GitHub release;
  auto-signs when platform credentials are present (macOS passkey builds need `APPLE_TEAM_ID` +
  `MACOS_PROVISIONING_PROFILE`; Windows uses Azure Trusted Signing); ships unsigned artifacts
  otherwise.
- **Rust**: `native/resource-monitor` has its own `cargo build --release` / `cargo test` scripts,
  wired into the root `package.json` (`build:resource-monitor`, `test:resource-monitor`).

## 11. Package manager / dependency management details

- **pnpm 11.10.0** (`packageManager` field), Node `^24.13.1` engine at the workspace root
  (individual apps have looser ranges, e.g. server allows Node 22.16+/23.11+/24.10+).
- Heavy use of **pnpm catalogs** (`catalog:` protocol) to pin shared versions across the monorepo —
  Effect ecosystem (`effect` 4.0.0-beta.102 and all `@effect/*` packages), Clerk packages, `vite`/
  `vite-plus`, `@types/node`, `@typescript/native-preview`, `jose`, `yaml`.
- **`allowBuilds`** (new in pnpm 11, replaces `onlyBuiltDependencies`) explicitly allow-lists which
  deps may run install scripts: `electron`, `esbuild`, `msgpackr-extract`, `node-pty`, `sharp` = true;
  `browser-tabs-lock`, `bufferutil`, `core-js`, `electron-winstaller`, `msw`, `utf-8-validate`,
  `workerd` = false.
- Extensive `patchedDependencies` (pnpm patch files) for Effect platform packages, Expo/React Native
  native modules, and `@pierre/diffs`.
- `minimumReleaseAgeExclude` list — likely paired with a pnpm "minimum release age" supply-chain
  safety setting (delay adopting brand-new npm publishes) with specific fast-moving/beta packages
  exempted.
- Everything on the effect side is pinned to **Effect 4.0.0-beta.102** — i.e. this codebase runs on
  a pre-release major version of Effect-TS.

## 12. Summary: concrete "Vite+ stack" dependency fingerprint

- Monorepo: pnpm workspace, pnpm 11, catalogs
- Build/task runner: **Vite+ (`vite-plus` / `vp`)**, wrapping Vite (via `@voidzero-dev/vite-plus-core`)
  + Rolldown bundler, replacing Turborepo/Nx, ESLint+Prettier, and partially tsup/electron-vite
- Backend runtime paradigm: **Effect-TS** (v4 beta) end-to-end — server, desktop main process, CLI,
  contracts, client runtime, tests (`@effect/vitest`)
- Frontend: React 19 + React Compiler, TanStack Router, Tailwind CSS v4, shadcn/ui (custom "base-mira"
  theme + custom component registries), Clerk auth, Lexical editor, xterm.js terminal, Pierre diffs
- Desktop: Electron 41, packaged via **Vite+'s own `pack` bundler** (not electron-vite/forge) +
  **electron-builder** for installers, `electron-updater` for auto-update, Clerk-in-Electron auth
  incl. passkeys, custom `t3code://` protocol, SSH/WSL remote environment support
- Server/CLI: Node.js (published as npm package `t3`), `@anthropic-ai/claude-agent-sdk` +
  `@opencode-ai/sdk` + custom ACP/Codex-app-server Effect clients, SQLite via `@effect/sql-sqlite-bun`,
  `node-pty` for terminals, event-sourced orchestration engine over Effect RPC/WebSocket
- Mobile: Expo/React Native, same client-runtime package as web
- Marketing site: Astro
- Native: Rust (`native/resource-monitor`, Cargo)
- Types: strict TypeScript 6 config, checked by Microsoft's native **tsgo** compiler preview, plus
  an `@effect/language-service` TS plugin enforcing Effect idioms at the type level
- Lint/format: Oxlint-based linter + custom Oxlint plugin, Vite+'s own formatter (no Prettier)
- CI: GitHub Actions (check/test/mobile-lint/release-smoke on PRs; multi-platform electron-builder
  release pipeline on tags)

## 13. On "the T3 stack" / create-t3-app relationship

Because the org is `pingdotgg` (Theo Browne's org, also behind `create-t3-app` and `t3.chat`), it's
worth noting explicitly: **this is a different product from the classic "T3 Stack"**
(Next.js + tRPC + Prisma/Drizzle + NextAuth + Tailwind, scaffolded by `create-t3-app`). There is no
tRPC, no Next.js, no Prisma/Drizzle, and no NextAuth anywhere in this repo — it uses Effect RPC
(not tRPC) over WebSocket, React+Vite (not Next.js) for the web client, SQLite via Effect SQL (not
Drizzle/Prisma) for server persistence, and Clerk (not NextAuth/Auth.js) for auth. The only
throughline from the "T3" brand is the org/company and the general philosophy of "opinionated,
type-safe, minimal-magic tooling" — here expressed via Effect-TS + Vite+ instead of tRPC +
Next.js. If the user's actual intent was researching **create-t3-app** / the classical T3 Stack for
an Electron+Vite app, that is a distinct, older project (Next.js-oriented) and would need separate
research — flag this back to the user if the task turns out to need that instead.
