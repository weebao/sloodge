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

`LAYOUT_RESOLVED_PROPERTIES` is the inverted deny-list, and each of its ~200 entries is a written,
falsifiable claim about CSS. r3 falsified three of them by hand (`contain`, `visibility`, `content`),
two of which made the exporter **invent** content the slide never showed. They are not tested
mechanically, and the check that would test them all — render a slide setting each property to a
non-initial value and assert the Chromium capture is pixel-identical to the same slide without it —
needs the renderer this harness still does not have.

## Layout

- `corpus/*.html` — 24 fixture slides: `01`–`08` from the research (§0), `x1`–`x6` written by review
  r1 against the finished exporter, `x7`–`x10` by r2, and `x11`–`x16` by r3. Every `x` slide
  reproduces a construct that once scored 85–100 while vanishing from, or arriving wrong in, the
  `.pptx` — and `x14`/`x15` two that the `.pptx` **invented**, a banner and a sentence that appear
  nowhere on screen.
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
- `lib/renderer.ts` — renderer resolution (fail-closed) and the pixel diff.
- `harness.ts` — the Electron main script; `run.ts` bundles it with vite and launches Electron.
