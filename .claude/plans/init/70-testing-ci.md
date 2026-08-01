# 70 — Testing, CI, and Repo Workflow

> Parent: [00-overview.md](00-overview.md) · Related: [60-export.md](60-export.md) §7 (export-specific tests), [80-roadmap.md](80-roadmap.md) (PR breakdown)

## 0. Constraints that shape everything here

1. **GitHub Actions minutes are limited.** CI runs **unit tests and lint only**. No `tsc` full-project build, no `electron-vite build`, no `electron-builder` packaging, no Playwright, no Electron. Compilation and packaging happen locally and at release time, on a developer machine. This is a deliberate, load-bearing constraint, not an oversight — see §3.
2. **The app is Electron.** Anything touching `webContents`, `BrowserWindow`, `printToPDF`, or `capturePage` cannot run in a plain Node test process and cannot run in CI. Those tests are local-only by construction, so the architecture must push as much logic as possible *out* of Electron-dependent code.
3. **Slides are self-contained HTML documents.** The most valuable integration test in the project — "does this slide honour the contract?" — needs a browser but *not* Electron. Playwright against Chromium covers it, and [`experiments/init/harness/render.mjs`](../../../experiments/init/harness/render.mjs) already proves the pattern works.

Constraint 1 has a design consequence worth stating outright: **testability pressure pushes logic into pure functions.** The document model, patching, export mapping, and confidence scoring are all designed to be pure and Electron-free precisely so they are cheap to test in CI. Electron code becomes a thin, boring shell whose failures are obvious.

---

## 1. The test pyramid

```
                    ┌───────────────────────────────┐
                    │  Manual / release checklist   │   ~30 min, per release, human
                    │  real PowerPoint, Win + macOS │
                    ├───────────────────────────────┤
                    │  Electron smoke (local)       │   ~2 min, pre-merge on risky PRs
                    │  app boots, IPC, export e2e   │
                    ├───────────────────────────────┤
                    │  Playwright integration       │   ~30 s, local + pre-release
                    │  slide-contract validation    │
                    ├───────────────────────────────┤
                    │  Vitest unit  ◄── CI RUNS ONLY THIS ──┐   < 15 s, every push
                    │  doc model, patching, export mapping  │
                    └───────────────────────────────────────┘
```

| Layer | Runner | Where | Speed | Gate |
|---|---|---|---|---|
| Unit | vitest | **CI** + local watch | < 15 s | Blocks merge |
| Integration (slide contract) | Playwright + chromium | Local, pre-release | ~30 s | Blocks release |
| Electron smoke | custom script + Electron | Local | ~2 min | Blocks release; run on risky PRs |
| Manual | human | Local, Win + macOS | ~30 min | Blocks release |

The pyramid is deliberately bottom-heavy. The point is not test-count vanity — it is that the only layer that runs automatically on every change must be the one that is fast and free, so it must also be the one that carries the most correctness weight.

---

## 2. Layer 1 — Vitest unit tests

### 2.1 Setup

```
vitest.config.ts          # root; projects for main / renderer / shared
src/shared/**/*.test.ts   # colocated with source
```

```ts
// vitest.config.ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      { test: { name: 'shared', environment: 'node',    include: ['src/shared/**/*.test.ts'] } },
      { test: { name: 'main',   environment: 'node',    include: ['src/main/**/*.test.ts'] } },
      { test: { name: 'renderer', environment: 'jsdom', include: ['src/renderer/**/*.test.{ts,tsx}'],
                setupFiles: ['./test/setup-renderer.ts'] } },
    ],
    coverage: { provider: 'v8', reporter: ['text', 'json-summary'],
                include: ['src/shared/**', 'src/main/document/**', 'src/main/export/**'] },
  },
});
```

**`electron` is never imported by tested code.** Modules that need it take their Electron dependencies as injected parameters (`(webContents: PrintablePage) => ...`) behind a narrow local interface, so tests pass a fake. The one place this is enforced: a lint rule forbidding `import ... from 'electron'` anywhere outside `src/main/electron/**`.

### 2.2 What gets unit-tested

**Document model** ([30-slide-format.md](30-slide-format.md)) — the highest-value target, since every feature funnels through it.
- `.sloodge` parse → model → serialize round-trip is byte-stable (property test over generated decks).
- Schema validation: rejects missing slide IDs, duplicate IDs, out-of-range indices, unknown version; accepts and migrates each historical version fixture.
- Slide CRUD: insert at index, delete, reorder, duplicate (fresh IDs, no `data-sl-id` collisions).
- Version migration: for every `v_n → v_{n+1}` migration there is a frozen fixture deck at `v_n` and an expected output. Migrations are append-only and never edited after shipping.
- `data-sl-id` injection: stable across reparse, unique, preserved by unrelated edits, regenerated only for genuinely new elements.

