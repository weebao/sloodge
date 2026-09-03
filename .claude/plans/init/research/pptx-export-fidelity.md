# Research — PPTX export fidelity: is pptxgenjs the bottleneck?

**Status:** research, not a plan of record. **Date:** 2026-09-03.
**Question asked:** _"revisit the export to powerpoint logic. If we've already used a library for this,
see if there's any library that's better and more accurate at preserving all the text and color and
positions. If not, see if we can build on our own."_

**Answer, up front:** the library is not the bottleneck and swapping it would buy nothing. Every
fidelity loss measured below happens in Sloodge's own **measurement + mapping** layer, before
pptxgenjs is ever called. The writer chain is exact to 0.0001 px. A from-scratch OOXML writer was
prototyped and validated in real Microsoft PowerPoint; it is ~250 lines and works, but it produces
_the same output_ as pptxgenjs for everything except gradient fills. Recommendation is **(a) keep
pptxgenjs and finish the mapping** — which is largely a matter of implementing rows of
`60-export.md` §3.3 that were specified but never built.

---

## 0. How this was measured

Everything below is a reproduced measurement, not a reading of the code. Scratch rig lived in the
session scratchpad (`pptx-research/`); no repo source was modified.

- **Layout engine:** headless Chromium via puppeteer, viewport 1280×720, `deviceScaleFactor: 1`,
  after `document.fonts.ready`.
- **Code under test:** the repo's _actual_ shipped modules, bundled with esbuild from
  `src/shared/export/pptx/{node,walker,confidence,plan}.ts` and `src/main/export/pptx-writer.ts`.
  Nothing was reimplemented, so the numbers describe the shipping code path.
- **Ground truth:** an independent script walking every **text node** (`TreeWalker` + `Range`
  bounding rect + parent `getComputedStyle`), plus every element with a non-transparent background or
  a visible border. Deliberately _not_ derived from the exporter's own leaf-element rule — that rule
  is one of the things under test.
- **Inspection:** `python-pptx` 1.0.2 in a scratch venv, reading back runs, colors, sizes, EMU boxes
  and rotation from the emitted `.pptx`.
- **Real-application validation:** Microsoft PowerPoint (Office16) on the Windows host, driven over
  COM from WSL, opening each file and reading back shape count and text.

**Corpus:** 8 slides written to span the failure surface — title+body with mixed inline formatting,
multi-column mixed weights/colors, absolute positioning, an SVG bar chart, a gradient/rounded-card
design, a CSS grid/flex dashboard, rotated/transformed elements, and a web-font slide.

**Not measured (stated honestly):**

- **Visual** fidelity of the rendered result. No LibreOffice on this machine (`soffice` absent
  locally and on the Windows host), and PowerPoint COM was used only for open-and-read-back, not
  for image diffing. So "the text box is at the right EMU" is proven; "the glyphs land where
  Chromium put them" is not.
- **Text reflow inside a box.** PowerPoint's line-breaking is not Chromium's. A box sized to
  Chromium's measured height may overflow or underflow in PowerPoint. This is a real risk and it is
  unquantified here.
- Font substitution appearance for the web-font slide (`Inter Tight` is not installed anywhere in
  this environment, so both sides fell back).

---

## 1. The measured baseline

### 1.1 Headline numbers

| Metric (8-slide corpus)                                       | `auto`               | `editable`     |
| ------------------------------------------------------------- | -------------------- | -------------- |
| HTML text fragments preserved verbatim                        | 60/65 = **92.3 %**   | 62/65 = 95.4 % |
| Exact hex color match on preserved text                       | 60/60 = **100 %**    | 62/62 = 100 %  |
| Exact font-size match (±0.02 pt) on preserved text            | 60/60 = **100 %**    | 62/62 = 100 %  |
| SVG `<text>` preserved                                        | 0/5                  | 5/5 (see §1.4) |
| Shape box position vs planner spec                            | 84/84 exact, worst delta **0.0001 px** | |
| Rotations emitted for 3 rotated elements                      | **0**                | 0              |
| Slides scoring ≥ 95 that are nonetheless badly wrong          | **2 of 8 (25 %)**    |                |

### 1.2 Per-slide

