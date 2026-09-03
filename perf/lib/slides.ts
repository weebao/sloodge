/**
 * The four stress-slide archetypes.
 *
 * These exist to make the app do *real* work. A stress deck of 1000 near-empty slides would measure
 * the cost of mounting 1000 iframes and nothing else, and every optimization gated on M8.1's numbers
 * would then be tuned against a workload no user has. So each archetype targets a distinct, real
 * cost centre in the renderer:
 *
 * | Archetype          | What it provokes                                                        |
 * |--------------------|-------------------------------------------------------------------------|
 * | `svg-animation`    | Continuous compositor + SMIL/CSS animation work on every mounted frame   |
 * | `interactive-graph`| A per-frame `requestAnimationFrame` canvas redraw and JS event listeners |
 * | `image-laden`      | Raster decode and decoded-bitmap cache residency (the RAM budget's enemy)|
 * | `component-dense`  | Deep DOM: style recalc, layout, and per-node memory                      |
 *
 * Every archetype must pass the shipped Tier-1 linter (`validateSlideContract`), and the generator
 * asserts that before writing a deck — a stress deck the app would reject on load is not a stress
 * deck. Two of the linter's rules shape the code here in non-obvious ways and are easy to
 * reintroduce by accident:
 *
 *  - **SL-H01** requires declared `capabilities` to match content *exactly*. A `<script>` demands
 *    `interactive-js`; a `@keyframes` block or a SMIL tag demands an animation capability. So the
 *    interactive archetype must contain **no** `@keyframes` and no `<animate*>`, and the static
 *    archetypes must contain neither scripts nor animation. The shared skeleton therefore carries no
 *    animation CSS — each archetype adds its own.
 *  - **SL-S04** substring-scans the whitespace-stripped, lowercased *whole source* for tokens like
 *    `eval(` and `alert(`. That matches prose, not just code: the word "retrieval" followed by an
 *    opening parenthesis packs to `…ieval(` and trips `eval(`. All generated prose here is drawn
 *    from a fixed vocabulary and avoids parentheses entirely.
 */

import {
  escapeHtml,
  renderThemeBlock,
  SYSTEM_FONT_STACK,
} from '../../src/shared/document/starter-slide'
import type { SlideCapability, SlideKind } from '../../src/shared/document/types'
import { encodePngDataUri } from './png'
import { intBetween, pick, type Rng } from './prng'

/** How much content each archetype emits. Lets a deck trade fidelity against total bytes. */
export type Density = {
  /** Animated SVG nodes in the `svg-animation` archetype. */
  readonly animatedNodes: number
  /** Bars in the `interactive-graph` chart. */
  readonly chartBars: number
  /** Embedded PNGs in the `image-laden` archetype. */
  readonly images: number
  /** Pixel width of each embedded PNG (height is 5/8 of it). */
  readonly imageWidth: number
  /** Stat cards in the `component-dense` archetype. */
  readonly cards: number
  /** Table rows in the `component-dense` archetype. */
  readonly tableRows: number
}

export const DEFAULT_DENSITY: Density = {
  animatedNodes: 64,
  chartBars: 14,
  images: 4,
  imageWidth: 240,
  cards: 36,
  tableRows: 18,
}

export type Archetype = 'svg-animation' | 'interactive-graph' | 'image-laden' | 'component-dense'

/** Fixed rotation, so slide N is the same archetype in every deck of every size. */
export const ARCHETYPE_CYCLE: readonly Archetype[] = [
  'svg-animation',
  'interactive-graph',
  'image-laden',
  'component-dense',
]

/**
 * Prose vocabulary. Deliberately parenthesis-free and drawn from a closed set — see the SL-S04 note
 * in the file header for why free-form generated text is a contract hazard.
 */
const NOUNS: readonly string[] = [
  'Throughput',
  'Latency',
  'Adoption',
  'Retention',
  'Coverage',
  'Capacity',
  'Utilization',
  'Backlog',
  'Margin',
  'Velocity',
  'Density',
  'Headroom',
]

const QUALIFIERS: readonly string[] = [
  'by region',
  'by quarter',
  'by cohort',
  'year over year',
  'against plan',
  'per workspace',
]

