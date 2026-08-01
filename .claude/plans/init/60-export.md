# 60 — Export (PDF, PPTX, HTML)

> Parent: [00-overview.md](00-overview.md) · Depends on: [30-slide-format.md](30-slide-format.md) (slide contract), [10-architecture.md](10-architecture.md) (main-process services, IPC)
> Research basis: [research/slides-export-electron.md](research/slides-export-electron.md) §2

## 0. Premises

Every slide is a **self-contained 1280×720 HTML document** — no shared stylesheet, no cross-slide DOM, no external network dependencies. That single fact is what makes export tractable:

- 1280 × 720 CSS px at Chromium's 96 dpi print baseline = **13.333 in × 7.5 in** exactly, which is also PowerPoint's 16:9 "widescreen" slide size. **No scaling is ever needed** in any pipeline. `px / 96 = inches` is the only unit conversion in the codebase, and it is exact.
- A slide can be rendered in isolation, in any order, in a throwaway window. Export is therefore embarrassingly parallel in principle and trivially resumable in practice.
- Slides may contain CSS/SMIL animation and vanilla JS interactivity. Neither PDF nor PPTX can represent these. §4 defines the degradation policy.

Three export targets, three fidelity contracts:

| Target | Fidelity contract | Editable downstream? | Primary mechanism |
|---|---|---|---|
| **PDF** | Pixel-exact, vector text where possible | No (by design) | `webContents.printToPDF` per slide + `pdf-lib` merge |
| **PPTX** | Best-effort editable, guaranteed-visual fallback | Yes, per-slide-dependent | `pptxgenjs` structured DOM walk **or** full-slide PNG raster |
| **HTML** | Byte-exact (it *is* the source), **animation and interactivity preserved** | Yes, trivially | zip of slide files + generated presenter shell |

**Design rule that governs all three:** the export pipeline never re-implements layout. Chromium is the layout engine; we either ask it to print, ask it to screenshot, or ask it (via injected script, in its own context) to *report* the boxes it already computed. We never parse CSS ourselves.

---

## 1. Pipeline architecture

### 1.1 Where it runs

All export runs in the **main process**, in a dedicated `ExportService`. Rationale:

- `printToPDF` and `capturePage` are `webContents` APIs — main-process only.
- Writing the output file needs `fs`; the renderer has no Node.
- Export must survive the user navigating the editor UI, switching slides, or opening a dialog. Coupling it to the visible canvas iframe would make it fragile and slow (thumbnail iframes are lazy, scaled, and may be virtualized out of the DOM).

The renderer's role is limited to: invoking the export, choosing options, and rendering progress. It never touches a pixel.

### 1.2 The offscreen render window

A single reusable hidden `BrowserWindow` — the **export window** — is created once per export job and torn down at the end.

```ts
// main/export/export-window.ts
const win = new BrowserWindow({
  show: false,
  width: 1280,
  height: 720,
  useContentSize: true,           // 1280x720 of *content*, excluding any chrome
  webPreferences: {
    offscreen: false,             // see note below
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    backgroundThrottling: false,  // hidden windows are throttled by default -> animations stall
    preload: EXPORT_PRELOAD,      // exposes only slideReady() + measure RPC
  },
});
win.webContents.setZoomFactor(1);
```

Three non-obvious settings, each of which is a bug if omitted:

- **`backgroundThrottling: false`** — Chromium throttles timers and rAF in hidden/occluded windows. Without this, a slide's CSS animations advance at ~1 fps or freeze entirely, and the "final frame" we capture (§4) is wrong.
- **`useContentSize: true`** — otherwise the OS window frame is subtracted from 1280×720 and the viewport is a few px short, shifting every `vw`/`vh`-relative layout.
- **`offscreen: false`** — we deliberately do *not* use Electron's offscreen-rendering (OSR) mode. OSR routes through a software/shared-texture compositor path with known differences in font rasterization and GPU-accelerated effects (filters, blend modes, 3D transforms). A normal hidden window uses the same compositor as the visible editor, so **what you saw in the canvas is what you export**. `show: false` is sufficient isolation.

**Zoom/DPR discipline.** `printToPDF` works in CSS px at 96 dpi and is DPR-independent. `capturePage` works in *device* px and **is** DPR-dependent — on a 2× display it returns a 2560×1440 image. This is desirable for raster quality but must be explicit, never accidental. `ExportService` records `win.webContents.getZoomFactor()` and `screen.getPrimaryDisplay().scaleFactor` into the export manifest, and the raster path forces its own scale (§3.5) rather than inheriting the display's.

### 1.3 Loading a slide deterministically

Slides come from the `.sloodge` document as HTML strings, not files. They are written to a per-job temp directory and loaded via `file://` so that relative asset references (images the agent generated, embedded fonts) resolve:

```
<tmp>/sloodge-export-<jobId>/
  assets/            # deck assets, hardlinked/copied once
  slide-001.html
  slide-002.html
  ...
```

Loading `data:` URLs is rejected (opaque origin breaks relative assets and some font loading); `loadFile` on the temp copy is the only path.

**The readiness barrier.** `did-finish-load` is not sufficient — it fires before webfonts settle, before `<img>` decode, and before any slide JS that builds its own DOM. Printing early produces blank charts and fallback fonts, and it does so *intermittently*, which is the worst failure mode. Every render waits on an explicit barrier:

```ts
await win.webContents.executeJavaScript(`(async () => {
  await new Promise(r => (document.readyState === 'complete' ? r() : addEventListener('load', r)));
  await document.fonts.ready;
  await Promise.all([...document.images]
    .filter(img => !img.complete)
    .map(img => img.decode().catch(() => {})));      // decode() rejects on broken imgs; ignore
  // Slide contract opt-in: a slide doing async work sets window.__slideReady as a Promise.
  if (window.__slideReady) await window.__slideReady;
  await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));  // 2 frames = committed
  return true;
})()`, true);
```

Wrapped in a **6 s timeout**. On timeout the slide is still exported, and the job manifest records `readinessTimeout: true` for that slide — a degraded export beats a hung one, but the user is told which slides were degraded.