**Patching** ([40-design-mode.md](40-design-mode.md)) — byte-span edits are exactly the kind of code that is subtly wrong and cheap to test.
- Byte-span property edits: replacing a style value updates only the intended span; surrounding bytes are untouched (assert on the full string, not a substring).
- Multi-edit application: overlapping spans are rejected; non-overlapping spans apply right-to-left so earlier offsets stay valid.
- Idempotence: applying the same patch twice equals applying it once.
- Malformed input: unclosed tags, HTML comments containing `>` , `<script>` bodies containing `</div>` strings, CDATA — the patcher must refuse rather than corrupt.
- Undo/redo: inverse patch of every patch restores the exact prior bytes; a random 200-operation sequence followed by 200 undos returns the original document (property test — this one has caught real bugs in every editor that has written it).

**Export mapping** ([60-export.md](60-export.md) §7.2) — pure functions over recorded `SlideNode[]` fixtures.
- px→in / px→pt conversions; the 1280×720 → 13.333×7.5 identity.
- Colour parsing and `rgba` → `{ color, transparency }`.
- Node classification (leaf-text rule, container-paint rule, invisible rejection).
- Confidence scorer: table-driven, one case per signal, plus caps, plus hard blockers, plus the four boundary fixtures.
- Tier selection decision table (auto / force-editable / force-raster / per-slide override).
- Text-run building, bullets, hyperlinks, font mapping + substitution warnings.
- `deck.json` manifest and filename slugging.

**Agent integration** ([50-agent-integration.md](50-agent-integration.md)) — no live API calls in tests, ever.
- MCP tool-input schema validation: each slide-CRUD tool accepts its valid shapes and rejects malformed ones.
- Tool-result serialization.
- Streaming-event reducer: a recorded transcript of SDK events replays to the expected UI state. Transcripts are committed JSON fixtures captured once from a real session.
- Permission gate: a tool call requiring approval never reaches the executor without an approval record.

**Renderer (jsdom)** — thin, and kept thin.
- Zustand store reducers: slide selection, dirty tracking, undo stack depth, export-progress state machine.
- Pure UI helpers: slide-thumbnail scaling math, keyboard-accelerator mapping (Ctrl vs ⌘), range parsing for the export dialog (`1,3,5-9`).
- Not tested here: React component rendering beyond smoke-mounting a couple of critical surfaces. Component-level DOM assertions are high-maintenance and low-yield relative to the store tests underneath them.

### 2.3 Conventions

- **Colocated** `*.test.ts` next to source. Shared fixtures in `test/fixtures/`.
- **Golden files** (recorded `SlideNode[]`, migration decks, agent transcripts) live in `test/fixtures/` and are regenerated by explicit scripts (`pnpm fixtures:regen`), never hand-edited. A regeneration shows up as a reviewable diff — that diff *is* the change review.
- **No snapshot tests of large blobs.** Snapshots are permitted only for small, human-readable outputs where the diff is the assertion. A 400-line auto-updated snapshot is a test that asserts nothing.
- **Property tests** (`fast-check`) for the three invariants above that are worth it: serialize/parse round-trip, undo/redo inverse, patch idempotence.
- **Determinism**: no `Date.now()`, no `Math.random()`, no real filesystem in unit tests. IDs come from an injected generator; time from an injected clock. `memfs` where a filesystem shape is genuinely part of the unit.
- **Coverage** is reported but **not gated**. A threshold gate on a codebase this young mostly produces tests written to satisfy the gate. Coverage of `src/shared` and `src/main/document` is watched informally; a PR that drops it noticeably gets a comment, not a red X.

---

## 3. Layer 2 — Playwright integration (slide-contract validation)

### 3.1 What it is for

The single most important non-unit question in this project: **does a slide HTML document actually satisfy the contract?** Fits 1280×720 without overflow, no console errors, animations actually animate and loop, declared interaction hooks respond. This is precisely what the skill-iteration experiment measured, and [`experiments/init/harness/render.mjs`](../../../experiments/init/harness/render.mjs) is the working prototype: launch chromium, 1280×720 viewport, `file://` load, screenshot at `t=0/2/5 s`, capture `console` and `pageerror`, probe `[data-hover-target]` / `[data-click-target]`, emit `report.json`.

