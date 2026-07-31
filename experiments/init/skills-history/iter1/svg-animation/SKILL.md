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
- **Orbits**: put each planet in a `<g>` centered on the sun; rotate the group with `animateTransform type="rotate"` (or CSS `transform-origin` at the sun's center + `@keyframes spin`). Different speeds = different durations (e.g. 4s/7s/11s). Draw orbit paths as circles with `fill:none;stroke:rgba(...,0.25)` BEFORE adding motion so radii visibly match the paths. Counter-rotate labels if they must stay upright, or place planet labels outside the rotating group near each orbit.
- **Pulse along a path**: `<circle r="6">` + `<animateMotion dur="..." repeatCount="indefinite"><mpath href="#pathId"/></animateMotion>`, where `#pathId` is an invisible path tracing the whole route through all stages IN ORDER. For stage-to-stage sequencing, either one path through all stages, or chained `begin="prev.end"` with the LAST one restarting the FIRST (`begin="0s; last.end"`) so the loop never dies.
- **Dashed-line flow**: animate `stroke-dashoffset` with linear timing for conveyor effects on arrows.

## Diagram clarity
- Labels never rotate with their shapes unless asked; keep labels horizontal and unclipped.
- Arrows use a defined `<marker>` arrowhead; boxes/stages are evenly spaced and aligned; the moving element must visibly touch each stage it passes.
- The animated SVG should occupy the majority of the content area (it's the point of the slide); title above, sized per the standard scale.

## Self-check before returning
1. Trace every animation: does it repeat indefinitely? Is any `fill="freeze"` (forbidden unless part of a restarting chain)?
2. Do moving elements stay inside the 1280x720 viewport for the whole cycle?
3. Are all requested stages/planets/labels present, legible, and correctly attached?
4. Zero JS errors (prefer zero JS).