const SERIES_COLORS: readonly string[] = [
  '#4c8dff',
  '#f2994a',
  '#27ae60',
  '#bb6bd9',
  '#eb5757',
  '#56ccf2',
]

/**
 * The shared skeleton. Carries exactly the substrings SL-G01/SL-G03 require
 * (`width:1280px`, `height:720px`, `box-sizing:border-box`, `margin:0`, `padding:0`) and nothing
 * that would imply a capability the archetype has not declared.
 */
function baseCss(): string {
  // Theme tokens come from the shipped renderer, so slides carry the real sentinel block.
  return `${renderThemeBlock()}
*,*::before,*::after{box-sizing:border-box}
html,body{margin:0;padding:0;background:var(--sl-bg)}
.slide{width:1280px;height:720px;overflow:hidden;position:relative;box-sizing:border-box;padding:var(--sl-pad);background:var(--sl-bg);color:var(--sl-fg);font-family:${SYSTEM_FONT_STACK};font-size:20px}
.slide h1{margin:0 0 16px;font-size:44px;font-weight:700;line-height:1.2}
.slide h2{margin:0 0 12px;font-size:28px;font-weight:600}
.slide .sub{margin:0 0 24px;font-size:22px;color:var(--sl-muted)}
.slide .foot{position:absolute;left:48px;bottom:24px;font-size:16px;color:var(--sl-muted)}`
}

function renderDocument(
  id: string,
  title: string,
  css: string,
  body: string,
  script: string | null,
): string {
  const scriptTag = script === null ? '' : `\n<script>\n${script}\n</script>`
  return `<!doctype html>
<html lang="en" data-sl-slide="${escapeHtml(id)}" data-sl-contract="1">
<head>
<meta charset="utf-8">
<title>${escapeHtml(title)}</title>
<style>
${css}
</style>
</head>
<body>
<div class="slide" data-sl-id="e_root">
${body}
</div>${scriptTag}
</body>
</html>
`
}

function heading(rng: Rng, index: number): { title: string; sub: string } {
  const noun = pick(rng, NOUNS)
  const qualifier = pick(rng, QUALIFIERS)
  return { title: `${noun} ${qualifier}`, sub: `Stress slide ${String(index + 1)}` }
}

// --- A. svg-animation ---------------------------------------------------------------------------

/**
 * Continuous motion on every mounted frame: SMIL transforms plus a CSS `@keyframes` layer, over a
 * gradient and a Gaussian blur filter so the compositor has real work rather than a solid fill.
 *
 * Declares `css-animation` **and** `smil-animation` because it genuinely contains both; SL-H01
 * rejects a slide that animates by a mechanism it did not declare.
 */
export function svgAnimationSlide(id: string, index: number, rng: Rng, density: Density): string {
  const { title, sub } = heading(rng, index)
  const nodes: string[] = []
  for (let n = 0; n < density.animatedNodes; n += 1) {
    const cx = intBetween(rng, 40, 1140)
    const cy = intBetween(rng, 40, 420)
    const r = intBetween(rng, 6, 26)
    const dur = (intBetween(rng, 20, 90) / 10).toFixed(1)
    const color = pick(rng, SERIES_COLORS)
    // SMIL: rotate forever about the shape's own centre, and pulse opacity. `repeatCount` is
    // indefinite and there is no fill="freeze" — SL-A01 wants perpetual motion, SL-A02 forbids
    // freezing on the last frame.
    nodes.push(
      `<circle cx="${String(cx)}" cy="${String(cy)}" r="${String(r)}" fill="${color}" opacity="0.75">` +
        `<animateTransform attributeName="transform" type="rotate" from="0 ${String(cx)} ${String(cy)}" to="360 ${String(cx)} ${String(cy)}" dur="${dur}s" repeatCount="indefinite"/>` +
        `<animate attributeName="opacity" values="0.75;0.2;0.75" dur="${dur}s" repeatCount="indefinite"/>` +
        `</circle>`,
    )
  }
  const bars: string[] = []
  for (let n = 0; n < 12; n += 1) {
    const delay = (n * 0.17).toFixed(2)
    bars.push(`<span class="pulse" style="animation-delay:${delay}s"></span>`)
  }

  const css = `${baseCss()}
.stage{position:relative;width:1184px;height:470px;border-radius:var(--sl-radius);overflow:hidden;background:#0a0f1c}
.pulse{display:inline-block;width:72px;height:18px;margin:0 6px;border-radius:9px;background:var(--sl-accent);animation:sl-pulse 2.4s ease-in-out infinite}
.pulses{margin-top:14px}
@keyframes sl-pulse{0%{transform:scaleX(0.35);opacity:0.4}50%{transform:scaleX(1);opacity:1}100%{transform:scaleX(0.35);opacity:0.4}}
.orbit{transform-origin:592px 235px;animation:sl-orbit 18s linear infinite}
@keyframes sl-orbit{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}`

  const body = `<h1>${escapeHtml(title)}</h1>
<p class="sub">${escapeHtml(sub)}</p>
<div class="stage">
<svg width="1184" height="470" viewBox="0 0 1184 470" role="img" aria-label="Animated field">
<defs>
<linearGradient id="g${String(index)}" x1="0" y1="0" x2="1" y2="1">
<stop offset="0%" stop-color="#12203c"/><stop offset="100%" stop-color="#0a0f1c"/>
</linearGradient>
<filter id="b${String(index)}"><feGaussianBlur stdDeviation="3"/></filter>
</defs>
<rect x="0" y="0" width="1184" height="470" fill="url(#g${String(index)})"/>
<g filter="url(#b${String(index)})" class="orbit">
${nodes.join('\n')}
</g>
</svg>
</div>
<div class="pulses">${bars.join('')}</div>
<div class="foot">Archetype: svg-animation</div>`

  return renderDocument(id, title, css, body, null)
}