That harness is **promoted from experiment to product test infrastructure**, essentially unchanged in shape, at `test/slide-contract/harness.ts`. Keeping the same structure means the experiment's evidence and the product's tests are directly comparable, and the [review rubric](../../../experiments/init/review-rubric.md) checklist maps 1:1 onto assertions.

### 3.2 The harness, productized

```ts
// test/slide-contract/harness.ts  — evolution of experiments/init/harness/render.mjs
export type SlideReport = {
  file: string;
  overflow: { scrollW: number; scrollH: number; overflows: boolean };
  console: string[];                    // console messages + pageerrors
  frames: { t0: Buffer; t2: Buffer; t5: Buffer };
  animated: boolean;                    // any animation differed between t0 and t2
  looping: boolean;                     // still differing at t5
  hover: 'captured' | 'absent' | Buffer;
  click: 'captured' | 'absent' | Buffer;
  settled: Buffer;                      // frame after the export settle procedure
};

export async function renderSlide(file: string, opts?: { interactive?: boolean }): Promise<SlideReport>;
```

Changes from the experiment version, all driven by what the tests need to assert:

- Returns image **buffers** instead of writing PNGs, so assertions run in-process; writing to disk is opt-in for debugging (`SLOODGE_TEST_ARTIFACTS=1`).
- Adds a `settled` frame produced by the export settle procedure ([60-export.md](60-export.md) §4.1), so contract tests and export tests observe the identical state.
- Computes `animated` / `looping` via `pixelmatch` between frames rather than leaving it to a human reviewer.
- Uses a shared browser instance across the suite (`test.beforeAll`) instead of one launch per slide — 7+ launches dominate the runtime otherwise.

### 3.3 The suite

Runs against the fixture corpus: the 7 promoted experiment cases plus the 4 export-boundary fixtures ([60-export.md](60-export.md) §7.1), plus every new slide fixture a feature adds.

| Assertion | Rubric item |
|---|---|
| `overflow.overflows === false` | Visual 3 |
| `console` contains no `[error]` / `[pageerror]` | Interactivity 12 |
| `settled` frame has > 2 % non-background pixel variance (not blank) | catches `opacity: 0` entrance states |
| For animated fixtures: `animated === true` and `looping === true` | Animation 7, 8 |
| For interactive fixtures: `hover` and `click` produce a frame differing from baseline | Interactivity 10, 11 |
| Settle determinism: two runs of the settle procedure are byte-identical | export flakiness guard |
| Structural: exactly one `<style>`-scoped document, no external `http(s)` subresources | slide contract |
| Measurement pass runs without throwing; node count within band | feeds the §2.2 golden fixtures |

Contrast-and-legibility (rubric items 4, 5) and "did it match the prompt" (items 1, 2, 6, 9) stay **human/LLM-reviewed** — they are judgement calls, and the experiment already established the adversarial-review method for them. The automated suite covers the mechanical half; the [review rubric](../../../experiments/init/review-rubric.md) covers the semantic half whenever the skills change.

### 3.4 How it is run

```bash
pnpm test:slides          # full suite, ~30 s
pnpm test:slides -- -g solar
```

- Local, on demand. **Not in CI** — Playwright means downloading a browser (~150 MB) plus a container, which is exactly the kind of minute-burn the constraint forbids.
- **Required before release** and before merging any PR that touches the skills, the slide contract, or the export measurement pass. The PR description states that it was run and pastes the summary line.
- `playwright-chromium` only (never all three engines): slides render in Chromium in production, so Firefox/WebKit results would be information about browsers we don't ship.

---

## 4. Layer 3 — Electron smoke (local)

A single script, `pnpm smoke`, that boots the real app and exercises the paths that only exist in Electron. Driven by `@playwright/test`'s `_electron.launch()` — the standard way to drive Electron without a separate WebDriver stack.

```ts
const app = await _electron.launch({ args: ['out/main/index.js'] });
const win = await app.firstWindow();
```

Checklist it automates:

