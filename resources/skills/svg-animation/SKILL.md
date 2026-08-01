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
6. **Validate by rendering.** After writing the slide with `mcp__slides__create_slide` / `mcp__slides__update_slide`, call `mcp__slides__screenshot_slide` three times for that slide id — with `atMs: 0`, `atMs: 2000` and `atMs: 5000` — and Read all three PNGs at full attention: the animated element must be visibly present and in a DIFFERENT correct position in all three, on its path/connector, labels legible and nearest their subjects, nothing clipped. Fix with `mcp__slides__update_slide` and re-screenshot until all three frames pass. Do not report done until they do.

## Animation contract (machine-checked)
- Animation starts IMMEDIATELY on load (no click-to-start) and LOOPS FOREVER (`animation-iteration-count: infinite` or SMIL `repeatCount="indefinite"`). Screenshots at t=0s, t=2s and t=5s must all differ in the animated region and never show a frozen end-state.
- Prefer CSS `@keyframes` on SVG elements, or SMIL (`<animate>`, `<animateMotion>`, `<animateTransform>`) — both run in any browser with zero JS. Use JS (`requestAnimationFrame`) only for logic CSS/SMIL can't express (e.g. sequenced multi-stage timing) and wrap it in `try/catch`-free clean code — zero console errors allowed. JS means declaring `interactive-js` and adding the two testing hooks (see the Sloodge contract below), so prefer none.
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

## Sloodge slide contract (machine-checked before the slide is accepted)
The `mcp__slides__*` tools reject HTML that breaks these — a rejection comes back as `SL-xxx: …`, fix and resend.

- **Declare `capabilities` as a TOOL ARGUMENT.** `capabilities` is an argument to `mcp__slides__create_slide`, alongside `html` and `title` — it is **not** part of the HTML, and nothing reads it from a comment or a meta tag. An animated slide is NEVER `["static"]`: CSS `@keyframes` motion is `capabilities: ["css-animation"]`; SMIL (`<animate>`, `<animateTransform>`, `<animateMotion>`) is `["smil-animation"]`; both is both. An animation you did not declare is rejected, and a declared animation the slide does not actually contain is also rejected (SL-H01, SL-A01). If you use JS, add `"interactive-js"` — and then the slide needs exactly one `[data-hover-target]` and one `[data-click-target]` (SL-I01), which is why zero-JS is preferred here.
- **Capabilities are fixed at creation — you cannot fix them later.** `mcp__slides__update_slide` validates your new HTML against the capabilities the slide *already* has and has no argument to change them, and there is no tool to delete a slide. So a slide created as `["static"]` can never be edited into an animated one: every `update_slide` will fail SL-H01 and retrying cannot help. If it happens, stop and ask the user to delete that slide so you can create it again — do not loop on `update_slide`, and do not create a second slide beside the broken one. Decide the capabilities BEFORE the first `create_slide` call.
- **The 1280x720 sizing and the resets must be in a `<style>` block** — `width:1280px`, `height:720px`, `box-sizing:border-box`, and `margin:0`/`padding:0` are read from your stylesheet, not from `style="…"` attributes (SL-G01, SL-G03).
- **No `position:fixed` and no viewport units** (`vh`/`vw`/`vmin`/`vmax`) anywhere — size in px against 1280x720 (SL-G05).
- **No external subresources**: no `<link>`, no `<script src>`, no remote `url()`, no `@import`, no `@font-face`. Images must be `data:` URIs (SL-S01, SL-S02, SL-S03).
- **No network, storage, or eval APIs** — `fetch`, `XMLHttpRequest`, `WebSocket`, `localStorage`, `document.cookie`, `alert`/`confirm`/`prompt`, `eval`, `new Function` are all rejected (SL-S04).
- **A `<script>`, if present, is the last element of `<body>`** (SL-I02). **Nothing below 16px** anywhere (SL-C01) — and this skill's own 18px label floor is stricter, so follow that.

Minimal contract-valid slide (zero JS, CSS keyframes, loops forever) — call `mcp__slides__create_slide` with `capabilities: ["css-animation"]`, a `title`, and this `html`:

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
        background: #0d1220;
        color: #eef2f8;
        font-family: -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
      }
      .title {
        font-size: 44px;
        font-weight: 700;
      }
      .orbit {
        transform-origin: 592px 260px;
        animation: spin 7s linear infinite;
      }
      @keyframes spin {
        from {
          transform: rotate(0deg);
        }
        to {
          transform: rotate(360deg);
        }
      }
      text {
        font-size: 20px;
        fill: #eef2f8;
      }
    </style>
  </head>
  <body>
    <div class="slide">
      <h1 class="title">Requested title</h1>
      <svg width="1184" height="520" viewBox="0 0 1184 520">
        <circle cx="592" cy="260" r="180" fill="none" stroke="rgba(238,242,248,0.25)" />
        <circle cx="592" cy="260" r="28" fill="#ffb020" />
        <g class="orbit">
          <circle cx="772" cy="260" r="14" fill="#5aa9ff" />
        </g>
        <text x="784" y="300">Requested label</text>
      </svg>
    </div>
  </body>
</html>
```

## Self-check before returning
1. Trace every animation: does it repeat indefinitely? Is any `fill="freeze"` (forbidden unless part of a restarting chain)?
2. Simulate three timestamps (t=0, t=T/4, t=T/2) for EVERY moving element: compute roughly where it is and what it overlaps. A label 180° from its planet, or a pulse inside a box, fails.
3. Do moving elements stay inside the 1280x720 viewport for the whole cycle?
4. Are all requested stages/planets/labels present, legible, and visually adjacent to the thing they name at ALL times (not just t=0)?
5. Are arrowheads actually visible (not under boxes), and does every connector touch its target's edge?
6. Zero JS errors (prefer zero JS).