| Slide               | Tier (auto) | Score | Text kept (auto) | Text kept (editable) | Color exact | Size exact | What actually degraded                                                       |
| ------------------- | ----------- | ----- | ---------------- | -------------------- | ----------- | ---------- | ---------------------------------------------------------------------------- |
| 01-title-body       | structured  | 100   | **7/10**         | 7/10                 | 7/7         | 7/7        | Bare text around `<strong>`/`<em>` **silently dropped**                       |
| 02-columns          | structured  | 100   | 10/10            | 10/10                | 10/10       | 10/10      | Clean                                                                         |
| 03-absolute         | structured  | 100   | 8/8              | 8/8                  | 8/8         | 8/8        | Clean                                                                         |
| 04-svg-chart        | **raster**  | 82    | 0/2              | 2/2                  | 2/2         | 2/2        | Whole slide → picture; correct call, but §3.3's hybrid path would keep text    |
| 05-gradient-cards   | structured  | **100** | 10/10          | 10/10                | 10/10       | 10/10      | **Background silently lost → pale text on white. Score says 100.**             |
| 06-grid-flex        | structured  | 100   | 17/17            | 17/17                | 17/17       | 17/17      | Clean                                                                         |
| 07-rotated          | structured  | **95**  | 4/4            | 4/4                  | 4/4         | 4/4        | **All 3 rotations dropped**; 90° label boxed 21 px wide                        |
| 08-webfont          | structured  | 90    | 4/4              | 4/4                  | 4/4         | 4/4        | Font substitution only (expected, scored, reported)                            |

### 1.3 The two silent high-confidence failures

These matter more than the aggregate percentages, because the confidence score — the mechanism whose
entire job is to route bad slides to raster — reports success.

**(a) Gradient body background vanishes at score 100/100 — `05-gradient-cards`.**

Measured, from the emitted file:

- `body` computed style: `background-color: rgba(0,0,0,0)`,
  `background-image: linear-gradient(135deg, rgb(76,29,149) 0%, rgb(30,58,138) 100%)`.
- `plan.background` → `null`. Emitted `ppt/slides/slide1.xml` contains **no `<p:bg>` element**, so
  PowerPoint renders the slide **white**.
- The cards were authored `rgba(255,255,255,0.10)` → emitted as `FFFFFF` at 90 % transparency, i.e.
  invisible on white.
- Card text is `#FDE68A` and `#E0E7FF`, chosen for a dark purple ground. On white it is unreadable.
- Confidence: **100**. `reasons: []`. Nothing in the export report warns the user.

Root cause is arithmetic, in `walker.ts`:

```ts
const bodyGradient = /gradient\(|url\(/i.test(body.backgroundImage)
// A gradient/image body background cannot be represented by the pure path; count it as a coverage
// gap the size of the slide so it nudges auto toward raster.
if (bodyGradient) {
  contentArea += 1
}
```

The comment says "the size of the slide". The code adds **1 px²** against a 921,600 px² slide.
Coverage moved from 1.000 to 0.99999. It cannot nudge anything. Separately, `scoreSlide` takes
`nodes` only and never sees `measure.body` at all, so the gradient-background case is invisible to
the scorer by construction — verified: `grep -n "body" src/shared/export/pptx/confidence.ts` returns
nothing.

**(b) Rotation is scored but never emitted — `07-rotated`.**

`scoreSlide` deducts 5 points for `'rotation transform'` and the reason appears in the report — so
the pipeline _detects_ rotation. But `grep -n "rotate" src/shared/export/pptx/walker.ts` returns
**nothing**: `ShapeSpec` carries an optional `rotate`, `pptx-writer.ts` forwards it, pptxgenjs
supports it — and the walker never sets it. Measured output:

```
rot=   0.0  box=( 806.4,  75.4)  388.1x173.2  'CONFIDENTIAL'      (authored rotate(-14deg))
rot=   0.0  box=(  86.7, 266.5)  526.6x167.0  'Rotated elements…' (authored rotate(3deg))
rot=   0.0  box=( 969.0, 331.0)   21.0x159.0  'INTERNAL ONLY'     (authored rotate(90deg))
```

Every element is placed at its **axis-aligned bounding box**. The 90°-rotated label gets a 21 px-wide
box and will wrap to roughly one character per line. A 5-point deduction does not come close to
describing that.

**(c) Mixed inline formatting loses the surrounding text — `01-title-body`.**

Source: `<p class=note>Growth was driven by <strong>enterprise expansion</strong> and a <em>lower
churn rate</em> than forecast.</p>`

Emitted: two text boxes, each with exactly one run — `'enterprise expansion'` and
`'lower churn rate'`. The three bare text nodes — `'Growth was driven by'`, `'and a'`,
`'than forecast.'` — are **absent from the file entirely**.

This follows directly from the leaf-text rule in `node.ts`/`walker.ts`: `<p>` has element children so
it is not a leaf and contributes no text; `<strong>` and `<em>` are leaves and contribute theirs; the
bare text nodes belong to no leaf _element_ and are therefore never visited. The rule was introduced
to prevent double-rendering nested spans, and it does — but it drops text as the price, with no
warning and no score deduction.

This is also why **every emitted text box in the entire corpus has exactly one run** — 67 text boxes,
67 runs, across all 8 slides, with no box ever carrying two. Run-level formatting is not partially
supported; it is structurally unreachable.