1. App boots; main window appears at the expected size; no main-process exception in the first 5 s.
2. `File → New` creates an empty deck; the slide rail shows one slide.
3. Open a fixture `.sloodge`; slide count and titles match; every thumbnail iframe reaches a non-blank state.
4. IPC round-trip: renderer → main slide-CRUD call mutates the document and the change reflects back in the store.
5. Undo/redo across an agent edit and a Design Mode edit returns the document to its exact prior bytes.
6. Present mode enters fullscreen, advances with `→`, exits with `Esc`.
7. Export smoke: PDF, PPTX, HTML of the fixture deck ([60-export.md](60-export.md) §7.4) — page counts, page size, OOXML structure, byte-identity of HTML slides.
8. Export cancel mid-job leaves no output file and no temp dir.
9. Clean shutdown: no orphaned hidden `BrowserWindow`, no lingering temp dir, exit code 0.

Requires a built app (`pnpm build`), which is why it cannot be CI. Run before release, and on any PR touching main-process code, IPC, or export. Takes ~2 minutes.

---

## 5. Layer 4 — Manual release checklist

Kept short enough to actually be done. Per release, on both OSes:

- Full happy path from the v1 success criteria: New → chat-generate a 5-slide deck → tweak an element in Design Mode → Present fullscreen → Export PDF + PPTX.
- Open the exported PPTX in **real PowerPoint** (Windows and macOS) and in **Google Slides**: text editable where Tier A was chosen, nothing wildly mispositioned, no black boxes, images sharp. Findings tune the confidence-score weights ([60-export.md](60-export.md) §3.4).
- Open the exported PDF in Preview/Acrobat/Chrome: page size, text selectable, backgrounds present.
- Open the exported HTML bundle from `file://`: presenter shell navigates, speaker window syncs, animations run.
- Installer: NSIS on Windows and dmg on macOS install, launch, and uninstall cleanly.
- Cold start < 3 s; slide switch < 100 ms (eyeball + one timed run).

---

## 6. GitHub Actions CI

### 6.1 Scope: unit tests only

**One workflow, one job, no matrix, ubuntu-latest only.** No build, no typecheck of the full project, no packaging, no Electron, no Playwright, no coverage upload, no cross-OS matrix. (This governs the *development* path — every PR and every push to `main`. Release packaging is a separate tag-triggered workflow that cannot fire here; see §6.5.) A 3-OS matrix triples the bill for near-zero signal on code that is 90 % platform-agnostic pure TypeScript; platform differences show up in packaging and in the Electron shell, neither of which CI touches anyway.

Typechecking is the one judgement call. Full `tsc -b` on an Electron monorepo is slow. The compromise: **`tsc --noEmit` on `src/shared` and `src/main/document` only** — the pure, dependency-light core — which is fast and catches the type errors that matter most. Full typecheck is a local pre-push concern.

### 6.2 The workflow

```yaml
# .github/workflows/ci.yml
name: CI
on:
  push:
    branches: [main]
  pull_request:

concurrency:
  group: ci-${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: true          # superseded pushes stop burning minutes immediately

permissions:
  contents: read

jobs:
  test:
    name: lint + unit tests
    runs-on: ubuntu-latest
    timeout-minutes: 10             # hard cap; a hung job must never bill for hours
    steps:
      - uses: actions/checkout@v4

      - uses: pnpm/action-setup@v4  # reads packageManager from package.json

      - uses: actions/setup-node@v4
        with:
          node-version-file: .nvmrc
          cache: pnpm               # caches the pnpm store, keyed on the lockfile

      - name: Install
        run: pnpm install --frozen-lockfile --ignore-scripts
        env:
          ELECTRON_SKIP_BINARY_DOWNLOAD: 1    # ~120 MB and ~40 s we never use in CI
          PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: 1 # ~150 MB likewise

      - run: pnpm lint
      - run: pnpm typecheck:core   # tsc --noEmit on shared + document model
      - run: pnpm test:unit -- --reporter=dot
```

Minute-saving measures, each deliberate:

| Measure | Saving |
|---|---|
| `cancel-in-progress` concurrency | Stops superseded runs on rapid pushes |
| `ELECTRON_SKIP_BINARY_DOWNLOAD` | ~40 s + bandwidth per run |
| `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD` | ~30 s + bandwidth per run |
| `--ignore-scripts` on install | Skips postinstall native rebuilds we don't need |
| `cache: pnpm` in setup-node | ~30 s once warm |
| ubuntu-latest only | 1× billing (macOS is 10×, Windows 2×) |
| `timeout-minutes: 10` | Caps the worst case |
| No `paths` filter | Intentionally omitted — path-filtered required checks turn "skipped" into "pending" and block merges; the job is cheap enough that always running it is simpler and safer |