// --- B. interactive-graph -----------------------------------------------------------------------

/**
 * A JS-driven chart: an SVG bar series with hover/click behaviour plus a `<canvas>` redrawn every
 * animation frame. The canvas loop is the point — it is the per-frame CPU cost that M8.4
 * ("animation throttling for inactive surfaces") has to eliminate for non-active slides, so the
 * baseline needs it present on every one of these frames.
 *
 * Contract shape: exactly one `[data-hover-target]` and one `[data-click-target]` (SL-I01), the
 * `<script>` is the last element of `<body>` (SL-I02), and there is deliberately no `@keyframes`
 * and no SMIL anywhere, because `capabilities` declares only `interactive-js` (SL-H01).
 */
export function interactiveGraphSlide(
  id: string,
  index: number,
  rng: Rng,
  density: Density,
): string {
  const { title, sub } = heading(rng, index)
  const values: number[] = []
  for (let n = 0; n < density.chartBars; n += 1) values.push(intBetween(rng, 12, 100))
  const maxValue = Math.max(...values)
  const chartHeight = 300
  const barWidth = Math.floor(1100 / values.length) - 10

  const bars = values
    .map((value, n) => {
      // Geometry computed numerically from the data, y-axis anchored at zero.
      const h = Math.round((value / maxValue) * chartHeight)
      const x = n * (barWidth + 10)
      const y = chartHeight - h
      const hook = n === 0 ? ' data-hover-target cursor-hint' : ''
      return `<rect class="bar"${hook} x="${String(x)}" y="${String(y)}" width="${String(barWidth)}" height="${String(h)}" fill="${pick(rng, SERIES_COLORS)}" data-value="${String(value)}"/>`
    })
    .join('\n')

  const labels = values
    .map((_, n) => {
      const x = n * (barWidth + 10) + barWidth / 2
      return `<text x="${String(x)}" y="${String(chartHeight + 24)}" text-anchor="middle" font-size="16" fill="#9aa4b8">Q${String(n + 1)}</text>`
    })
    .join('\n')

  const css = `${baseCss()}
.chart{position:relative;width:1184px;height:352px}
.bar{transition:opacity 0.15s ease}
.bar:hover{opacity:0.65}
.cursor-hint{cursor:pointer}
.legend{margin-top:8px;font-size:18px;color:var(--sl-muted);cursor:pointer;display:inline-block;padding:6px 12px;border:1px solid #2a3350;border-radius:8px}
.tip{position:absolute;left:0;top:0;display:none;padding:6px 10px;border-radius:8px;background:#11182b;color:var(--sl-fg);font-size:16px;border:1px solid #2a3350}
.summary{margin-top:10px;font-size:18px;color:var(--sl-fg)}
canvas{display:block;margin-top:6px;border-radius:8px;background:#0a0f1c}`

  const body = `<h1>${escapeHtml(title)}</h1>
<p class="sub">${escapeHtml(sub)}</p>
<div class="chart">
<svg width="1184" height="340" viewBox="0 0 1184 340" role="img" aria-label="Bar chart">
${bars}
${labels}
</svg>
<div class="tip" data-sl-tooltip>0</div>
</div>
<span class="legend cursor-hint" data-click-target>Toggle series</span>
<div class="summary" data-sl-summary>Series shown</div>
<canvas id="spark" width="1184" height="90"></canvas>
<div class="foot">Archetype: interactive-graph</div>`

  // Vanilla JS only, no libraries, no forbidden APIs. The rAF loop runs forever by design.
  const script = `var bars = document.querySelectorAll('.bar');
var tip = document.querySelector('[data-sl-tooltip]');
var summary = document.querySelector('[data-sl-summary]');
var hoverBar = document.querySelector('[data-hover-target]');
function showTip(ev) {
  if (!tip || !hoverBar) return;
  tip.textContent = hoverBar.getAttribute('data-value') || '0';
  tip.style.display = 'block';
  tip.style.left = '24px';
  tip.style.top = '24px';
}
function hideTip() { if (tip) tip.style.display = 'none'; }
if (hoverBar) {
  hoverBar.addEventListener('mouseenter', showTip);
  hoverBar.addEventListener('mouseover', showTip);
  hoverBar.addEventListener('mouseleave', hideTip);
}
var on = true;
var toggle = document.querySelector('[data-click-target]');
if (toggle) {
  toggle.addEventListener('click', function () {
    on = !on;
    for (var i = 0; i < bars.length; i += 1) {
      bars[i].style.opacity = on ? '1' : '0.25';
    }
    if (summary) summary.textContent = on ? 'Series shown' : 'Series hidden';
  });
}
var canvas = document.getElementById('spark');
var ctx = canvas ? canvas.getContext('2d') : null;
var phase = 0;
function draw() {
  if (ctx && canvas) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.strokeStyle = '#4c8dff';
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (var x = 0; x < canvas.width; x += 4) {
      var y = 45 + Math.sin(x * 0.02 + phase) * 30;
      if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
  phase += 0.05;
  requestAnimationFrame(draw);
}
requestAnimationFrame(draw);`

  return renderDocument(id, title, css, body, script)
}

