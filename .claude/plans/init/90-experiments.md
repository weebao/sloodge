# 90 — Skill-Iteration Experiments (init)

Goal: prove, before building the app, that skill-guided generation can reliably produce presentation-grade HTML slides — and converge the three skills (`slide-deck`, `svg-animation`, `interactive-graph`) to **100/100 adversarial confidence on all test cases**. Achieved in **5 iterations** (mean 58 → 100).

All materials live in [`experiments/init/`](../../../experiments/init/): skills (final + per-iteration snapshots in `skills-history/`), 7 test-case artifacts per iteration (`artifacts/iter*/`), screenshot evidence (`evidence/iter*/`, 105 PNGs), raw Opus verdict JSONs (`results/iter*/`), the defect log (`results/iterations.csv`), and the graphical report (`results/report.html`).

## Method
1. **Generators**: Sonnet subagents, one per test case, fresh context, instructed only to read the skill and fulfil the case prompt.
2. **Harness**: Playwright headless Chromium renders each slide at 1280×720; screenshots at t=0/2/5s (animation loop proof), synthetic hover/click via `data-hover-target`/`data-click-target` (screenshots after each), console/pageerror capture, scroll-overflow check ([`harness/render.mjs`](../../../experiments/init/harness/render.mjs)).
3. **Reviewers**: independent Opus subagents judging ONLY rendered evidence (never the code) against [`review-rubric.md`](../../../experiments/init/review-rubric.md) — visual accuracy and interactivity only; confidence 0–100, any concrete defect caps at ≤85, zero defects must score exactly 100.
4. **Iteration**: defects → skill amendments (never per-case hacks) → regenerate or surgically fix → re-render → re-review. Iterations 1–3 regenerated fresh; 4–5 applied surgical fixes to near-passing artifacts.

## Results
| Case | I1 | I2 | I3 | I4 | I5 |
|---|--|--|--|--|--|
| slide-title | 82 | 38 | 82 | **100** | – |
| slide-content-layout | 80 | 47 | 82 | **100** | – |
| slide-comparison | 80 | 62 | 93 | **100** | – |
| anim-solar | 8 | 62 | 38 | **100** | – |
| anim-pipeline | 20 | 32 | 62 | **100** | – |
| graph-bar-interactive | 58 | 58 | 79 | **100** | – |
| graph-line-toggle | 78 | 62 | 62 | 72 | **100** |
| **mean** | 58 | 51.6 | 71.1 | 96 | **100** |

(The iter-2 dip is real: fixing geometry blockers exposed finer defect classes, and prose-only rules proved weak — see findings.)

## Findings that now shape the product skills
1. **Self-validation is the single biggest lever.** Iter 3 added a mandatory render-and-inspect loop to every skill (generator screenshots its own slide and fixes defects before returning). Blocker-class defects vanished; mean jumped 51.6 → 71 → 96. The app must give the agent a screenshot tool (`mcp__slides__screenshot_slide`) and its skills must mandate its use.
2. **Prose prohibitions fail; assets and constructions succeed.** "Don't invent text" was violated twice until promoted to a numbered HARD RULE with a self-audit step. Freehand SVG icon paths produced mangled glyphs until replaced by a vetted copy-paste icon library (`icons.md`). Fragile constructs (SMIL `begin`-chains, floating tooltips, separately-animated label groups) were each replaced by a single robust pattern that is correct *by construction* (one continuous motion path; readout strip outside the plot; labels riding inside the planet's rotating group).
3. **Occlusion is the dominant interactive-slide failure mode.** Every graph iteration until the last had the tooltip covering something. In dense plots the only stable answer is a reserved readout area outside the plot.
4. **Reviewer calibration matters.** One reviewer returned 93 with an empty defect list; the rubric now states zero defects ⇒ exactly 100, and taste-only complaints don't count as defects. Independent adversarial reviewers also oscillate (iter-3 solar penalized the exact pattern iter-2 suggested) — which is why rules must be geometric ("closer to its subject than any other, at every time t") rather than stylistic.
5. **Surgical fix mode converges faster than regeneration** once artifacts score ≥75: fixers get the verdict JSON, patch only named defects, and re-validate — 6/7 cases hit 100 on the first surgical pass.

The converged skills ship with the app (see [50-agent-integration.md](50-agent-integration.md)) and the harness graduates into the slide-contract test layer (see [70-testing-ci.md](70-testing-ci.md)).
