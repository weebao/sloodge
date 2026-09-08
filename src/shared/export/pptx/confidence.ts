/**
 * The confidence scorer and per-slide tier decision (M4.3 / 60-export.md §3.4). Pure and
 * table-driven, so every signal's deduction and every cap are asserted by unit tests. The raster
 * threshold is pinned by two fixtures whose *computed* scores straddle it — one at 71 (must stay
 * structured) and one at 68 (must route to raster) — so moving the threshold to 90 reds the first and
 * to 60 reds the second (`confidence.test.ts`), rather than the self-referential check a
 * threshold-vs-constant assertion would give. `assess.ts`'s `BOX_TOLERANCE_PCT` is pinned the same
 * way, by two computed deviations that straddle it (`fidelity-assess.test.ts`).
 *
 * The score starts at 100 and loses points for features PowerPoint cannot represent. It is computed
 * from the measurement pass alone — no rendering comparison at decision time. Separately, a small set
 * of **hard blockers** force raster regardless of score (§3.4): a construct the structured walk cannot
 * even approximate without producing silently-wrong output, which is worse than an honest picture.
 *
 * ## Two floors for un-modelled constructs (M4.8a; research §5.1 item 4)
 *
 * A confidence of 100 with a construct missing is the failure this module exists to prevent, so a
 * weight is not a taste judgement — it has a floor set by what the construct's absence does:
 *
 * - **Dropped** (`DROPPED_CONSTRUCT_FLOOR`): the paint is simply absent and the rest of the slide is
 *   intact (an inset shadow, a text-shadow). One occurrence must take the slide out of the
 *   high-confidence band the fidelity harness trusts (`PPTX_HIGH_CONFIDENCE`).
 * - **Wrong** (`WRONG_CONSTRUCT_FLOOR`): the output would be misleading, not just plainer — text on
 *   the wrong colour because a panel's gradient vanished, a clipped blob spilling out of its card, a
 *   skewed ribbon drawn upright, a `li::before` bullet gone. One occurrence must cross the raster
 *   threshold on its own so `auto` ships an honest picture.
 *
 * `confidence.test.ts` asserts every weight against its floor; softening one reds a test.
 *
 * ## The world is closed (M4.8a; review r2)
 *
 * Every signal above is a named construct somebody thought to add — a deny-list, which two review
 * rounds showed cannot converge: whatever is not on it scores 100. `unmodelledProperty` inverts the
 * default. The measurement pass censuses every computed longhand against `properties.ts`'s explicit
 * modelled set, and a property in neither set costs a WRONG-class deduction *and is named in the
 * reasons*. A slide reaches the structured tier only when the pipeline can account for everything
 * the oracle can see; an unfamiliar property fails toward an honest picture.
 *
 * The census covers `<html>` and `<body>` alongside the nodes (review r3), and `rootPaint` scores
 * the four properties on those two elements that recomposite everything beneath them. They are a
 * WRONG-class weight rather than the per-element `filter`/`mixBlend` ones for a specific reason:
 * on an element the effect is missing, on a root element every colour in the file is the wrong one.
 */

import type { MeasureResult, RootPaint, SlideNode, TransformSpec } from './node'
import { SLIDE_HEIGHT_PX, SLIDE_WIDTH_PX } from '../types'
import type { SlideTier } from './types'
import { isSystemFont } from '../../fonts/system-fonts'

/** At or above this score, an `auto` slide is converted structurally; below it, rasterized. */
export const PPTX_TIER_THRESHOLD = 70

/** At or above this score the output is trusted as-is; a lost construct here is a silent lie (§5.2). */
export const PPTX_HIGH_CONFIDENCE = 90

/** Smallest deduction that takes a 100 out of the high-confidence band. */
export const DROPPED_CONSTRUCT_FLOOR = 100 - PPTX_HIGH_CONFIDENCE + 1
/** Smallest deduction that routes a 100 to raster in `auto` by itself. */
export const WRONG_CONSTRUCT_FLOOR = 100 - PPTX_TIER_THRESHOLD + 1

