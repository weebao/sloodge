/**
 * The structured DOM→PPTX walker (M4.3 / 60-export.md §3.2–§3.3). Pure: it maps a measured
 * `SlideNode[]` to a `ShapeSpec[]` the pptxgenjs writer emits, with no browser, no `electron`, and no
 * pptxgenjs — so the load-bearing mapping (which contract element becomes which PowerPoint object,
 * with what position, size and style) is unit-tested directly.
 *
 * ## The two structural rules (§3.2)
 *
 * - **Leaf-text rule.** Only elements with no element children contribute text. This prevents the
 *   classic double-render bug where a heading is emitted once for the `<h1>` and again for a nested
 *   `<span>`. (Its cost — text beside inline elements is dropped — is scored by `confidence.ts` until
 *   M4.8b replaces it with a run-level walk.)
 * - **Container-paint rule.** A non-leaf element contributes a shape *only* if it paints something
 *   itself — a non-transparent background or a visible border. Pure layout wrappers (flex/grid with no
 *   paint) are skipped; PowerPoint has no concept of them.
 *
 * Emission order is `(zIndex, domIndex)` ascending, approximating paint order.
 *
 * ## Rotation (M4.8a)
 *
 * `getBoundingClientRect` returns the axis-aligned bounds of a transformed element, so placing a
 * rotated element at its measured rect gave a 90° label a 21 px-wide box and no `rot`. The walker
 * now decomposes the angle out of the computed matrix (own transform plus transformed ancestors) and
 * hands PowerPoint the **unrotated** box: the bounds of a rectangle rotated about its centre are
 * symmetric about that centre, so the centre is exact for any composition of rotations and
 * translations, and the size is the layout box (`offsetWidth`/`offsetHeight`) rather than an
 * inversion of the bounds, which is singular at 45°.
 *
 * ## Honesty about coverage
 *
 * `<img>`, `<svg>`, and `<canvas>` cannot be turned into editable shapes without their pixel data,
 * which the structured (pure) path does not have. Rather than silently drop them, the walker reports
 * `coveredFraction` — the share of visible content area it actually emitted a shape for — and the
 * confidence scorer penalizes those same nodes, so a media-heavy slide routes to an honest raster
 * instead of a structured slide with holes in it.
 */

import { boxToInches, pxToPoints } from './geometry'
import { alphaToTransparency, parseCssColor } from './color'
import { firstFontFamily, paintsImage, rotationDegrees } from './confidence'
import type { SlideNode, MeasureResult } from './node'
import type { FillSpec, LineSpec, ShapeSpec, TextAlign, TextRunSpec } from './types'

/** The walker output: emitted shapes, the resolved slide background, and the honesty coverage metric. */
export type WalkResult = {
  shapes: ShapeSpec[]
  /** The body's solid colour, or null. */
  background: FillSpec | null
  /**
   * True when the body paints a gradient/image. The pure walk has no pixels for it; the planner
   * supplies the capture as a full-bleed picture (§3.3), or routes to raster if it cannot.
   */
  bodyImage: boolean
  /** Fraction (0–1) of visible content area the structured walk represented. 1 = nothing dropped. */
  coveredFraction: number
}

const OPAQUE_ENOUGH = 0.03
const BORDER_STYLES_VISIBLE = new Set(['solid', 'dashed', 'dotted', 'double', 'groove', 'ridge'])
/** Below this, a decomposed angle is layout noise, not a rotation. */
const ROTATION_EPSILON_DEG = 0.01

function toFill(color: string): FillSpec | null {
  const parsed = parseCssColor(color)
  if (parsed === null || parsed.alpha < OPAQUE_ENOUGH) return null
  const transparency = alphaToTransparency(parsed.alpha)
  return transparency > 0 ? { color: parsed.hex, transparency } : { color: parsed.hex }
}

