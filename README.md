# sloodge

A local desktop app that looks like PowerPoint but whose slides are HTML/CSS/SVG/JS — generated and edited by Claude via chat, and fine-tuned by hand through a Design Mode that HTML slides normally lack.

- **Plans:** [`.claude/plans/init/00-overview.md`](.claude/plans/init/00-overview.md) — master plan referencing modular sub-plans (architecture, tech stack, UI wireframes, slide format, design mode, agent integration, export, testing/CI, roadmap) and raw research.
- **Experiments:** [`experiments/init/`](experiments/init/) — skill/prompt iteration lab: Sonnet generators + Opus adversarial reviewers over 7 slide test cases, with a Playwright evidence harness, per-iteration metrics, screenshots, and raw verdict logs.

Stack: Electron (electron-vite + electron-builder), React 19, TypeScript, Tailwind v4, shadcn/ui, Zustand, Claude Agent SDK, pptxgenjs. Windows + macOS.
