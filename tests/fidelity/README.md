# PPTX export fidelity harness (M4.8a)

Round-trip instrument for `research/pptx-export-fidelity.md` §5.2: HTML slide → the **real** export
path (`slide://` registry, offscreen window, planner, pptxgenjs) → `.pptx` → read back → compared to an
independent ground truth and, when a renderer is available, pixel-diffed against Chromium's own
screenshot of the slide.

Local only. It launches Electron and must never run in GitHub Actions (CI is unit-tests-only).

```bash
pnpm fidelity            # run; writes tests/fidelity/out/{report.md,report.json,*.pptx,*.ref.png}
pnpm fidelity --record   # also refresh tests/fidelity/corpus/recorded/*.json
```

Exit codes: `0` every structural target met and the pixel step ran and passed; `1` a structural
target failed (or a pixel diff exceeded the ceiling); `2` structural targets met but **the pixel
step could not run** because no renderer is installed. The summary says so in words as well; the
pixel row is never reported as a pass when it did not execute.

## The pixel step needs a renderer

Rendering a `.pptx` back to PNG needs LibreOffice (`soffice`/`libreoffice` on `PATH`) or an
equivalent named by `SLOODGE_PPTX_RENDERER=/path/to/soffice`. Neither was installed on the
authoring machine, so `lib/renderer.ts`'s conversion call and `PIXEL_DIFF_MAX_FRACTION` are
untested against a live renderer; calibrate the ceiling on the first real run.

## The metric is closed-world

The confidence scorer used to be a deny-list of known-lossy constructs, so anything nobody had
thought of scored 100 — a pattern two review rounds found at successive depths. It is now inverted:
`src/shared/export/pptx/properties.ts` enumerates the properties the pipeline **emits or scores by
name**, plus those whose effect is already inside the measured geometry, and the measurement pass
reports every _other_ non-initial computed property by name. Those cost a WRONG-class deduction, so
an unfamiliar property routes the slide to an honest picture. Adding support for a CSS feature is one
explicit edit to `MODELLED_PROPERTIES`, made together with the emitter or deduction that earns it.

Review r3 attacked the **quantifier** rather than the list, and won three times, so two things about
it are worth stating plainly:

- The world is `document.body.querySelectorAll('*')` **plus `<body>` and `<html>`**. The root
  elements are outside that enumeration, and until r3 a paint property on either was censused by
  nothing and scored by nothing: `body { filter: invert(1) }` scored 100 with an empty loss list
  while every colour in the deck was the exact complement of the rendered one.
- The baseline the census compares against is a probe **two shadow roots deep**. One root was not
  enough: author CSS cannot reach inside a shadow tree, but it can style the host, and an
  `!important` declaration there beat the host's inline `all: initial` — so the baseline became the
  value under test and the same slide scored 65 or 100 on the presence of one keyword.

`LAYOUT_RESOLVED_PROPERTIES` is the inverted deny-list, and each of its ~160 entries is a written,
falsifiable claim about CSS. r3 falsified four of them by hand (`contain`, `content-visibility`,
`visibility`, `content`), two of which made the exporter **invent** content the slide never showed.
r4 falsified two more — `view-transition-name` and `will-change` — and they are the ones that turned
the pattern into a rule, because both fail the same way for the same reason:

> **A property that establishes a stacking context can never be layout-resolved.** The measurement
> pass records rects and computed colours and nothing about paint order, so such an entry cannot be
> falsified from the recording at all: no rect moves, no colour changes, and the census, the oracle
> and the score go blind together. `corpus/x17-paint-order.html` and
> `corpus/x18-view-transition-name.html` are the demonstration — two files differing in exactly one
> declaration (asserted), emitting byte-identical shapes in identical order, where the reader sees
> red and the `.pptx` shows green.

The rule is enforced in `tests/unit/export/pptx/node.test.ts` against CSS's own list of
stacking-context creators, so putting one back reds a test rather than shipping. `will-change` was
deleted outright; `view-transition-name` survives only as a **value-scoped** exemption for the UA's
`root` on `<html>`, since Chromium names the document element that and the census baseline — a
detached `<html>` two shadow roots deep, which is not _the_ root — computes `none`.