function toLine(node: SlideNode): LineSpec | null {
  const width = parseFloat(node.style.borderTopWidth)
  if (!Number.isFinite(width) || width <= 0) return null
  if (!BORDER_STYLES_VISIBLE.has(node.style.borderTopStyle)) return null
  const color = parseCssColor(node.style.borderTopColor)
  if (color === null || color.alpha < OPAQUE_ENOUGH) return null
  return {
    color: color.hex,
    width: pxToPoints(width),
    dashType:
      node.style.borderTopStyle === 'dashed' || node.style.borderTopStyle === 'dotted'
        ? 'dash'
        : 'solid',
  }
}

function toAlign(textAlign: string): TextAlign {
  if (textAlign === 'center' || textAlign === 'right' || textAlign === 'justify') return textAlign
  if (textAlign === 'end') return 'right'
  return 'left'
}

/** The leading corner radius in px, or 0. `borderRadius` may be shorthand (`8px` / `8px 8px …`). */
function firstRadiusPx(borderRadius: string): number {
  const first = borderRadius.trim().split(/\s+/)[0] ?? '0'
  const v = parseFloat(first)
  return Number.isFinite(v) ? v : 0
}

function textRunFor(node: SlideNode): TextRunSpec {
  const s = node.style
  const weight = parseInt(s.fontWeight, 10)
  const text = s.textTransform === 'uppercase' ? node.text.toUpperCase() : node.text
  const color = parseCssColor(s.color)
  const run: TextRunSpec = { text }
  if (Number.isFinite(weight) && weight >= 600) run.bold = true
  else if (s.fontWeight === 'bold' || s.fontWeight === 'bolder') run.bold = true
  if (s.fontStyle === 'italic' || s.fontStyle === 'oblique') run.italic = true
  if (s.textDecorationLine.includes('underline')) run.underline = true
  if (s.textDecorationLine.includes('line-through')) run.strike = true
  if (color !== null) run.color = color.hex
  const family = firstFontFamily(s.fontFamily)
  if (family !== '') run.fontFace = family
  if (s.fontSize > 0) run.fontSize = pxToPoints(s.fontSize)
  if (node.listType === 'ol') run.bullet = { type: 'number' }
  else if (node.listType === 'ul') run.bullet = true
  if (node.href !== null && node.href !== '') run.hyperlink = node.href
  return run
}

/** line-height as a multiple of font-size, or `undefined` for `normal` / unresolved. */
function lineSpacingMultiple(lineHeight: string, fontSize: number): number | undefined {
  if (lineHeight === 'normal' || fontSize <= 0) return undefined
  const px = parseFloat(lineHeight)
  if (!Number.isFinite(px) || px <= 0) return undefined
  return Math.round((px / fontSize) * 100) / 100
}

/** True when a container paints something of its own (has a fill or a visible border). */
function containerPaints(node: SlideNode): boolean {
  return toFill(node.style.backgroundColor) !== null || toLine(node) !== null
}

/**
 * Total clockwise rotation of a node: its own transform plus every transformed ancestor's. `null`
 * when any of them is not a pure rotation (skew/scale/3D) — then there is no single angle to emit and
 * the measured bounds are the best available box.
 */
function effectiveRotation(node: SlideNode): number | null {
  let total = 0
  for (const transform of [node.style.transform, ...node.ancestorTransforms]) {
    const deg = rotationDegrees(transform)
    if (deg === null) return null
    total += deg
  }
  return total
}

type Placement = { x: number; y: number; w: number; h: number; rotate?: number }

/**
 * Where a node's shape goes, in px. Unrotated: the measured rect, exactly. Rotated: the layout box
 * centred on the measured bounds' centre (see the module docstring), plus the angle in [0, 360).
 */
function placement(node: SlideNode): Placement {
  const deg = effectiveRotation(node)
  if (deg === null || Math.abs(deg) < ROTATION_EPSILON_DEG) {
    return { x: node.x, y: node.y, w: node.w, h: node.h }
  }
  const cx = node.x + node.w / 2
  const cy = node.y + node.h / 2
  const { layoutW: w, layoutH: h } = node
  return { x: cx - w / 2, y: cy - h / 2, w, h, rotate: ((deg % 360) + 360) % 360 }
}

