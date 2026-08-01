---
name: interactive-graph
description: Creates presentation slides containing interactive charts (bar, line, legend toggles, hover tooltips, click highlights) as self-contained 1280x720 HTML files with vanilla JS + inline SVG. Use when asked for an interactive graph, chart with tooltips, clickable chart, or data visualization on a slide.
---

# interactive-graph

Produce ONE self-contained 1280x720 HTML slide (same layout/typography/contrast contract as a standard slide: fixed `.slide` root, `overflow:hidden`, zero page scroll, title 40–48px, axis/legend text >= 16px). Chart is hand-built inline SVG + vanilla JS. No libraries.

## HARD RULES — violating any of these fails the slide outright
1. **The tooltip may not cover ANYTHING that matters.** When visible it must not overlap: the hovered element, ANY value/tick/axis label, any other data element, or the legend. The one robust construction: while the tooltip is shown, HIDE the hovered element's static value label (the tooltip replaces it), place the tooltip centered ABOVE the hovered element with a 12px gap, and clamp it horizontally so it stays INSIDE THE PLOT AREA (right of the y-axis tick labels, left of the plot's right edge) — clamping to the SVG edge still lets it cover y-axis ticks and fails. Verify the WORST cases: the leftmost element (tooltip must clear the y-axis labels), the rightmost, and the tallest/topmost (reserve headroom: top of plot ≥ tooltip height + 16px above the tallest element). Every line of tooltip text ≥18px — captions and epoch/series sublabels included.
   For LINE/SCATTER charts (many nearby points), a floating in-plot tooltip WILL occlude neighboring markers/segments/gridlines somewhere — instead reserve a readout strip ABOVE the plot (a fixed row between the title and the chart, outside the plot area) that fills in with "Series · Epoch N · value" on hover, combined with strong hovered-marker emphasis (ring + enlarge). The strip has a quiet placeholder at rest (e.g. "Hover a point for details") so hover visibly changes it. This is the only pattern that overlaps nothing by construction. Bar charts (sparse, headroom reserved) may keep the above-the-bar tooltip.
1b. **Hover and click state are isolated.** Hovering must never modify click-selection styling and vice versa: drive selection with a CSS class on the chart root (e.g. `.has-selection`) + a `.selected` class on the element, drive hover with a separate class, and define the CSS so the combinations compose. After hover-out, the click state must look exactly as it did before hover. De-emphasized/dimmed text must STILL meet 4.5:1 contrast — dim with reduced weight/size or a still-passing color, never below AA.
2. **Axis titles never overlap ticks.** Put the y-axis title HORIZONTALLY above the y-axis (top-left of the plot), not rotated alongside the ticks.
3. **All chart text ≥16px, tooltip text ≥18px.**
4. **No dead zones**: the chart fills the content area — no band of unused space taller than 60px anywhere.
5. **Validate by rendering.** After writing the slide with `mcp__slides__create_slide` / `mcp__slides__update_slide`, call `mcp__slides__screenshot_slide` for that slide id and Read the PNG at full attention: correct proportions, all labels fully rendered (descenders intact), no dead zones, nothing clipped, the summary line in its at-rest state. The screenshot shows the slide AT REST, so the hover and click states are on you: walk the tooltip geometry numerically for the leftmost, rightmost and tallest element (hard rule 1) and trace every selector and class toggle in your script by hand before reporting done. Fix with `mcp__slides__update_slide` and re-screenshot until clean.

## Interactivity contract (machine-checked)
- Tag EXACTLY the elements a tester should touch — exactly ONE of each, no more:
  - `data-hover-target` on the primary hoverable data element (e.g. the FIRST bar, the FIRST data-point marker).
  - `data-click-target` on the primary clickable element (e.g. the FIRST bar, or the legend item to toggle).