Two limitations of that audit are worth having in writing:

- The other ~160 entries are still not tested one slide at a time. They were swept mechanically
  instead: `will-change: <property>` creates a stacking context exactly when Chromium holds that
  property to be one that creates a stacking context or containing block, so every name in the list
  was run through the `z-index: -1` fixture that way. `view-transition-name` was the only hit.
  `container-type` — which the spec's own wording puts in doubt — was checked directly and computes
  `contain: none`. That sweep covers paint order; it does not cover the other ways a written claim
  could be wrong, and the check that would cover those (render each property set to a non-initial
  value and assert the Chromium capture is pixel-identical) still needs the renderer below.
- **The rule does not cover `MODELLED_PROPERTIES`, and one open class lives there.** `transform`,
  `rotate`, `scale`, `translate`, `opacity` and `position: fixed` all establish a stacking context;
  what the pipeline emits for them is a placement or an alpha, never a paint order. (`filter`,
  `clip-path`, `mix-blend-mode`, `backdrop-filter` and `position: sticky` do too, but each carries a
  named deduction that rasters the slide, so none of those can lie.) So a `transform: translateZ(0)`
  card with a `z-index: -1` child is the x17/x18 defect with a modelled property in place of an
  exempted one, and nothing in this harness can see it: the emitted shape set is identical and only
  paint order differs. It is the pixel step's to catch, which is the strongest reason the renderer is
  a prerequisite for M4.8 rather than a nice-to-have.

## Layout

- `corpus/*.html` — 26 fixture slides: `01`–`08` from the research (§0), `x1`–`x6` written by review
  r1 against the finished exporter, `x7`–`x10` by r2, `x11`–`x16` by r3 and `x17`/`x18` by r4. Every
  `x` slide reproduces a construct that once scored 85–100 while vanishing from, or arriving wrong
  in, the `.pptx` — and `x14`/`x15` two that the `.pptx` **invented**, a banner and a sentence that
  appear nowhere on screen. `x17`/`x18` are the only pair: they differ in one declaration, and only
  together do they show anything, since each on its own emits a shape list that looks correct.
- `corpus/recorded/*.json` — per slide, the measurement pass production saw plus the ground truth,
  recorded by `--record`. `tests/unit/export/pptx/fidelity-corpus.test.ts` runs the pure pipeline
  over these with no app launch, and fails closed if `slideMeasurementScript` changed since they were
  recorded. The recordings are **not** append-only across milestones: r2 widened `truth.scale` from
  a number to the computed `scale` string (the old number moved to `renderedScale`) and
  `measure.nodes[].ancestorTransforms[]` from a string to a `TransformSpec` (the old string is
  `.transform`); r3 widened `measure.body` from two fields to a `RootPaint` and added `measure.root`
  and `truth.rootPaint`. No measured value was lost in any of those, but "every change is additive"
  was the wrong description and re-recording is mandatory, not optional.
- `lib/truth.ts` — the independent oracle (text nodes via `Range`, painted boxes); deliberately not
  the exporter's leaf rule. It also records what a reader _sees_ rather than what the CSS says:
  clipped text, list markers, and bounds-vs-layout geometry, so a rotation shipped upright is caught
  without the oracle parsing a transform.
- `lib/readback.ts` — the `.pptx` reader (EMU boxes, `rot`, runs, `<p:bg>`); python-pptx stand-in.
- `lib/assess.ts` — the §5.2 targets as code; shared by the harness table and the vitest assertions.
  Every check but one runs **truth → file**, which by construction costs a fabricated shape nothing;
  `surplusShapes` (r4) runs the other direction once, for any string and any fill, and replaces the
  two r3 tests that could only catch fabrication by naming its literal text. It closes fabrication,
  not compositing — it would not have caught the `x17`/`x18` blocker, where the shape sets are
  identical. Building it immediately found a hole in the oracle beside it: `truth.ts` read
  `borderTopWidth` only, so a `border-left` accent bar was in no `truth.box` and neither dropping nor
  inventing it was visible. It now records the widest painted side.
- `lib/renderer.ts` — renderer resolution (fail-closed) and the pixel diff.
- `harness.ts` — the Electron main script; `run.ts` bundles it with vite and launches Electron.