/** Corner radius as a fraction of the shorter side, capped at a semicircle; 0 when square. */
function radiusFraction(radiusPx: number, w: number, h: number): number {
  const shortSide = Math.min(w, h)
  return radiusPx > 0 && shortSide > 0 ? Math.min(0.5, radiusPx / shortSide) : 0
}

/**
 * Walk the measured nodes into shape specs. `body` supplies the slide background: a solid colour maps
 * to `slide.background`; a gradient/image is flagged (`bodyImage`) for the planner to supply as a
 * full-bleed picture from the capture, since the pure walker has no pixels for it.
 */
export function walkSlide(measure: MeasureResult): WalkResult {
  const { nodes, body } = measure
  const ordered = [...nodes].toSorted((a, b) => (a.z !== b.z ? a.z - b.z : a.domIndex - b.domIndex))

  const shapes: ShapeSpec[] = []
  let contentArea = 0
  let coveredArea = 0
  const note = (node: SlideNode, covered: boolean): void => {
    const area = Math.max(0, node.w) * Math.max(0, node.h)
    contentArea += area
    if (covered) coveredArea += area
  }

  for (const node of ordered) {
    // Media the pure path cannot embed: counts as content, not covered → drags coverage down.
    if (node.tag === 'img' || node.tag === 'svg' || node.tag === 'canvas') {
      note(node, false)
      continue
    }

    const place = placement(node)
    const box = boxToInches(place)
    const fill = toFill(node.style.backgroundColor)
    const line = toLine(node)
    const radius = radiusFraction(firstRadiusPx(node.style.borderRadius), place.w, place.h)

    if (node.isLeaf && node.text !== '') {
      const spacing = lineSpacingMultiple(node.style.lineHeight, node.style.fontSize)
      const letter = parseFloat(node.style.letterSpacing)
      const shape: Extract<ShapeSpec, { kind: 'text' }> = {
        kind: 'text',
        box,
        runs: [textRunFor(node)],
        align: toAlign(node.style.textAlign),
        valign: 'top',
      }
      if (fill !== null) shape.fill = fill
      if (line !== null) shape.line = line
      if (radius > 0) shape.rectRadius = radius
      if (place.rotate !== undefined) shape.rotate = place.rotate
      if (spacing !== undefined) shape.lineSpacingMultiple = spacing
      if (Number.isFinite(letter) && letter !== 0) shape.charSpacing = pxToPoints(letter)
      shapes.push(shape)
      note(node, true)
      continue
    }

    // Non-leaf, non-text: a shape only if it paints (container-paint rule).
    if (!node.isLeaf && containerPaints(node)) {
      const isEllipse = radius >= 0.5
      const shape: Extract<ShapeSpec, { kind: 'rect' | 'roundRect' | 'ellipse' }> = {
        kind: isEllipse ? 'ellipse' : radius > 0 ? 'roundRect' : 'rect',
        box,
      }
      if (fill !== null) shape.fill = fill
      if (line !== null) shape.line = line
      if (!isEllipse && radius > 0) shape.rectRadius = radius
      if (place.rotate !== undefined) shape.rotate = place.rotate
      shapes.push(shape)
      note(node, true)
    }
    // Pure layout wrappers contribute neither a shape nor content area — they are invisible in PPTX.
  }

  return {
    shapes,
    background: toFill(body.backgroundColor),
    bodyImage: paintsImage(body.backgroundImage),
    coveredFraction: contentArea > 0 ? coveredArea / contentArea : 1,
  }
}

/** The slide's visible text, for the accessibility speaker-notes layer (§3.5). */
export function slideTextForNotes(nodes: readonly SlideNode[]): string {
  return nodes
    .filter((n) => n.isLeaf && n.text !== '')
    .map((n) => n.text)
    .join('\n')
    .trim()
}