**One deliberate exception, added in M5.2.** `pnpm-workspace.yaml`'s `supportedArchitectures` makes
every cold install — CI's included — fetch `@anthropic-ai/claude-agent-sdk-win32-x64`, a ~254 MB
binary an ubuntu runner can never execute, and `tests/unit/packaging/build-config.test.ts` asserts
its presence so it is mandatory rather than opportunistic. This is knowingly against the grain of
§1, and it is kept: without it, `electron-builder --win` cross-packed from Linux produces an
installer with **no `claude.exe` and a dead chat panel, while every build step reports success**.
The cost lands only on cache-miss runs, under a 10-minute cap for a ~7-second suite. Do not delete
`supportedArchitectures` to reclaim it without first re-reading docs/windows-smoke-runbook.md §8.

`pnpm test:unit` maps to `vitest run` (never `vitest` watch — a watch-mode invocation in CI hangs until the timeout and bills for it).

### 6.3 Branch protection

`main` requires: the `lint + unit tests` check green, and one approving review **except** for auto-merge categories (§7.2). Linear history enforced (squash or rebase merges only) — jj's model produces clean linear stacks and a merge-commit history would fight it.

### 6.4 What is explicitly *not* automated

Stated plainly so nobody adds it back without a decision: code signing and notarization (local, credentials never in CI), Playwright slide-contract tests (local), Electron smoke (local), auto-update publishing (manual release step), dependency auto-update bots (they generate PR runs, i.e. minutes, for a solo-scale repo).

Packaging *was* on this list and has moved — to §6.5, under a trigger that keeps it off the development path entirely. The rule in §6.1 is unchanged: **nothing in the PR/push path ever compiles or packages.**

### 6.5 The one exception: release packaging, tag-triggered only (M9.0)

`.github/workflows/release.yml` builds the Windows installer on `windows-latest`. It is the only workflow that compiles or packages anything, and it is allowed to exist because of exactly one property:

```yaml
on:
  push:
    tags:
      - 'v*'
```

**No `pull_request`. No `push: branches`. No `schedule`. No `workflow_dispatch`.** It therefore costs nothing during normal development — its cost is O(releases), a handful of runs a year, not O(commits). §6.1's "no packaging in CI" was always a *budget* rule rather than a purity rule, and a workflow that cannot fire outside a release does not spend the budget it protects.

The cost, stated honestly rather than hand-waved: Windows runners bill at **2x**, and a packaging run is roughly 12–15 minutes wall (install with the real Electron binary + the win32 Agent SDK CLI, `pnpm build`, then NSIS + zip). `timeout-minutes: 30` caps the worst case at ~60 billable minutes for a release. Cutting a release by hand costs more than that in human time, and it costs correctness besides — see below.

**Why it is worth spending at all.** A preview release was once hand-built from a stale worktree: the artifact predated a merged milestone, so an entire export format silently did nothing in the shipped build, and no step of the build reported a problem. Hand-built artifacts from a developer machine have no provenance — nothing ties the binary to a commit. Building from a clean checkout of the tag removes that class of bug outright. It also retires the hand-maintained duplicate builder config the manual procedure required (a throwaway `package.json` + `electron-builder.yml` on the Windows host, kept in sync by hand — docs/windows-smoke-runbook.md §8.2).

**Why `windows-latest` specifically.** Not a preference: NSIS *cannot* be built on Linux, because electron-builder executes the freshly built installer in order to generate its uninstaller, which needs Wine — and Wine does not work on this project's WSL2 box (runbook §8.1, root cause still unidentified). A native Windows runner makes that step a non-event, and deletes the `--prepackaged` two-machine dance along with it.

Deliberate differences from §6.2's unit-test workflow, each the *opposite* of the choice made there:

| Unit-test workflow | Release workflow | Why the inversion |
|---|---|---|
| `ELECTRON_SKIP_BINARY_DOWNLOAD=1` | **not set** | Packaging packs the real win32 Electron binary; skipping the download breaks the artifact |
| `--ignore-scripts` on install | **not set** | Electron's postinstall is what fetches that binary |
| `ubuntu-latest` (1x billing) | `windows-latest` (2x) | NSIS is unbuildable on Linux |
| `cancel-in-progress: true` | **`false`** | Killing a half-finished release leaves a tag with partial artifacts attached |
| `permissions: contents: read` | job-scoped `contents: write` | Needed to attach artifacts to the release; scoped to the one job, workflow default stays read |