/** Per-signal deduction caps and weights, kept beside the threshold rather than as scattered magic. */
export const SCORE_WEIGHTS = {
  /**
   * A gradient/`url()` background on an element (not the body): the pure walk has no pixels for it
   * and emits no shape, so text that sat on the panel lands on the slide colour. Wrong, not plainer —
   * until M4.8c captures the region.
   *
   * The weight is the **ceiling** of an area-scaled deduction, not a flat charge (review r2). Flat,
   * it fired identically for a full-bleed panel and for a 120×40 decorative pill, so one pill
   * rasterized a slide whose title and three paragraphs were perfectly editable. See
   * `elementImageDeduction`.
   */
  elementImageBackground: 35,
  insetShadowEach: 12,
  insetShadowCap: 24,
  textShadow: 12,
  filter: 25,
  mixBlend: 20,
  /**
   * A clipped element is not dropped, it is emitted as its full unclipped shape — PowerPoint gets a
   * pink SQUARE where the reader sees a circle. That is wrong output, not plainer output, so it sits
   * in `WRONG_CONSTRUCT_WEIGHTS` and crosses the raster threshold on its own (review r2).
   */
  clipPath: 35,
  /** Rotation and uniform scale are modelled (`rot`, scaled box and font size); still a reflow risk. */
  transformSimilarity: 5,
  /** Skew, flip, non-uniform scale, 3D: flattened to an upright axis-aligned box. Wrong. */
  transformOther: 35,
  svgEach: 18,
  svgCap: 40,
  imageEach: 18,
  imageCap: 40,
  canvas: 18,
  nonSystemFont: 10,
  overlapEach: 10,
  overlapCap: 30,
  nodeExplosion: 15,
  nodeExplosionThreshold: 120,
  /** The body paints a gradient/image: representable only as a full-bleed picture (M4.8a). */
  bodyImageBackground: 5,
  /**
   * A filter, backdrop-filter, blend mode or clip on `<html>`/`<body>` (M4.8a, review r3). On one
   * element such a paint costs `filter`/`mixBlend`, which are dropped-class: the effect is missing
   * and the rest is intact. On a root element it recomposites the whole slide, so *every* colour
   * the file carries is wrong — `body { filter: invert(1) }` emitted `#E2E8F0` for a panel the
   * reader sees at `rgb(29,23,15)`. Wrong output, not plainer output.
   */
  rootPaint: 35,
  /**
   * Text beside inline elements that no leaf owns (`<p>a <b>b</b> c</p>`) is dropped by the leaf-text
   * rule. Missing words are unreadable output, and a high score would suppress the raster fallback
   * that fixes it (M4.8a). M4.8b's run-level walk removes the loss and this deduction with it.
   */
  bareText: 35,
  /** `::before`/`::after` that paint: no rect can be measured for them, so nothing is emitted. */
  pseudoElement: 35,
  /** `overflow: hidden|clip` with a descendant outside the box: PowerPoint cannot clip it. */
  clippedOverflow: 35,
  /**
   * A leaf whose own text its own `overflow` cuts off — the `text-overflow: ellipsis` headline, the
   * fixed-height tile showing three lines of six. PowerPoint has no clipping, so the *whole* string
   * ships: the reader's truncated headline arrives at full length and the tile spills over the
   * footer. A content difference visible on the Chromium side, not merely a reflow risk (review r2).
   */
  clippedText: 35,
  /**
   * The closed-world signal: a computed property set to a non-initial value that `properties.ts`
   * claims neither to emit nor to score. Nobody knows what it does to the output, so the honest
   * outcome is a picture — an unfamiliar property must fail toward raster, never toward a confident
   * 100. Promoting one out of this bucket is a deliberate edit to `MODELLED_PROPERTIES`.
   */
  unmodelledProperty: 35,
} as const

/**
 * The share of the slide a gradient must cover for `elementImageBackground` to reach its ceiling.
 * Below it the deduction scales linearly from `DROPPED_CONSTRUCT_FLOOR`, so a decorative pill costs
 * a few points and a hero panel rasterizes. `WRONG_CONSTRUCT_FLOOR` is crossed at ~8.3 % of the
 * slide — about 350×220 px, a panel rather than a badge.
 */
const ELEMENT_IMAGE_SATURATION_FRACTION = 0.1

