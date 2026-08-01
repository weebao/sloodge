# 80 — Roadmap & PR Breakdown

Principles: every PR is incremental and digestible; titles prefixed `feat/fix/doc/chore/ci`; stacked with jj where dependent. CI = unit tests only. `chore`/config/init PRs auto-merge (`gh pr merge --auto`). Feature PR descriptions are one-liners. Perf/compilation PRs must include before/after logs or metrics. UI PRs include a recording **as an animated GIF** (GitHub renders GIFs inline in a PR body; webm/mp4 attach as unviewable files — do not produce them). See 70-testing-ci.md for the WSL/headless caveat; Playwright records webm, so convert it with ffmpeg and keep only the GIF (plus a PNG still).

## Milestone 0 — Repo & scaffolding (parallelizable, all auto-merge except M0.4)
| PR | Title | Contents |
|---|---|---|
| M0.1 | `chore: repo init (plans, experiments, gitignore, license)` | This plan tree + experiment artifacts |
| M0.2 | `ci: unit-test workflow (pnpm + vitest, ubuntu-latest)` | `.github/workflows/test.yml`, lint job |
| M0.3 | `chore: electron-vite scaffold (main/preload/renderer, TS strict, tailwind, shadcn)` | Empty app boots to blank window |
| M0.4 | `feat: app shell layout (menu bar, thumbnail rail, canvas, status bar)` | Static UI, no logic |

## Milestone 1 — Document core (stack: each depends on previous)
| PR | Title |
|---|---|
| M1.1 | `feat: .sloodge document model + zod schemas + open/save` |
| M1.2 | `feat: command-pattern mutations with undo/redo` |
| M1.3 | `feat: sandboxed slide iframe renderer + thumbnail pipeline` |
| M1.4 | `feat: slide CRUD UI (add, delete, duplicate, reorder)` |

