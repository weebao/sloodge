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
5. **Validate by rendering.** After writing the file, run:
   `export PATH="$HOME/.nvm/versions/node/v24.18.1/bin:$PATH" && node /home/baoro/stuff/random/sloodge/experiments/init/harness/render.mjs <your-file> /tmp/claude-1000/-home-baoro-stuff-random-sloodge/e0c46df0-cfa4-4efa-9f79-3438b9af54d1/scratchpad/selfcheck-<case-id> --interactive`
   then Read t0.png, hover.png AND click.png at full attention: tooltip present with the exact value and overlapping nothing (hard rule 1), click state visibly changed as requested, all labels fully rendered (descenders intact), correct proportions. Fix and re-render until all three frames pass. Do not return until they do.

## Interactivity contract (machine-checked)
- Tag EXACTLY the elements a tester should touch:
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

## Self-check before returning
1. Recompute two bar heights from the data — proportional?
2. Simulate hover on the tagged element: tooltip shows the exact prompt value?
3. Simulate click: does the described change definitely happen, visibly?
4. `data-hover-target` and `data-click-target` both present exactly where the harness will look?
5. Zero console errors; all text >= 16px; nothing overflows 1280x720.