/** Below this many clipped pixels, a leaf's `scrollHeight` excess is line-box rounding, not truncation. */
export const CLIPPED_TEXT_MIN_PX = 2

const SLIDE_AREA_PX = SLIDE_WIDTH_PX * SLIDE_HEIGHT_PX

/**
 * The deduction for element gradient/image backgrounds covering `area` px² in total. Area-aware
 * because `coveredFraction` already knew 97.5 % of a pill-decorated slide was representable while a
 * flat 35 rasterized it anyway (review r2).
 */
export function elementImageDeduction(area: number): number {
  if (area <= 0) return 0
  const reach = Math.min(1, area / SLIDE_AREA_PX / ELEMENT_IMAGE_SATURATION_FRACTION)
  const span = SCORE_WEIGHTS.elementImageBackground - DROPPED_CONSTRUCT_FLOOR
  return Math.round(DROPPED_CONSTRUCT_FLOOR + span * reach)
}

/** Weights whose construct is merely absent from the output. Each must be ≥ `DROPPED_CONSTRUCT_FLOOR`. */
export const DROPPED_CONSTRUCT_WEIGHTS = [
  'insetShadowEach',
  'textShadow',
  'filter',
  'mixBlend',
  'svgEach',
  'imageEach',
  'canvas',
] as const satisfies readonly (keyof typeof SCORE_WEIGHTS)[]

/** Weights whose construct would render wrong. Each must be ≥ `WRONG_CONSTRUCT_FLOOR`. */
export const WRONG_CONSTRUCT_WEIGHTS = [
  'elementImageBackground',
  'clipPath',
  'transformOther',
  'bareText',
  'pseudoElement',
  'clippedOverflow',
  'clippedText',
  'unmodelledProperty',
  'rootPaint',
] as const satisfies readonly (keyof typeof SCORE_WEIGHTS)[]

/** The result of scoring one slide. `hardBlocker` non-null forces raster whatever the score. */
export type SlideScore = { score: number; reasons: string[]; hardBlocker: string | null }

/**
 * A computed `transform`, decomposed. `identity` covers `none` and pure translation (position is
 * already in the measured box). `similarity` is a rotation times a uniform scale — both modelled: the
 * angle becomes `rot`, the scale multiplies the layout box and the font size. `other` is skew, flip,
 * non-uniform scale or 3D: no single angle/size describes it, so it is scored as wrong.
 */
export type TransformDecomposition =
  { kind: 'identity' } | { kind: 'similarity'; deg: number; scale: number } | { kind: 'other' }

/**
 * The slack on "is this matrix a rotation times a uniform scale", tested as `a = d` and `b = −c`.
 *
 * Chromium's own rotations never need it: it writes `a` and `d` from the same rounded cosine and
 * `b`/`c` from the same rounded sine, so `|a − d|` and `|b + c|` are **exactly** 0 across a full turn
 * (verified over a 3601-step sweep, and pinned below). The tolerance exists for a hand-authored
 * `matrix()` whose values were typed to fewer digits; 1e-4 corresponds to a skew of 0.006°, far below
 * anything visible, and still rejects any real skew or non-uniform scale.
 *
 * What review r1 actually hit was a different test entirely — an orthonormality check, `|a² + b² − 1|
 * < 1e-6`, which a serialized `rotate(28deg)` fails at 1.1e-6. Modelling the scale removed that check
 * rather than loosening it: a matrix is a similarity because `a = d` and `b = −c`, whatever its
 * magnitude.
 */
export const MATRIX_TOLERANCE = 1e-4
/** Below this, a decomposed angle is layout noise, not a rotation. */
export const ROTATION_EPSILON_DEG = 0.01

const IDENTITY: TransformDecomposition = { kind: 'identity' }
const OTHER: TransformDecomposition = { kind: 'other' }