### 1.4 SVG

In `editable` mode the measurement script's `document.body.querySelectorAll('*')` descends into the
SVG, so SVG `<text>` elements are leaves and _do_ become text boxes — while the `<rect>` bars are
leaves with no text and hit neither branch of the walker, so they are dropped silently. The result is
5 axis labels floating on an empty slide. In `auto` the coverage rule catches it (0.137 < 0.75) and
rasterizes the whole slide, which is the honest outcome — so `auto` is safe here and `editable` is
not.

### 1.5 What is already exact

Worth stating plainly, because it bounds the problem:

- **Position/size: 84/84 emitted shapes matched the planner's spec to within 0.0001 px.** The
  `px → inches → EMU` chain (`px/96`, `914400/96 = 9525`, integer-exact) is correct and pptxgenjs
  reproduces it faithfully.
- **Color: 100 % exact hex** on every preserved text run, across 62 runs.
- **Font size: 100 % exact** (`px * 0.75`).
- The emitted files open in **real Microsoft PowerPoint** without repair prompts.

Minor blemish: `fontFace` is emitted lower-cased (`'arial'`, not `'Arial'`) because
`firstFontFamily()` in `confidence.ts` lower-cases for its set lookup and `walker.ts` reuses it for
the run's font name. PowerPoint font matching is case-insensitive so this is cosmetic, but it is
wrong in the XML.

---

## 2. Alternatives survey

### 2.1 The JavaScript ecosystem, with maintenance data

Versions, licenses and last-publish dates below are from `npm view` run during this research
(2026-09-03), not from memory.