The workflow calls `pnpm pack:win:release`, **not** its own `electron-builder` command line. Targets (nsis + zip) and artifact names come from `package.json`'s `build.win` block, which `tests/unit/packaging/build-config.test.ts` already guards; a command line in the workflow would be a second source of truth that drifts silently — the same failure mode as the duplicate Windows-host config it replaces. The script passes `--publish never` so electron-builder does not detect the CI tag build and race the workflow's own upload step.

Artifacts are attached to the tag's GitHub release via the preinstalled `gh` CLI (no third-party action, so no extra supply-chain surface — this repo sets `minimumReleaseAge` for the same reason). If no release exists for the tag, one is created **as a draft**: M9.4 keeps its human step, where a person writes the release notes and publishes.

**This rule is enforced by a test, not by discipline.** `tests/unit/packaging/release-workflow.test.ts` asserts the trigger set *exhaustively* — the only key permitted under `on` is `push`, and the only key under `push` is `tags`. Adding `pull_request`, `workflow_dispatch`, a `branches` filter, or switching to a Linux runner reds the suite. Verified by mutation: nine separate edits (including each of those) were applied and each turned the suite red. If you are reading this because that test failed, it did its job.

---

## 7. PR conventions

### 7.1 Titles

Every PR title is `<prefix>: <summary>`, one of five prefixes:

| Prefix | Use | Example |
|---|---|---|
| `feat` | New user-visible capability | `feat: PPTX export with per-slide tier selection` |
| `fix` | Bug fix | `fix: printToPDF fires before webfonts settle` |
| `doc` | Docs and plan files only | `doc: export pipeline plan (60-export.md)` |
| `chore` | Deps, config, scaffolding, refactors with no behaviour change | `chore: scaffold electron-vite + tailwind v4` |
| `ci` | Workflow and CI-tooling changes | `ci: cap job timeout and skip electron binary download` |

Lowercase prefix, colon, space, imperative summary, no trailing period, ≤ 72 chars. Enforced socially, and by a tiny check in the lint script that reads `$PR_TITLE` when present — not by an extra CI job.

### 7.2 Auto-merge categories

**`chore`, `ci`, and config/init PRs use `gh pr merge --auto`.** These are mechanical, review adds little, and waiting on a human review blocks the stack underneath them (§8).

```bash
gh pr create --title "chore: add vitest config and shared test setup" --body "Adds vitest projects for shared/main/renderer."
gh pr merge --auto --squash --delete-branch
```

Auto-merge lands the PR the moment required checks go green. Because the required check is unit tests, a `chore` PR that breaks anything still cannot merge — the safety property that makes auto-merge acceptable.

`feat` and `fix` PRs **never** auto-merge; they wait for a human read.

### 7.3 Description requirements by type

| Type | Description requirement |
|---|---|
| `chore`, `ci` | One line, or none. These auto-merge; a paragraph nobody reads is waste. |
| `feat` | **One line.** What it does, from the user's point of view. Not a changelog of files — the diff is the changelog. If one line genuinely can't capture it, the PR is too big and should be split (which the stacked workflow makes cheap). |
| `fix` | One line: symptom → cause. `Charts exported blank because printToPDF ran before document.fonts.ready.` |
| `doc` | One line naming the doc. |
| **Performance PRs** | **Must include before/after logs or metrics.** A claim of "faster" without numbers is not reviewable. Paste the actual measurement: timing output, a profile summary, bundle-size delta, frame timings. State the machine and how many runs. A perf PR without numbers is closed with "please add the numbers", not debated. |
| **UI PRs** | **Must include a screen recording.** Any PR changing rendered UI — layout, Design Mode overlay, export dialog, present mode, animations — attaches a short screencast **as an animated GIF** showing the interaction (GIF is the only format GitHub renders inline in a PR body — webm/mp4 attach as unviewable files, so do not produce them). Screenshots are acceptable only for genuinely static changes (a colour, a label). This is the only practical review signal for UI work in a repo whose CI cannot render anything. |

Perf and UI requirements compose with the prefix: a UI feature is `feat:` **and** carries a recording; an export speedup is `feat:`/`fix:` **and** carries numbers.

### 7.4 Size

PRs are small by construction because the stacked workflow makes small PRs cheap. Target: one reviewable idea, ideally < 400 changed lines excluding fixtures and lockfiles. [80-roadmap.md](80-roadmap.md) breaks milestones into PR-sized units up front, so "should this be split?" is answered before the code is written.

---

## 8. jj (Jujutsu) stacked-branch workflow

### 8.1 Why jj

