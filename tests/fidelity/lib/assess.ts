/**
 * The §5.2 fidelity targets, computed from three inputs per slide: the independent ground truth,
 * the exporter's measurement pass, and the `.pptx` read back from disk. Every number the milestone
 * reports comes from here — the same function feeds the local harness's table and the vitest corpus
 * assertions, so "the harness measured X" and "the test asserts X" cannot drift apart.
 *
 * ## What "a construct" means (M4.8a, review r1)
 *
 * The first cut of `constructsLost` covered three *classes* — text nodes, corpus-declared rotations,
 * and a body gradient — so "0/8 silent lies" was a claim about three constructs rather than about
 * constructs. A slide could drop three painted boxes, ship an 8 % watermark fully opaque, and lose a
 * `::before` accent bar while this file printed "no silent lie". The corpus and the metric had been
 * tuned to each other.
 *
 * A construct is now anything the oracle can see a reader seeing, paired against the emitted file:
 *
 * - every **text node** (`truth.texts`), verbatim;
 * - every **painted box** (`truth.boxes`) — background or border, at a matching position *and* a
 *   matching colour, which is what catches an element the walker never emitted;
 * - the **alpha** every paint ships at, so a ghosted watermark cannot arrive opaque;
 * - every painting **`::before`/`::after`** (`truth.pseudos`), which nothing can emit — so its
 *   presence must push the slide out of the structured tier rather than pass silently;
 * - every **transform the exporter cannot decompose** (skew, flip, non-uniform scale, 3D), which is
 *   emitted as an upright axis-aligned box — the element is present but drawn wrong;
 * - the corpus-declared **rotations** and the **body gradient/image**.
 *
 * Text size is compared against *rendered* glyph size (`fontSizePx × scale`), not the authored
 * `font-size`, so a `scale(1.4)` stat cannot read "exact" while shipping 1.4× too small.
 *
 * ## Closing the world here too (M4.8a, review r2)
 *
 * r2 showed the oracle could still share the exporter's blindness: `mask-image`, `-webkit-text-
 * stroke`, invented bullets, clipped text and the standalone `rotate:` property all read as clean
 * because `truth.ts` recorded exactly the facts the walker already knew. Four checks close that:
 *
 * - **rotation is measured, not declared** — an element whose axis-aligned bounds disagree with its
 *   layout box is rotated or scaled by *something*, and shipping it at those bounds with `rot = 0`
 *   is caught whether or not the corpus declared the angle and whatever syntax produced it;
 * - **clipped text** — a string the browser cuts off that the file carries in full;
 * - **bullets** — glyphs the file invents for a list the reader sees unbulleted;
 * - **the property census** — `measure.nodes[].unmodelledProperties`, the exporter's own report of
 *   CSS nobody claims to model. Reading it here is not circular: it is the pipeline declaring a
 *   blindness, which is exactly what the metric should surface by name.
 *
 * Colour and size mismatches are folded in as well, since §5.2 lists both as targets in their own
 * right and the headline "N slides scoring ≥ 90 that drop a construct" should not exclude them.
 */

import { SLIDE_HEIGHT_PX, SLIDE_WIDTH_PX } from '../../../src/shared/export/types'
import { pxToPoints } from '../../../src/shared/export/pptx/geometry'
import { decomposeTransformSpec } from '../../../src/shared/export/pptx/confidence'
import type { MeasureResult, SlideNode } from '../../../src/shared/export/pptx/node'
import type { SlideTier } from '../../../src/shared/export/pptx/types'
import type { CorpusSlide } from './corpus'
import { normalizeWhitespace, type ReadbackShape, type ReadbackSlide } from './readback'
import type { GroundTruth, TruthBox, TruthText } from './truth'

