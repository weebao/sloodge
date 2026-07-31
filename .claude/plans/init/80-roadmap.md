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
      └─ M0.3 ── M0.4 ── M1.1 ── M1.2 ── M1.3 ── M1.4 ─┬─ M2.1..M2.5 (stack)
                                                        ├─ M3.1..M3.5 (stack)
                                                        └─ M4.1
                                  M1.3 ─────────────────┬─ M4.2, M4.3, M4.4
                                  M2.x + M3.x + M4.x ──── M5.x
```