The roadmap is a long chain of dependent PRs (document model → IPC → canvas → Design Mode → export). With plain git this means either giant PRs or hand-managed dependent branches and constant `rebase --onto` archaeology. jj makes stacking the default mode of work: every change is addressable and immutable-by-identity, rebasing a stack is one command, and **descendants rebase automatically** whenever an ancestor is amended — which is the entire pain of stacked PRs, removed.

jj also removes the staging area and the "dirty working copy blocks the operation" class of interruption: the working copy *is* a commit, so switching context is always safe. And `jj undo` reverses any operation, including a botched rebase.

### 8.2 Setup — colocated repo

```bash
jj git init --colocate            # in the existing repo, or alongside git init
```

`--colocate` keeps a real `.git` alongside `.jj`, so **every git tool keeps working**: `gh`, GitHub Actions checkout, IDE git integrations, and a plain `git log` all see a normal repository. jj and git stay in sync automatically on each jj command. This matters because the CI and PR tooling above are entirely git/GitHub-native — jj is a local ergonomics choice that the rest of the world never has to know about.

Repo-level config:

```bash
jj config set --repo user.name  "..."
jj config set --repo user.email "..."
jj config set --repo git.auto-local-bookmark false   # don't auto-create local bookmarks for every remote branch
```

`.gitignore` gains `.jj/` only if the repo is *not* colocated; with `--colocate` jj manages this itself.

### 8.3 The mental model, briefly

- **Change** — a unit of work with a stable *change ID* that survives amendment and rebase. This is what you think in.
- **Commit** — the git object a change currently points at; its hash changes when the change is amended. You mostly ignore these.
- **`@`** — the working-copy commit. It is a real commit, updated continuously. There is no `git add`.
- **Bookmark** — jj's name for a git branch: a movable pointer. Bookmarks do **not** follow you as you commit (unlike git branches); you move them deliberately. **One bookmark per PR.**

### 8.4 Building a stack

Each PR in the stack is one change (or a small run of changes) with a bookmark at its tip.

```bash
jj git fetch                                  # refresh main@origin
jj new main@origin -m "chore: scaffold electron-vite + tailwind"
# ...edit files; the working copy IS the commit, nothing to stage...
jj bookmark create pr/scaffold -r @           # name this PR

jj new -m "feat: .sloodge document model + parser"
# ...edit...
jj bookmark create pr/doc-model -r @          # stacked on top of pr/scaffold

jj new -m "feat: slide CRUD IPC surface"
jj bookmark create pr/slide-ipc -r @
```

`jj log` shows the stack:

```
@  qpvuntsm  pr/slide-ipc   feat: slide CRUD IPC surface
○  kxryzmuw  pr/doc-model   feat: .sloodge document model + parser
○  zsuskuln  pr/scaffold    chore: scaffold electron-vite + tailwind
◆  mzvwutvl  main@origin    ...
```

Push and open PRs bottom-up:

```bash
jj git push --bookmark pr/scaffold --bookmark pr/doc-model --bookmark pr/slide-ipc
# or simply: jj git push --all

gh pr create --base main             --head pr/scaffold  --title "chore: scaffold electron-vite + tailwind" --body "Project scaffolding."
gh pr merge --auto --squash --delete-branch                                    # chore -> auto-merge

gh pr create --base pr/scaffold      --head pr/doc-model --title "feat: .sloodge document model + parser" --body "Parses and serializes .sloodge decks."
gh pr create --base pr/doc-model     --head pr/slide-ipc --title "feat: slide CRUD IPC surface"          --body "Renderer can create, delete, and reorder slides."
```

**Each PR's base is the bookmark below it**, so each PR's diff on GitHub shows only its own change — reviewers see one idea, not the cumulative stack. Every PR description carries a stack footer so a reviewer landing cold knows where they are:

```
Stack: pr/scaffold -> **pr/doc-model** -> pr/slide-ipc
```

### 8.5 Revising a change mid-stack

This is the payoff. Review comes back on `pr/doc-model`, which has two PRs on top of it:

```bash
jj edit kxryzmuw          # or: jj edit pr/doc-model  — check out that change directly
# ...make the fixes; @ is now that change and edits land in it...
jj bookmark set pr/doc-model -r @      # only if the change ID moved; usually unnecessary
jj git push --all
```

**`pr/slide-ipc` and everything above it rebase automatically.** jj rewrites descendants on every edit — no `git rebase --onto`, no re-checkout of each branch, no conflict re-resolution per branch. Any conflicts are recorded *in* the affected commits rather than halting the operation, so the rebase always completes and conflicts are resolved when convenient (`jj resolve`). Force-pushing the moved bookmarks updates the open PRs in place; GitHub keeps the review threads.

