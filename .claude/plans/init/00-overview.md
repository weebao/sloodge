# Sloodge — Master Plan (init)

**Sloodge** is a local desktop app that looks and feels like PowerPoint but whose slides are HTML/CSS/SVG/JS — generated and edited by Claude through a chat box, and fine-tuned by hand through a Design Mode (Cursor/v0/react-grab-style element selection) that HTML slides normally lack.

## Why
Recent models (Kimi K3, Gemini Flash, Claude Opus, …) are excellent at SVG animation and interactive JS graphs, so people increasingly build slides in HTML instead of PowerPoint/Google Slides. What's missing is fine-grained control: you can't click a title and nudge it, restyle a bar chart, or move an element without re-prompting. Sloodge closes that gap: **chat for generation, Design Mode for control, PowerPoint UI for familiarity.**

## Product shape
- Local Electron desktop app, Windows + macOS.
- UI mirrors PowerPoint's layout exactly: slide-thumbnail rail (left), current-slide canvas (right), chat box docked on the canvas side, text-formatting tab on top, bottom status bar with deck info and a **Present** (fullscreen) button. Menu bar: **File** (New / Open / Export ▸ PPTX, PDF, HTML / — / Close on macOS, Quit elsewhere) and **Edit** (Undo / Redo / — / Cut / Copy / Paste / Paste and Match Style on macOS / Delete / Select All) with OS-native accelerators (Ctrl on Windows, ⌘ on macOS). Edit items are native Electron roles, so they act on whatever has focus.
- Each slide is a self-contained 1280×720 HTML document rendered in a sandboxed frame. Animations are CSS/SMIL; interactivity is vanilla JS. This contract was validated experimentally (see [experiments](../../../experiments/init/) and [90-experiments.md](90-experiments.md)).
- The agent runtime is the **Claude Agent SDK** running in the Electron main process, equipped with the three validated skills (`slide-deck`, `svg-animation`, `interactive-graph`) plus in-process MCP tools for slide CRUD.

## Plan tree
| Doc | Scope |
|---|---|
| [10-architecture.md](10-architecture.md) | Process model, IPC, state, undo/redo, file format lifecycle |
| [11-tech-stack.md](11-tech-stack.md) | Concrete stack + versions, and why |
| [20-ui-wireframes.md](20-ui-wireframes.md) | ASCII wireframes for every surface |
| [30-slide-format.md](30-slide-format.md) | The `.sloodge` document model & slide HTML contract |
| [40-design-mode.md](40-design-mode.md) | Element picker, overlay, local property edits, AI element-context edits |
| [50-agent-integration.md](50-agent-integration.md) | Claude Agent SDK wiring, skills, MCP tools, permissions, cost |
| [60-export.md](60-export.md) | PPTX (pptxgenjs + raster fallback), PDF (printToPDF), HTML |
| [70-testing-ci.md](70-testing-ci.md) | Unit/integration/visual tests, GitHub Actions (unit-only), jj stacked-PR workflow |
| [80-roadmap.md](80-roadmap.md) | Milestones → incremental PR breakdown with prefixes |
| [90-experiments.md](90-experiments.md) | Skill-iteration experiment: method, per-iteration data, results |
| [research/](research/) | Raw research: t3code/Vite+, Agent SDK, skills best practices, design-mode tools, slides/export/Electron |

## Key decisions (made from research)
1. **electron-vite 5 + electron-builder**, not Vite+ — t3code's "viteplus" stack is a private/early Vite superset (`@voidzero-dev/vite-plus-core`); electron-vite is the stable public equivalent with the same DX (HMR, main/preload/renderer). Revisit when Vite+ is GA.
2. **React 19 + TypeScript (strict) + Tailwind CSS v4 + shadcn/ui + Zustand** for the shell UI (matches t3code's frontend minus Effect-TS, which is overkill for v1).
3. **Slides render in sandboxed iframes** (`sandbox="allow-scripts"`) inside the canvas for editing, and a fullscreen frame for Present — not `<webview>` (deprecated pattern).
4. **Design Mode**: compile-time stable element IDs (`data-sl-id`) injected into slide HTML; overlay hit-testing via `elementFromPoint`; local (zero-LLM) property panel edits patch source byte-spans directly (v0 lesson); AI edits get a context bundle (element HTML + computed styles + screenshot crop) à la Cursor/react-grab; accept/reject gate before writing (Onlook lesson).
5. **Export**: PDF via `webContents.printToPDF` (one page per slide); PPTX via pptxgenjs structured conversion for text/shapes with full-slide PNG raster fallback for complex slides; animations exported as their final frame (PowerPoint can't run them — noted in UI).
6. **Skills iterated to 100% adversarial confidence** on 7 test cases before being frozen into the app (see 90-experiments.md).
7. **jj (Jujutsu) for stacked branches**; PRs prefixed `feat/fix/doc/chore/ci`; CI runs unit tests only (no compilation/packaging in CI — GitHub minutes are limited); config/init PRs auto-merge.

## Success criteria for v1
- Create → chat-generate a 5-slide deck → tweak an element in Design Mode → Present fullscreen → Export PDF and PPTX, all offline except Claude API calls.
- Cold start < 3s; slide switch < 100ms; agent edit round-trip shows streaming progress.
- Runs on Windows (NSIS installer) and macOS (dmg).
