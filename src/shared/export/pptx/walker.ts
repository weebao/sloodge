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
 *   `<span>`.
 * - **Container-paint rule.** A non-leaf element contributes a shape *only* if it paints something
 *   itself — a non-transparent background or a visible border. Pure layout wrappers (flex/grid with no
 *   paint) are skipped; PowerPoint has no concept of them.
 *
 * Emission order is `(zIndex, domIndex)` ascending, approximating paint order.
 *
 * ## Honesty about coverage (task requirement 4)
 *
 * `<img>`, `<svg>`, and `<canvas>` cannot be turned into editable shapes without their pixel data,
 * which the structured (pure) path does not have. Rather than silently drop them, the walker reports
 * `coveredFraction` — the share of visible content area it actually emitted a shape for — and the
 * confidence scorer penalizes those same nodes, so a media-heavy slide routes to an honest raster
 * instead of a structured slide with holes in it.
 */

import { boxToInches, pxToPoints } from './geometry'
import { alphaToTransparency, parseCssColor } from './color'
import { firstFontFamily } from './confidence'
import type { SlideNode, MeasureResult } from './node'
import type { FillSpec, LineSpec, ShapeSpec, TextAlign, TextRunSpec } from './types'

/** The walker output: emitted shapes, the resolved slide background, and the honesty coverage metric. */
export type WalkResult = {
  shapes: ShapeSpec[]
  background: FillSpec | null
  /** Fraction (0–1) of visible content area the structured walk represented. 1 = nothing dropped. */
  coveredFraction: number
}

const OPAQUE_ENOUGH = 0.03
const BORDER_STYLES_VISIBLE = new Set(['solid', 'dashed', 'dotted', 'double', 'groove', 'ridge'])

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
 * Walk the measured nodes into shape specs. `body` supplies the slide background (a solid colour maps
 * to `slide.background`; a gradient/image body background is left to the raster path and reported as a
 * coverage gap, since the pure walker has no pixels for it).
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
    const box = boxToInches(node)

    // Media the pure path cannot embed: counts as content, not covered → drags coverage down.
    if (node.tag === 'img' || node.tag === 'svg' || node.tag === 'canvas') {
      note(node, false)
      continue
    }

    if (node.isLeaf && node.text !== '') {
      const fill = toFill(node.style.backgroundColor)
      const radius = firstRadiusPx(node.style.borderRadius)
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
      if (radius > 0) shape.rounded = true
      if (spacing !== undefined) shape.lineSpacingMultiple = spacing
      if (Number.isFinite(letter) && letter !== 0) shape.charSpacing = pxToPoints(letter)
      shapes.push(shape)
      note(node, true)
      continue
    }

    // Non-leaf, non-text: a shape only if it paints (container-paint rule).
    if (!node.isLeaf && containerPaints(node)) {
      const fill = toFill(node.style.backgroundColor)
      const line = toLine(node)
      const radiusPx = firstRadiusPx(node.style.borderRadius)
      const shortSide = Math.min(node.w, node.h)
      const isEllipse = shortSide > 0 && radiusPx >= shortSide / 2
      const shape: Extract<ShapeSpec, { kind: 'rect' | 'roundRect' | 'ellipse' }> = {
        kind: isEllipse ? 'ellipse' : radiusPx > 0 ? 'roundRect' : 'rect',
        box,
      }
      if (fill !== null) shape.fill = fill
      if (line !== null) shape.line = line
      if (!isEllipse && radiusPx > 0 && shortSide > 0)
        shape.rectRadius = Math.min(0.5, radiusPx / shortSide)
      shapes.push(shape)
      note(node, true)
    }
    // Pure layout wrappers contribute neither a shape nor content area — they are invisible in PPTX.
  }

  const bgFill = toFill(body.backgroundColor)
  const bodyGradient = /gradient\(|url\(/i.test(body.backgroundImage)
  // A gradient/image body background cannot be represented by the pure path; count it as a coverage
  // gap the size of the slide so it nudges auto toward raster.
  if (bodyGradient) {
    contentArea += 1
  }

  return {
    shapes,
    background: bgFill,
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
