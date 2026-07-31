# Research: HTML-Slides + Export + Electron Ecosystem for a PowerPoint-like Desktop App

> Scope: building a desktop app (Electron) where slides are HTML/CSS/SVG/JS (potentially AI-generated), with export to PPTX and PDF, presenter mode, and a sandboxed rendering surface. Compiled July 2026.

---

## 1. HTML Slide Frameworks

### 1.1 reveal.js (`hakimel/reveal.js`)

**Current version:** `reveal.js@6.0.1` on npm. Version 6.0 was a major shift: build system moved from Gulp to **Vite**, ES module build renamed `.esm.js` → `.mjs`. ([npm](https://www.npmjs.com/package/reveal.js), [releases](https://github.com/hakimel/reveal.js/releases), [upgrade guide](https://revealjs.com/upgrading/))

**Slide/section DOM model** — strict, shallow hierarchy: `.reveal > .slides > section`.

```html
<div class="reveal">
  <div class="slides">
    <section>Single horizontal slide</section>
    <section>
      <section>Vertical slide 1 (nested = down-navigation)</section>
      <section>Vertical slide 2</section>
    </section>
  </div>
</div>
```

- Nesting `<section>` creates a **vertical stack**; top-level siblings form the **horizontal** sequence — slides get a 2D address `{h, v}`.
- `data-state="make-it-pop"` pushes a CSS class onto the viewport root while a slide is active.
- `data-background-*` (image/video/color/iframe) and `data-transition`/`data-transition-speed` give **per-slide overrides** of global config.
- **Most reusable idea for a desktop editor:** each slide is an addressable, self-contained DOM subtree carrying presentation semantics via attributes, not a monolithic canvas blob.

**Fragments (progressive reveal)** — elements with class `fragment` step through before advancing to the next slide.

```html
<p class="fragment">Fade in (default)</p>
<p class="fragment fade-out">Fade out</p>
<p class="fragment highlight-red">Highlight red</p>
<p class="fragment fade-up" data-fragment-index="2">Appears as step 2</p>
<p class="fragment" data-fragment-index="1">Appears as step 1 (simultaneous with other idx=1)</p>
```

- Built-in effects: `fade-in` (default), `fade-out`, `fade-up/down/left/right`, `fade-in-then-out`, `grow`, `shrink`, `strike`, `highlight-red/green/blue`, `highlight-current-*`.
- `data-fragment-index` decouples reveal order from DOM order; equal indices reveal together.
- Toggling adds/removes `.visible`; custom effects are CSS rules on `.fragment.myeffect(.visible)`.
- Events `fragmentshown`/`fragmenthidden`; API `Reveal.navigateFragment()`, `nextFragment()`, `prevFragment()`, `availableFragments()`.
- **For an editor:** maps cleanly onto a per-element "build step" property (numeric index + effect enum) — far simpler than PowerPoint's animation timeline XML, still expressive enough for click-builds.

**Transitions:** global via `Reveal.initialize({ transition: 'slide' })` (`none`, `fade`, `slide`, `convex`, `concave`, `zoom`), overridable per-slide (`data-transition="zoom-in fade-out"` for asymmetric in/out).

**Presenter/speaker mode:**
- Press **S** to open a separate speaker-notes window; timer auto-starts.
- Notes authored via `<aside class="notes">`, `data-notes="..."`, or Markdown `Note:` delimiter.
- Enabled by the **Notes** plugin: `<script src="dist/plugin/notes.js">` + `Reveal.initialize({ plugins: [RevealNotes] })`.
- Speaker window syncs to main window (window.open + messaging), shows elapsed/wall time, pacing, current+next slide, notes text.
- `showNotes: "separate-page"` puts notes on their own page during PDF export.

**PDF export ("print-pdf")** — no headless renderer required; reuses the browser's native print pipeline:
1. Load deck with `?print-pdf` in URL — swaps in a print stylesheet laying every slide out as its own full page.
2. Browser print dialog → Save as PDF, **Landscape**, **margins None**, **Background graphics on**.
3. Chrome/Chromium is the only officially confirmed browser for pixel accuracy.
- Page size derives from configured presentation `width`/`height`. `pdfMaxPagesPerSlide` caps overflow pages (`1` hard-clips).
- Fragments print onto separate stacked pages by default (`pdfSeparateFragments: false` collapses to one page, all visible).
- For headless/CI export: **DecktapeJS** (Puppeteer-based) drives the same `?print-pdf` mode without a manual dialog.
- **For an editor:** "expose a print-optimized CSS mode, delegate rasterization to Chromium's print engine" is directly reusable — correct page sizing/fonts/vector fidelity for free.

**Programmatic API:**

```js
Reveal.initialize({
  hash: true, controls: true, progress: true, transition: 'slide',
  plugins: [RevealMarkdown, RevealHighlight, RevealNotes, RevealMath, RevealZoom, RevealSearch]
});

Reveal.slide(2, 0);              // absolute nav (h, v, f)
Reveal.next(); Reveal.prev();
Reveal.getIndices();             // { h, v, f }
Reveal.getCurrentSlide(); Reveal.getTotalSlides(); Reveal.getProgress();
Reveal.sync();                   // re-index after DOM mutation (slides added/removed at runtime)
Reveal.layout();                 // recompute scale on resize
Reveal.on('slidechanged', (e) => { /* e.indexh, e.indexv, e.currentSlide */ });
```

`Reveal.sync()` matters for a WYSIWYG editor: slides can be inserted/removed/reordered live and reveal.js re-derives navigation without a full re-init.

**Plugin ecosystem** (`dist/plugin/`, bundled): `RevealMarkdown` (author via Markdown), `RevealHighlight` (code syntax via highlight.js), `RevealNotes` (speaker notes/window), `RevealMath` (LaTeX/MathJax/KaTeX), `RevealZoom` (click zoom), `RevealSearch` (Ctrl+Shift+F). Registered via `plugins: [...]` array — a clean extension model to imitate.

**Pros for a WYSIWYG editor:** simple documented DOM contract; per-slide/per-element data-attributes trivial to generate/read back; fragment model is a good expressiveness/complexity tradeoff; print-based PDF export avoids a custom PDF renderer.
**Cons:** reveal.js is a *runtime* controller assuming live browser navigation state — better to borrow markup conventions than embed its controller directly, since WYSIWYG drag/resize/inline-edit conflicts with reveal.js's own transform-based slide positioning/scaling.

---

### 1.2 Slidev (`slidevjs/slidev`)

**Current versions:** `@slidev/cli` **52.18.0**, `@slidev/client` matching, on a fast-moving 52.x cadence. ([npm](https://www.npmjs.com/package/@slidev/cli), [sli.dev](https://sli.dev/guide/))

**Data model: Markdown + Vue SFCs.** A single `slides.md`, slides separated by `---`:

```md
---
theme: default
title: My Deck
---

# Welcome
This is slide 1

---
layout: center
class: text-white
background: /images/bg.jpg
transition: slide-left
---

# Slide 2 (center layout, custom background)

<v-click>
This appears on click
</v-click>
```

- First frontmatter block = deck-wide config; each subsequent `---` block = per-slide frontmatter (`layout`, `background`, `class`, `transition`, `clicks`).
- Each slide compiles to a **Vue 3 SFC** — Markdown → Vue render functions via a custom Vite plugin, so slides can embed live Vue components, `<script setup>`, JSX/TSX.
- Styling via UnoCSS utilities; code via Shiki/Monaco; diagrams via Mermaid; math via KaTeX.

**Animation/click system** — materially richer than reveal.js's fragment classes:

```html
<v-click>Hello World!</v-click>
<div v-click class="text-xl">Directive form</div>

<v-clicks depth="2">
- Item 1
  - Item 1.1
  - Item 1.2
</v-clicks>

<div v-click.hide>Vanishes after being clicked</div>
<div v-after>Appears together with previous v-click (shorthand for v-click="'+0'")</div>

<div v-motion
     :initial="{ x: -80, opacity: 0 }"
     :enter="{ x: 0, opacity: 1 }"
     :click-1="{ y: 30 }">
  Motion-based animation
</div>
```

- `v-click`/`v-clicks` (with `depth`) drive click-reveal; position relative (`at="'+2'"`) or absolute (`at="3"`); `.hide` removes instead of just revealing.
- `v-motion` (via `@vueuse/motion`) gives spring/tween animation keyed to click index ranges (`:click-1`, `:click-2-4`).
- Deck-wide default via frontmatter `clickAnimation` (`fade`, `up`, `down`, `left`, `right`, `scale`, `none`); per-slide `clicks: 10` declares total steps.
- Essentially a small reactive state machine (`$clicks`/`$slidev.nav.clicks`) driving Vue reactivity — powerful but tightly coupled to Vue.

**Presenter mode:** built-in `/presenter` route — current+next slide, synced click state, speaker notes (plain text or `<!-- notes -->` comment), timer, drawing/annotation overlay. Sync via local WebSocket (dev) or `BroadcastChannel`.

**Export mechanism** — Playwright-driven headless Chromium:

```bash
npm i -D playwright-chromium
slidev export                        # -> slides-export.pdf
slidev export --format pptx          # slides as full-slide images, notes attached
slidev export --format png           # one PNG per slide
slidev export --format md            # markdown referencing exported PNGs
slidev export --with-clicks          # one page/image per click step
slidev export --dark --range 1,6-8,10 --output deck.pdf --with-toc --omit-background
```

- Loads the live Vite dev build in headless Chromium, walks each slide/click-state, screenshots/prints — same "render in real engine, then rasterize" idea as reveal.js print-pdf, but automated via Playwright.
- PPTX export is **raster-only** (full-slide images, no editable text/shapes) — a delivery format, not round-trippable.
- Browser exporter UI also available at `http://localhost:<port>/export`.

**Architecture:** fully Vite-based — custom plugin parses `slides.md` into per-slide Vue routes with HMR; same build produces dev server and static production SPA, plus Playwright exporter for offline artifacts.

**Pros for an editor:** "slide = component + declarative click-state directives" is a strong reference for representing animations as ordered state transitions rather than a full timeline; Playwright-headless-export pattern directly reusable (embed headless Chromium in the desktop app, drive via Playwright/Puppeteer for deterministic rasterization).
**Cons:** deep coupling to Vue SFC compilation/Vite dev-time transforms — poor fit to embed directly (content isn't plain tool-agnostic HTML, it's Vue template syntax needing a compiler); click/animation model harder to represent generically in a structured non-code property panel than reveal.js's flat CSS-class fragments; PPTX export being raster-only doesn't solve editable PowerPoint interop.

---

### 1.3 impress.js (`impress/impress.js`)

**Current version:** npm `impress.js@1.1.0`, last published ~2020 — effectively unmaintained on npm (GitHub has later unpublished commits). Clear outlier in maintenance. ([npm](https://www.npmjs.com/package/impress.js/v/1.1.0), [GitHub](https://github.com/impress/impress.js/))

**Positioning model: CSS3 3D transforms on an infinite canvas.** Every "step" gets an explicit 3D coordinate; the camera animates between them via `transform-style: preserve-3d` and chained `translate3d`/`rotate`/`scale`.

```html
<div id="impress">
  <div id="title" class="step" data-x="0" data-y="0">
    <h1>impress.js</h1>
  </div>

  <div class="step" data-x="1000" data-y="1000" data-z="-1000"
       data-scale="2" data-rotate-z="90">
    <h1>Powerful, yet still simple</h1>
  </div>

  <div class="step" data-rotate-x="-40" data-rotate-y="10" data-rotate-order="xyz">
    3D-tilted step
  </div>
</div>
```

- `data-x/y/z` — pixel position of step center (default 0, negatives allowed).
- `data-rotate-x/y/z` (or `data-rotate` = z alias), `data-rotate-order` — rotation composition order matters (non-commutative).
- `data-scale` — relative zoom vs. baseline camera scale.
- `rel` plugin adds `data-rel-x/y/z` for relative positioning off the previous step, easing large-deck authoring.
- Navigation order = DOM order (or `data-step` override); "the deck" is a single flat `#impress` container whose shared 3D transform matrix the browser animates to re-center each step.

**How it differs from linear decks:** reveal.js/Slidev model a deck as a queue of discrete pages; impress.js models **camera movement through a spatial scene graph** — steps are positioned/rotated/scaled DOM nodes, "advancing" = CSS-transitioning the canvas's transform to the next step's frame. No inherent 2D grid or "fragment within a step" — steps and content-reveal are conflated; incremental reveal must be hand-built.

**Limitations for a structured editor:**
- **No built-in PDF export** — no `?print-pdf` analog; content scattered across unbounded 3D space with camera transforms doesn't map to sequential print pages natively. Workarounds exist but are hacky.
- **No built-in presenter/speaker-notes mode** — only a rudimentary example/plugin.
- **No native fragment/build-step system.**
- **Authoring complexity scales badly** — every step's absolute (or relative) 3D coordinate needs manual tuning for a coherent camera path; no vertical/horizontal grid abstraction; reordering/inserting/deleting a step isn't a trivial array splice (may require renudging neighbor coordinates).
- Small ecosystem (`navigation-ui`, `autoplay`, `rel`, `mouse` plugins), accessibility/perf concerns around offscreen 3D-transformed content.

**Why poorly suited as an editor base:** PowerPoint's mental model is a flat, ordered array of independently-addressable slides, each an independent canvas with build/animation steps — maps ~1:1 onto reveal.js's `.slides > section[+fragment]` and reasonably onto Slidev's `slides.md`+`v-click`. impress.js's shared unbounded 3D coordinate space has no natural slide boundary; adapting it means imposing an artificial slide grid on top, discarding what makes it distinctive, while still lacking export/presenter tooling the others provide.

**Worth borrowing anyway:** the 3D transform technique itself (composited `translate3d/rotateX/Y/Z/scale` on a `preserve-3d` container, GPU-accelerated) is legitimate for a single *transition effect* (zoom/pan) within an otherwise flat reveal.js-style deck — not for the whole document model.

### 1.4 Summary comparison

| | reveal.js 6.0.1 | Slidev (`@slidev/cli` 52.18.0) | impress.js 1.1.0 (stale) |
|---|---|---|---|
| Slide unit | `<section>` in flat/nested DOM | Vue SFC per `---` MD block | `.step` div at 3D coord |
| Build/animation | `.fragment` + `data-fragment-index` | `v-click` reactive click-state | none native |
| Presenter mode | Built-in (`RevealNotes`, separate window) | Built-in `/presenter` route | Minimal/example only |
| PDF export | Browser print via `?print-pdf` (or DecktapeJS) | Playwright headless (`slidev export`) | None built-in |
| Programmatic API | Rich (`Reveal.slide/next/prev`, events) | Vue reactivity + CLI | Minimal (`impress().init()`, `goto()`) |
| Best borrowed idea | Slide-as-`<section>` contract; fragment index; print-to-PDF pattern | Playwright headless rasterization pipeline; per-slide frontmatter | 3D transform as a transition effect only |
| Maintenance | Active (Vite rewrite in 6.0) | Very active (52.x cadence) | Effectively unmaintained |

**Recommendation for a custom editor:** adopt reveal.js's DOM contract (slide = self-contained `<section>`-like element, fragment = `data-fragment-index` + effect class) as the internal slide data model — it's framework-agnostic HTML, easy to generate/parse, and doesn't require a Vue/JSX compiler in the loop. Borrow Slidev's/reveal.js's "render in a real browser engine (or headless Chromium via Playwright/Puppeteer), then rasterize" pattern for PDF/image export instead of building a custom layout+PDF engine.

**Sources:** [reveal.js GitHub](https://github.com/hakimel/reveal.js/), [revealjs.com](https://revealjs.com/) ([Markup](https://revealjs.com/markup/), [Fragments](https://revealjs.com/fragments/), [PDF Export](https://revealjs.com/pdf-export/), [Speaker View](https://revealjs.com/speaker-view/), [API](https://revealjs.com/api/), [Plugins](https://revealjs.com/plugins/)); [Slidev GitHub](https://github.com/slidevjs/slidev), [sli.dev](https://sli.dev/) ([Getting Started](https://sli.dev/guide/), [Syntax](https://sli.dev/guide/syntax), [Animations](https://sli.dev/guide/animations), [Exporting](https://sli.dev/guide/exporting)); [impress.js GitHub](https://github.com/impress/impress.js/) ([DOCUMENTATION.md](https://github.com/impress/impress.js/blob/master/DOCUMENTATION.md), [impress.js.org](https://impress.js.org/)).

---

## 2. PPTX and PDF Export from JS/Electron

### 2.1 pptxgenjs — native PPTX generation API

**Current version:** `pptxgenjs@4.0.1` on npm ([gitbrent/PptxGenJS](https://github.com/gitbrent/PptxGenJS)). Runs in Node, Electron, and browsers; outputs standards-compliant OOXML `.pptx` readable by PowerPoint/Keynote/LibreOffice/Google Slides.

```js
import pptxgen from "pptxgenjs";

const pptx = new pptxgen();
pptx.defineLayout({ name: "WIDE", width: 13.33, height: 7.5 }); // 16:9
pptx.layout = "WIDE";

// Slide master (background/branding template)
pptx.defineSlideMaster({
  title: "MASTER_SLIDE",
  background: { color: "F1F1F1" },
  objects: [
    { rect: { x: 0, y: 6.9, w: "100%", h: 0.6, fill: { color: "1A1A2E" } } },
    { text: { text: "My Deck", options: { x: 0.3, y: 6.95, fontSize: 10, color: "FFFFFF" } } },
  ],
  slideNumber: { x: 12.5, y: 7.0, color: "FFFFFF" },
});

const slide = pptx.addSlide({ masterName: "MASTER_SLIDE" });

// addText with formatting
slide.addText("Quarterly Results", {
  x: 0.5, y: 0.4, w: 9, h: 1,
  bold: true, fontSize: 32, color: "1A1A2E", align: "left", fontFace: "Calibri",
});
slide.addText(
  [
    { text: "Revenue up 12%", options: { bullet: true, color: "2E7D32", bold: true } },
    { text: "Churn down 3%", options: { bullet: { code: "25CF" } } },
  ],
  { x: 0.5, y: 1.6, w: 5, h: 2, fontSize: 18 }
);

// addImage
slide.addImage({ path: "chart.png", x: 6, y: 1.6, w: 6, h: 3.5 });
// also { data: "base64..." } for in-memory images

// addShape (built-in autoshapes)
slide.addShape(pptx.ShapeType.roundRect, {
  x: 0.5, y: 5.2, w: 3, h: 1, fill: { color: "4472C4" },
  line: { color: "2E4E8C", width: 1 }, rectRadius: 0.1,
});

// addChart — supports bar, bar3D, line, area, pie, doughnut, radar, scatter, bubble, bubble3D
slide.addChart(pptx.ChartType.bar, [
  { name: "Sales", labels: ["Q1", "Q2", "Q3"], values: [21, 26, 19] },
], { x: 6, y: 5.2, w: 6, h: 2, barDir: "col", showLegend: true });

// addTable
slide.addTable(
  [[{ text: "Metric", options: { bold: true } }, { text: "Value", options: { bold: true } }],
   ["ARR", "$4.2M"]],
  { x: 0.5, y: 6.0, w: 9, colW: [4.5, 4.5], border: { type: "solid", color: "CFCFCF" } }
);

slide.addNotes("Remember to mention the churn improvement driver.");

await pptx.writeFile({ fileName: "deck.pptx" }); // Node/Electron
// pptx.write("blob") / pptx.write("base64") for browser contexts
```

References: [Quick Start](https://gitbrent.github.io/PptxGenJS/docs/quick-start/), [Adding a Slide](https://gitbrent.github.io/PptxGenJS/docs/usage-add-slide/), [GitHub](https://github.com/gitbrent/PptxGenJS).

#### What pptxgenjs cannot do easily — the HTML→PPTX gap

pptxgenjs is a **PowerPoint object model** (shapes/text/tables/charts positioned in absolute inches/EMUs) — not an HTML renderer. Converting arbitrary HTML/CSS to editable PPTX requires manually walking the DOM and mapping nodes to primitives. Specifically it cannot easily reproduce:

- **CSS Grid/Flexbox** — no layout engine; every shape needs absolute `x/y/w/h` in inches, so flex/grid must be resolved in the browser first (`getBoundingClientRect()`), then converted px→inches (`px / 96`).
- **Web/custom fonts** — PPTX embeds font *references* by name, not files; custom `@font-face` fonts render as the nearest installed font on the viewer's machine unless the binary is separately embedded (PowerPoint supports font embedding, pptxgenjs doesn't automate it).
- **Gradients/box-shadows/blurs/backdrop-filters** — OOXML has gradient-fill and shadow-effect nodes, but pptxgenjs's typed options cover only a subset; complex CSS effects generally need rasterizing to an image.
- **Arbitrary SVG paths** — `addShape` only exposes PowerPoint's built-in autoshape gallery, not arbitrary vector path data. Custom SVG icons/illustrations must be rasterized to PNG via `addImage`, losing vector editability.
- **Precise text reflow** — PowerPoint's autofit behaves differently from CSS; pixel-perfect wrapping isn't guaranteed.

**Is there an auto DOM→PPTX converter?** pptxgenjs's own `tableToSlides()` "HTML-to-PowerPoint" feature converts **only `<table>` elements** ([docs](https://gitbrent.github.io/PptxGenJS/html2pptx/)). Third-party projects doing the full "walk DOM → measure `getBoundingClientRect` → emit pptxgenjs calls" pattern:

- [joker-duzhong/html-to-pptx](https://github.com/joker-duzhong/html-to-pptx) — uses `getBoundingClientRect()` for coordinates, editable text/native tables, skips `display:none`/`opacity:0`.
- [atharva9167j/dom-to-pptx](https://github.com/atharva9167j/dom-to-pptx) — client-side, "pixel-accurate" conversion, falls back to rasterization for unsupported CSS (gradients/shadows/rounded images).
- [abdelkrimkr/html2pptx](https://github.com/abdelkrimkr/html2pptx) — CLI + Node library for whole-HTML-file conversion.
- [it-beyondit/html2pptxgenjs](https://github.com/it-beyondit/html2pptxgenjs) — narrower: HTML markup → pptxgenjs rich-text runs (bold/italic/links) only, not full layout.

All confirm the same manual pattern: measure each element's box in pixels, classify it (text/image/shape/table), emit the matching `add*()` call, and gracefully degrade to rasterization for CSS-complex content.

### 2.2 Fallback: full-slide raster image fidelity

Skip DOM decomposition entirely: render each slide to PNG/JPEG (Electron `webContents.capturePage()`, `html2canvas` for pure-browser, or headless-Chromium via Puppeteer/Playwright), then insert one full-bleed image per slide with pptxgenjs.

```js
// In an Electron BrowserWindow already showing the slide at exact size:
const image = await win.webContents.capturePage(); // NativeImage
const pngBuffer = image.toPNG();
const base64 = `data:image/png;base64,${pngBuffer.toString("base64")}`;

const slide = pptx.addSlide();
slide.addImage({ data: base64, x: 0, y: 0, w: 13.33, h: 7.5 }); // fills 16:9 slide
```

**Pros:** pixel-perfect fidelity — every gradient/shadow/custom font/SVG path renders exactly as drawn; zero DOM-mapping logic.
**Cons:** no editable text/shapes in PowerPoint (just a picture — loses accessibility/screen-reader support and PowerPoint's "edit text" workflow); much larger file size; no post-export wording tweaks without regenerating.

**Hybrid strategy:** render text/simple shapes natively via pptxgenjs (editable), rasterize only complex sub-regions (charts, illustrations, gradient panels) as images layered on top.

### 2.3 PDF export via Electron `webContents.printToPDF`

As of Electron 43 (`electron@43.2.0`), `contents.printToPDF(options)` returns `Promise<Buffer>` ([docs](https://www.electronjs.org/docs/latest/api/web-contents)).

```js
const fs = require("node:fs/promises");

async function exportSlidesToPDF(win, outPath) {
  await win.webContents.executeJavaScript(`document.fonts.ready`); // wait for fonts

  const pdfBuffer = await win.webContents.printToPDF({
    printBackground: true,        // required for CSS backgrounds/gradients/colors
    preferCSSPageSize: true,      // honor @page { size: ... }
    landscape: true,
    pageSize: { width: 13.33, height: 7.5 }, // inches, ignored if preferCSSPageSize + @page set
    margins: { top: 0, bottom: 0, left: 0, right: 0 },
    scale: 1,
  });
  await fs.writeFile(outPath, pdfBuffer);
}
```

Options (Electron 30+ through 43): `landscape`, `displayHeaderFooter`, `printBackground`, `scale` (default 1), `pageSize` (`A0`–`A6`, `Letter`, `Legal`, `Tabloid`, `Ledger`, or `{width,height}` inches), `margins` `{top,bottom,left,right}` inches, `pageRanges`, `headerTemplate`/`footerTemplate`, `preferCSSPageSize`, experimental `generateTaggedPDF`/`generateDocumentOutline` for accessible PDFs.

**Combining multiple slides into one PDF:**

1. **Single-document approach** — one HTML doc, CSS page breaks, one `printToPDF` call:
   ```css
   .slide { width: 1280px; height: 720px; break-after: page; }
   @media print { .slide:last-child { break-after: auto; } }
   @page { size: 1280px 720px; margin: 0; }
   ```
2. **Per-slide + merge approach** — render each slide separately, `printToPDF` per slide → N single-page Buffers, merge with [pdf-lib](https://pdf-lib.js.org/):
   ```js
   const { PDFDocument } = require("pdf-lib");
   const merged = await PDFDocument.create();
   for (const buf of pdfBuffers) {
     const doc = await PDFDocument.load(buf);
     const [page] = await merged.copyPages(doc, [0]);
     merged.addPage(page);
   }
   await fs.writeFile(outPath, await merged.save());
   ```

**Gotchas:**
- `printBackground: true` is mandatory — without it CSS backgrounds/gradients silently vanish (default `false`).
- `preferCSSPageSize` + `@page` is the reliable way to force exact custom slide dimensions rather than fighting `pageSize`/`scale`.
- **Font/content loading race** — `printToPDF` can fire before web fonts or async content finish; await `document.fonts.ready`, image `decode()` promises, or a custom "render complete" signal before printing.
- **Page breaks** — `break-after: page` (or legacy `page-break-after: always`) on each slide wrapper; test under `@media print` since `vh`/`vw` units and `position: fixed` can behave differently during Chromium's print pass.
- **DPI/scale mismatch** — `capturePage()`/screenshot approaches use device pixel ratio, `printToPDF` uses CSS pixels at 96dpi baseline; mixing both pipelines requires consistent px→inches conversion (÷96) to avoid size mismatches between PDF and PPTX exports.

**Sources:** [pptxgenjs npm](https://www.npmjs.com/package/pptxgenjs), [PptxGenJS GitHub](https://github.com/gitbrent/PptxGenJS), [Quick Start](https://gitbrent.github.io/PptxGenJS/docs/quick-start/), [Adding a Slide](https://gitbrent.github.io/PptxGenJS/docs/usage-add-slide/), [HTML-to-PowerPoint](https://gitbrent.github.io/PptxGenJS/html2pptx/), [html-to-pptx](https://github.com/joker-duzhong/html-to-pptx), [dom-to-pptx](https://github.com/atharva9167j/dom-to-pptx), [html2pptx](https://github.com/abdelkrimkr/html2pptx), [html2pptxgenjs](https://github.com/it-beyondit/html2pptxgenjs), [Electron webContents docs](https://www.electronjs.org/docs/latest/api/web-contents), [pdf-lib](https://pdf-lib.js.org/).

---

## 3. Electron + Vite Tooling

### 3.1 electron-vite

**Current version:** `electron-vite@5.0.0`, scaffolded via `npm create electron-vite@latest my-app`.

**Scaffolded structure:** `electron/main/` (main-process entry), `electron/preload/` (preload scripts), `src/` (renderer — Vue/React/Svelte/vanilla), root `index.html` as renderer entry, single root `electron.vite.config.ts`.

```ts
// electron.vite.config.ts
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: { plugins: [externalizeDepsPlugin()] },
  preload: { plugins: [externalizeDepsPlugin()] },
  renderer: {
    root: 'src',
    plugins: [react()]
  }
})
```

Runs three independent Vite builds (main/preload as library-mode Node/CJS-ESM targets; renderer as standard Vite web build) from one config point.

**Dev vs build:** `dev` starts a Vite dev server for the renderer with **instant HMR**; main/preload changes trigger a **process restart** (Electron killed and relaunched — not in-place patching, since Node-context code can't be hot-swapped like DOM modules). `build` outputs to `out/main`, `out/preload`, `out/renderer`; `preview` runs the packaged build for sanity-checking before invoking a packager.

Sources: [electron-vite.org guide](https://electron-vite.org/guide/), [dev docs](https://electron-vite.org/guide/dev), [create-electron-vite](https://github.com/electron-vite/create-electron-vite).

### 3.2 Electron Forge's Vite plugin (`@electron-forge/plugin-vite`)

Structurally different: config lives in `forge.config.ts`, referencing **separate config files per target**:

```ts
// forge.config.ts
export default {
  plugins: [
    {
      name: '@electron-forge/plugin-vite',
      config: {
        build: [
          { entry: 'src/main.js', config: 'vite.main.config.mjs' },
          { entry: 'src/preload.js', config: 'vite.preload.config.mjs' }
        ],
        renderer: [
          { name: 'main_window', config: 'vite.renderer.config.mjs' }
        ]
      }
    }
  ]
}
```

`vite.main.config.mjs` / `vite.preload.config.mjs` / `vite.renderer.config.mjs` are ordinary Vite configs (vs. electron-vite's single merged object). Forge builds renderer targets first, then main+preload in parallel batches. Renderer HMR works via injected globals (`MAIN_WINDOW_VITE_DEV_SERVER_URL`) that main-process code checks to decide `loadURL()` (dev) vs `loadFile()` (prod). As of Forge v7.5.0, Vite support is still flagged **experimental**.

Source: [Electron Forge Vite plugin docs](https://www.electronforge.io/config/plugins/vite).

### 3.3 electron-vite vs. Forge+Vite — 2026 recommendation

- **Maintenance:** both active; Forge is Electron-org-official with broader scope (packaging + publishing + templates); electron-vite is a focused, community (alex8088) Vite integration.
- **Packaging opinion:** electron-vite is deliberately unopinionated about packaging — handles build/dev only, paired with **electron-builder** by the community for installers/updates. Forge bundles its own **makers** (squirrel, zip, deb, rpm, dmg) and **publishers** (GitHub, S3) directly.
- **Trend:** electron-vite is widely recommended as the 2026 default for new apps wanting a clean Vite-native main/preload/renderer split; Forge favored for the "official," all-in-one build+package+publish story (Vite integration still experimental there).
- **Recommendation for this project:** **electron-vite + electron-builder** — cleanest dev loop, most mature/flexible installer and auto-update story (NSIS diffs, notarization, multiple publish targets).

Source: [electron-vite FAQ: Electron Forge](https://electron-vite.github.io/faq/electron-forge.html).

### 3.4 electron-builder — packaging, signing, auto-update

**Windows NSIS:**
```json
"win": { "target": "nsis" },
"nsis": {
  "oneClick": false,
  "perMachine": true,
  "allowToChangeInstallationDirectory": true
}
```
`oneClick: false` shows the full wizard; `perMachine` controls system-wide vs. per-user install (affects UAC prompt and install path).

**macOS dmg:** `"mac": { "target": ["dmg", "zip"] }` — `zip` is required alongside `dmg` because Squirrel.Mac (used by `electron-updater`) reads `latest-mac.yml`, generatable only from a zip artifact.

**Code signing:**
- *Windows:* electron-builder supports four signing backends via `win.sign.type` — local pfx/cert-store (signtool, default), HSM, PKCS#11, or **Azure Trusted Signing** (cloud, Entra-ID auth, no local key). Standard OV certs build SmartScreen reputation slowly; EV certs (hardware-token-bound) get immediate reputation but can't export to a CI-friendly `.pfx`. Azure Trusted Signing is increasingly recommended, replacing the discontinued/expensive standard-cert path with a cloud-managed reputation-friendly option.
- *macOS:* requires a Developer ID Application certificate, `hardenedRuntime: true`, an `entitlements.mac.plist` (and inherit variant for child processes — typically `com.apple.security.cs.allow-jit` / `allow-unsigned-executable-memory`), plus notarization wired through electron-builder's `afterSign` hook calling `@electron/notarize`.

**Auto-update via `electron-updater`:** works out of the box with NSIS on Windows (not Squirrel.Windows), supports differential/delta downloads (range-request based, can be disabled). macOS relies on Squirrel.Mac (needs the zip artifact). `publish` config points at GitHub Releases, S3, Cloudflare R2, or a generic HTTP feed; electron-builder auto-generates `latest.yml`/`latest-mac.yml` metadata alongside installers on each build.

Sources: [electron-builder code signing](https://www.electron.build/docs/features/code-signing/), [Windows code signing](https://www.electron.build/docs/features/code-signing/code-signing-win/), [macOS notarization](https://www.electron.build/docs/features/code-signing/notarization/), [Auto Update](https://www.electron.build/docs/features/auto-update/).

---

## 4. Sandboxed Rendering of AI-Generated Slide HTML

### 4.1 Options

Electron's docs frame this as three options, explicitly steering away from `<webview>`:

- **`<iframe sandbox="allow-scripts">`** in a normal renderer page — cheapest, same-process. Works well when the host renderer already has `contextIsolation: true` / `nodeIntegration: false`, since a sandboxed iframe has no path to Node/Electron APIs regardless. Good default for AI-generated slide HTML/CSS/SVG/JS running scripted animations/interactions.
- **`<webview>`** — implemented as an out-of-process iframe with async IPC bridging; historically Electron's recommended tool for untrusted content, but current docs say the tag "undergoes dramatic architectural changes" and recommend `iframe` or `WebContentsView` instead.
- **`WebContentsView`** (replaces deprecated `BrowserView`) — main-process-managed view, not part of the renderer DOM, positioned/sized from main, backed by its own separate renderer process. Full process isolation and most control, at the cost of more plumbing (bounds/z-order/IPC managed from main instead of embedding an element).

Sources: [Electron Web Embeds docs](https://www.electronjs.org/docs/latest/tutorial/web-embeds.html), [webview tag docs](https://www.electronjs.org/docs/latest/api/webview-tag).

### 4.2 CSP considerations

- **Host renderer:** strict CSP (meta tag or session-level `webRequest.onHeadersReceived`) — `default-src 'self'; script-src 'self'` — with `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true` in `webPreferences`. Electron security advisories note CSP `script-src` restrictions (no `unsafe-eval`) are **not reliably enforced** in renderers without sandbox/contextIsolation — those two flags are prerequisites, not optional hardening.
- **Slide content (iframe/WebContentsView):** its own CSP restricting `script-src` (to `'unsafe-inline'` only if AI-generated `<script>` blocks are inlined, no external script loading), disallow `object-src`, block `navigation`/`form-action` to prevent redirecting the surrounding app. Combine with `sandbox="allow-scripts"` only (omit `allow-same-origin`, `allow-top-navigation`, `allow-popups`) so even a misconfigured CSP has no origin-level escalation path.

Sources: [Electron Security docs](https://www.electronjs.org/docs/latest/tutorial/security), [CSP eval advisory GHSA-gxh7-wv9q-fwfr](https://github.com/electron/electron/security/advisories/GHSA-gxh7-wv9q-fwfr).

### 4.3 Recommendation matrix

| Approach | Isolation | Cost | Best for |
|---|---|---|---|
| `iframe sandbox="allow-scripts"` | Same process, sandboxed document | Very low | Fast slide preview/thumbnails, editor canvas, most AI slide content once host CSP/sandbox is set up correctly |
| `WebContentsView` | Separate OS process | Higher (main-process bookkeeping, IPC) | Presenting/exporting a slide running heavier arbitrary JS (WebGL, heavy canvas, network fetches); crash isolation from the app UI process |
| `<webview>` | Out-of-process but deprecated path | Medium | Avoid for new code per current Electron guidance |

**Recommendation for this app:** sandboxed `iframe`s for the editing grid/thumbnails (many slides on screen at once, need speed); promote the active/presenting slide to a `WebContentsView` if slide JS is allowed to do anything more elaborate, where process-level fault isolation matters more.

---

## 5. LLM Slide-Generation Prior Art

**Gamma (gamma.app)** — proprietary, web-based. Publicly documented as a pipeline of "20+ AI models" running in parallel — separate passes for text generation, image selection, layout decisions, and visual-consistency ("theme") enforcement — producing a full deck in ~30–60s from a topic/outline/doc/URL. Editor is block-based (closer to Notion than fixed PowerPoint slides): each text run/image/card is an independently editable, resizable block; cards can expand vertically rather than being fixed-aspect slides. Gamma 3 (Sept 2025) added "Gamma Agent," a chat-driven restyle/rewrite assistant operating across the whole deck. Exposes a public **API** for programmatic generation; underlying model/rendering stack is not open.

Source: [Gamma explore guides](https://gamma.app/explore/content/guides/what-is-gamma-and-how-does-it-use-ai-to-build-presentations).

**Open-source LLM→HTML slide generators found:**

- **`nooqta/ai-presentation`** — Node.js CLI/app; calls OpenAI's API with a subject prompt, LLM generates slide content, assembled into a single HTML file rendered with **reveal.js**. Architecture: prompt → LLM markdown/text → templated into reveal.js `<section>` slides → static HTML output.
- **`YuxiangChai/OpenSlides`** — more complete "local-first AI workspace": generates reveal.js decks from prompts, uploaded docs, or web search results; visual block editor and raw-HTML editing mode; versioning; exports as standalone HTML. Closest architecture to what this project needs: LLM generates structured slide data/HTML per slide, a template wraps it in reveal.js sections, app layers editing/versioning UI on top.
- **`danielrosehill/AI-Presentation-Builders-Index`** — curated aggregator/index of open-source and agent-driven presentation-builder tools; useful discovery hub for further prior art.
- **reveal.js itself** is the dominant target framework for these — most open-source AI slide generators output Markdown/HTML that reveal.js renders into `<section>`-based slides with its own theming/animation, rather than building a bespoke renderer.

**Common architecture pattern:** prompt/outline → LLM produces per-slide HTML (or Markdown converted to HTML) → slotted into a template (reveal.js `<section>` per slide, or custom CSS grid/flex layout) → rendered in-browser (reveal.js) or exported as standalone HTML. This validates a design where each AI-generated slide is a self-contained HTML/CSS/SVG/JS fragment rendered per-slide inside a sandboxed iframe/WebContentsView — analogous to how reveal.js treats each `<section>`, but with process-level isolation added since AI-generated content should be treated as semi-untrusted (unlike reveal.js decks written by trusted authors).

Sources: [nooqta/ai-presentation](https://github.com/nooqta/ai-presentation), [YuxiangChai/OpenSlides](https://github.com/YuxiangChai/OpenSlides), [AI-Presentation-Builders-Index](https://github.com/danielrosehill/AI-Presentation-Builders-Index), [reveal.js](https://revealjs.com/).

---

## 6. Synthesis / Recommendations for This App

1. **Slide data model:** adopt a reveal.js-style contract — each slide is a self-contained HTML fragment (think `<section>`), with a flat/ordered array as the deck, and per-element `data-build-index` + effect enum for progressive reveal (borrowing the fragment idea, not the reveal.js runtime itself). This keeps slide content plain, tool-agnostic HTML/CSS/SVG/JS — ideal both for an editor's structured property panel and for LLM generation (no framework-specific compiler needed, unlike Slidev's Vue SFCs).
2. **Rendering/isolation:** render each slide inside a sandboxed `<iframe sandbox="allow-scripts">` for the editing grid and thumbnails; consider a `WebContentsView` for the active presenting slide or export rendering pass if slide JS needs heavier capabilities or stronger fault isolation. Enforce strict CSP on both host and slide content; never grant `allow-same-origin` to slide iframes.
3. **Export pipeline:**
   - **PDF:** use Electron's `webContents.printToPDF` with `printBackground: true` and `preferCSSPageSize` + `@page` sized to slide dimensions; either lay out all slides in one document with `break-after: page`, or render per-slide and merge with `pdf-lib`. Await `document.fonts.ready` (and any custom "ready" signal) before printing.
   - **PPTX:** default to the **raster fallback** (one full-slide image per slide via `webContents.capturePage()` + pptxgenjs `addImage`) for guaranteed visual fidelity of arbitrary AI-generated CSS/SVG; optionally offer a "best-effort editable" mode that walks simple DOM structures (plain text blocks, images, basic shapes) into native pptxgenjs text/shape/image calls, falling back to rasterizing anything CSS-complex (gradients, custom fonts, arbitrary SVG paths, grid/flex layouts).
4. **Tooling:** electron-vite for main/preload/renderer with HMR, electron-builder for NSIS (Windows) and dmg (macOS) packaging, Azure Trusted Signing or a Developer ID cert + notarization for signing, `electron-updater` for auto-update via GitHub Releases or a generic feed.
5. **LLM generation:** follow the `OpenSlides`/`ai-presentation` pattern — LLM emits per-slide HTML/CSS/SVG fragments slotted into a template, rendered per-slide in the sandboxed surface, with the app layering structured editing (drag/resize, property panel) and versioning on top.