| Package                                                          | Version | Last publish | License | Verdict                                                                                |
| ---------------------------------------------------------------- | ------- | ------------ | ------- | -------------------------------------------------------------------------------------- |
| **pptxgenjs** ([repo](https://github.com/gitbrent/PptxGenJS))     | 4.0.1   | 2025-06-26   | MIT     | **Current.** Run-level text ✅, exact RGB ✅, EMU positioning ✅, rotation ✅, shadow ✅, roundRect ✅, images ✅, **gradients ❌** |
| **html-to-pptx** ([repo](https://github.com/joker-duzhong/html-to-pptx)) | 1.1.0 | 2025-12-06 | MIT | **Wrapper over pptxgenjs** (`dependencies: { pptxgenjs: "^4.0.1" }`). Cannot exceed its ceiling. |
| **pptx-automizer** ([repo](https://github.com/singerla/pptx-automizer)) | 0.9.3 | 2026-08-22 | MIT | **Also wraps pptxgenjs** (`^3.12.0`) + jszip + @xmldom. Template-composition tool: stitches _existing_ `.pptx` templates. No HTML→shape mapping. |
| **officegen** ([repo](https://github.com/Ziv-Barber/officegen))   | 0.6.5   | **2022-06-22** | MIT  | Effectively **abandoned** (4+ years). Weaker shape/text model than pptxgenjs.            |
| **nodejs-pptx** ([repo](https://github.com/heavysixer/node-pptx)) | 1.2.5   | 2025-09-26   | MIT     | Hand-rolled xmlbuilder/xml2js. Smaller surface, far less battle-tested. No advantage.    |

**The finding that settles the JS question:** the two packages that advertise HTML→PPTX conversion
are both **built on pptxgenjs**. There is no JS library that beats pptxgenjs on fidelity, because the
ecosystem's higher-level options _are_ pptxgenjs with a layer on top. Swapping to either would add a
dependency and subtract nothing from the loss measured in §1.

#### pptxgenjs's real ceiling, measured

Three findings, each reproduced locally against the vendored 4.0.1:

- **No gradient fill.** `gradFill` occurs twice in `pptxgen.cjs.js`, both inside the hardcoded Office
  `theme1.xml` boilerplate; `gradient` is absent from `types/index.d.ts`.
  [Issue #102](https://github.com/gitbrent/PptxGenJS/issues/102) has been open since **2017-06-15**;
  [PR #1469](https://github.com/gitbrent/PptxGenJS/pull/1469) (2026-07-30) implements it and is
  unmerged. Do not plan around it landing.
- **No shape grouping.** Emitted `<p:grpSp>` count is **0** — only the mandatory `<p:grpSpPr>`
  boilerplate. [Issue #307](https://github.com/gitbrent/PptxGenJS/issues/307) open since 2018; the
  maintainer said grouping would ship in v4.0, and v4.0 shipped without it. Not currently a
  constraint for Sloodge (the walker emits a flat shape list), but it forecloses future
  group-preserving work.
- **Raw-EMU passthrough — undocumented, and exact.** `getSmartParseNumber` treats a coordinate
  **≥ 100 as raw EMU** and < 100 as inches. Verified by emitting `{x: 123457, y: 234567, w: 1000001}`
  and reading back `<a:off x="123457" y="234567"/><a:ext cx="1000001" cy="200000"/>` — verbatim. The
  docs advertise inches/percent only. This is a useful escape hatch: it means integer-exact EMU
  positioning is available today without leaving the library. (Current code passes inches, which is
  already exact for our 96 dpi mapping, so this is opportunity rather than a fix.)

One claim from the survey I could **not** reproduce: that pptxgenjs emits two `<a:pPr>` elements
inside one `<a:p>` (schema-invalid; [issue #258](https://github.com/gitbrent/PptxGenJS/issues/258)).
My decks emitted exactly one `pPr` per paragraph. It may require a specific option combination.
Recorded as unverified rather than repeated as fact.

Maintenance note: the last **release** is 2025-06-26 and the newest commit on any branch is
2025-11-28 — roughly 14 months without a release, with 294 open issues. Healthy enough to depend on,
not healthy enough to wait on for a feature.

### 2.2 Other runtimes

- **python-pptx** (1.0.2, MIT, last release 2024-08-07). Genuinely excellent and more precise than
  pptxgenjs at the XML level — but it is a **different process and a different runtime**. Shipping a
  Python interpreter inside an Electron app, or requiring the user to install one, is a large
  permanent cost. And per §3 it would not recover a single one of the measured losses, because those
  happen before any writer is called. Its real value to this project is as a **test oracle**, which
  is exactly how it was used here and how the M4.8 tests should use it.
- **LibreOffice headless** (`soffice --convert-to pptx`). **Eliminate outright — the conversion path
  does not exist.** I could not measure it (`soffice` is absent from this machine and the Windows
  host), but measurement is unnecessary: LibreOffice has **no HTML→Impress import filter**.
  `HTML.xcu` declares `DocumentService = com.sun.star.text.WebDocument`, so HTML always imports as a
  Writer/Web text document, and `--convert-to pptx` requires a `PresentationDocument`. Impress
  imports only ODP/PPT/PPTX/Keynote/CGM/SVG. Secondary disqualifier: LibreOffice's internal
  coordinate system is 1/100 mm = **360 EMU**, so anything routed through it is quantized to a
  360-EMU grid and cannot be EMU-exact. Plus a ~357 MiB install and MPL-2.0 source-offer obligations.
- **Aspose.Slides.** Feature-complete (the only option surveyed with full run-level shadow control),
  but wrong runtime and wrong price: no pure-JS or WASM build exists, so it needs a JDK or .NET
  runtime behind a native N-API addon requiring `electron-rebuild` per Electron × platform × arch. A
  shipped desktop app needs an OEM tier — realistic floor **$2,997**.
- **unioffice** (Go) — commercial-only, no public offline pricing, identifier-obfuscated source.
  **Disqualified.** The AGPL-3.0 ancestor `carmel/gooxml` is unmaintained since 2023.
- **Rust / .NET.** Both credible if a native writer ever becomes necessary: `rpptx` (MIT/Apache,
  EMU-native, has gradients + grouping, ~1.8 MB via napi-rs, but only weeks old) and .NET Open XML
  SDK (MIT, 424M downloads, ~27.7 MB NativeAOT single binary, all features present). Both add a
  per-platform native build matrix. Neither is warranted, because §3 establishes the writer is not
  where fidelity is lost.

Note the recurring structural argument, articulated best in ppt-master's design notes: HTML is
flow-based, DrawingML is a flat list of absolutely-positioned shapes, so PPTX→HTML is a _widening_
and HTML→PPTX a _narrowing_. That asymmetry is why the reverse direction is crowded and this one is
sparse — and the usual objection ("you would have to solve browser layout") **does not apply to
Sloodge, because Sloodge is Electron and already owns a layout engine.**

### 2.3 Is there anything that does high-fidelity CSS-layout → PPTX shapes?

**Yes — and this corrects an earlier conclusion in this document.** An initial npm-only search found
only pptxgenjs wrappers and I concluded no such tool existed. A wider survey found a small ecosystem
that appeared during 2026, driven by AI-slide workflows. I re-verified each repo's existence and
stats directly via `gh api` (2026-09-03), because the numbers looked implausible to me at first:

| Project                                                                              | Lang | Stars      | License | Last push  |
| ------------------------------------------------------------------------------------ | ---- | ---------- | ------- | ---------- |
| [atharva9167j/dom-to-pptx](https://github.com/atharva9167j/dom-to-pptx)               | JS   | 339        | MIT     | 2026-08-28 |
| [Hasasasa/html-to-editable-pptx](https://github.com/Hasasasa/html-to-editable-pptx)   | Py   | 61         | MIT     | 2026-07-07 |
| [Design-Arena/html-to-pptx](https://github.com/Design-Arena/html-to-pptx)             | Py   | 21         | MIT     | 2026-08-31 |
| [hugohe3/ppt-master](https://github.com/hugohe3/ppt-master)                           | —    | **51,665** | MIT     | 2026-09-03 |

Critically, **they all independently converged on Sloodge's architecture**: let Chromium resolve
layout, then map `getBoundingClientRect` + `getComputedStyle` onto native OOXML shapes. Once the
browser has resolved the box tree, flexbox and grid stop being a problem — the remaining work is
*style* translation, not layout. That is exactly what `pptx-renderer.ts` + `walker.ts` do.

So the corrected conclusion is narrower but still favourable: **Sloodge's architecture is the one the
field converged on.** What these projects have that Sloodge does not is a more complete mapping layer
— which is precisely the §1 finding.

Two techniques from them are worth stealing outright, independent of whether we ever take a
dependency:

- **Hasasasa's decoration-only capture.** Before rasterizing an element, hide all descendant text and
  set its own text colour transparent; capture the *decoration* pixels; then redraw the text as a
  vector text box on top. This converts "which CSS features do we support?" into a bounded question
  — "when do we snapshot?" — and yields a hard, testable invariant: **text is never rasterized.**
  That is a strictly better contract than the current all-or-nothing tier decision and is a natural
  fit for M4.8c.
- **Per-line geometry via `Range.getBoundingClientRect()`** (dom-to-pptx) — the same API this
  research used for ground truth in §0. It is the right tool for run- and line-level boxes and is
  already proven to work in this codebase's measurement context.

**On taking a dependency: don't, yet.** `dom-to-pptx` ships a 3.7 MB standalone browser bundle that
would be injected into the export window, it has a single maintainer, and its ~161k monthly downloads
against 339 stars is an odd ratio. Sloodge deliberately maintains a hardened slide sandbox and a
"one door" pptxgenjs boundary (`safe-pptx.ts`, six review rounds); injecting a large third-party
bundle into that window is a supply-chain and threat-model decision, not a convenience. **Read it as
prior art and as a source of test cases.** If it is ever adopted, it needs its own review round.

---

## 3. Where the loss actually happens

The task asked whether the bottleneck is measurement, mapping, or writing. The measurements answer
it unambiguously.

| Stage           | Evidence                                                                                                                                                       | Verdict                          |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| **Measurement** | Text nodes not owned by a leaf element are never visited (3/65 fragments lost). `transform` matrices are captured but discarded. `measure.body` never reaches the scorer. | **Lossy — and silently so**      |
| **Mapping**     | Never emits `rotate`; never emits `background: {dataUrl}`; drops `<img>`/`<canvas>`/SVG primitives; one run per box always; `valign` hardcoded `'top'`; only `border-top` read. | **The dominant loss**            |
| **Writing**     | 84/84 shapes exact to 0.0001 px; 100 % color; 100 % size; opens in PowerPoint.                                                                                    | **Not lossy** (one gap: gradients) |

The decisive experiment: I authored the same logical content twice — once through my from-scratch
OOXML writer, once through pptxgenjs — including a **five-run paragraph** with per-run color, bold
and italic, and a **-14° rotated** text box. python-pptx read back from _both_ files:

```
5 run(s):
   ('Growth was driven by ', 'CBD5E1', 20.0, None, None)
   ('enterprise expansion', 'FDE68A', 20.0, True, None)
   (' and a ',              'CBD5E1', 20.0, None, None)
   ('lower churn rate',     '5EEAD4', 20.0, None, True)
   (' than forecast.',      'CBD5E1', 20.0, None, None)
...
[TEXT_BOX] pos=(700.0, 430.0) 420.0x120.0 rot=346.0
```

Identical. **pptxgenjs can already express everything the current exporter fails to produce.** The
five-run paragraph that `01-title-body` loses is not a library limitation — pptxgenjs's
`addText(TextProps[])` signature has taken run arrays all along. The rotation that `07-rotated` loses
is not a library limitation — `rotate?: number` is in its public `.d.ts` (lines 1338, 1516, 1879).

pptxgenjs has exactly two reproduced ceilings (§2.1): **no gradient fill** and **no shape grouping**.
Neither explains a single loss measured in §1. Grouping is not a constraint at all today, because the
walker emits a flat shape list and nothing asks for groups. And the gradient gap is smaller than it
looks: §3.3 already specifies that gradient body backgrounds should be **rasterized to a full-bleed
image**, which pptxgenjs supports fine via `slide.background = { data }` — that path was simply never
implemented. So `05-gradient-cards` fails for want of code we specified, not for want of a library
feature.

### 3.1 The gap is mostly unimplemented spec, not unknown territory

`60-export.md` §3.3's mapping table has rows that were specified and never built. Verified against
the shipped tree:

| §3.3 row                                              | Shipped?                                                              |
| ----------------------------------------------------- | --------------------------------------------------------------------- |
| Gradient/image body background → full-bleed image     | **No** — `background: {dataUrl}` is a type the writer handles but nothing constructs |
| Sub-region rasterization (`capturePage({x,y,w,h})`)   | **No** — `capturePage` is called with **no arguments**, once, in the whole repo |
| `<img>` → `addImage`                                  | **No** — walker drops `img`                                            |
| `<canvas>` → `toDataURL()` → `addImage`               | **No** — walker drops `canvas`                                         |
| `<table>` → `addTable`                                | **No** — no table handling anywhere                                    |
| Single-primitive SVG → autoshape                      | **No** — walker drops all `svg`                                        |
| Leaf text, colors, sizes, boxes, bullets, hyperlinks  | Yes, and exact                                                         |

Sub-region rasterization is the one §3.3 calls "the intended common outcome" for chart slides. Its
absence is why `04-svg-chart` degrades to a whole-slide picture instead of an editable title and
caption over an inert chart image.

So the honest framing is not "our exporter is behind the state of the art." It is "our exporter
implements about half of its own spec, and the half it implements is exact."

---

## 4. The build-our-own question

### 4.1 The prototype

Built in the scratchpad: `proto-writer.ts`, ~250 lines of TypeScript, using **fflate** (already a
repo dependency, already used by `pptx-opc.ts` for reading). It emits an 11-part OPC package —
`[Content_Types].xml`, package rels, `presentation.xml` + rels, one slideMaster + rels, one
slideLayout + rels, `slides/slide1.xml` + rels, `theme1.xml` — with:

- `p:sp` shapes carrying `a:xfrm` at exact EMU offsets (`px * 9525`),
- `p:txBody` with **multi-run `a:p`**, each `a:r` carrying its own `a:rPr` (`sz`, `b`, `i`,
  `a:solidFill/a:srgbClr`, `a:latin`),
- `a:prstGeom prst="roundRect"` with a computed `a:gd name="adj"`,
- shape rotation via `a:xfrm/@rot` (60000ths of a degree),
- and **`<p:bg><a:gradFill>` — a real slide-level gradient background, which pptxgenjs cannot emit.**

**Result:** 5,094 bytes, 11 parts. python-pptx reads back all four shapes with exact boxes, exact
colors, the 5-run paragraph, and `rot=346.0`. **Microsoft PowerPoint opens it without a repair
prompt** and reports `shapes=4` with the full text intact. For comparison, pptxgenjs's rendering of
the identical content is 48,608 bytes across 39 parts — and, apart from the gradient, byte-for-byte
equivalent in fidelity.

Language choice, since the task asked: **TypeScript**, decisively. It shares the repo's existing
fflate OPC layer and the importer's EMU constants, runs in-process in Electron's main process with no
runtime the user must install, and is unit-testable with the existing vitest setup. Python +
python-pptx would prototype marginally faster but would mean shipping a Python runtime inside an
Electron app to solve a problem that is not in the writer — a large, permanent cost for no fidelity
gain. Rust/Go would add a native toolchain and cross-compilation burden for the same non-gain.

### 4.2 Why the prototype is nonetheless the wrong thing to ship

The prototype proves a custom writer is _cheap_ and _correct_. It does not prove it is _useful_,
because it produced the same fidelity as pptxgenjs on everything measured except gradients. Shipping
it would mean:

- re-deriving the sanitization boundary that `safe-pptx.ts` earned over six review rounds
  (XML-illegal characters in every forwarded string) — the exact invariant that took three separate
  fixes to get structurally right;
- re-implementing bullets, hyperlinks, `lineSpacingMultiple`, `charSpacing`, image embedding with
  content-type negotiation, speaker-notes parts, and `docProps` — all of which pptxgenjs already
  does and all of which are currently correct;
- and inheriting the long tail of PowerPoint's tolerance quirks that a 5-year-old library has
  already absorbed.

All of that to gain one feature — gradient fills — that the spec says should be solved by
rasterization anyway.

**The narrow exception worth keeping in the back pocket:** if gradient fidelity later becomes the top
complaint and rasterizing gradient panels proves unacceptable (it costs editability), the prototype
shows a **post-processing** route is viable: let pptxgenjs write the deck, then unzip with fflate,
splice `<a:gradFill>` into the target `p:spPr`/`p:bg`, and rezip. That is ~40 lines against a
package we already know how to read, and it does not require owning a writer.

Two notes that make this escape hatch more attractive than it first looks. First, the prototype's
`bgXml()` already emits exactly the `<a:gradFill><a:gsLst>…<a:lin ang>` fragment such a pass would
splice, and it is PowerPoint-validated — so the hard part is done and sitting in the scratchpad.
Second, if hand-rolling the zip surgery is unappealing, **`pptx-automizer` exposes a maintained
`ModifyXmlCallback`** (`(xml, index?, archive?) => void`, full DOM access to any OPC part) that does
this class of edit as a first-class operation — and it is the healthiest-maintained package surveyed
(7 open issues, last commit 2026-09-02). It is the ready-made tool for injecting the two things
pptxgenjs cannot emit, `<a:gradFill>` and `<p:grpSp>`, without waiting on issue #102's tenth
anniversary.

---

## 5. Recommendation

**(a) Keep pptxgenjs. Fix the measurement and the mapping.** Do not swap libraries; do not build a
writer.

The rationale in one line: swapping the writer cannot recover text the measurement pass never
collected, and cannot rotate shapes the walker never marks as rotated.

### 5.1 Milestone breakdown (3 PRs)

**M4.8a — Stop the silent lies.** _The highest value-per-line work in this document._

1. **Rotation.** Have the walker decompose the rotation angle out of the computed `transform` matrix
   (`classifyTransform` already identifies the pure-rotation case; extract `atan2(b, a)`) and set
   `ShapeSpec.rotate`. The writer and pptxgenjs already support it end to end. Correct the measured
   box from the axis-aligned rect back to the unrotated box.
2. **Gradient/image body background.** Implement the `background: { dataUrl }` variant §3.3 already
   specifies: when `body.backgroundImage` is a gradient or `url()`, use the full-slide capture as a
   full-bleed background image. This alone fixes `05-gradient-cards`.
3. **Make the scorer see `measure.body`.** Change `scoreSlide(nodes)` to `scoreSlide(measure)` so a
   body gradient is a scored signal rather than a 1 px² arithmetic no-op. Delete the misleading
   `contentArea += 1` and its comment.
4. Add a **hard blocker or heavy deduction for any un-modelled construct that currently scores 100**.

_Tests must assert:_ no slide in the fixture corpus both scores ≥ 90 and loses a construct; rotated
elements emit a non-zero `rot`; a gradient-background slide emits either `<p:bg>` or a full-bleed
picture.

**M4.8b — Run-level text.** Replace the leaf-_element_ rule with a leaf-**block** rule: find the
nearest block-level ancestor, and within it walk **text nodes**, emitting one `TextRunSpec` per text
node with the computed style of its parent inline element. One text box per block, N runs inside it.
`TextRunSpec[]` and pptxgenjs's `addText(TextProps[])` already accept this — only the producer
changes. Keep the anti-double-render guarantee by keying on the block, not the leaf.

_Tests must assert:_ `<p>a <strong>b</strong> c</p>` emits **one** box with **three** runs, all three
strings present, `b` bold; total text-node coverage is 100 % on the corpus.

**M4.8c — Sub-region rasterization (the hybrid tier).** Implement §3.3's specified hybrid: for
`<svg>`, `<canvas>`, `<img>` and any node the walker cannot model, call
`capturePage({ x, y, width, height })` on that node's device rect and insert an `image` ShapeSpec at
the right z-position among the native shapes. Raise `COVERAGE_RASTER_THRESHOLD`'s effect accordingly
— a chart slide should keep an editable title and caption over an inert picture rather than
rasterizing wholesale.

Adopt **Hasasasa's decoration-only capture** here (§2.3): before snapshotting a region, hide
descendant text and make the element's own text transparent, capture decoration pixels, then redraw
the text as vector runs on top. This converts the open-ended question "which CSS features do we
support?" into the bounded one "when do we snapshot?", and buys a hard invariant worth asserting in
the test suite: **text is never rasterized.** That invariant also subsumes most of the gradient
problem — a gradient panel becomes a picture with live text over it, which is the outcome §3.3 wanted
all along.

_Tests must assert:_ `04-svg-chart` stays `structured`, keeps its `<h1>` and caption as editable
text, and carries exactly one embedded picture covering the SVG's rect; and, corpus-wide, that no
slide emits a picture whose region contained text that is absent from the file's text runs.

_(Optional M4.8d, only if measurement demands it: font-name casing, `valign` from the computed
`align-items`/`justify-content`, and per-side borders instead of `border-top` for all four.)_

### 5.2 Fidelity targets the milestone's tests must assert

Stated as assertions over the fixture corpus, measurable by the rig described in §0:

| Target                                                                                              | Today                | After          |
| --------------------------------------------------------------------------------------------------- | -------------------- | -------------- |
| Text nodes preserved verbatim in `structured` slides                                                | 92.3 % (auto)        | **≥ 99 %**     |
| Exact hex color match on preserved runs                                                             | 100 %                | **100 %** (hold) |
| Exact font-size match (±0.02 pt)                                                                    | 100 %                | **100 %** (hold) |
| Emitted shape box vs measured DOM box                                                               | ≤ 0.0001 px          | **≤ 0.5 %** of slide dimension (hold; currently far better) |
| Rotated elements carrying a correct non-zero `rot`                                                  | 0/3                  | **3/3**, angle within 0.1° |
| Slides scoring ≥ 90 that drop a visually load-bearing construct                                     | 2/8 (**25 %**)       | **0**          |
| Multi-run paragraphs: runs per box where the source has mixed inline styling                        | always 1             | **= source run count** |

The last row and the "silent failure" row are the ones that matter. A confidence score that says 100
while the slide is unreadable is worse than a low score, because it suppresses the raster fallback
that would have produced an honest picture.

**Close the visual-fidelity measurement gap first.** Every target above is structural (is the text
there? is the hex right? is the EMU right?) because that is all §0's rig could measure. The thing
none of it proves is that the slide *looks* right — PowerPoint's line breaking is not Chromium's, so
a box sized to Chromium's measured height can overflow. Both mature projects in §2.3 ship a
round-trip harness — HTML screenshot → convert → render the `.pptx` back to PNG → image-diff — and
neither reached its fidelity without one. **Build that harness as the first task of M4.8a, not last.**
It is the only way to assert the reflow target, and it converts every row above from a proxy into a
measurement. (Rendering the `.pptx` back to an image needs LibreOffice or PowerPoint; on CI that
likely means a soffice container used purely as a renderer — which is a legitimate use of it, unlike
the conversion path rejected in §2.2.)

**Use the leverage nobody else has: constrain the generated CSS.** Every working implementation
surveyed depends on a fixed-size slide container and a style whitelist. Sloodge already has both —
the 1280×720 slide contract (`30-slide-format.md`) — *and* it controls the LLM prompt that authors
the CSS in the first place. That is a stronger position than any of these projects have. Steering
generation away from the constructs that force rasterization (inset shadows, `mix-blend-mode`,
`clip-path`, `backdrop-filter`) is cheaper than mapping them, and it raises average fidelity across
every deck rather than one slide at a time. Worth a short experiment before M4.8c, since it may
shrink how much hybrid rasterization is needed at all.

### 5.3 Identity-preservation plan for M4.5's round-trip

**Nothing in the above touches the round-trip guarantee, and this must stay true.**

M4.5 (`src/shared/import/pptx/ledger.ts`, branch `worktree-agent-a0ffe4a96e129ec62`) retains the
original archive verbatim at `import/original.pptx` and derives dirtiness by re-hashing slide HTML at
export time. `planRoundTrip` classifies every export into one of three modes:

- **`identity`** — retained archive re-emitted byte for byte. **Never reaches the shape writer.**
- **`patched`** — changed slide parts rewritten by text substitution on the _original_ XML; all other
  parts copied byte-for-byte. **Never reaches the shape writer.**
- **`rebuild`** — structural change; falls back to M4.3's structured export. **This is the only mode
  the shape writer serves.**

So the invariant for M4.8 is a one-liner, and it should be written down as a test:

> **The structured exporter is only ever reached in `rebuild` mode. Improving it cannot change
> `identity` or `patched` output, and no M4.8 change may introduce a call path from an unedited
> imported deck into the walker.**

That makes the relationship strictly positive: M4.8 improves the _worst_ case of the round-trip (the
case where retention buys nothing and we must regenerate from HTML) while leaving the byte-identity
claim structurally untouched. A boundary test in the spirit of `pptx-boundary.test.ts` — asserting
that `identity`/`patched` plans never invoke the `PptxWriter` seam — would make that structural
rather than reviewed.

One caution: `src/main/document/archive.ts` is **read-only** (it exposes `readArchive` /
`looksLikeZip` / name-map helpers, no `zipSync`). Any part-splicing work — the gradient
post-processing escape hatch in §4.2, or `patched`-mode rewriting — needs a hardened _write_ side
that does not yet exist. Do not assume the import OPC layer can be run in reverse.

---

## 6. Scratch artifacts

Session scratchpad, `pptx-research/` (not in the repo):

- `slides/01..08*.html` — the fixture corpus
- `harness.mjs` — puppeteer measurement + shipped planner/writer driver
- `analyze.py` — python-pptx read-back and ground-truth comparison
- `proto-writer.ts`, `proto-driver.ts` — the ~250-line from-scratch OOXML writer
- `baseline-same.mjs` — the pptxgenjs rendering of identical content, for A/B
- `out/*.pptx`, `out/results.json`, `out/analysis.json` — raw measurements
