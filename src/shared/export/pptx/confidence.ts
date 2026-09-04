/**
 * The confidence scorer and per-slide tier decision (M4.3 / 60-export.md §3.4). Pure and
 * table-driven, so every signal's deduction and every cap are asserted by unit tests. The raster
 * threshold is pinned by two fixtures whose *computed* scores straddle it — one at 72 (must stay
 * structured) and one at 63 (must route to raster) — so moving the threshold to 90 reds the first and
 * to 60 reds the second (`confidence.test.ts`), rather than the self-referential check a
 * threshold-vs-constant assertion would give.
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
 */

import type { MeasureResult, SlideNode } from './node'
import type { SlideTier } from './types'

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
   */
  elementImageBackground: 35,
  insetShadowEach: 12,
  insetShadowCap: 24,
  textShadow: 12,
  filter: 25,
  mixBlend: 20,
  clipPath: 20,
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
   * Text beside inline elements that no leaf owns (`<p>a <b>b</b> c</p>`) is dropped by the leaf-text
   * rule. Missing words are unreadable output, and a high score would suppress the raster fallback
   * that fixes it (M4.8a). M4.8b's run-level walk removes the loss and this deduction with it.
   */
  bareText: 35,
  /** `::before`/`::after` that paint: no rect can be measured for them, so nothing is emitted. */
  pseudoElement: 35,
  /** `overflow: hidden|clip` with a descendant outside the box: PowerPoint cannot clip it. */
  clippedOverflow: 35,
} as const

/** Weights whose construct is merely absent from the output. Each must be ≥ `DROPPED_CONSTRUCT_FLOOR`. */
export const DROPPED_CONSTRUCT_WEIGHTS = [
  'insetShadowEach',
  'textShadow',
  'filter',
  'mixBlend',
  'clipPath',
  'svgEach',
  'imageEach',
  'canvas',
] as const satisfies readonly (keyof typeof SCORE_WEIGHTS)[]

/** Weights whose construct would render wrong. Each must be ≥ `WRONG_CONSTRUCT_FLOOR`. */
export const WRONG_CONSTRUCT_WEIGHTS = [
  'elementImageBackground',
  'transformOther',
  'bareText',
  'pseudoElement',
  'clippedOverflow',
] as const satisfies readonly (keyof typeof SCORE_WEIGHTS)[]

/** The result of scoring one slide. `hardBlocker` non-null forces raster whatever the score. */
export type SlideScore = { score: number; reasons: string[]; hardBlocker: string | null }

/**
 * A conservative system-safe font list (§3.6). Families here map 1:1 into PowerPoint with no
 * substitution risk; anything else keeps its name but takes a confidence penalty and a report note.
 */
const SYSTEM_FONTS: ReadonlySet<string> = new Set(
  [
    'arial',
    'helvetica',
    'helvetica neue',
    'calibri',
    'cambria',
    'georgia',
    'times new roman',
    'times',
    'courier new',
    'courier',
    'verdana',
    'tahoma',
    'trebuchet ms',
    'segoe ui',
    'sans-serif',
    'serif',
    'monospace',
    'system-ui',
    '-apple-system',
    'ui-sans-serif',
    'ui-serif',
    'ui-monospace',
  ].map((f) => f.toLowerCase()),
)

/** The first family in a `font-family` list, unquoted and lower-cased. */
export function firstFontFamily(fontFamily: string): string {
  const first = fontFamily.split(',')[0] ?? ''
  return first
    .trim()
    .replace(/^["']|["']$/g, '')
    .toLowerCase()
}

/** True when the (first) family maps into PowerPoint without substitution risk. */
export function isSystemFont(fontFamily: string): boolean {
  return SYSTEM_FONTS.has(firstFontFamily(fontFamily))
}

/**
 * A computed `transform`, decomposed. `identity` covers `none` and pure translation (position is
 * already in the measured box). `similarity` is a rotation times a uniform scale — both modelled: the
 * angle becomes `rot`, the scale multiplies the layout box and the font size. `other` is skew, flip,
 * non-uniform scale or 3D: no single angle/size describes it, so it is scored as wrong.
 */
export type TransformDecomposition =
  { kind: 'identity' } | { kind: 'similarity'; deg: number; scale: number } | { kind: 'other' }

/**
 * Chromium serializes matrices to six decimals, so a real `rotate(28deg)` arrives as
 * `matrix(0.882948, 0.469472, -0.469472, 0.882948, 0, 0)` with a² + b² = 1.0000011. A 1e-6 tolerance
 * called that `other` and shipped the element upright in an axis-aligned box (review r1). 1e-4 admits
 * the rounding with two orders of margin and still rejects any authored skew or non-uniform scale.
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

/** True when a `background-image` is a gradient or `url()` — paint the pure walker has no pixels for. */
export function paintsImage(backgroundImage: string): boolean {
  return /gradient\(|url\(/i.test(backgroundImage)
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
  const { nodes, body } = measure
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

  // --- Element gradient/image backgrounds: no shape is emitted for them ---
  const imageBackgrounds = nodes.filter((n) => paintsImage(n.style.backgroundImage)).length
  if (imageBackgrounds > 0)
    deduct(
      SCORE_WEIGHTS.elementImageBackground,
      `${String(imageBackgrounds)} element gradient/image background(s) — no shape emitted`,
    )

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
    .flatMap((n) => [n.style.transform, ...n.ancestorTransforms])
    .map(decomposeTransform)
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
