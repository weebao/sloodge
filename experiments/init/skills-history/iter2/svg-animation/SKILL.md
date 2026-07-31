---
name: svg-animation
description: Creates presentation slides containing looping, smooth SVG animations (orbits, flow diagrams, animated paths, pulses) as self-contained 1280x720 HTML files. Use when asked for an animated diagram, animated SVG, motion graphics, or any slide where elements move.
---

# svg-animation

Produce ONE self-contained 1280x720 HTML slide with an inline SVG animation. Follow every layout/typography rule of a standard slide (fixed `.slide` root 1280x720, `overflow:hidden`, zero page scroll, 48px padding, presentation-grade text sizes, WCAG AA contrast).

## Animation contract (machine-checked)
- Animation starts IMMEDIATELY on load (no click-to-start) and LOOPS FOREVER (`animation-iteration-count: infinite` or SMIL `repeatCount="indefinite"`). Screenshots at t=0s, t=2s and t=5s must all differ in the animated region and never show a frozen end-state.
- Prefer CSS `@keyframes` on SVG elements, or SMIL (`<animate>`, `<animateMotion>`, `<animateTransform>`) — both run in any browser with zero JS. Use JS (`requestAnimationFrame`) only for logic CSS/SMIL can't express (e.g. sequenced multi-stage timing) and wrap it in `try/catch`-free clean code — zero console errors allowed.
- Smoothness: animate only `transform`/`opacity`/SMIL motion (compositor-friendly). Never animate layout properties (width/left/top of HTML elements).

## Technique guide
- **Orbits**: put each planet in a `<g>` centered on the sun; rotate the group with `animateTransform type="rotate"` (or CSS `transform-origin` at the sun's center + `@keyframes spin`). Different speeds = different durations (e.g. 4s/7s/11s). Draw orbit paths as circles with `fill:none;stroke:rgba(...,0.25)` BEFORE adding motion so radii visibly match the paths.
- **Labels on moving elements — DANGER ZONE.** The safest correct pattern, use it by default: STATIC labels placed just outside each orbit path (horizontal text, next to the orbit circle, e.g. at its rightmost point), identifying the orbit rather than chasing the planet. Do NOT put a label in its own separately-animated group: rotating a label group with the OPPOSITE sign (-360deg) while the planet goes +360deg makes the label revolve backwards AWAY from its planet — they meet only at t=0. If (and only if) a label must ride its planet: put the `<text>` INSIDE the same rotating `<g>` as the planet, then counter-rotate the text about the PLANET's own position with the SAME duration and OPPOSITE sign so it stays upright. Verify mentally at t=T/4: where is the planet, where is the label?
- **Pulse along a path**: `<circle r="6">` + `<animateMotion dur="..." repeatCount="indefinite"><mpath href="#pathId"/></animateMotion>`. The motion path must trace the CONNECTORS: its waypoints are the arrow attachment points on each box's EDGE (e.g. right-edge midpoint of box A → left-edge midpoint of box B). The path must NEVER pass through a box interior — compute box edge x/y coordinates and build the path from those exact numbers. Check: at any time, the dot lies ON a visible connector line, not inside a stage. For stage-to-stage sequencing, one path through all connector segments in order, or chained `begin="prev.end"` with the LAST restarting the FIRST (`begin="0s; last.end"`).
- **Arrowheads**: define a filled `<marker>` and make each connector a separate line/path that STOPS AT the target box's edge (never runs underneath an opaque rect — an arrowhead drawn under a box is invisible). Draw order: boxes first, connectors+markers after, so arrows sit above box borders. After writing coordinates, re-check: connector end x == target box edge x.
- **Dashed-line flow**: animate `stroke-dashoffset` with linear timing for conveyor effects on arrows.

## Diagram clarity
- Labels never rotate with their shapes unless asked; keep labels horizontal and unclipped.
- Arrows use a defined `<marker>` arrowhead; boxes/stages are evenly spaced and aligned; the moving element must visibly touch each stage it passes.
- The animated SVG should occupy the majority of the content area (it's the point of the slide); title above, sized per the standard scale.

## Self-check before returning
1. Trace every animation: does it repeat indefinitely? Is any `fill="freeze"` (forbidden unless part of a restarting chain)?
2. Simulate three timestamps (t=0, t=T/4, t=T/2) for EVERY moving element: compute roughly where it is and what it overlaps. A label 180° from its planet, or a pulse inside a box, fails.
3. Do moving elements stay inside the 1280x720 viewport for the whole cycle?
4. Are all requested stages/planets/labels present, legible, and visually adjacent to the thing they name at ALL times (not just t=0)?
5. Are arrowheads actually visible (not under boxes), and does every connector touch its target's edge?
6. Zero JS errors (prefer zero JS).
