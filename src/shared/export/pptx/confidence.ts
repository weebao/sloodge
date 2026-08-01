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
 */

import type { SlideNode } from './node'
import type { SlideTier } from './types'

/** At or above this score, an `auto` slide is converted structurally; below it, rasterized. */
export const PPTX_TIER_THRESHOLD = 70

/** Per-signal deduction caps and weights, kept beside the threshold rather than as scattered magic. */
export const SCORE_WEIGHTS = {
  gradientEach: 12,
  gradientCap: 25,
  insetShadowEach: 8,
  insetShadowCap: 20,
  filter: 25,
  mixBlend: 20,
  clipPath: 20,
  transformRotate: 5,
  transformOther: 15,
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
} as const

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
 * Classify a computed `transform` (a `matrix(...)`/`matrix3d(...)` or a keyword). `translate` and
 * `none` are free (pure position, already captured by the measured box); a pure rotation maps to a
 * shape's `rotate` cheaply; skew/3D/scale is `other` — unrepresentable, the heavier penalty.
 */
export function classifyTransform(transform: string): 'none' | 'translate' | 'rotate' | 'other' {
  const t = transform.trim().toLowerCase()
  if (t === '' || t === 'none') return 'none'
  if (t.startsWith('matrix3d')) return 'other'
  const m = /^matrix\(([^)]+)\)$/.exec(t)
  if (m) {
    const parts = (m[1] ?? '').split(',').map((p) => parseFloat(p.trim()))
    if (parts.length !== 6 || parts.some((n) => !Number.isFinite(n))) return 'other'
    const [a, b, c, d] = parts as [number, number, number, number, number, number]
    // Identity linear part → pure translate.
    if (a === 1 && b === 0 && c === 0 && d === 1) return 'translate'
    // Pure rotation: columns orthonormal and det ≈ 1 (a=d, b=-c, a²+b²≈1).
    const det = a * d - b * c
    const nearlyRotation =
      Math.abs(a - d) < 1e-6 &&
      Math.abs(b + c) < 1e-6 &&
      Math.abs(a * a + b * b - 1) < 1e-6 &&
      Math.abs(det - 1) < 1e-6
    return nearlyRotation ? 'rotate' : 'other'
  }
  return 'other'
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

const isGradient = (bgImage: string): boolean => /gradient\(/i.test(bgImage)
const isComplexShadow = (shadow: string): boolean => shadow !== 'none' && /inset/i.test(shadow)
const isPresent = (v: string): boolean => v !== '' && v !== 'none'

/**
 * Score a slide from its measured nodes. Deductions are grouped by signal and capped per §3.4, so no
 * single feature can drive the score arbitrarily negative and the reasons list stays legible.
 */
export function scoreSlide(nodes: readonly SlideNode[]): SlideScore {
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

  // --- Gradients (painting backgrounds) ---
  const gradients = nodes.filter((n) => isGradient(n.style.backgroundImage)).length
  deduct(
    Math.min(gradients * SCORE_WEIGHTS.gradientEach, SCORE_WEIGHTS.gradientCap),
    `${String(gradients)} gradient background(s)`,
  )

  // --- Inset / complex shadows ---
  const shadows = nodes.filter((n) => isComplexShadow(n.style.boxShadow)).length
  deduct(
    Math.min(shadows * SCORE_WEIGHTS.insetShadowEach, SCORE_WEIGHTS.insetShadowCap),
    `${String(shadows)} complex shadow(s)`,
  )

  // --- Filters (no OOXML equivalent at all) ---
  if (nodes.some((n) => isPresent(n.style.filter) || isPresent(n.style.backdropFilter)))
    deduct(SCORE_WEIGHTS.filter, 'CSS filter / backdrop-filter')

  // --- Blend modes ---
  if (nodes.some((n) => isPresent(n.style.mixBlendMode) && n.style.mixBlendMode !== 'normal'))
    deduct(SCORE_WEIGHTS.mixBlend, 'mix-blend-mode')

  // --- Clip paths ---
  if (nodes.some((n) => isPresent(n.style.clipPath))) deduct(SCORE_WEIGHTS.clipPath, 'clip-path')

  // --- Transforms: rotation is cheap, skew/3D/scale is not ---
  const transforms = nodes.map((n) => classifyTransform(n.style.transform))
  if (transforms.some((t) => t === 'other'))
    deduct(SCORE_WEIGHTS.transformOther, 'skew/scale/3D transform')
  else if (transforms.some((t) => t === 'rotate'))
    deduct(SCORE_WEIGHTS.transformRotate, 'rotation transform')

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