Other routine operations:

```bash
jj squash                            # fold @ into its parent (the "amend" of a mid-stack change)
jj squash --into kxryzmuw            # send the working-copy fix to a specific lower change
jj new kxryzmuw -m "..."             # insert a NEW PR into the middle of the stack
jj rebase -s pr/slide-ipc -d main@origin   # detach a change and its descendants onto trunk
jj split                             # a change grew too big -> split into two PRs
jj undo                              # reverse the last jj operation, whatever it was
jj op log                            # full operation history when undo isn't enough
```

`jj new kxryzmuw` inserting a PR mid-stack is worth highlighting: adding a missed prerequisite between two open PRs is a single command plus retargeting one PR's base, versus a multi-branch rebase dance in git.

### 8.6 Merging a stack

Stacks merge **bottom-up, strictly in order**. The bottom PR's base is `main`; nothing above it can merge first.

1. `pr/scaffold` (a `chore`) auto-merges the moment CI is green. Squash-merged; branch deleted.
2. GitHub automatically **retargets `pr/doc-model`'s base to `main`** when its base branch is deleted. This is the behaviour the whole workflow leans on.
3. Locally: `jj git fetch` then `jj rebase -d main@origin -s pr/doc-model`. Because the bottom change was squash-merged, its jj change still exists locally as a duplicate; `jj abandon <change>` drops it, or jj detects the identical content and drops it during rebase.
4. `jj git push --all` updates the remaining PRs, whose diffs now cleanly show only their own content.
5. Repeat for the next PR up.

The common friction — **squash-merge means the merged commit's hash differs from the local change** — is handled by `jj abandon` on the now-redundant change after fetching, or by rebasing onto the new `main@origin` and letting jj drop the empty change. It is one extra command per merged PR, and it is the price of squash-merge's clean linear history, which is worth it.

**Convention:** don't let a stack exceed ~4 open PRs. Beyond that the bottom-up merge cadence becomes the bottleneck and the top of the stack drifts far from `main`. If a milestone needs more, land the bottom half first.

### 8.7 Practical notes

- **CI runs on every pushed bookmark.** With `concurrency: cancel-in-progress` and per-PR grouping, pushing a 4-PR stack costs 4 short runs, not 4 long ones — another reason the CI job must stay minute-cheap.
- **Never rewrite a change that is already merged into `main`.** jj marks commits reachable from `main@origin` immutable by default and will refuse; this is a feature, don't override it.
- **`jj git fetch` before starting anything.** Stacks built on a stale `main` compound rebase pain.
- **Bookmark naming:** `pr/<short-kebab-topic>`, matching the PR's subject, no prefix duplication (`pr/pptx-export`, not `pr/feat-pptx-export`) — the prefix belongs in the PR title.
- **Team escape hatch:** because the repo is colocated, anyone who doesn't want jj can use plain git on the same clone. jj is a local preference, never a contribution requirement.

---

## 9. Decisions summary

1. **Bottom-heavy pyramid**: vitest units carry the correctness weight because they are the only layer CI can afford; Playwright and Electron layers are local and gate releases, not merges.
2. **CI = lint + core typecheck + vitest on ubuntu-latest only.** No build, no packaging, no Electron, no Playwright, no OS matrix, with binary downloads skipped, concurrency cancellation on, and a 10-minute hard cap. **One exception (§6.5):** release packaging runs on `windows-latest`, triggered by a `v*` tag push and nothing else, so it never fires on the development path; a test asserts that trigger set exhaustively.
3. **Electron is quarantined** behind injected interfaces and a lint rule, so the logic that matters is testable in a plain Node process.
4. **The experiment harness ([`render.mjs`](../../../experiments/init/harness/render.mjs)) is promoted to product test infrastructure**, with the [review rubric](../../../experiments/init/review-rubric.md) split into automated (mechanical) and human/LLM (semantic) halves.
5. **PR titles are `feat`/`fix`/`doc`/`chore`/`ci`**; `chore`/`ci`/config PRs use `gh pr merge --auto`; `feat` PRs get a one-line description; **perf PRs must include measurements**; **UI PRs must include a screen recording**.
6. **jj colocated (`jj git init --colocate`) with one bookmark per PR**, stacked bottom-up, auto-rebasing descendants, merged bottom-up with GitHub base-retargeting, stacks capped at ~4 open PRs — and git tooling keeps working throughout.