// --- C. image-laden -----------------------------------------------------------------------------

/**
 * Several real PNGs as `data:` URIs. This is the archetype that most directly attacks the 200 MB
 * median-RAM budget: Chromium holds a *decoded* bitmap per visible image, and at N mounted frames
 * that cost multiplies by the deck length rather than by the visible window.
 */
export function imageLadenSlide(id: string, index: number, rng: Rng, density: Density): string {
  const { title, sub } = heading(rng, index)
  const height = Math.round((density.imageWidth * 5) / 8)
  const tiles: string[] = []
  for (let n = 0; n < density.images; n += 1) {
    const uri = encodePngDataUri({ width: density.imageWidth, height, rng })
    const caption = `${pick(rng, NOUNS)} ${String(intBetween(rng, 2019, 2026))}`
    tiles.push(
      `<figure class="tile"><img src="${uri}" width="${String(density.imageWidth)}" height="${String(height)}" alt="${escapeHtml(caption)}"><figcaption>${escapeHtml(caption)}</figcaption></figure>`,
    )
  }

  const css = `${baseCss()}
.grid{display:flex;flex-wrap:wrap;gap:20px}
.tile{margin:0;border-radius:var(--sl-radius);overflow:hidden;background:#11182b;border:1px solid #2a3350}
.tile img{display:block;width:${String(density.imageWidth)}px;height:${String(height)}px;object-fit:cover}
.tile figcaption{padding:8px 12px;font-size:16px;color:var(--sl-muted)}`

  const body = `<h1>${escapeHtml(title)}</h1>
<p class="sub">${escapeHtml(sub)}</p>
<div class="grid">
${tiles.join('\n')}
</div>
<div class="foot">Archetype: image-laden</div>`

  return renderDocument(id, title, css, body, null)
}

// --- D. component-dense -------------------------------------------------------------------------

