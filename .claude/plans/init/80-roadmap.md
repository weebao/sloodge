# 80 — Roadmap & PR Breakdown

Principles: every PR is incremental and digestible; titles prefixed `feat/fix/doc/chore/ci`; stacked with jj where dependent. CI = unit tests only. `chore`/config/init PRs auto-merge (`gh pr merge --auto`). Feature PR descriptions are one-liners. Perf/compilation PRs must include before/after logs or metrics. UI PRs include a recording (see 70-testing-ci.md for the WSL/headless caveat — Playwright video is the fallback recorder).

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
| M2.0 | `feat: slide:// protocol delivery for interactive slides` — **prerequisite.** blob *and* `srcdoc` both inherit the host page's CSP (verified in Chromium 2026-07-31, `experiments/init/harness/csp-blob-inheritance.mjs`), so a slide's inline `<script>` is blocked by `script-src 'self'` and `capabilities: ["interactive-js"]` does not work. Serve slides from a non-local scheme registered with `protocol.handle` in main, which escapes policy-container inheritance and gives each slide a real per-document CSP. Gates M2.2's `interactive-graph` skill and any interactive slide the agent generates. See the correction note in [10-architecture.md §7](10-architecture.md). |
| M2.1 | `feat: agent service in main (Agent SDK, streaming, key storage)` |
| M2.2 | `feat: mcp__slides tool server (create/update/read/reorder/screenshot)` |
| M2.3 | `feat: chat panel with streaming + live slide updates` |
| M2.4 | `chore: bundle validated skills (slide-deck, svg-animation, interactive-graph)` |
| M2.5 | `feat: cost meter + budget guard in status bar` |

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
      └─ M0.3 ── M0.4 ── M1.1 ── M1.2 ── M1.3 ── M1.4 ─┬─ M2.0..M2.5 (stack)
                                                        ├─ M3.1..M3.5 ── M3.6..M3.10 (stack)
                                                        └─ M4.1
                                  M1.3 ─────────────────┬─ M4.2, M4.3, M4.4
                                  M0.4 ── M6.1 ── M6.2 ── M6.3 (needs M3.1 ids + M3.8 colors)
                                  M6.3 ─┬─ M7.1 ── M7.2
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

## Review gate (applies to every code PR)
Every code change is reviewed by a **fresh-memory subagent on the strongest available model (Opus/Fable)** loaded with the repo-local [`ship-ready-review`](../../skills/ship-ready-review/SKILL.md) skill, given only the changeset. The change is fixed and re-reviewed until the verdict reaches **confidence 100 (zero blockers, zero majors, lint/typecheck/tests independently verified green)** before merge.