## Milestone 2 — Agent (stack; parallel with M3)
| PR | Title |
|---|---|
| M2.0 | `feat: slide:// protocol delivery for interactive slides` — **prerequisite, DONE.** blob *and* `srcdoc` both inherit the host page's CSP (verified in Chromium 2026-07-31, `experiments/init/harness/csp-blob-inheritance.mjs`), so a slide's inline `<script>` was blocked by `script-src 'self'` and `capabilities: ["interactive-js"]` did not work. Slides are now served from a privileged non-local scheme registered with `protocol.registerSchemesAsPrivileged` + `protocol.handle` in main, which escapes policy-container inheritance and gives each slide a real per-document CSP. Documents live in an in-memory registry keyed by 128-bit CSPRNG ids (no filesystem paths, so no traversal surface), published/revoked over typed `slide:publish`/`slide:revoke` channels. Acceptance proof: `experiments/init/harness/slide-protocol-smoke.mjs` launches the real app on WSLg and shows the *same* inline-script slide RUN over `slide://` and stay BLOCKED over `blob:`, with the sandbox still containing it (`parent.document`/`localStorage` denied). Unblocks M2.2's `interactive-graph` skill and any interactive slide the agent generates. See the resolution note in [10-architecture.md §7](10-architecture.md). |
| M2.1 | `feat: agent service in main (Agent SDK, streaming, key storage)` |
| M2.2 | `feat: mcp__slides tool server (create/update/read/reorder/screenshot)` |
| M2.3 | `feat: chat panel with streaming + live slide updates` — **renderer side shipped; main-side emitter deferred to M2.6.** The chat UI, streaming transcript, tool-call chips, no-key gate, and the `deck:updated`→`applyRemoteDeck` transport all ship, but M2.3 wires NO main-side emitter: in the shipped app the deck is renderer-authoritative (`deckStore` owns `DocumentHistory`, per M1.3/M1.4), so an agent tool edit (M2.2) does not yet reach the user's deck. Pushing a full-snapshot `deck:updated` now would overwrite the user's deck and wipe their undo stack — deliberately deferred, see M2.6. |
| M2.6 | `feat: agent-edit ↔ renderer deck reconciliation (undo-parity)` — **closes the chat→generate loop.** Route M2.2's agent `DocCommand`s (already built with `origin:agent`) into the renderer's single `DocumentHistory` via `history.apply` — NOT the full-snapshot `history.reset` path (which clears undo). Keeps renderer authority; agent edits become reversible by the same Ctrl/⌘+Z as manual edits. Acceptance criteria: (1) an agent tool call visibly mutates the on-screen deck live; (2) that edit is undone/redone by the standard Edit-menu path in one step (the 50 §6 / 10 §5 undo-parity invariant); (3) the `deck:updated` full-snapshot path is relegated to `doc:open`/full-reload only. This is the milestone that makes "chat generates the slides you see" actually true in the running app. |
| M2.4 | `chore: bundle validated skills (slide-deck, svg-animation, interactive-graph)` |
| M2.5 | `feat: cost meter + budget guard in status bar` — **also owns the two pieces of [50 §8](50-agent-integration.md) M2.4 deferred.** M2.4 ships skill bundling plus *detection* of a skill-less session (logged in main, shown as a chat notice); the compensating behaviour is M2.5's: (1) the **`skills: fallback` status-bar indicator** — this is the milestone that creates the status bar, so nothing earlier can host it; (2) the **automatic fallback restart** — on a `system:init` whose `skills` array is missing any bundled skill, transparently reopen the query with `skills: []` and the three SKILL.md bodies appended to `systemPrompt.append`. Ship them together: a session that silently restarts itself with a different prompt shape and shows nothing is worse than M2.4's loud non-healing state. Acceptance: a session whose init reports missing skills restarts once, the indicator reads `skills: fallback`, and slide quality is unchanged from a skills-loaded session. |
| M2.7 | `feat: Settings dialog with a dedicated Auth tab (subscription login, not just an API key)` — **moves auth out of the chat panel.** Today M2.3 ships a minimal inline "add your Claude API key" gate in the chat composer; that is a stopgap. Ship a real **Settings dialog** opened from **File ▸ Settings…** *and* **Ctrl/⌘+,** (native accelerator via the M1.4 menu→IPC path), with tabbed sections — **Auth**, Model, Budget, About — and move the key entry into the Auth tab (the composer gate becomes a "Set up authentication" link that opens Settings). **Preferred auth path: `claude auth login`-style OAuth**, i.e. sign in with an existing Claude subscription rather than pasting a raw API key — the pattern [t3code](https://github.com/pingdotgg/t3code) uses: spawn/drive the Claude Code CLI's login flow from main, let it complete in the system browser, and reuse the credentials it stores, so a Pro/Max subscriber never handles an API key. Requirements: (a) both auth modes supported — subscription login (preferred, offered first) and manual API key (fallback, e.g. for org keys/CI); (b) auth state surfaces honestly in the tab (signed in as / key configured ••••last4 / not configured) with sign-out + key-clear; (c) plaintext credentials still never cross IPC toward the renderer (the M2.1 `safeStorage` vault rule holds — the renderer sees only masked status); (d) the login subprocess is spawned with the same isolation discipline as the agent (`settingSources`, `CLAUDE_CONFIG_DIR` under userData) so the app never reads or mutates the user's ambient `~/.claude` credentials unless they explicitly choose that; (e) verify against the current Agent SDK/CLI auth surface before implementing — check what `claude auth login` (or its successor) actually writes and which env var/flag makes the SDK consume it, and record the finding in [50-agent-integration.md](50-agent-integration.md) rather than guessing. **Superseded in part by [50-agent-integration.md](50-agent-integration.md) §4** — requirement (e) was carried out and reversed the approach: there is no supported programmatic login, and a pasted `claude setup-token` token replaces the driven OAuth flow (requirement (d) is vacuous, since no login subprocess is spawned). §4 also records the provider-pinning and base-URL decisions that followed. |

## Milestone 3 — Design Mode (stack; parallel with M2)
| PR | Title |
|---|---|
| M3.1 | `feat: data-sl-id injection + byte-span source map` |
| M3.2 | `feat: selection overlay + postMessage hit-testing bridge` |
| M3.3 | `feat: local property panel (text, color, size, position)` |
| M3.4 | `feat: element context bundle → chat (ask Claude about this element)` |
| M3.5 | `feat: drag-to-move/resize with undo coalescing` |

## Milestone 4 — Present & Export (parallel tracks)
| PR | Title |
|---|---|
| M4.1 | `feat: present mode (fullscreen, keys, auto-hiding controls)` |
| M4.2 | `feat: PDF export (printToPDF + pdf-lib merge)` |
| M4.3 | `feat: PPTX export (structured + raster fallback)` |
| M4.4 | `feat: HTML export (zip + presenter shell)` |
| M4.5 | `feat: PPTX import (open .pptx files & templates, not just .sloodge)` — File ▸ Open accepts `.pptx`/`.potx`; slides convert to contract HTML best-effort (text boxes, images, shapes, theme colors/fonts → theme tokens); **the original archive is retained verbatim inside the deck** (`import/original.pptx` + per-part edit ledger) so unedited content never suffers conversion loss; template import extracts masters/layouts into the sloodge theme |
| M4.6 | `test: PPTX round-trip identity` — imports then exports back to PPTX must reproduce **the exact same file**: a no-edit round-trip re-emits the retained original archive byte-for-byte (asserted by hash in CI-runnable unit tests over fixture decks); an edited round-trip rewrites only the OPC parts the edit touched, with every untouched part asserted byte-identical (part-level passthrough). This gate makes M4.5's retention strategy load-bearing rather than decorative |
| M4.7 | `feat: present hardening (separate-window PresentService)` — the deferred half of 10-architecture.md §8. M4.1 shipped a same-window renderer overlay (reusing the `slide://` `SlideFrame`, testable, meets the v1 wireframe); M4.7 promotes Present to the main-owned separate-window design: a borderless fullscreen `BrowserWindow` with a per-slide `WebContentsView` for **process-level fault isolation** (a runaway interactive slide must not stall the app mid-talk), the **presenter console** on a second display (current/next/notes/timer), **multi-display targeting** (`screen.getAllDisplays()`), off-screen preload of the next slide, `powerSaveBlocker`, build-step (`data-sl-build`) advancement, and `.`-to-black — over the `present:start`/`present:goto`/`present:state` IPC surface |

## Milestone 3b — Fine-grained control (stack on M3.1–M3.5)
Direct-manipulation depth so Design Mode reaches parity with a real slide editor.
| PR | Title | Notes |
|---|---|---|
| M3.6 | `feat: transform controls (stretch/zoom handles, rotate, flip H/V, duplicate)` | Handles on the selection box; rotation via corner handle with angle snap (0/45/90); flip = CSS transform written back to source; duplicate = Ctrl/⌘+D cloning the element subtree with fresh `data-sl-id`s |
| M3.7 | `feat: multi-select + align & distribute` | Shift-click / marquee multi-select; align left/center/right/top/middle/bottom; distribute horizontal/vertical; PowerPoint-style smart guides while dragging |
| M3.8 | `feat: color controls + eyedropper` | Fill/stroke/text color swatches with theme-token quick row; eyedropper via the `EyeDropper` API (Chromium ships it) sampling anywhere in the app window; writes hex back to source |
| M3.9 | `feat: animation controls (duration, easing/bezier editor, transition presets)` | Per-element panel: duration/delay sliders, easing dropdown (ease/linear/ease-in-out/spring) + draggable cubic-bezier curve editor; one-click entrance presets (fade, slide-in, scale) written as CSS keyframes honoring the slide contract |
| M3.10 | `feat: installed-font family dropdown` | Main process enumerates machine fonts (`queryLocalFonts` in renderer needs a permission prompt; fallback: `font-list` npm lib in main over IPC); dropdown previews each face; embeds font-family stack into slide source with system-fallback chain and an export-fidelity warning (non-system fonts won't travel) |

## Milestone 6 — Insert ribbon (contextual toolbar framework)
PowerPoint's ribbon behavior: the top tab strip gains **Insert** next to Home(Edit), and switching tabs swaps the toolbar row content.
| PR | Title | Notes |
|---|---|---|
| M6.1 | `feat: ribbon tab framework (contextual toolbar switching)` | Tab strip state machine; toolbar row renders per active tab; contextual auto-switch (selecting a shape jumps to the shape toolbar, like PowerPoint's Shape Format) |
| M6.2 | `feat: Insert tab with shapes toolbar (line weight, stroke/fill color, background)` | Shape gallery (rect, rounded rect, ellipse, line, arrow, text box); line-weight stepper, stroke/fill/background pickers reusing M3.8 color controls |
| M6.3 | `feat: shape insertion into slide source` | Click-to-place or drag-to-size; shapes inserted as contract-compliant inline SVG/positioned divs with `data-sl-id`, immediately selectable in Design Mode |

## Milestone 7 — Images
| PR | Title | Notes |
|---|---|---|
| M7.1 | `feat: insert image from file` | Insert ▸ Image file picker; image copied into the deck zip's `assets/`, referenced by relative path in-editor and inlined as data URI at export/present time (slide contract stays self-contained); auto-fit to slide with aspect preserved |
| M7.2 | `feat: paste & drag-drop images` | Clipboard paste (Ctrl/⌘+V with image data via `clipboard.readImage` / renderer paste events) and OS drag-drop onto the canvas; same asset pipeline as M7.1; pasted image lands centered, selected, ready to transform |
| M7.3 | `feat: video insert & canvas render` | Insert/drag-drop video → `ffprobe` gate → deck `assets/` + manifest metadata (duration/dimensions/codec) + generated poster frame; canvas/rail show the **poster placeholder** (never N live decoders), playback on explicit selection; iframe gains `allow="autoplay; fullscreen"`; soft caps warn ~200 MB/video, ~500 MB/deck. Research: [research/video-in-slides.md](research/video-in-slides.md) — native `<video>` (Electron ships H.264/AAC), libvlc ecosystem dead, ffmpeg.wasm rejected |
| M7.4 | `feat: present-mode video playback + import normalization` | Bundled `ffmpeg-static`/`ffprobe-static` (spawned from main, `asarUnpack`, GPL-aggregation posture with license notice): pass-through natively-playable → remux `-c copy` for wrong-container → transcode HEVC/AVI/WMV to H.264/AAC MP4 (1080p cap, progress UI, cancelable; **HEVC always transcodes** — hardware-decode-only in Chromium). Present mode: native `<video>` with sloodge-styled controls, per-video autoplay-on-enter/loop/mute/trim, pause-on-exit, `autoplayPolicy: 'no-user-gesture-required'` (+ CLI-switch fallback). Self-containment exception (documented): the deck ZIP, not the slide HTML, is the unit of self-containment for media ≥ ~2 MB; exports get poster frames (PDF) or media parts if the writer supports them (PPTX) |

## Milestone 5 — Polish & packaging
| PR | Title |
|---|---|
| M5.1 | `feat: File/Edit menus with OS accelerators + clipboard` |
| M5.2 | `chore: electron-builder config (NSIS + dmg)` |
| M5.3 | `fix/perf: startup + slide-switch profiling` (metrics required in PR) |
| M5.4 | `doc: README, user guide, skill-authoring guide` |

Dependency graph (arrows = "must land first"):
```
M0.1 ─┬─ M0.2
      └─ M0.3 ── M0.4 ── M1.1 ── M1.2 ── M1.3 ── M1.4 ─┬─ M2.0..M2.7 (stack; M2.7 needs M2.1 vault + M2.3 chat gate)
                                                        ├─ M3.1..M3.5 ── M3.6..M3.10 (stack)
                                                        └─ M4.1
                                  M1.3 ─────────────────┬─ M4.2, M4.3, M4.4
                                  M4.3 ── M4.5 ── M4.6 (import + round-trip identity gate)
                                  M0.4 ── M6.1 ── M6.2 ── M6.3 (needs M3.1 ids + M3.8 colors)
                                  M6.3 ─┬─ M7.1 ── M7.2 ── M7.3 ── M7.4 (video)
                                  M2.x + M3.x + M4.x + M6.x + M7.x ── M5.x
                                  M1.4 ── M8.1 ── M8.2..M8.6 (each gated on M8.1 metrics) ── M8.7
```

## Milestone 8 — Performance & stress testing (starts after M1.4; hardens continuously)
Budgets (enforced, not aspirational): cold start < 3s to interactive shell; slide switch < 100ms; **median RAM < 200 MB during the stress suite**; no dropped-frame animation on the active slide; open/save of a 500-slide deck < 5s.
| PR | Title | Notes |
|---|---|---|
| M8.1 | `feat: stress-deck generator + perf harness` | Script generates synthetic decks (100/500/1000 slides mixing heavy SVG animation, interactive graphs, image-laden and component-dense slides); harness launches the app, replays a scripted session (open → scroll rail → rapid slide switching → present → export), samples RSS/heap/CPU/frame times via `process.memoryUsage`/`app.getAppMetrics` + PerformanceObserver, emits JSON + flamegraph-ready traces to `perf/results/` |
| M8.2 | `perf: lazy slide mounting` | Only the active slide's iframe is live; ±1 neighbors pre-warmed; all others unmounted to serialized source (metrics required in PR) |
| M8.3 | `perf: thumbnail virtualization + cache` | Rail renders only visible thumbnails (virtual list); thumbnails are cached PNGs invalidated by slide-source hash, persisted in the workspace so reopen is instant (metrics required) |
| M8.4 | `perf: animation throttling for inactive surfaces` | Pause SMIL/CSS animation in non-active slides and background thumbnails (`pauseAnimations()`, `visibility`-gated), resume on focus (metrics required) |
| M8.5 | `perf: parse/source-map caching + incremental patching` | Cache parse5 source maps per slide-source hash; Design-Mode edits reuse spans instead of reparsing; agent edits patch single slides, never the whole deck (metrics required) |
| M8.6 | `perf: startup path audit` | Defer agent-SDK spawn, skill copy, and export modules off the critical path; V8 snapshot/lazy `require` where measurable; before/after startup traces in PR (metrics required) |
| M8.7 | `ci: perf regression check (local-runner report diffing)` | Perf suite runs locally (not on GitHub minutes); committed baseline JSON diffed by a fast CI job that only compares numbers — fails if median RAM ≥ 200 MB, startup or switch budgets regress >10% |
Every `perf:` PR must include the harness's before/after logs and metric tables in its description, per the PR conventions.

## Milestone 8b — Design polish pass (after every feature milestone; gates the release)
Everything up to here optimizes for *correctness*; this milestone is the one that optimizes for **how the app looks and feels**. It runs after M0–M8 are complete and before M9 cuts the release, because polish should ship in v0.0.1 rather than trail it.

| PR | Title | Notes |
|---|---|---|
| M8b.1 | `doc: design audit + token inventory` | **Explore what design skills/resources are actually available first** (the `artifact-design` and `dataviz` skills, any design system the environment exposes) and record what they prescribe — do not invent a house style from scratch if a vetted one is at hand. Then audit the shipped UI surface by surface (app shell, thumbnail rail, canvas, chat panel, property panel, arrange bar, export dialogs, present mode + its controls, first-run/no-key gate, notices/status lines) and inventory every color, spacing value, radius, shadow, font size/weight, border, and transition currently in use. Output: a written audit naming each inconsistency (the same "gray" spelled three ways, one-off paddings, ad-hoc `text-[13px]`), plus the **canonical token set** the polish will converge on — extending the existing `chrome-*`/`ink-*` Tailwind theme rather than replacing it, and staying compatible with the `.sloodge` deck theme tokens (30-slide-format.md) so app chrome and slide content don't fight. |
| M8b.2 | `feat: design tokens + primitives` | Land the canonical tokens (Tailwind theme extension + CSS variables) and a small set of shared primitives the surfaces will adopt — button variants, input, dialog/modal shell, panel header, toolbar group, chip/badge, status line. Light and dark must both be correct (the app already ships `dark:` variants; the audit will show where they've drifted). Accessibility is part of the definition of done: contrast ratios checked against WCAG AA for text and UI, visible focus rings on every interactive element, and no information conveyed by color alone. |
| M8b.3+ | `feat: polish <surface>` — **parallel subagents, one surface each** | Fan out one subagent per UI surface (rail, canvas/overlay, chat, property panel + arrange bar, export dialogs, present mode, menus/status bar), each converting its surface to the M8b.2 tokens and primitives, each its own reviewable PR with a before/after GIF. They run in parallel because the surfaces are independent once the tokens exist — that is exactly why M8b.1/M8b.2 come first: a fan-out without an agreed token set produces seven inconsistent opinions. Each PR must show it changed *only* presentation: no behavior change, existing tests unchanged and green, and the Design-Mode byte-span/undo invariants untouched. |
| M8b.4 | `test: visual consistency check` | A test that fails when a surface reintroduces an off-token value — e.g. scan the renderer's source for raw hex colors / arbitrary Tailwind values (`text-[13px]`, `p-[7px]`) outside the token definitions, with an explicit allow-list for genuine exceptions. Same discipline as the rest of the repo: the guard must red under a mutation that reintroduces a one-off value, or it is not a guard. |

## Milestone 9 — v0.0.1 release (gated on every other milestone reaching 100%)
When all milestones above are complete (every PR merged at review confidence 100, CI green) — **including the M8b design polish pass** — cut the first release:
| PR / step | What | Notes |
|---|---|---|
| M9.1 | `chore: electron-builder release config for v0.0.1` | Version bump to 0.0.1; NSIS `.exe` installer + portable `.zip` for Windows; `.dmg` (plus `.zip` for auto-update) for macOS — dmg is the standard macOS distribution format |
| M9.2 | Local builds | Build locally, NOT in CI (GitHub minutes are limited): `electron-builder --win` and `--mac`. macOS artifacts cross-build unsigned from the dev machine; signing/notarization is deferred past 0.0.1 |
| M9.3 | Smoke-test runnability | The dev machine is Windows (WSL2): install and run the `.exe` on the Windows host and walk the v1 success path (new deck → generate → Design-Mode tweak → Present → export PDF/PPTX). macOS artifact is best-effort untested until a mac is available — state that plainly in the release notes |
| M9.4 | GitHub release `v0.0.1` | `gh release create v0.0.1` with the `.exe`, Windows `.zip`, `.dmg`, macOS `.zip`; release notes summarize milestones and known limitations (unsigned mac build, untested on macOS) |

## Review gate (applies to every code PR)
Every code change is reviewed by a **fresh-memory subagent on the strongest available model (Opus/Fable)** loaded with the repo-local [`ship-ready-review`](../../skills/ship-ready-review/SKILL.md) skill, given only the changeset. The change is fixed and re-reviewed until the verdict reaches **confidence 100 (zero blockers, zero majors, lint/typecheck/tests independently verified green)** before merge.