/** A slide at or above this confidence is trusted to be structured; losing a construct here is the lie. */
export const HIGH_CONFIDENCE = 90
/** Rotation must land within this many degrees of the authored angle. */
export const ROTATION_TOLERANCE_DEG = 0.1
/** Emitted box vs DOM box: worst deviation allowed, as a percentage of the slide dimension. */
export const BOX_TOLERANCE_PCT = 0.5
/** Font size must match to this many points (`px * 0.75`). */
export const SIZE_TOLERANCE_PT = 0.02
/** Below this effective alpha, a paint is ghosted and the emitted shape must say so. */
export const OPACITY_SIGNIFICANT = 0.95
/** How far the emitted alpha may sit from the rendered one. */
export const OPACITY_TOLERANCE = 0.05
/** Below this effective alpha a paint is invisible to a reader, so nothing need be emitted for it. */
const INVISIBLE_ALPHA = 0.03
/** Slack on "the bounds disagree with the layout box"; below it the difference is layout rounding. */
export const TRANSFORM_BOUNDS_TOLERANCE_PX = 1
/** How far the two bounds/layout ratios may diverge and still be one uniform scale (px rounding). */
export const UNIFORM_SCALE_TOLERANCE = 0.02

export type SlideAssessment = {
  file: string
  tier: SlideTier
  score: number
  reasons: string[]
  /** Non-SVG text nodes in the source, and how many survive verbatim in the file. */
  textTotal: number
  textKept: number
  lostText: string[]
  colorExact: number
  colorWrong: string[]
  sizeExact: number
  sizeWrong: string[]
  /** Emitted shapes paired to a DOM box, and the worst deviation among them (% of slide dimension). */
  boxChecks: number
  boxWorstPct: number
  /** Painted boxes in the source (background or border), and how many an emitted shape matches. */
  paintedTotal: number
  paintedKept: number
  paintedLost: string[]
  /** Paints whose emitted alpha does not match what the reader sees. */
  opacityWrong: string[]
  /** Painting `::before`/`::after` in the source. Nothing can be emitted for them. */
  pseudoTotal: number
  /** Text the browser clips that the file nonetheless carries in full. */
  truncatedShipped: string[]
  /** Bullet glyphs the emitted file invents for a list the reader sees unbulleted. */
  bulletsInvented: number
  /** Rotations the oracle measured from the rendered quad that the file does not carry. */
  rotationLost: string[]
  /** Properties `properties.ts` claims neither to emit nor to score, as the measurement pass saw them. */
  unmodelledProperties: string[]
  rotationsExpected: number
  rotationsOk: number
  rotationDetails: string[]
  bodyImageExpected: boolean
  bodyImagePreserved: boolean
  /** Declared constructs the structured output does not carry. Always empty for a raster slide. */
  constructsLost: string[]
  /** The failure this milestone exists to remove: high confidence AND a lost construct. */
  silentLie: boolean
}

export type AssessArgs = {
  corpus: CorpusSlide
  truth: GroundTruth
  measure: MeasureResult
  readback: ReadbackSlide
  tier: SlideTier
  score: number
  reasons: readonly string[]
}

function expectedText(t: TruthText): string {
  return t.textTransform === 'uppercase' ? t.text.toUpperCase() : t.text
}

function runsContaining(readback: ReadbackSlide, text: string): ReadbackShape[] {
  return readback.shapes.filter((s) => s.text.includes(text))
}

function angleDelta(a: number, b: number): number {
  const d = Math.abs(((a - b) % 360) + 360) % 360
  return Math.min(d, 360 - d)
}

/** Axis-aligned bounds of an emitted box after its own rotation about its centre. */
function rotatedBounds(s: ReadbackShape): { x: number; y: number; w: number; h: number } {
  const rad = (s.rot * Math.PI) / 180
  const c = Math.abs(Math.cos(rad))
  const n = Math.abs(Math.sin(rad))
  const w = s.w * c + s.h * n
  const h = s.w * n + s.h * c
  return { x: s.x + s.w / 2 - w / 2, y: s.y + s.h / 2 - h / 2, w, h }
}

function boxDeviationPct(
  a: { x: number; y: number; w: number; h: number },
  b: { x: number; y: number; w: number; h: number },
): number {
  return (
    Math.max(
      Math.abs(a.x - b.x) / SLIDE_WIDTH_PX,
      Math.abs(a.w - b.w) / SLIDE_WIDTH_PX,
      Math.abs(a.y - b.y) / SLIDE_HEIGHT_PX,
      Math.abs(a.h - b.h) / SLIDE_HEIGHT_PX,
    ) * 100
  )
}

