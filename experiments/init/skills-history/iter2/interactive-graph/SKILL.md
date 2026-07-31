---
name: interactive-graph
description: Creates presentation slides containing interactive charts (bar, line, legend toggles, hover tooltips, click highlights) as self-contained 1280x720 HTML files with vanilla JS + inline SVG. Use when asked for an interactive graph, chart with tooltips, clickable chart, or data visualization on a slide.
---

# interactive-graph

Produce ONE self-contained 1280x720 HTML slide (same layout/typography/contrast contract as a standard slide: fixed `.slide` root, `overflow:hidden`, zero page scroll, title 40–48px, axis/legend text >= 16px). Chart is hand-built inline SVG + vanilla JS. No libraries.

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