- Hover MUST show a tooltip near the element containing the EXACT value from the prompt data (e.g. "4.2M" — match the prompt's formatting). Implement with mouseenter/mouseleave (also fire on `mouseover` — synthetic hovers vary) toggling a positioned `<div class="tooltip">` or SVG `<g>`; tooltip must be fully inside the viewport, readable (>= 18px), high-contrast, and hidden at rest.
- Tooltip PLACEMENT rules (checked from screenshots): position it above-right of the hovered element with a ~12px gap, clamped inside the slide. It must NOT cover (a) the hovered element itself or its value label, (b) any axis tick label, (c) the legend. If the element is near the top, place the tooltip beside it instead. Compute the tooltip's box against those coordinates before settling.
- Click MUST produce a clearly visible state change per the prompt (highlight = strong fill/stroke change plus de-emphasis of others; toggle = series visibly disappears AND its legend item gets struck-through/dimmed; summary line = actual text update mentioning the clicked datum).
- ZERO console errors. Attach listeners after DOM exists (script at end of body). Test your own selectors mentally: every `querySelector` must match.

## Chart correctness — the #1 failure mode
- Bar heights / point positions must be PROPORTIONAL to the data. Compute pixel values from the data numerically in JS (or precompute exactly by hand and show the numbers as axis labels that agree). E.g. Q4 6.3M must be visibly the tallest; 4.8M taller than 4.2M.
- Axes: labeled per prompt (axis titles if asked), tick labels legible and non-overlapping. Bar charts: y-axis starts at 0. Line charts: FIT the y-range to the data with ~10% padding (a fixed 0–1 axis that leaves half the plot empty and squashes the series fails review). Gridlines subtle (`rgba(...,0.1)`).
- SVG text never clips: leave >= 8px between any text BASELINE and the SVG/viewBox bottom edge so descenders (Q, y, g, p) survive — "Q1" clipped to "O1" is a review blocker. Same for right-edge labels: leave room for the full glyph box.
- All chart text >= 16px, prefer 18px (axis ticks, tick labels, legend, category labels alike).
- Multi-series: distinct accessible colors (not red/green only), legend mapping color→name, series lines 3px with 5–6px point markers. Legend sits fully OUTSIDE the plot area (e.g. above the chart, right-aligned) — it must never overlap gridlines, series lines, or data points.
- Every category label under its bar / tick; nothing rotated unless space demands it, and then 45° with room.

## Layout
- Chart occupies the main content area (~800–1000px wide, ~420–480px tall); title top; summary line (if requested) reserved BELOW the chart with a non-empty initial state (e.g. "Click a bar to see details") so the click visibly changes it.
- Interactive affordance: `cursor:pointer` on interactive elements; subtle hover emphasis (brighten/outline) besides the tooltip.

## Sloodge slide contract (machine-checked before the slide is accepted)
The `mcp__slides__*` tools reject HTML that breaks these — a rejection comes back as `SL-xxx: …`, fix and resend.

- **Declare `capabilities` as a TOOL ARGUMENT.** `capabilities` is an argument to `mcp__slides__create_slide`, alongside `html` and `title` — it is **not** part of the HTML, and nothing reads it from a comment or a meta tag. A charted slide with a `<script>` is NEVER `["static"]`: it is `capabilities: ["interactive-js"]`; add `"css-animation"` / `"smil-animation"` only if it also animates. An undeclared `<script>` or animation is rejected (SL-H01).
- **Capabilities are fixed at creation — you cannot fix them later.** `mcp__slides__update_slide` validates your new HTML against the capabilities the slide *already* has and has no argument to change them, and there is no tool to delete a slide. So a slide created as `["static"]` can never be edited into an interactive one: every `update_slide` will fail SL-H01 and retrying cannot help. If it happens, stop and ask the user to delete that slide so you can create it again — do not loop on `update_slide`, and do not create a second slide beside the broken one. Decide the capabilities BEFORE the first `create_slide` call.
- **Exactly one `[data-hover-target]` and exactly one `[data-click-target]`** on an `interactive-js` slide — zero or two is a rejection (SL-I01), which is why the interactivity contract above says exactly one of each.
- **The `<script>` must be the last element of `<body>`** (SL-I02) — the same rule as "attach listeners after DOM exists".
- **The 1280x720 sizing and the resets must be in a `<style>` block** — `width:1280px`, `height:720px`, `box-sizing:border-box`, and `margin:0`/`padding:0` are read from your stylesheet, not from `style="…"` attributes (SL-G01, SL-G03).
- **No `position:fixed` and no viewport units** (`vh`/`vw`/`vmin`/`vmax`) anywhere — size in px against 1280x720 (SL-G05).
- **No external subresources**: no `<link>`, no `<script src>`, no remote `url()`, no `@import`, no `@font-face`. Images must be `data:` URIs (SL-S01, SL-S02, SL-S03).
- **No network, storage, or eval APIs** — `fetch`, `XMLHttpRequest`, `WebSocket`, `localStorage`, `document.cookie`, `alert`/`confirm`/`prompt`, `eval`, `new Function` are all rejected (SL-S04). Chart data is a literal array in your script; there is nothing to fetch.
- **Nothing below 16px** anywhere (SL-C01) — and this skill's 18px tooltip floor is stricter, so follow that.

Minimal contract-valid slide (shape only — build the real chart to the rules above) — call `mcp__slides__create_slide` with `capabilities: ["interactive-js"]`, a `title`, and this `html`:

```html
<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <style>
      html,
      body {
        margin: 0;
        padding: 0;
      }
      *,
      *::before,
      *::after {
        box-sizing: border-box;
      }
      .slide {
        width: 1280px;
        height: 720px;
        overflow: hidden;
        position: relative;
        padding: 48px;
        background: #fafbfc;
        color: #16202e;
        font-family: -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
      }
      .title {
        font-size: 44px;
        font-weight: 700;
      }
      .bar {
        cursor: pointer;
        fill: #2f6df6;
      }
      .bar.selected {
        fill: #103a9e;
      }
      .tooltip {
        position: absolute;
        display: none;
        padding: 10px 14px;
        border-radius: 10px;
        background: #16202e;
        color: #ffffff;
        font-size: 20px;
      }
      .tooltip.shown {
        display: block;
      }
      .summary {
        font-size: 22px;
        color: #5a6478;
      }
      text {
        font-size: 20px;
        fill: #16202e;
      }
    </style>
  </head>
  <body>
    <div class="slide">
      <h1 class="title">Requested title</h1>
      <svg width="1000" height="440" viewBox="0 0 1000 440">
        <rect class="bar" data-hover-target data-click-target x="80" y="140" width="120" height="260" />
        <rect class="bar" x="260" y="60" width="120" height="340" />
        <text x="110" y="428">Q1</text>
        <text x="290" y="428">Q2</text>
      </svg>
      <div class="tooltip" id="tip"></div>
      <p class="summary" id="summary">Click a bar to see details</p>
    </div>
    <script>
      const tip = document.getElementById('tip')
      const summary = document.getElementById('summary')
      const show = () => {
        tip.textContent = '4.2M'
        tip.classList.add('shown')
        tip.style.left = '150px'
        tip.style.top = '180px'
      }
      for (const bar of document.querySelectorAll('.bar')) {
        bar.addEventListener('mouseenter', show)
        bar.addEventListener('mouseover', show)
        bar.addEventListener('mouseleave', () => tip.classList.remove('shown'))
        bar.addEventListener('click', () => {
          for (const other of document.querySelectorAll('.bar')) other.classList.remove('selected')
          bar.classList.add('selected')
          summary.textContent = 'Q1: 4.2M'
        })
      }
    </script>
  </body>
</html>
```

## Self-check before returning
1. Recompute two bar heights from the data — proportional?
2. Simulate hover on the tagged element: tooltip shows the exact prompt value?
3. Simulate click: does the described change definitely happen, visibly?
4. `data-hover-target` and `data-click-target` both present exactly where the harness will look?
5. Zero console errors; all text >= 16px; nothing overflows 1280x720.