export function decomposeTransform(transform: string): TransformDecomposition {
  const t = transform.trim().toLowerCase()
  if (t === '' || t === 'none') return IDENTITY
  const m = /^matrix\(([^)]+)\)$/.exec(t)
  if (m === null) return OTHER
  const parts = (m[1] ?? '').split(',').map((p) => parseFloat(p.trim()))
  if (parts.length !== 6 || parts.some((n) => !Number.isFinite(n))) return OTHER
  const [a, b, c, d] = parts as [number, number, number, number, number, number]
  // `matrix(a, b, c, d)` is the column-major [[a, c], [b, d]]; a = d and b = −c makes it exactly
  // k·[[cos, −sin], [sin, cos]] with k = √(a² + b²) — a rotation by atan2(b, a) scaled by k.
  if (Math.abs(a - d) > MATRIX_TOLERANCE || Math.abs(b + c) > MATRIX_TOLERANCE) return OTHER
  const scale = Math.hypot(a, b)
  if (scale < MATRIX_TOLERANCE) return OTHER
  const deg = (Math.atan2(b, a) * 180) / Math.PI
  if (Math.abs(deg) < ROTATION_EPSILON_DEG && Math.abs(scale - 1) < MATRIX_TOLERANCE)
    return IDENTITY
  return { kind: 'similarity', deg, scale }
}

/**
 * CSS's standalone `rotate:`. `none` is identity; a bare `<angle>`, `z <angle>` or the `0 0 1
 * <angle>` axis form is a plane rotation. Any other axis is a 3D rotation with no `rot` equivalent.
 */
function decomposeRotateProperty(value: string): TransformDecomposition {
  const t = value.trim().toLowerCase()
  if (t === '' || t === 'none') return IDENTITY
  const m = /^(?:z\s+|0\s+0\s+1\s+)?(-?\d+(?:\.\d+)?)deg$/.exec(t)
  if (m === null) return OTHER
  const deg = parseFloat(m[1] ?? '')
  if (!Number.isFinite(deg)) return OTHER
  return Math.abs(deg) < ROTATION_EPSILON_DEG ? IDENTITY : { kind: 'similarity', deg, scale: 1 }
}

/**
 * CSS's standalone `scale:`. Uniform in the plane is modelled (the box and font size multiply);
 * anything anisotropic or mirrored has no single size to emit, exactly like `transform: scale(2, 1)`.
 */
function decomposeScaleProperty(value: string): TransformDecomposition {
  const t = value.trim().toLowerCase()
  if (t === '' || t === 'none') return IDENTITY
  const parts = t.split(/\s+/).map((p) => parseFloat(p) * (p.endsWith('%') ? 0.01 : 1))
  if (parts.length < 1 || parts.length > 3 || parts.some((n) => !Number.isFinite(n))) return OTHER
  const [sx, sy = sx, sz = 1] = parts as [number, number?, number?]
  if (
    sx <= 0 ||
    sy <= 0 ||
    Math.abs(sx - sy) > MATRIX_TOLERANCE ||
    Math.abs(sz - 1) > MATRIX_TOLERANCE
  )
    return OTHER
  return Math.abs(sx - 1) < MATRIX_TOLERANCE ? IDENTITY : { kind: 'similarity', deg: 0, scale: sx }
}

/**
 * Total rotation and uniform scale of one element's four transform properties, composed in the order
 * CSS Transforms Level 2 mandates — `translate`, then `rotate`, then `scale`, then `transform`.
 * (Similarities commute, so the order does not change the angle or the scale; it is followed anyway
 * because the *classification* must be order-independent for the right reason, not by luck.)
 *
 * `translate` is always identity here: the measured `getBoundingClientRect` is post-transform, so a
 * translation is already in the box the walker is handed.
 *
 * Reading `transform` alone reported `none` for an element rotated with the standalone `rotate:`
 * property, which then shipped upright at `rot=0` in its axis-aligned bounding box — research
 * §1.3(b) reached through the modern syntax (review r2).
 */
export function decomposeTransformSpec(spec: TransformSpec): TransformDecomposition {
  let deg = 0
  let scale = 1
  const parts: TransformDecomposition[] = [
    decomposeRotateProperty(spec.rotate),
    decomposeScaleProperty(spec.scale),
    decomposeTransform(spec.transform),
  ]
  for (const part of parts) {
    if (part.kind === 'other') return OTHER
    if (part.kind === 'similarity') {
      deg += part.deg
      scale *= part.scale
    }
  }
  if (Math.abs(deg) < ROTATION_EPSILON_DEG && Math.abs(scale - 1) < MATRIX_TOLERANCE)
    return IDENTITY
  return { kind: 'similarity', deg, scale }
}

