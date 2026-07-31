---
name: svg-animation
description: Creates presentation slides containing looping, smooth SVG animations (orbits, flow diagrams, animated paths, pulses) as self-contained 1280x720 HTML files. Use when asked for an animated diagram, animated SVG, motion graphics, or any slide where elements move.
---

# svg-animation

Produce ONE self-contained 1280x720 HTML slide with an inline SVG animation. Follow every layout/typography rule of a standard slide (fixed `.slide` root 1280x720, `overflow:hidden`, zero page scroll, 48px padding, presentation-grade text sizes, WCAG AA contrast).

## HARD RULES — violating any of these fails the slide outright
1. **No SMIL begin-chains.** Sequenced motion uses ONE `<animateMotion>` on ONE continuous path (with `keyPoints`/`keyTimes` for dwell pauses), or one CSS `@keyframes` with percentage stops. Chained `begin="x.end"` restarts silently die in real browsers — banned.
2. **Nothing within 40px of any slide edge.** Every box, label, and moving element (over its whole cycle) stays inside a 1200x640 safe area.
3. **All labels ≥18px** (SVG `font-size` included), each on a solid or high-contrast backing where it crosses artwork — never light text over a bright shape (e.g. a label ON a glowing sun must sit on a dark chip below it).
4. **Label proximity is checked geometrically**: each label must be CLOSER to the thing it names than to any other candidate, at every point of the animation cycle, and must NEVER occlude or be occluded by any moving element at any time. For orbiting bodies the ONLY pattern that satisfies both: the label RIDES WITH its planet — `<text>` inside the planet's rotating `<g>`, offset ~18-24px from the planet, kept upright by a nested counter-rotation (same duration, opposite sign, anchored at the planet's own cx,cy). Static chips pinned on the orbit fail (the planet passes behind them once per revolution).
5. **Dwell points sit at connector MIDPOINTS.** A moving pulse must never pause on top of an arrowhead, a box border, or a label; dwells happen mid-connector, and the pulse merely passes through endpoints without stopping. Motionless time at any single point ≤15% of the cycle.
6. **Validate by rendering.** After writing the file, run:
   `export PATH="$HOME/.nvm/versions/node/v24.18.1/bin:$PATH" && node /home/baoro/stuff/random/sloodge/experiments/init/harness/render.mjs <your-file> /tmp/claude-1000/-home-baoro-stuff-random-sloodge/e0c46df0-cfa4-4efa-9f79-3438b9af54d1/scratchpad/selfcheck-<case-id>`
   then Read t0.png, t2.png AND t5.png at full attention: the animated element must be visibly present and in a DIFFERENT correct position in all three, on its path/connector, labels legible and nearest their subjects, nothing clipped. Fix and re-render until all three frames pass. Do not return until they do.

## Animation contract (machine-checked)
- Animation starts IMMEDIATELY on load (no click-to-start) and LOOPS FOREVER (`animation-iteration-count: infinite` or SMIL `repeatCount="indefinite"`). Screenshots at t=0s, t=2s and t=5s must all differ in the animated region and never show a frozen end-state.
- Prefer CSS `@keyframes` on SVG elements, or SMIL (`<animate>`, `<animateMotion>`, `<animateTransform>`) — both run in any browser with zero JS. Use JS (`requestAnimationFrame`) only for logic CSS/SMIL can't express (e.g. sequenced multi-stage timing) and wrap it in `try/catch`-free clean code — zero console errors allowed.
- Smoothness: animate only `transform`/`opacity`/SMIL motion (compositor-friendly). Never animate layout properties (width/left/top of HTML elements).

## Technique guide
- **Orbits**: put each planet in a `<g>` centered on the sun; rotate the group with `animateTransform type="rotate"` (or CSS `transform-origin` at the sun's center + `@keyframes spin`). Different speeds = different durations (e.g. 4s/7s/11s). Draw orbit paths as circles with `fill:none;stroke:rgba(...,0.25)` BEFORE adding motion so radii visibly match the paths.
- **Labels on moving elements — DANGER ZONE.** The safest correct pattern, use it by default: STATIC labels placed just outside each orbit path (horizontal text, next to the orbit circle, e.g. at its rightmost point), identifying the orbit rather than chasing the planet. Do NOT put a label in its own separately-animated group: rotating a label group with the OPPOSITE sign (-360deg) while the planet goes +360deg makes the label revolve backwards AWAY from its planet — they meet only at t=0. If (and only if) a label must ride its planet: put the `<text>` INSIDE the same rotating `<g>` as the planet, then counter-rotate the text about the PLANET's own position with the SAME duration and OPPOSITE sign so it stays upright. Verify mentally at t=T/4: where is the planet, where is the label?
- **Pulse along a path**: `<circle r="6">` + `<animateMotion dur="..." repeatCount="indefinite"><mpath href="#pathId"/></animateMotion>`. The motion path must trace the CONNECTORS: its waypoints are the arrow attachment points on each box's EDGE (e.g. right-edge midpoint of box A → left-edge midpoint of box B). The path must NEVER pass through a box interior — compute box edge x/y coordinates and build the path from those exact numbers. Check: at any time, the dot lies ON a visible connector line, not inside a stage. For stage-to-stage sequencing use ONE path through all connector segments in order with a single `animateMotion` + `keyPoints`/`keyTimes` for dwells (hard rule 1 bans begin-chains). If stages should light up as the pulse arrives, drive the glow with CSS `@keyframes` whose percentage stops match the pulse's keyTimes — same total duration, `infinite`, so both loop in lockstep.
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