/**
 * A deep, wide DOM — a stat-card grid over a data table — with no images, no script and no
 * animation. Isolates the cost of node count alone: style recalc, layout, and the per-node memory
 * that makes a 1000-slide deck's *structure* expensive independent of what it paints.
 */
export function componentDenseSlide(id: string, index: number, rng: Rng, density: Density): string {
  const { title, sub } = heading(rng, index)

  const cards: string[] = []
  for (let n = 0; n < density.cards; n += 1) {
    const label = pick(rng, NOUNS)
    const value = intBetween(rng, 10, 999)
    const delta = intBetween(rng, -40, 60)
    const tone = delta >= 0 ? 'up' : 'down'
    cards.push(
      `<div class="card"><div class="card-h"><span class="dot"></span><span class="card-l">${escapeHtml(label)}</span></div>` +
        `<div class="card-v">${String(value)}</div>` +
        `<div class="card-d ${tone}">${delta >= 0 ? '+' : ''}${String(delta)}%</div>` +
        `<div class="spark"><i></i><i></i><i></i><i></i><i></i><i></i></div></div>`,
    )
  }

  const rows: string[] = []
  for (let n = 0; n < density.tableRows; n += 1) {
    const cells: string[] = []
    for (let c = 0; c < 6; c += 1) {
      cells.push(`<td><span class="cell">${String(intBetween(rng, 100, 9999))}</span></td>`)
    }
    rows.push(
      `<tr><th scope="row">${escapeHtml(pick(rng, NOUNS))} ${String(n + 1)}</th>${cells.join('')}</tr>`,
    )
  }

  const css = `${baseCss()}
.cards{display:flex;flex-wrap:wrap;gap:10px;margin-bottom:16px}
.card{width:126px;padding:8px 10px;border-radius:10px;background:#11182b;border:1px solid #2a3350}
.card-h{display:flex;align-items:center;gap:6px}
.dot{width:8px;height:8px;border-radius:50%;background:var(--sl-accent);display:inline-block}
.card-l{font-size:16px;color:var(--sl-muted)}
.card-v{font-size:24px;font-weight:700}
.card-d{font-size:16px}
.card-d.up{color:#27ae60}
.card-d.down{color:#eb5757}
.spark{display:flex;gap:2px;margin-top:4px}
.spark i{display:block;width:8px;height:10px;background:#2a3350;border-radius:2px}
table{border-collapse:collapse;width:1184px;font-size:16px}
th,td{padding:4px 8px;border-bottom:1px solid #2a3350;text-align:left;color:var(--sl-fg)}
.cell{display:inline-block;min-width:44px}`

  const body = `<h1>${escapeHtml(title)}</h1>
<p class="sub">${escapeHtml(sub)}</p>
<div class="cards">
${cards.join('\n')}
</div>
<table><tbody>
${rows.join('\n')}
</tbody></table>
<div class="foot">Archetype: component-dense</div>`

  return renderDocument(id, title, css, body, null)
}

/** The `capabilities` each archetype must declare for SL-H01 to accept it. */
export function capabilitiesFor(archetype: Archetype): readonly SlideCapability[] {
  switch (archetype) {
    case 'svg-animation':
      return ['css-animation', 'smil-animation']
    case 'interactive-graph':
      return ['interactive-js']
    case 'image-laden':
    case 'component-dense':
      return ['static']
  }
}

/** The manifest `kind` each archetype reports, so the deck looks like a real mixed deck. */
export function kindFor(archetype: Archetype): SlideKind {
  switch (archetype) {
    case 'svg-animation':
      return 'animation'
    case 'interactive-graph':
      return 'chart'
    case 'image-laden':
    case 'component-dense':
      return 'content'
  }
}

/** Build one slide's HTML for the given archetype. */
export function buildSlideHtml(
  archetype: Archetype,
  id: string,
  index: number,
  rng: Rng,
  density: Density = DEFAULT_DENSITY,
): string {
  switch (archetype) {
    case 'svg-animation':
      return svgAnimationSlide(id, index, rng, density)
    case 'interactive-graph':
      return interactiveGraphSlide(id, index, rng, density)
    case 'image-laden':
      return imageLadenSlide(id, index, rng, density)
    case 'component-dense':
      return componentDenseSlide(id, index, rng, density)
  }
}