/** True when a `background-image` is a gradient or `url()` — paint the pure walker has no pixels for. */
export function paintsImage(backgroundImage: string): boolean {
  return /gradient\(|url\(/i.test(backgroundImage)
}

/**
 * The paint operations on a root element that recomposite everything painted beneath them, named.
 * Empty for a root that only carries a colour or a background image — those *are* modelled, as the
 * slide fill and as `bodyImageBackground`'s full-bleed picture.
 *
 * Deliberately **not** exported: `assess.ts` computes the same list from the oracle's own recording
 * with its own four lines. Sharing this function would mean one narrowing edit blinds the exporter
 * and the independent check together, which is the exact failure r3 found here.
 */
function rootPaintOperations(paint: RootPaint): string[] {
  const ops: string[] = []
  if (isPresent(paint.filter)) ops.push(`filter: ${paint.filter}`)
  if (isPresent(paint.backdropFilter)) ops.push(`backdrop-filter: ${paint.backdropFilter}`)
  if (isPresent(paint.mixBlendMode) && paint.mixBlendMode !== 'normal')
    ops.push(`mix-blend-mode: ${paint.mixBlendMode}`)
  if (isPresent(paint.clipPath)) ops.push(`clip-path: ${paint.clipPath}`)
  return ops
}

/** Intersection-over-union of two px boxes; 0 when they do not overlap. */
function iou(a: SlideNode, b: SlideNode): number {
  const ix = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x))
  const iy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y))
  const inter = ix * iy
  if (inter <= 0) return 0
  const union = a.w * a.h + b.w * b.h - inter
  return union > 0 ? inter / union : 0
}

/** True when `n`'s centre lies within `box` — "the reader sees this run on that paint". */
function centreInside(n: SlideNode, box: SlideNode): boolean {
  const cx = n.x + n.w / 2
  const cy = n.y + n.h / 2
  return cx >= box.x && cx <= box.x + box.w && cy >= box.y && cy <= box.y + box.h
}

const isInsetShadow = (shadow: string): boolean => shadow !== 'none' && /inset/i.test(shadow)
const isPresent = (v: string): boolean => v !== '' && v !== 'none'
const sum = (nodes: readonly SlideNode[], f: (n: SlideNode) => number): number =>
  nodes.reduce((acc, n) => acc + f(n), 0)

/**
 * Score a slide from its measurement pass — the nodes *and* the body. Deductions are grouped by signal
 * and capped per §3.4, so no single feature can drive the score arbitrarily negative and the reasons
 * list stays legible. Takes the whole `MeasureResult` (M4.8a) because a body gradient was invisible
 * to a nodes-only scorer by construction and a gradient slide scored 100 while rendering white.
 */