`window.__slideReady` is part of the slide contract in [30-slide-format.md](30-slide-format.md): optional, but the `slide-deck` / `interactive-graph` skills emit it whenever a slide fetches, computes, or lays out asynchronously.

### 1.4 Job model

```ts
type ExportJob = {
  id: string;
  format: 'pdf' | 'pptx' | 'html';
  slideIds: string[];              // respects a user-chosen range/selection
  outPath: string;
  options: PdfOptions | PptxOptions | HtmlOptions;
};

type ExportProgress =
  | { phase: 'preparing' }
  | { phase: 'rendering'; slideIndex: number; total: number; slideTitle: string }
  | { phase: 'assembling' }
  | { phase: 'done'; outPath: string; report: ExportReport }
  | { phase: 'error'; slideIndex?: number; message: string }
  | { phase: 'cancelled' };
```

Slides are processed **strictly sequentially** in one window. Parallel windows were considered and rejected: N hidden windows contend for the GPU process, and a slide with a heavy `requestAnimationFrame` loop starves its neighbours, making the "final frame" capture nondeterministic. Sequential export of a 30-slide deck is ~10–20 s, which is acceptable; determinism is not negotiable.

Between slides the window is reused but fully reset (`loadFile` of the next slide). A `webContents` crash (`render-process-gone`) is caught, the window is recreated, and the slide is retried **once**; a second failure marks that slide as failed and the job continues, recording it in the report.