/**
 * Bounds that disagree with the layout box in a way a **uniform scale cannot explain** — which is to
 * say, the element is rotated (or skewed, or in 3D).
 *
 * Scaling W×H by k gives bounds kW×kH, so both ratios are k and the walker's `rot = 0` placement is
 * correct. Rotating by θ gives `W·c + H·s` by `W·s + H·c`, whose ratios differ unless W = H — so a
 * rotated *square* is the one case this cannot separate from a scale, and is left to the corpus's
 * declared rotations. Everything else, including the standalone `rotate:` property, shows up here
 * without the oracle parsing a line of CSS.
 */
function rotatedBoundsSignature(w: number, h: number, layoutW: number, layoutH: number): boolean {
  if (layoutW <= 0 || layoutH <= 0) return false
  if (
    Math.abs(w - layoutW) <= TRANSFORM_BOUNDS_TOLERANCE_PX &&
    Math.abs(h - layoutH) <= TRANSFORM_BOUNDS_TOLERANCE_PX
  )
    return false
  const ratioW = w / layoutW
  const ratioH = h / layoutH
  const spread = Math.abs(ratioW - ratioH) / Math.max(ratioW, ratioH)
  return spread > UNIFORM_SCALE_TOLERANCE
}

/** The §1.3(b) signature: emitted at the axis-aligned bounds of a transform, with no `rot` at all. */
function shippedUpright(shape: ReadbackShape, boundsW: number, boundsH: number): boolean {
  return (
    shape.rot === 0 &&
    Math.abs(shape.w - boundsW) <= TRANSFORM_BOUNDS_TOLERANCE_PX &&
    Math.abs(shape.h - boundsH) <= TRANSFORM_BOUNDS_TOLERANCE_PX
  )
}

/** The alpha a truth box's background actually paints at: its own alpha times inherited opacity. */
function boxAlpha(b: TruthBox): number {
  return b.bgAlpha * b.opacity
}

/** An emitted shape's axis-aligned bounds, after its own rotation. */
function shapeBounds(s: ReadbackShape): { x: number; y: number; w: number; h: number } {
  return s.rot === 0 ? s : rotatedBounds(s)
}

function samePlace(shape: ReadbackShape, box: TruthBox): boolean {
  return boxDeviationPct(shapeBounds(shape), box) <= BOX_TOLERANCE_PCT
}

/** True when `shape` lies inside `box` — how a non-uniform border arrives, as a rect per painted side. */
function insideBox(shape: ReadbackShape, box: TruthBox): boolean {
  const b = shapeBounds(shape)
  const padX = (BOX_TOLERANCE_PCT / 100) * SLIDE_WIDTH_PX
  const padY = (BOX_TOLERANCE_PCT / 100) * SLIDE_HEIGHT_PX
  return (
    b.x >= box.x - padX &&
    b.y >= box.y - padY &&
    b.x + b.w <= box.x + box.w + padX &&
    b.y + b.h <= box.y + box.h + padY
  )
}

/**
 * The emitted shape that carries a painted box, or `null` when nothing does. A background must be
 * matched by a shape of the same size *and* the same fill hex — position alone would pass a shape
 * that happens to sit there in another colour. A border-only box is carried either by an outline at
 * the same place or, when the border is not uniform on all four sides, by edge rects inside it.
 *
 * The pairing is a **bijection**: `used` is carried across the whole `truth.boxes` loop, so one
 * emitted shape cannot stand in for several painted boxes. Without it, a card and a full-bleed inner
 * overlay both `#FFFFFF` at the same rect both paired against the single shape that survived, and
 * dropping one of them left no trace (review r2).
 */
function carrierOf(
  shapes: readonly ReadbackShape[],
  box: TruthBox,
  bgVisible: boolean,
  used: ReadonlySet<ReadbackShape>,
): ReadbackShape | null {
  const free = shapes.filter((s) => s.kind === 'sp' && !used.has(s))
  if (bgVisible) return free.find((s) => s.fill === box.bg && samePlace(s, box)) ?? null
  return (
    free.find(
      (s) =>
        (s.line === box.borderColor && samePlace(s, box)) ||
        (s.fill === box.borderColor && insideBox(s, box)),
    ) ?? null
  )
}