export function scoreSlide(measure: MeasureResult): SlideScore {
  const { nodes, body, root } = measure
  const roots = [
    { where: 'html', paint: root },
    { where: 'body', paint: body },
  ]
  const reasons: string[] = []
  let score = 100
  const deduct = (amount: number, reason: string): void => {
    if (amount <= 0) return
    score -= amount
    reasons.push(reason)
  }

  // --- Hard blockers: any one forces raster regardless of score. First wins. ---
  let hardBlocker: string | null = null
  for (const n of nodes) {
    if (hardBlocker !== null) break
    if (n.style.writingMode.startsWith('vertical')) hardBlocker = 'vertical writing-mode'
    else if (n.style.position === 'sticky') hardBlocker = 'position: sticky'
  }

  // --- Element gradient/image backgrounds: no shape is emitted for them, scaled by how much of
  // the slide they cover, so a hero panel rasterizes and a decorative pill costs a few points.
  // Unless a text run sits on one: then the run lands on the bare slide colour instead, which is
  // the condition that makes the missing paint WRONG rather than plainer, and the area scaling is
  // floored at the wrong-class floor however small the panel is (review r3) ---
  const gradients = nodes.filter((n) => paintsImage(n.style.backgroundImage))
  const gradientArea = sum(gradients, (n) => Math.max(0, n.w) * Math.max(0, n.h))
  if (gradients.length > 0) {
    const textOnGradient = nodes.some(
      (n) => n.isLeaf && n.text !== '' && gradients.some((g) => centreInside(n, g)),
    )
    const area = ((100 * gradientArea) / SLIDE_AREA_PX).toFixed(1)
    deduct(
      textOnGradient
        ? Math.max(elementImageDeduction(gradientArea), WRONG_CONSTRUCT_FLOOR)
        : elementImageDeduction(gradientArea),
      `${String(gradients.length)} element gradient/image background(s) over ${area}% of the slide — no shape emitted${textOnGradient ? ', with text sitting on it' : ''}`,
    )
  }

  // --- Inset shadows (outer ones are emitted as PowerPoint shadows) ---
  const shadows = nodes.filter((n) => isInsetShadow(n.style.boxShadow)).length
  deduct(
    Math.min(shadows * SCORE_WEIGHTS.insetShadowEach, SCORE_WEIGHTS.insetShadowCap),
    `${String(shadows)} inset shadow(s)`,
  )

  // --- Text shadows: no run-level equivalent emitted ---
  if (nodes.some((n) => n.isLeaf && n.text !== '' && isPresent(n.style.textShadow)))
    deduct(SCORE_WEIGHTS.textShadow, 'text-shadow')

  // --- Filters (no OOXML equivalent at all) ---
  if (nodes.some((n) => isPresent(n.style.filter) || isPresent(n.style.backdropFilter)))
    deduct(SCORE_WEIGHTS.filter, 'CSS filter / backdrop-filter')

  // --- Blend modes ---
  if (nodes.some((n) => isPresent(n.style.mixBlendMode) && n.style.mixBlendMode !== 'normal'))
    deduct(SCORE_WEIGHTS.mixBlend, 'mix-blend-mode')

  // --- Clip paths ---
  if (nodes.some((n) => isPresent(n.style.clipPath))) deduct(SCORE_WEIGHTS.clipPath, 'clip-path')

  // --- Transforms, own and inherited: rotation/uniform scale are modelled, the rest flatten ---
  const transforms = nodes
    .flatMap((n) => [n.style, ...n.ancestorTransforms])
    .map(decomposeTransformSpec)
  if (transforms.some((t) => t.kind === 'other'))
    deduct(SCORE_WEIGHTS.transformOther, 'skew/flip/3D transform — flattened to an upright box')
  else if (transforms.some((t) => t.kind === 'similarity'))
    deduct(SCORE_WEIGHTS.transformSimilarity, 'rotation/scale transform')

  // --- SVG with more than one primitive → forced rasterization ---
  const svgHits = nodes.filter((n) => n.tag === 'svg' && n.svgPrimitiveCount > 1).length
  deduct(
    Math.min(svgHits * SCORE_WEIGHTS.svgEach, SCORE_WEIGHTS.svgCap),
    `${String(svgHits)} multi-primitive SVG(s)`,
  )

  // --- Images: the structured path cannot embed <img> bytes, so they are a coverage gap ---
  const images = nodes.filter((n) => n.tag === 'img' && n.src !== null).length
  deduct(
    Math.min(images * SCORE_WEIGHTS.imageEach, SCORE_WEIGHTS.imageCap),
    `${String(images)} image(s) not embeddable structurally`,
  )

  // --- Canvas ---
  const canvases = nodes.filter((n) => n.tag === 'canvas').length
  if (canvases > 0) deduct(SCORE_WEIGHTS.canvas, `${String(canvases)} <canvas>`)

  // --- Non-system fonts on text nodes ---
  if (nodes.some((n) => n.isLeaf && n.text !== '' && !isSystemFont(n.style.fontFamily)))
    deduct(SCORE_WEIGHTS.nonSystemFont, 'non-system font (substitution risk)')

  // --- Overlapping text boxes (usually an effect we did not model) ---
  const textNodes = nodes.filter((n) => n.isLeaf && n.text !== '')
  let overlaps = 0
  for (let i = 0; i < textNodes.length; i += 1) {
    for (let j = i + 1; j < textNodes.length; j += 1) {
      const a = textNodes[i]
      const b = textNodes[j]
      if (a !== undefined && b !== undefined && iou(a, b) > 0.15) overlaps += 1
    }
  }
  deduct(
    Math.min(overlaps * SCORE_WEIGHTS.overlapEach, SCORE_WEIGHTS.overlapCap),
    `${String(overlaps)} overlapping text box(es)`,
  )

  // --- Shape explosion ---
  if (nodes.length > SCORE_WEIGHTS.nodeExplosionThreshold)
    deduct(SCORE_WEIGHTS.nodeExplosion, `${String(nodes.length)} nodes (shape explosion)`)

  // --- Body gradient/image: emitted as a full-bleed picture, not editable paint ---
  if (paintsImage(body.backgroundImage))
    deduct(SCORE_WEIGHTS.bodyImageBackground, 'body gradient/image background (full-bleed picture)')

  // --- Root paint: a filter/blend/clip on <html> or <body> recomposites everything under it, so
  // every colour the file carries is wrong rather than merely plainer (review r3) ---
  const rootOps = roots.flatMap(({ where, paint }) =>
    rootPaintOperations(paint).map((op) => `${where} ${op}`),
  )
  if (rootOps.length > 0)
    deduct(SCORE_WEIGHTS.rootPaint, `${rootOps.join(', ')} — recolours the whole slide`)

  // --- Text no leaf owns: dropped by the leaf-text rule, so the slide would lose words ---
  const bare = sum(nodes, (n) => n.bareTextCount)
  if (bare > 0)
    deduct(
      SCORE_WEIGHTS.bareText,
      `${String(bare)} text fragment(s) beside inline elements dropped`,
    )

  // --- Painting pseudo-elements: unmeasurable, so nothing is emitted for them ---
  const pseudos = sum(nodes, (n) => n.paintedPseudoCount)
  if (pseudos > 0)
    deduct(SCORE_WEIGHTS.pseudoElement, `${String(pseudos)} painting ::before/::after dropped`)

  // --- Clipped overflow: PowerPoint cannot clip, so the escaping descendants would spill out ---
  const escaping = sum(nodes, (n) => n.escapingDescendants)
  if (escaping > 0)
    deduct(
      SCORE_WEIGHTS.clippedOverflow,
      `${String(escaping)} element(s) clipped by overflow would spill out`,
    )

  // --- Text a leaf's own overflow truncates: PowerPoint ships the whole string instead ---
  const truncated = nodes.filter((n) => n.clippedTextPx >= CLIPPED_TEXT_MIN_PX)
  if (truncated.length > 0)
    deduct(
      SCORE_WEIGHTS.clippedText,
      `${String(truncated.length)} text box(es) truncated on screen would ship in full`,
    )

  // --- The closed world: any property nobody claims to emit or score (see `properties.ts`).
  // The two root elements are censused alongside the nodes; they are outside `querySelectorAll`,
  // which is how a whole class of paint sat outside the quantifier for two rounds (r3) ---
  const unmodelled = [
    ...new Set([
      ...nodes.flatMap((n) => n.unmodelledProperties),
      ...roots.flatMap(({ paint }) => paint.unmodelledProperties),
    ]),
  ].toSorted()
  if (unmodelled.length > 0)
    deduct(SCORE_WEIGHTS.unmodelledProperty, `un-modelled CSS: ${unmodelled.join(', ')}`)

  return { score: Math.max(0, Math.min(100, score)), reasons, hardBlocker }
}

/**
 * The per-slide tier decision. `raster` forces a picture; `editable` forces shapes below threshold
 * (the report still lists the risks); `auto` uses the score, but a hard blocker overrides `auto` and
 * `editable` alike — a construct that would render silently wrong is never shipped as "editable".
 */
export function chooseTier(
  score: number,
  fidelity: 'auto' | 'editable' | 'raster',
  hardBlocker: string | null,
): SlideTier {
  if (fidelity === 'raster') return 'raster'
  if (hardBlocker !== null) return 'raster'
  if (fidelity === 'editable') return 'structured'
  return score >= PPTX_TIER_THRESHOLD ? 'structured' : 'raster'
}