**Cancellation** is cooperative: an `AbortSignal` checked at each phase boundary. On cancel, the temp dir is removed and no output file is written (never a truncated PDF at the user's chosen path).

**Atomic output.** Everything is written to `<outPath>.partial` and `fs.rename`d into place on success. A failed or cancelled export never leaves a half-file where the user expects a deck.

### 1.5 IPC surface

```ts
// preload -> renderer
window.sloodge.export = {
  start(job: Omit<ExportJob, 'id'>): Promise<{ jobId: string }>,
  cancel(jobId: string): Promise<void>,
  onProgress(cb: (p: ExportProgress & { jobId: string }) => void): Unsubscribe,
};
```

Progress is pushed on a `webContents.send` channel, not polled. The main process owns the `dialog.showSaveDialog` call (native, main-only) and hands the chosen path into the job, so the renderer never handles filesystem paths it could tamper with.

---

## 2. PDF export

### 2.1 Approach: per-slide print, then merge

Two viable designs (research §2.3). We choose **per-slide + merge**:

| | Single stitched document | **Per-slide + `pdf-lib` merge (chosen)** |
|---|---|---|
| Slide isolation | Broken — all slides share one document, so IDs, CSS selectors, and global JS collide | Preserved exactly; matches the core product invariant |
| Page-break control | Fragile; `break-after` interacts badly with `position: fixed`, `vh` units, and transforms under Chromium's print pass | Trivial — one document, one page |
| Progress reporting | All-or-nothing, one long opaque call | Natural per-slide granularity |
| Failure blast radius | One bad slide kills the whole PDF | One bad slide is isolated and reported |
| Cost | 1 print call | N print calls + a merge (~ms per page) |

The stitched approach also forces us to rewrite every slide's HTML to be co-hostable — exactly the work the self-contained-slide contract exists to avoid.

### 2.2 Per-slide print call

```ts
const buf = await win.webContents.printToPDF({
  printBackground: true,        // MANDATORY — without it every background/gradient silently vanishes
  preferCSSPageSize: true,      // honor the slide's own @page rule
  pageSize: { width: 13.333, height: 7.5 },   // inches; fallback if the slide lacks @page
  landscape: false,             // irrelevant when the page size is already explicit + wide
  margins: { top: 0, bottom: 0, left: 0, right: 0 },
  scale: 1,
  generateDocumentOutline: false,  // outline is built at merge time from slide titles
  generateTaggedPDF: true,         // structure tags -> selectable/accessible text; cheap, no visual cost
});
```

`printBackground` and the zero margins are the two settings that account for nearly all "the PDF looks wrong" reports in the wild. Both are locked in constants, not options.

### 2.3 The `@page` requirement in the slide contract

`preferCSSPageSize: true` is only meaningful if the slide declares its page. The slide contract ([30-slide-format.md](30-slide-format.md)) therefore requires every generated slide to carry a print block, and the export service **injects it defensively** if absent (older decks, hand-edited slides):

```css
@page { size: 1280px 720px; margin: 0; }

@media print {
  html, body { width: 1280px; height: 720px; margin: 0; overflow: hidden; }
  /* Pin viewport-relative units: during the print pass Chromium's viewport is the
     page box, so vw/vh can differ from screen. Slides are authored against a fixed
     1280x720 root, so this is a no-op for compliant slides and a rescue for others. */
  :root { --slide-w: 1280px; --slide-h: 720px; }
  * { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
}
```

Injection happens by appending a `<style data-sloodge-print>` node after the readiness barrier, then waiting one more frame. It is idempotent and never modifies the stored slide source.

**A known Chromium behaviour to guard against:** `position: fixed` elements are painted only on the first page during print. With one page per slide this is harmless — another reason per-slide beats stitching, where fixed footers would appear only on slide 1.

### 2.4 Merge

```ts
import { PDFDocument } from 'pdf-lib';

const merged = await PDFDocument.create();
merged.setTitle(deck.title);
merged.setProducer('Sloodge');
merged.setCreationDate(new Date());

for (const { buf, slide } of perSlide) {
  const doc = await PDFDocument.load(buf);
  const [page] = await merged.copyPages(doc, [0]);   // exactly one page expected
  merged.addPage(page);
}
await fs.writeFile(partialPath, await merged.save({ useObjectStreams: true }));
```

Two integrity checks during merge:

1. **Page count per slide must be exactly 1.** More than one means content overflowed 720 px — a genuine authoring defect. The extra pages are dropped (matching reveal.js's `pdfMaxPagesPerSlide: 1` clipping semantics) and the slide is flagged `overflowed: true` in the report, surfaced in the UI as "Slide 7 content extends past the slide edge and was clipped."
2. **Page box must be 960 × 540 pt** (13.333 in × 72). A mismatch means `@page` injection or `preferCSSPageSize` failed; the job aborts loudly rather than shipping a subtly mis-sized PDF.

**Outline / bookmarks.** `pdf-lib` has no high-level outline API, so a small helper writes the `/Outlines` dictionary directly: one top-level entry per slide, titled from the slide's `<title>` or first heading, destination `[page /Fit]`. Nice-to-have; behind `options.includeOutline`, default on. If the helper throws, it is caught and the PDF ships without an outline — never fail an export over a bookmark.

### 2.5 PDF options exposed to the user

| Option | Default | Notes |
|---|---|---|
| Slide range | All | Same range control as PPTX; shared component |
| Include speaker notes | off | When on, each slide page is followed by a generated notes page (letter portrait, plain HTML rendered through the same pipeline) |
| Include outline/bookmarks | on | §2.4 |
| Tagged PDF (accessibility) | on | `generateTaggedPDF`; text stays selectable regardless |

Deliberately **not** exposed: scale, margins, page size, `printBackground`. Every one of them can only make the output wrong.

---

## 3. PPTX export

This is the hard one. PowerPoint's object model is absolutely-positioned shapes in EMUs with no layout engine; a slide is CSS. The gap is unbridgeable in general, so the design is explicitly **two-tier with a per-slide decision**.

### 3.1 Two tiers

- **Tier A — structured conversion.** Walk the slide DOM, classify each visible node, emit `pptxgenjs` `addText` / `addShape` / `addImage` / `addTable` calls with boxes measured by Chromium. Result: real PowerPoint text boxes the user can edit, restyle, and screen-read.
- **Tier B — raster fallback.** `capturePage()` the whole slide, `addImage` it full-bleed. Result: pixel-perfect and completely inert.

Neither is right for every slide. A title slide with three text runs converts perfectly; an animated SVG solar system does not. **The choice is made per slide, automatically, by a confidence score, with a user override.**

### 3.2 Measurement pass

A single injected script runs in the slide's own context and returns a flat, serializable element list. It runs *after* the readiness barrier and after animations are settled (§4), so all boxes are final.

```js
// injected; returns SlideNode[]
const px2in = (v) => v / 96;
const nodes = [];

const visible = (el, cs) =>
  cs.display !== 'none' && cs.visibility !== 'hidden' && parseFloat(cs.opacity) > 0.01 &&
  el.getBoundingClientRect().width > 0.5 && el.getBoundingClientRect().height > 0.5;

for (const el of document.body.querySelectorAll('*')) {
  const cs = getComputedStyle(el);
  if (!visible(el, cs)) continue;
  const r = el.getBoundingClientRect();
  nodes.push({
    slId: el.getAttribute('data-sl-id') ?? null,     // Design Mode's stable id (40-design-mode.md)
    tag: el.tagName.toLowerCase(),
    x: px2in(r.x), y: px2in(r.y), w: px2in(r.width), h: px2in(r.height),
    z: cs.zIndex === 'auto' ? 0 : +cs.zIndex,
    domIndex: nodes.length,                          // paint-order tiebreak
    text: el.children.length === 0 ? el.textContent.trim() : '',
    style: {
      fontFamily: cs.fontFamily, fontSize: parseFloat(cs.fontSize), fontWeight: cs.fontWeight,
      fontStyle: cs.fontStyle, textDecoration: cs.textDecorationLine,
      color: cs.color, textAlign: cs.textAlign, lineHeight: cs.lineHeight,
      letterSpacing: cs.letterSpacing, textTransform: cs.textTransform,
      background: cs.backgroundColor, backgroundImage: cs.backgroundImage,
      borderRadius: cs.borderRadius, border: [cs.borderTopWidth, cs.borderTopStyle, cs.borderTopColor],
      boxShadow: cs.boxShadow, filter: cs.filter, backdropFilter: cs.backdropFilter,
      mixBlendMode: cs.mixBlendMode, transform: cs.transform, clipPath: cs.clipPath,
      writingMode: cs.writingMode, overflow: cs.overflow,
    },
    src: el.tagName === 'IMG' ? el.currentSrc : null,
  });
}
```

Two structural rules:

- **Leaf-text rule.** Only elements with no element children contribute text. This prevents emitting a heading twice (once for the `<h1>`, once for a nested `<span>`) — the classic double-render bug in naive DOM→PPTX converters.
- **Container rule.** A non-leaf element contributes a shape *only* if it paints something itself (non-transparent background, visible border, or radius+background). Pure layout wrappers (`display: flex/grid` with no paint) are skipped entirely — PowerPoint has no concept of them.

Z-order for emission is `(z, domIndex)` ascending, approximating paint order. Full CSS stacking-context semantics are not reproduced; slides that depend on them score low (§3.4) and go to raster anyway.

### 3.3 Node → pptxgenjs mapping

| DOM / CSS | pptxgenjs | Notes |
|---|---|---|
| Leaf text node | `addText(runs, { x,y,w,h, ... })` | `w`/`h` from the measured box; `valign: 'top'`; `margin: 0`; `wrap: true`; `shrinkText: false` |
| `font-size` px | `fontSize` pt | `pt = px * 0.75` (96 dpi → 72 pt/in) |
| `color`, `background-color` | `color`, `fill.color` | rgb(a)→`RRGGBB` + `transparency` percent |
| `font-weight >= 600` | `bold: true` | intermediate weights collapse to bold/regular |
| `font-family` | `fontFace` | first family name only; §3.6 |
| `text-align` | `align` | `justify` → `justify` (supported) |
| `line-height` | `lineSpacingMultiple` | ratio to font-size; `normal` → omit |
| `letter-spacing` | `charSpacing` (pt) | |
| `text-transform: uppercase` | applied to the string | PPTX has no run-level transform |
| `<ul>/<ol>` + `<li>` leaves | one `addText` with `bullet: true` runs | `<ol>` → `bullet: { type: 'number' }` |
| `<a href>` | run `hyperlink: { url }` | |
| Div/section with bg or border | `addShape(rect \| roundRect, { fill, line, rectRadius })` | uniform radius only |
| Uniform 1-color `border` | `line: { color, width, dashType }` | non-uniform borders → penalty |
| `<img>` | `addImage({ data \| path, x,y,w,h })` | re-encoded through the temp dir; `object-fit: cover` → pre-crop with sharp |
| `<table>` | `addTable(rows, { colW, border })` | only for simple grid tables; any `colspan`/`rowspan` → penalty |
| `<svg>` | rasterize subtree → `addImage` | never mapped to autoshapes; see below |
| `<canvas>` | `toDataURL()` → `addImage` | |
| `border-radius` on a text box | `shape: 'roundRect'` behind the text | text boxes can't be rounded directly |
| Slide `<body>` background | `slide.background = { color } \| { data }` | gradient/image body backgrounds are rasterized to a full-bleed background image |

**SVG is always rasterized, never converted.** `addShape` exposes only PowerPoint's built-in autoshape gallery — there is no arbitrary-path primitive — so a generic SVG→autoshape mapping is impossible. Attempting it would produce silently wrong geometry, which is worse than an image. The one concession: an SVG that is a *single* `<rect>`, `<circle>`, `<ellipse>`, or `<line>` with a flat fill maps to the corresponding autoshape, because that case is exact and common in generated slides (divider rules, dots, badges).

**Sub-region rasterization (the hybrid case).** When a slide is otherwise convertible but contains one or two complex regions (an SVG chart, a gradient panel), those subtrees are captured individually via `capturePage({ x, y, width, height })` with the device rect derived from `getBoundingClientRect()`, and inserted as images layered at the right z-position among the native shapes. The rest of the slide stays editable. This is the intended common outcome for `svg-animation` and `interactive-graph` slides: an editable title and caption over an inert picture of the graphic.

### 3.4 Confidence scoring and the per-slide decision

Each slide gets a score in **0–100**, starting at 100, with deductions from features that PPTX cannot represent. The score is computed from the measurement pass alone — no rendering comparison needed at decision time.

| Signal | Deduction | Why |
|---|---|---|
| `background-image` with `gradient()` on a painting element | −12 each (cap −25) | pptxgenjs gradient support is a narrow subset of CSS |
| `box-shadow` other than a simple outer shadow | −8 each (cap −20) | OOXML shadow ≠ CSS shadow |
| `filter` / `backdrop-filter` non-`none` | −25 | No OOXML equivalent at all |
| `mix-blend-mode` non-`normal` | −20 | |
| `clip-path` non-`none` | −20 | |
| `transform` with rotation/skew/3D | −15 (rotation-only: −5, mapped to shape `rotate`) | Skew/3D unrepresentable |
| `<svg>` with >1 drawable primitive | −18 each (cap −40) | Forced rasterization |
| `<canvas>` present | −18 | |
| Non-system font family (§3.6) | −10 | Substitution risk on the viewer's machine |
| Text node whose measured box would reflow differently at PPTX metrics | −6 each (cap −24) | Autofit divergence |
| Overlapping text boxes (IoU > 0.15) | −10 each | Overlap usually implies effects we didn't model |
| >120 emitted nodes | −15 | Shape explosion; also slow in PowerPoint |
| Element count where paint order can't be linearized (nested stacking contexts) | −15 | |
| Animation present (§4) | 0 | Handled by policy, not score — final frame is a legitimate still |

Thresholds:

- **score ≥ 70 → Tier A** (structured), with sub-region rasterization for the offending parts.
- **score < 70 → Tier B** (full raster).
- Any **hard blocker** forces Tier B regardless of score: `writing-mode` vertical, CSS `@container`/`@scope` queries in the sheet, `position: sticky`, an element with `overflow: scroll` whose content exceeds its box (i.e. content only reachable by scrolling), or a measurement-pass exception.

The thresholds are constants in one module with the score table beside them, tuned against the 7 experiment fixtures (§5.4) — not scattered magic numbers.

### 3.5 The raster path

```ts
// After the readiness + animation-settle barriers:
const img = await win.webContents.capturePage();      // full content area, device px
const png = img.toPNG();
slide.addImage({ data: `data:image/png;base64,${png.toString('base64')}`,
                 x: 0, y: 0, w: 13.333, h: 7.5 });
```

- **Capture scale.** `capturePage` follows the display's `scaleFactor`, so a naive capture is 1280×720 on one machine and 2560×1440 on another. Zoom is *not* used to normalize this — changing `zoomFactor` changes layout, which would make the raster disagree with the PDF. Instead: capture at whatever the display gives, then **resample to a fixed 2560×1440** (2×) with `sharp`. On a 1× display this upscales a 1280×720 capture, which is why 2× is the ceiling and not 3×; on a 2× display it is a no-op. Deterministic output size, zero layout perturbation. A `pptxRasterScale` setting (1× / 2×) trades file size for print quality.
- **Format.** PNG by default (text edges, flat UI colours). Slides classified as photographic (>60 % of the frame covered by `<img>` with a raster `src`) use JPEG q90 — a 30-slide photo deck is ~90 MB as PNG and ~9 MB as JPEG.
- **Text layer for accessibility.** Even in Tier B, the slide's visible text is preserved as machine-readable text: it is written into the slide's **speaker notes**, prefixed `[Slide text]`, so search, screen readers, and copy-paste still work on an otherwise flat image. (Invisible off-canvas text boxes were considered and rejected — PowerPoint surfaces them in the outline pane and the selection pane as phantom objects.) This costs nothing and recovers most of what rasterization loses.

### 3.6 Fonts

PPTX embeds font *references*, not files. A slide using a webfont renders in PowerPoint with whatever the viewer's machine substitutes.

- A conservative **system-safe list** (Arial, Helvetica, Calibri, Georgia, Times New Roman, Courier New, Verdana, Tahoma, Trebuchet MS, plus the macOS/Windows UI stacks) maps 1:1 with no penalty.
- Anything else: the family name is still written (so machines that *do* have it render correctly), a `−10` confidence deduction applies, and the **export report** lists the substitution risk: "Slide 3 uses 'Inter', which may be substituted on other machines."
- If the deck's non-system font usage is heavy and the score would otherwise fall in 60–75, the UI nudges toward raster for those slides with exactly that reason shown.

Font embedding (`fontEmbed` in OOXML) is out of scope for v1: it requires shipping/ licensing the TTF and pptxgenjs does not automate it. Revisit if it becomes the top fidelity complaint.

### 3.7 Deck-level PPTX setup

```ts
const pptx = new pptxgen();
pptx.defineLayout({ name: 'SLOODGE_16x9', width: 13.333, height: 7.5 });
pptx.layout = 'SLOODGE_16x9';
pptx.author = 'Sloodge';
pptx.title = deck.title;
```

No slide master is defined. Masters exist to share branding across slides; Sloodge slides are independently authored and carry their own backgrounds, so a master would only introduce a second, conflicting source of truth. Speaker notes are attached per slide via `addNotes`.

### 3.8 PPTX options exposed to the user

| Option | Default | Notes |
|---|---|---|
| Conversion mode | **Auto (recommended)** | Per-slide by score |
| — | Editable where possible | Forces Tier A even below threshold; report lists risks |
| — | Picture-perfect (all raster) | Forces Tier B for every slide |
| Per-slide override | — | The export dialog lists every slide with its score, chosen tier, and top reason; each row has an Editable/Picture toggle |
| Raster quality | 2× | 1× halves file size |
| Include speaker notes | on | |
| Slide range | All | |

The per-slide table is the centrepiece of the PPTX dialog. It makes the automatic decision legible and reversible, which converts "the export is unpredictable" into "the export explained itself and I overrode slide 4."

---

## 4. Animation & interactivity degradation policy

Neither PDF nor PPTX can run CSS animation, SMIL, or JS. The policy is explicit, uniform, and surfaced.

### 4.1 The rule: export the final frame

**A slide's exported representation is its steady state** — the frame after entrance animations complete and interactive widgets have settled into their default view. Not `t=0` (often an invisible pre-animation state: `opacity: 0`, `translateY(20px)` — exporting that yields a blank slide, the single worst possible failure), and not a mid-animation frame.

Settling procedure, run after the readiness barrier and before any print/capture/measure:

```js
// 1. Let time-based entrance animations run to completion, bounded.
//    getAnimations() covers CSS animations, CSS transitions, and Web Animations.
const anims = document.getAnimations();
const finite = anims.filter(a => {
  const t = a.effect?.getComputedTiming();
  return t && t.iterations !== Infinity;
});
await Promise.race([
  Promise.all(finite.map(a => a.finished.catch(() => {}))),
  new Promise(r => setTimeout(r, 3000)),           // bound: 3s
]);
finite.forEach(a => { try { a.finish(); } catch {} });   // force any stragglers

// 2. Infinite/looping animations: pause at a representative phase rather than t=0,
//    which for a spinner or orbit is an arbitrary but non-degenerate frame.
anims.filter(a => !finite.includes(a)).forEach(a => {
  try { a.currentTime = (a.effect.getComputedTiming().duration || 0) * 0.25; a.pause(); } catch {}
});

// 3. SMIL (<animate>, <animateTransform>) is not in getAnimations().
document.querySelectorAll('svg').forEach(svg => {
  try { svg.setCurrentTime(2.0); svg.pauseAnimations(); } catch {}
});

// 4. Two committed frames.
await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
```

The 25 % phase offset for looping animations is a deliberate small choice with a large effect: an orbit animation at `t=0` has every planet stacked at its start angle, which reads as a bug in the exported PDF. A quarter-cycle in, they are spread out and the still looks intentional.

**Interactivity** is exported in its default state — no hovers, no clicks, no toggles applied. Tooltips (typically `opacity: 0` until hover) are correctly absent. Legend series that start visible stay visible. A slide whose *meaning* only appears on interaction (e.g. answer revealed on click) exports as the un-revealed state; this is correct and is called out in the report.

### 4.2 What the user is told

Silent degradation is the failure we most want to avoid. Three touch points:

1. **In the export dialog, before running.** If any selected slide has animation or interactivity, an inline note: *"3 slides contain animation or interactivity. PDF and PowerPoint can't run these — they'll be exported as a single still frame. Export to HTML to keep them working."* With a "Which slides?" disclosure listing them.
2. **In the slide list of the PPTX dialog.** Each affected row carries an `Animated` / `Interactive` chip next to its confidence score.
3. **In the post-export report** (§6): a per-slide table of exactly what was degraded, kept until dismissed and re-openable from the status bar.

Additionally, **speaker notes gain a generated line** for degraded slides — `[Sloodge] This slide is animated; the exported image shows its final state.` — so the information survives into the file the user shares.

### 4.3 Explicitly out of scope for v1

- **Build steps / progressive reveal → multiple pages.** reveal.js and Slidev both export one page per fragment step. Sloodge's slide contract has no build-step model in v1 ([30-slide-format.md](30-slide-format.md)); when `data-build-index` lands, PDF export gains a `--with-builds` option that renders each build state as its own page. The pipeline is already shaped for it — it is one more loop inside the per-slide render.
- **Animated GIF/video export** of animated slides. Attractive, non-trivial (frame capture + encoding), and no clear v1 user need.

---

## 5. HTML export

The highest-fidelity export by a wide margin, because it is the source. This is the answer to "but my animation doesn't work in PowerPoint."

### 5.1 Output

A `.zip` (or an unzipped folder — user choice):

```
<deck-name>/
  index.html            # generated presenter shell, manifest inlined
  slides/
    001-title.html      # the wrapped slide document (see below)
    002-agenda.html
    ...
  deck.json             # ordered manifest: formatVersion, title, slideCount, slides[{index,id,title,file}]
```

The `NNN-` prefix makes filenames **structurally collision-free** (two slides titled "Agenda" become `003-agenda.html` and `007-agenda.html`) and makes `slides/` sort in presentation order in any file manager. Uniqueness comes from the counter, so the slug half can be lossy — it is stripped to lowercase ASCII alphanumerics, because it becomes a path on the recipient's filesystem.

**As shipped (M4.4), two things differ from the sketch above. Both are deliberate.**

**1. Slide files are the *wrapped* document, not byte-identical source.** This is the most important decision in the milestone and it is a security trade, not an oversight.

Inside the app a slide's CSP arrives twice: injected into the document by `wrapSlideHtml` (layer 3) *and* sent as a `slide://` response header. In an exported bundle **there is no response header and no host CSP** — the file is opened from `file://` by a browser that has never heard of us. The injected meta is the only policy that survives. A bundle of raw author source would ship documents that run with no CSP at all: free network egress, deck contents exfiltrated, remote code fetched on the viewer's machine. Byte-identity is a nice property; handing a third party an unpoliced document is a vulnerability.

The trade costs less than it looks, because `wrapSlideHtml` is a *constant-length prefix inserted at a computed offset* that rewrites no author byte. The original source is recoverable exactly by removing that known prefix, so re-import still round-trips losslessly and the fidelity-oracle role of §5.4 survives under the same subtraction — the comparison is `exported == wrap(source)` instead of `exported == source`.

**2. No `assets/` directory.** The slide CSP is `img-src data: blob:` / `font-src data:` (`SLIDE_CSP`). A slide therefore *cannot* reference a sibling file — the policy travelling in its own bytes forbids it — so every image and font it uses is already a `data:` URI inside the document. An `assets/` folder would hold files no slide is permitted to load. When the deck model grows an asset store whose files slides may reference, the CSP has to change first; this layout follows that change rather than anticipating it.

### 5.1a The `file://` threat model

The exported bundle carries untrusted, model-authored content and is opened **outside our app**, so the four-layer sandbox of [10-architecture.md](10-architecture.md) §7 is cut in half. Stating precisely what is left:

| Layer | In the app | In an exported bundle |
|---|---|---|
| 1. Host renderer CSP + `contextIsolation` | Yes | **Gone** — the host is the user's browser |
| 2. `sandbox="allow-scripts"` iframe, no `allow-same-origin` | Yes | **Yes — emitted by the presenter shell** |
| 3. Slide's own injected CSP meta | Yes | **Yes — travels in the slide bytes** |
| 4. `slide://` response header | Yes | **Gone** — no protocol handler, no server |

Layers 2 and 3 are the entire remaining defence, and each is now load-bearing in a way it was not before, because neither has a backstop.

**The attack that layer 2 stops.** `file://` documents have historically been granted same-origin access to other `file://` URLs under some browser configurations. A shell that framed slides *with* `allow-same-origin` — or that inlined slide markup into the top-level document — would let a hostile slide read the viewer's local files and the shell's own DOM. `allow-scripts` **without** `allow-same-origin` forces the slide into an opaque origin: its scripts run (they must; that is the product), but it cannot reach `parent`, sibling slides, or the filesystem.

The two tokens fail in opposite directions and both are pinned by tests: dropping `allow-scripts` silently kills every animated slide, and adding `allow-same-origin` silently dissolves the sandbox — the HTML standard documents that pair as equivalent to no sandbox at all. A test asserts the exact token string, a second asserts `allow-same-origin` appears nowhere in the emitted document, and a third asserts no frame uses `srcdoc` (which would run the slide in the shell's own origin). All three are mutation-verified.

The shell additionally opens **no channel** to the frames: no `postMessage`, no `contentWindow` access, nothing injected into a slide. A sandbox with no hole needs no hole guarded.

**Injected text.** The deck title reaches three contexts in the shell — the `<title>`, several attributes, and the inlined JSON manifest. All three use **HTML escaping**, which is the opposite operation from the PPTX path's XML sanitizing: XML has characters it cannot represent, so that sanitizer *strips*; HTML can represent everything, so this one *escapes* and never strips, and a deck legitimately titled `Q1 & Q2 <2026>` survives readable. The JSON block escapes `<` as the JSON escape `\u003c`, which is still valid JSON (it parses back to the identical string) and makes a `</script` terminator unconstructible.

### 5.2 The presenter shell (`index.html`)

A single self-contained file, no build step, no dependencies. **Shipped in M4.4:**

- Renders the current slide in an `<iframe sandbox="allow-scripts">` sized 1280×720 and CSS-scaled with `transform: scale()` to fit the viewport, letterboxed — the same scaling strategy the editor canvas uses, so behaviour is identical. The frame stays exactly 1280×720 and only the transform changes, so a slide's own layout is never re-run at a different viewport.
- Keyboard: `→`/`Space`/`PageDown` next, `←`/`PageUp` prev, `Home`/`End`, `B` blank, `F` fullscreen, `Esc` drops fullscreen. Keys the shell does not claim fall through untouched, so an interactive chart keeps its own shortcuts.
- Auto-hiding controls (prev / counter / next) on the same 2.5 s idle beat as in-app Present mode — `PRESENT_CONTROLS_HIDE_MS` is one shared constant, not two copies.
- **Preloads the next slide** into a hidden second iframe and swaps on advance, so transitions are instant and slide JS starts warm.
- Deep links via `#/3` hash so a specific slide is shareable and reload-stable.
- Works from `file://` — no server required. `fetch('deck.json')` from `file://` is blocked by the opaque-origin rule, so `deck.json` is **inlined into `index.html`** as a `<script type="application/json">` block rather than fetched. A shell that fetched would be a blank page for the user who did exactly what we told them and double-clicked the file.

**How the shell shares Present mode's logic.** The shell is *emitted* JavaScript — it cannot import `keyToPresentIntent`. Rather than retype the semantics (which drift the first time a key is added), M4.1's pure machine moved to `src/shared/present/machine.ts` and the shell's key→intent table is **generated** by calling the real function over an exported `PRESENT_KEYS` list. The clamp and reducer are emitted as a small chunk that a test `eval`s and cross-checks against `clampSlideIndex` / `reducePresent` for every intent from every position. Semantics have one source; only the transport differs.

**Deferred to a later milestone** (the shell is structured for each, none is stubbed):

- **Speaker view** (`S`): a second window synced via `BroadcastChannel('sloodge-present')`, showing notes, next-slide thumbnail, and a timer. Waits on the deck model exposing notes through the export request.
- **Overview grid** (`O`): all slides as lazily-instantiated scaled iframes, click to jump.

### 5.3 Options

Shipped in M4.4: **slide range** (All / Current / `1-4`), plumbed end to end and unit-tested, though the menu path currently sends `all` because the Export dialog is its own milestone. Package-as-zip is the only packaging, and the presenter shell and manifest are always included.

| Option | Default | Status |
|---|---|---|
| Slide range | All | Shipped (pipeline); dialog pending |
| Package as | zip | Zip only; plain folder deferred |
| Include presenter shell | on | Always on |
| Include speaker notes | on | Deferred with speaker view — notes are not yet in the export request |

### 5.4 Why this also serves as the fidelity oracle

HTML export is the only export whose correctness is definitionally checkable: the slide files must equal `wrapSlideHtml(source)` — byte-identity modulo the known constant-length prefix of §5.1. That makes it a cheap, strong regression test (§6.3) and the reference point against which PDF/PPTX fidelity is measured.

---

## 6. Export report & progress UI

### 6.1 Progress

- Modal-less **progress toast** anchored bottom-right, above the status bar: title (`Exporting deck.pptx`), determinate bar over `slideIndex/total`, current slide thumbnail + title, elapsed time, **Cancel**.
- The app stays fully usable during export — the whole point of the offscreen window. Editing a slide mid-export does not affect the job, which snapshots slide HTML at job start.
- Multiple concurrent jobs are permitted (PDF + PPTX at once) and stack in the toast area; each has its own window and temp dir.
- On completion the toast becomes a result card: **Reveal in folder** / **Open** / **View report**.

### 6.2 The report

```ts
type ExportReport = {
  jobId: string; format: string; outPath: string;
  durationMs: number; fileSizeBytes: number;
  slides: Array<{
    id: string; index: number; title: string;
    status: 'ok' | 'degraded' | 'failed';
    tier?: 'structured' | 'raster';        // pptx only
    confidence?: number;                   // pptx only
    notes: string[];                       // human-readable, e.g. "Animated — exported final frame"
  }>;
  warnings: string[];
};
```

Rendered as a table: slide thumbnail, title, status chip, and reasons. The design goal is that a user who is unhappy with an export can always answer "why did it come out like that?" in one click, and act on it (override the tier, simplify the slide, use HTML instead).

The report is also written to `<outPath>.sloodge-report.json` when a dev/debug setting is on — this is what the fidelity test suite consumes.

### 6.3 Error handling in the UI

| Failure | Behaviour |
|---|---|
| Slide render crash | Retry once, then mark slide `failed`, continue job, list in report |
| Readiness timeout | Export anyway, mark `degraded` with reason |
| Save path not writable | Caught at `showSaveDialog` time; re-prompt |
| Disk full during write | `.partial` removed, error toast with the OS message |
| Merge/assembly failure | Job fails, `.partial` removed, report retained for diagnosis |
| Cancel | Temp dir removed, no output file, neutral toast |

---

## 7. Test strategy for export fidelity

Detailed test infrastructure lives in [70-testing-ci.md](70-testing-ci.md); this section defines *what export-specific things are tested*. Note the CI constraint: **CI runs unit tests only** — everything requiring Electron or a browser is local/manual.

### 7.1 Fixture corpus

The 7 experiment cases from [`experiments/init/test-cases.json`](../../../experiments/init/test-cases.json) are promoted to the permanent export fixture corpus, because they already span the axes that matter: static text/layout (`slide-title`, `slide-content-layout`, `slide-comparison`), CSS/SMIL animation (`anim-solar`, `anim-pipeline`), and JS interactivity (`graph-bar-interactive`, `graph-line-toggle`). Four adversarial fixtures are added to probe the score boundaries specifically:

| Fixture | Probes |
|---|---|
| `fx-gradient-shadow` | Gradient + blur + shadow panel — must score < 70 → raster |
| `fx-overflow` | Content deliberately exceeding 720 px — must trigger the multi-page clip warning |
| `fx-webfont` | `@font-face` webfont — must produce the substitution warning |
| `fx-plain-text` | Pure text/box slide — must score ≥ 90 and produce zero images in the PPTX |

### 7.2 Unit tests (vitest — these run in CI)

Everything below is pure functions over the `SlideNode[]` measurement output, with **recorded fixtures** captured once from real slides and committed as JSON. No browser, no Electron, fast.

- `px2in` / `px2pt` conversions, including the exact-1280×720 → 13.333×7.5 identity.
- Colour parsing: `rgb`, `rgba`, `hsl`, named, `transparent` → `{ color, transparency }`.
- Node classification: leaf-text rule, container-paint rule, invisible-node rejection, double-render prevention on nested spans.
- Z-order linearization from `(zIndex, domIndex)`.
- **Confidence scorer**: table-driven — each signal in §3.4 gets a case asserting its exact deduction, plus caps, plus the four boundary fixtures landing on the intended side of 70, plus every hard blocker forcing raster.
- Tier selection given score + user mode (auto / force-editable / force-raster / per-slide override) — a small decision table with full coverage.
- Text-run building: bold/italic/underline, bullets from `<ul>`/`<ol>`, hyperlink runs, `text-transform` application.
- Font mapping against the system-safe list, and the warning it emits.
- `deck.json` manifest generation and slide filename slugging (collisions, unicode, very long titles).
- **HTML bundle builder (M4.4), exhaustively** — it is pure (`deck + range → {path: bytes}`), so all of it is CI-testable: emitted paths, manifest/slide-count/embedded-list agreement (including when a slide fails mid-range), range selection, per-slide error isolation, and HTML escaping of injected text in all three contexts, each probed with a real breakout payload asserted against a *parsed* document.
- **Presenter-shell sandboxing** — the exact `sandbox` token string, `allow-same-origin` absent from the whole emitted document, no `srcdoc`, no `postMessage`/`contentWindow` channel.
- **Emitted-logic parity** — the shell's generated key table, clamp, and reducer are `eval`'d and cross-checked against `keyToPresentIntent` / `clampSlideIndex` / `reducePresent` for every key and every intent from every position.
- **Zip round trip** — build → `zipSync` → `unzipSync` → assert the file map is byte-identical and `index.html` still parses with its manifest intact. Output is byte-deterministic (fixed `mtime`), so the archive itself can be asserted on.

All of the above are mutation-verified: adding `allow-same-origin`, dropping a single `.replace` from the escaper, counting the range instead of the survivors, ignoring the range, removing the clamp, and dropping the zip root prefix each turn a test red.
- Report assembly: statuses, notes, and warnings from a synthetic job trace.

### 7.3 Integration tests (Playwright — local, not CI)

Reuses the harness pattern from [`experiments/init/harness/render.mjs`](../../../experiments/init/harness/render.mjs) — same `chromium.launch()` + 1280×720 viewport + `file://` load + console capture. The export harness extends it with a measurement-pass injection and a `page.pdf()` call standing in for `printToPDF` (same underlying Chromium print path).

- **Measurement pass** runs on all 11 fixtures without throwing, and returns a node count within an expected band. This is the golden-file input for the §7.2 unit tests — regenerated by a script, reviewed as a diff.
- **PDF geometry**: every fixture prints to exactly 1 page at 960×540 pt (except `fx-overflow`, which must produce >1 pre-clip). Asserted by parsing the output with `pdf-lib`.
- **PDF content**: extracted text of `slide-content-layout` contains all 4 headings — catches `printBackground`/font/readiness regressions that a pixel diff would report as a vague blob.
- **Animation settle determinism**: run the settle script on `anim-solar` twice and screenshot; the two images must be byte-identical. This is the single most valuable export test, since nondeterministic animation state is the likeliest source of flaky, unreproducible export bugs.
- **Non-blank guard**: for every fixture, the settled screenshot must have >2 % non-background pixel variance. Directly catches the `opacity: 0` entrance-animation catastrophe.

### 7.4 Electron-level tests (local/manual smoke)

Run via a `pnpm export:smoke` script against a real Electron instance, and as part of the pre-release manual checklist:

- Export the 11-fixture deck to PDF, PPTX, and HTML end to end.
- **PDF**: page count, page size, and a perceptual diff of each rendered page against the fixture's reference screenshot (pdftoppm → pixelmatch, threshold 2 %).
- **PPTX**: unzip the output and assert on the XML — slide count, and for Tier A slides that `<a:t>` text nodes exist (i.e. text really is editable) with no `<p:pic>` covering the full slide; for Tier B slides the inverse. Asserting on OOXML rather than a rendered PPTX avoids requiring LibreOffice in the loop for the structural checks.
- **PPTX visual** (deeper, manual-triggered): render the PPTX to PNG via LibreOffice headless and perceptually diff against the reference. Kept out of the default script because it depends on a LibreOffice install and its own font substitution.
- **HTML**: byte-identity of every slide file vs. source; presenter shell opens from `file://` and navigates; `BroadcastChannel` speaker sync works.
- **Cancellation and crash**: cancel mid-job leaves no output file and no temp dir; a deliberately crashing slide (`fx-crash`, calls `process.crash()` equivalent) is retried, marked failed, and the job still completes.

### 7.5 Manual fidelity review

Automated pixel diffing catches regressions but not "does this look right in PowerPoint." Before each release, the 11-fixture deck is exported to PPTX and opened in **real PowerPoint (Windows + macOS)** and **Google Slides**, with a short checklist: text is editable and legible, no shape is wildly mispositioned, images are sharp, nothing renders as a black box. Findings feed back into the §3.4 score weights — that table is expected to be tuned, and the tuning history is the honest record of how well the structured path actually works.

---

## 8. Decisions summary

1. **PDF = per-slide `printToPDF` + `pdf-lib` merge**, not a stitched document — preserves slide isolation, per-slide progress, and per-slide failure containment.
2. **`printBackground: true` and `preferCSSPageSize` + `@page { size: 1280px 720px; margin: 0 }` are non-negotiable constants**, not user options.
3. **PPTX is two-tier with a per-slide automatic choice** driven by a transparent confidence score, always user-overridable, with sub-region rasterization as the common hybrid outcome.
4. **SVG is rasterized, never mapped to autoshapes** (except single flat primitives) — silently-wrong geometry is worse than an image.
5. **Animations export as the settled final frame**, looping ones pinned at 25 % phase; interactivity exports in its default state; both are disclosed in the dialog, the file's speaker notes, and the report.
6. **HTML export ships the *wrapped* slide document** — source plus the constant-length CSP prefix — not raw source, because the injected meta is the only policy that survives into a `file://` bundle (§5.1). Byte-identity is recoverable by subtracting that known prefix, so the fidelity-oracle and round-trip roles hold.
7. **The exported presenter shell frames every slide in `sandbox="allow-scripts"` with no `allow-same-origin`** and opens no channel to it. Outside the app only two of the four sandbox layers survive (§5.1a); this is one of them, and it is what stops an exported slide reaching the viewer's filesystem over `file://`.
8. **The shell's navigation semantics are generated from M4.1's pure machine**, not retyped: the key→intent table is produced by calling `keyToPresentIntent` over `PRESENT_KEYS` at build time, and a test evaluates the emitted clamp/reducer against the module it came from.
9. **HTML export needs no offscreen window at all** — no Chromium, no `slide://` registry, no readiness barrier. The slides already *are* the output, which is why it is both the highest-fidelity target and the fastest.
10. **All *rendering* export runs in a hidden main-process `BrowserWindow`** with `backgroundThrottling: false`, sequentially, behind an explicit readiness barrier; all three formats write atomically via `.partial` + rename.
11. **Export fidelity is tested at three levels**: pure-function unit tests in CI, a Playwright harness (extending the experiment harness) locally, and an Electron smoke + real-PowerPoint manual review before release. HTML adds a fourth that is cheap and total: build → zip → **unzip** → compare the file map, then open `index.html` in a real browser from `file://` and navigate it.