function leafText(node: SlideNode): string {
  const text = node.style.textTransform === 'uppercase' ? node.text.toUpperCase() : node.text
  return normalizeWhitespace(text)
}

export function assessSlide(args: AssessArgs): SlideAssessment {
  const { corpus, truth, measure, readback, tier, score } = args
  const structured = tier === 'structured'

  // --- Text nodes, colour, size (non-SVG; SVG text is the M4.8c hybrid's problem) ---
  const texts = truth.texts.filter((t) => !t.inSvg)
  const lostText: string[] = []
  const colorWrong: string[] = []
  const sizeWrong: string[] = []
  const opacityWrong: string[] = []
  let textKept = 0
  let colorExact = 0
  let sizeExact = 0
  for (const t of texts) {
    const expected = expectedText(t)
    const holders = runsContaining(readback, expected)
    if (holders.length === 0) {
      lostText.push(expected)
      continue
    }
    textKept += 1
    const run = holders
      .flatMap((s) => s.runs)
      .find(
        (r) =>
          normalizeWhitespace(r.text).includes(expected) ||
          expected.includes(normalizeWhitespace(r.text)),
      )
    if (run?.color === t.color) colorExact += 1
    else colorWrong.push(`${expected}: ${String(run?.color)} ≠ ${t.color}`)
    const wantAlpha = t.opacity * t.colorAlpha
    if (
      wantAlpha < OPACITY_SIGNIFICANT &&
      Math.abs((run?.opacity ?? 1) - wantAlpha) > OPACITY_TOLERANCE
    )
      opacityWrong.push(
        `text "${expected}": alpha ${(run?.opacity ?? 1).toFixed(2)} ≠ ${wantAlpha.toFixed(2)}`,
      )
    // Glyphs render at `font-size × scale`; comparing against the authored size would call a
    // `scale(1.4)` stat exact while it ships 1.4× too small.
    const wantPt = pxToPoints(t.fontSizePx * t.renderedScale)
    if (
      run?.sizePt !== null &&
      run?.sizePt !== undefined &&
      Math.abs(run.sizePt - wantPt) <= SIZE_TOLERANCE_PT
    )
      sizeExact += 1
    else sizeWrong.push(`${expected}: ${String(run?.sizePt)}pt ≠ ${wantPt.toFixed(2)}pt`)
  }

  // --- Emitted box vs DOM box: pair every text shape with the leaf node that produced it ---
  const leaves = measure.nodes.filter((n) => n.isLeaf && n.text !== '')
  const used = new Set<SlideNode>()
  let boxChecks = 0
  let boxWorstPct = 0
  for (const shape of readback.shapes) {
    if (shape.kind !== 'sp' || shape.text === '') continue
    const node = leaves.find((n) => !used.has(n) && leafText(n) === shape.text)
    if (node === undefined) continue
    used.add(node)
    boxChecks += 1
    const emitted = shape.rot === 0 ? shape : rotatedBounds(shape)
    boxWorstPct = Math.max(boxWorstPct, boxDeviationPct(emitted, node))
  }

  // --- Painted boxes: every background/border a reader sees must be an emitted shape (M4.8a) ---
  const paintedLost: string[] = []
  const carried = new Set<ReadbackShape>()
  let paintedTotal = 0
  let paintedKept = 0
  for (const b of truth.boxes) {
    const bgVisible = b.bg !== null && boxAlpha(b) > INVISIBLE_ALPHA
    const borderVisible = b.borderPx > 0 && b.borderColor !== null && b.opacity > INVISIBLE_ALPHA
    if (!bgVisible && !borderVisible) {
      // A gradient with no solid colour under it: there is no fill hex the pure walk could emit.
      if (b.hasGradient && b.opacity > INVISIBLE_ALPHA) {
        paintedTotal += 1
        paintedLost.push(`box: ${b.tag} gradient ${b.w.toFixed(0)}×${b.h.toFixed(0)}`)
      }
      continue
    }
    paintedTotal += 1
    const carrier = carrierOf(readback.shapes, b, bgVisible, carried)
    if (carrier === null) {
      paintedLost.push(
        `box: ${b.tag} ${bgVisible ? `#${String(b.bg)}` : `border #${String(b.borderColor)}`} ${b.w.toFixed(0)}×${b.h.toFixed(0)}`,
      )
      continue
    }
    paintedKept += 1
    carried.add(carrier)
    const wantAlpha = bgVisible ? boxAlpha(b) : b.opacity
    if (
      wantAlpha < OPACITY_SIGNIFICANT &&
      Math.abs(carrier.fillOpacity - wantAlpha) > OPACITY_TOLERANCE
    )
      opacityWrong.push(
        `box ${b.tag}: alpha ${carrier.fillOpacity.toFixed(2)} ≠ ${wantAlpha.toFixed(2)}`,
      )
  }

  // --- Rotations ---
  const rotationDetails: string[] = []
  let rotationsOk = 0
  for (const expected of corpus.rotations) {
    const want = ((expected.deg % 360) + 360) % 360
    const holder = runsContaining(readback, normalizeWhitespace(expected.text))[0]
    if (holder === undefined) {
      rotationDetails.push(`${expected.text}: no shape carries it`)
      continue
    }
    const delta = angleDelta(holder.rot, want)
    if (delta <= ROTATION_TOLERANCE_DEG) rotationsOk += 1
    rotationDetails.push(
      `${expected.text}: rot=${holder.rot.toFixed(2)}° want ${want}° (Δ${delta.toFixed(2)}°)`,
    )
  }

  // --- Body gradient/image ---
  const bodyImageExpected = corpus.bodyImage || /gradient\(|url\(/i.test(truth.bodyBgImage)
  const bodyImagePreserved =
    !bodyImageExpected || readback.background === 'picture' || readback.fullBleedPictures > 0

  // --- Transforms no `rot` can express: the element ships upright, which is wrong, not plainer ---
  const flattened = new Set<string>()
  for (const t of texts)
    if (decomposeTransformSpec(t).kind === 'other') flattened.add(`text "${expectedText(t)}"`)
  for (const b of truth.boxes)
    if (decomposeTransformSpec(b).kind === 'other') flattened.add(`box ${b.tag}`)

  // --- Rotation, from geometry rather than from a corpus declaration. This is the check that does
  // not share the exporter's blindness: an element whose axis-aligned bounds disagree with its
  // layout box is transformed by SOMETHING, and the oracle never asks by what. Shipping it at those
  // bounds with rot = 0 is precisely research §1.3(b)'s signature — a 90° label in a 21 px-wide box.
  const rotationLost: string[] = []
  for (const t of texts) {
    // Already named as an un-decomposable transform: report each loss once.
    if (flattened.has(`text "${expectedText(t)}"`)) continue
    if (!rotatedBoundsSignature(t.hostW, t.hostH, t.hostLayoutW, t.hostLayoutH)) continue
    const holder = runsContaining(readback, expectedText(t))[0]
    if (holder === undefined) continue
    if (shippedUpright(holder, t.hostW, t.hostH))
      rotationLost.push(
        `text "${expectedText(t)}": ${t.hostLayoutW.toFixed(0)}×${t.hostLayoutH.toFixed(0)} renders as ${t.hostW.toFixed(0)}×${t.hostH.toFixed(0)} but ships upright at its bounds`,
      )
  }
  for (const b of truth.boxes) {
    if (flattened.has(`box ${b.tag}`)) continue
    if (!rotatedBoundsSignature(b.w, b.h, b.layoutW, b.layoutH)) continue
    const carrier = readback.shapes.find((sh) => sh.kind === 'sp' && shippedUpright(sh, b.w, b.h))
    if (carrier !== undefined)
      rotationLost.push(
        `box ${b.tag}: ${b.layoutW.toFixed(0)}×${b.layoutH.toFixed(0)} renders as ${b.w.toFixed(0)}×${b.h.toFixed(0)} but ships upright at its bounds`,
      )
  }

  // --- Text the browser cuts off but the file carries whole: PowerPoint has no clipping ---
  const truncatedShipped: string[] = []
  for (const t of texts) {
    if (!t.clipped) continue
    const expected = expectedText(t)
    if (runsContaining(readback, expected).length > 0) truncatedShipped.push(expected)
  }

  // --- Bullets: a `list-style: none` chip row must not arrive with invented glyphs ---
  const bulletsExpected = texts.filter((t) => t.bulleted).length
  const bulletsEmitted = readback.shapes.reduce((n, sh) => n + sh.bullets, 0)
  const bulletsInvented = Math.max(0, bulletsEmitted - bulletsExpected)

  // --- The closed-world signal, as the measurement pass reported it (see `properties.ts`) ---
  const unmodelledProperties = [
    ...new Set(measure.nodes.flatMap((n) => n.unmodelledProperties)),
  ].toSorted()

  const constructsLost: string[] = []
  if (structured) {
    for (const t of lostText) constructsLost.push(`text: ${t}`)
    constructsLost.push(...paintedLost)
    constructsLost.push(...opacityWrong.map((o) => `opacity: ${o}`))
    // Nothing can be emitted for a painting pseudo-element: it has no rect to measure. Its presence
    // must therefore keep the slide out of the structured tier, not pass as a clean 100.
    for (const ps of truth.pseudos) constructsLost.push(`pseudo: ${ps.hostTag}${ps.which}`)
    for (const f of flattened) constructsLost.push(`transform flattened: ${f}`)
    constructsLost.push(...rotationLost.map((r) => `rotation wrong: ${r}`))
    for (const t of truncatedShipped) constructsLost.push(`clipped text shipped in full: "${t}"`)
    if (bulletsInvented > 0)
      constructsLost.push(`${String(bulletsInvented)} invented bullet glyph(s)`)
    for (const p of unmodelledProperties) constructsLost.push(`un-modelled CSS: ${p}`)
    // §5.2 lists exact hex colour and exact font size as targets in their own right, so a run
    // shipped in the wrong colour is a lost construct too, not merely a separate assertion.
    constructsLost.push(...colorWrong.map((c) => `colour wrong: ${c}`))
    constructsLost.push(...sizeWrong.map((c) => `size wrong: ${c}`))
    if (rotationsOk < corpus.rotations.length)
      constructsLost.push(
        `rotation: ${String(corpus.rotations.length - rotationsOk)} of ${String(corpus.rotations.length)} dropped`,
      )
    if (!bodyImagePreserved) constructsLost.push('body gradient/image background')
  }

  return {
    file: corpus.file,
    tier,
    score,
    reasons: [...args.reasons],
    textTotal: texts.length,
    textKept: structured ? textKept : 0,
    lostText,
    colorExact,
    colorWrong,
    sizeExact,
    sizeWrong,
    boxChecks,
    boxWorstPct,
    paintedTotal,
    paintedKept,
    paintedLost,
    opacityWrong,
    pseudoTotal: truth.pseudos.length,
    truncatedShipped,
    bulletsInvented,
    rotationLost,
    unmodelledProperties,
    rotationsExpected: corpus.rotations.length,
    rotationsOk,
    rotationDetails,
    bodyImageExpected,
    bodyImagePreserved,
    constructsLost,
    silentLie: structured && score >= HIGH_CONFIDENCE && constructsLost.length > 0,
  }
}

export type CorpusSummary = {
  slides: number
  structured: number
  /** Over structured slides only, as §5.2 states the target. */
  textTotal: number
  textKept: number
  colorTotal: number
  colorExact: number
  sizeExact: number
  boxChecks: number
  boxWorstPct: number
  /** Over structured slides only, like the text row. */
  paintedTotal: number
  paintedKept: number
  /** Painting pseudo-elements in the corpus, over structured slides — each one is unrepresentable. */
  pseudoTotal: number
  rotationsExpected: number
  rotationsOk: number
  bodyImageSlides: number
  bodyImagePreserved: number
  silentLies: string[]
}

const sum = (xs: readonly SlideAssessment[], f: (a: SlideAssessment) => number): number =>
  xs.reduce((acc, a) => acc + f(a), 0)

export function summarize(assessments: readonly SlideAssessment[]): CorpusSummary {
  const structured = assessments.filter((a) => a.tier === 'structured')
  return {
    slides: assessments.length,
    structured: structured.length,
    textTotal: sum(structured, (a) => a.textTotal),
    textKept: sum(structured, (a) => a.textKept),
    colorTotal: sum(structured, (a) => a.textKept),
    colorExact: sum(structured, (a) => a.colorExact),
    sizeExact: sum(structured, (a) => a.sizeExact),
    boxChecks: sum(assessments, (a) => a.boxChecks),
    boxWorstPct: Math.max(0, ...assessments.map((a) => a.boxWorstPct)),
    paintedTotal: sum(structured, (a) => a.paintedTotal),
    paintedKept: sum(structured, (a) => a.paintedKept),
    pseudoTotal: sum(structured, (a) => a.pseudoTotal),
    rotationsExpected: sum(assessments, (a) => a.rotationsExpected),
    rotationsOk: sum(assessments, (a) => a.rotationsOk),
    bodyImageSlides: assessments.filter((a) => a.bodyImageExpected).length,
    bodyImagePreserved: assessments.filter((a) => a.bodyImageExpected && a.bodyImagePreserved)
      .length,
    silentLies: assessments.filter((a) => a.silentLie).map((a) => a.file),
  }
}

function pct(n: number, d: number): string {
  return d === 0 ? 'n/a' : `${((100 * n) / d).toFixed(1)}% (${String(n)}/${String(d)})`
}

/** The §5.2 table for one run, as Markdown. */
export function formatSummary(label: string, s: CorpusSummary): string {
  return [
    `| Target (${label}) | Value |`,
    '| --- | --- |',
    `| Text nodes preserved verbatim in structured slides | ${pct(s.textKept, s.textTotal)} |`,
    `| Exact hex colour on preserved runs | ${pct(s.colorExact, s.colorTotal)} |`,
    `| Exact font size (±${String(SIZE_TOLERANCE_PT)} pt) on preserved runs | ${pct(s.sizeExact, s.colorTotal)} |`,
    `| Emitted box vs DOM box, worst (% of slide dimension, ${String(s.boxChecks)} boxes) | ${s.boxWorstPct.toFixed(4)}% |`,
    `| Painted boxes (background/border) carried by an emitted shape | ${pct(s.paintedKept, s.paintedTotal)} |`,
    `| Painting \`::before\`/\`::after\` in structured slides (unrepresentable) | ${String(s.pseudoTotal)} |`,
    `| Rotated elements carrying a correct \`rot\` (±${String(ROTATION_TOLERANCE_DEG)}°) | ${String(s.rotationsOk)}/${String(s.rotationsExpected)} |`,
    `| Gradient/image body backgrounds preserved | ${String(s.bodyImagePreserved)}/${String(s.bodyImageSlides)} |`,
    `| Slides scoring ≥ ${String(HIGH_CONFIDENCE)} that drop a construct | ${String(s.silentLies.length)}/${String(s.slides)}${s.silentLies.length > 0 ? ` (${s.silentLies.join(', ')})` : ''} |`,
  ].join('\n')
}

/** Per-slide rows, as Markdown. */
export function formatSlides(assessments: readonly SlideAssessment[]): string {
  const rows = assessments.map((a) => {
    const lost = a.constructsLost.length === 0 ? '' : a.constructsLost.join('; ')
    return `| ${a.file} | ${a.tier} | ${String(a.score)} | ${a.tier === 'structured' ? `${String(a.textKept)}/${String(a.textTotal)}` : `raster (${String(a.textTotal)} in source)`} | ${a.tier === 'structured' ? `${String(a.paintedKept)}/${String(a.paintedTotal)}` : `raster (${String(a.paintedTotal)} in source)`} | ${String(a.rotationsOk)}/${String(a.rotationsExpected)} | ${a.bodyImageExpected ? (a.bodyImagePreserved ? 'kept' : 'LOST') : '—'} | ${a.boxWorstPct.toFixed(3)}% | ${a.silentLie ? '**YES**' : 'no'} | ${lost} |`
  })
  return [
    '| Slide | Tier | Score | Text kept | Boxes | Rot | Body bg | Box worst | Silent lie | Lost |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...rows,
  ].join('\n')
}
