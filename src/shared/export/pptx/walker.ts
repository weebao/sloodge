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
 * - **Paint rule.** Any element that paints something of its own — a non-transparent background or a
 *   visible border — contributes a shape, whether or not it has children or text. Pure layout
 *   wrappers (flex/grid with no paint) are skipped; PowerPoint has no concept of them. (Until M4.8a
 *   this rule required children, so an empty `<div class="divider">` or `<hr>` vanished silently.)
 *
 * Emission order is `(zIndex, domIndex)` ascending, approximating paint order.
 *
 * ## Transforms (M4.8a)
 *
 * `getBoundingClientRect` returns the axis-aligned bounds of a transformed element, so placing a
 * rotated element at its measured rect gave a 90° label a 21 px-wide box and no `rot`. The walker
 * decomposes the total transform — all four of `transform`, `rotate`, `scale` and `translate`, own
 * plus every transformed ancestor's, since the standalone properties do not fold into the computed
 * `transform` (review r2) — into an angle and a uniform
 * scale and hands PowerPoint the **unrotated** box: the bounds of a rectangle rotated about its centre
 * are symmetric about that centre, so the centre is exact for any composition of rotations, scales and
 * translations, and the size is the layout box (`offsetWidth`/`offsetHeight`) times the scale rather
 * than an inversion of the bounds, which is singular at 45°. The scale also multiplies the font size,
 * border width and letter spacing — a `scale(1.4)` stat renders its glyphs 1.4× larger.
 *
 * ## Opacity, borders, shadows (M4.8a)
 *
 * The element's effective `opacity` multiplies into every fill, outline, run and shadow it emits; an
 * 8 % watermark used to ship as an opaque white numeral. A border that is not uniform on all four
 * sides has no outline equivalent (`ln` is all-or-nothing), so each painted side becomes a filled edge
 * rect; a `border-top` rule used to be emitted as a four-side outline. An outer `box-shadow` becomes
 * a PowerPoint outer shadow — the only boundary some cards have.
 *
 * ## Honesty about coverage
 *
 * `<img>`, `<svg>`, `<canvas>` and element gradient/image backgrounds cannot be turned into editable
 * shapes without their pixel data, which the structured (pure) path does not have. Rather than
 * silently drop them, the walker reports `coveredFraction` — the share of visible content area it
 * actually emitted a shape for — and the confidence scorer penalizes those same nodes, so a
 * media-heavy slide routes to an honest raster instead of a structured slide with holes in it.
 */

import { boxToInches, pxToPoints } from './geometry'
import { alphaToTransparency, parseCssColor } from './color'
import { decomposeTransformSpec, paintsImage, ROTATION_EPSILON_DEG } from './confidence'
import { firstFontFamily } from '../../fonts/system-fonts'
import type { BorderSide, SlideNode, MeasureResult } from './node'
import type { FillSpec, LineSpec, ShadowSpec, ShapeSpec, TextAlign, TextRunSpec } from './types'

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
/** Below this, a decomposed scale is layout noise, not a scale. */
const SCALE_EPSILON = 1e-3

/** A fill from a CSS colour at the element's effective opacity; `null` when it would not be seen. */
function toFill(color: string, opacity: number): FillSpec | null {
  const parsed = parseCssColor(color)
  if (parsed === null) return null
  const alpha = parsed.alpha * opacity
  if (alpha < OPAQUE_ENOUGH) return null
  const transparency = alphaToTransparency(alpha)
  return transparency > 0 ? { color: parsed.hex, transparency } : { color: parsed.hex }
}

type PaintedSide = { color: string; alpha: number; widthPx: number; dashType: 'solid' | 'dash' }

function paintedSide(side: BorderSide, opacity: number): PaintedSide | null {
  const width = parseFloat(side.width)
  if (!Number.isFinite(width) || width <= 0) return null
  if (!BORDER_STYLES_VISIBLE.has(side.style)) return null
  const color = parseCssColor(side.color)
  if (color === null) return null
  const alpha = color.alpha * opacity
  if (alpha < OPAQUE_ENOUGH) return null
  return {
    color: color.hex,
    alpha,
    widthPx: width,
    dashType: side.style === 'dashed' || side.style === 'dotted' ? 'dash' : 'solid',
  }
}

const SIDES = ['borderTop', 'borderRight', 'borderBottom', 'borderLeft'] as const
type SideName = (typeof SIDES)[number]
type PaintedSides = Record<SideName, PaintedSide | null>

function paintedSides(node: SlideNode, opacity: number): PaintedSides {
  return {
    borderTop: paintedSide(node.style.borderTop, opacity),
    borderRight: paintedSide(node.style.borderRight, opacity),
    borderBottom: paintedSide(node.style.borderBottom, opacity),
    borderLeft: paintedSide(node.style.borderLeft, opacity),
  }
}

/** The shape outline, when all four sides paint identically — PowerPoint's `ln` is all-or-nothing. */
function uniformLine(sides: PaintedSides, scale: number): LineSpec | null {
  const top = sides.borderTop
  if (top === null) return null
  for (const name of SIDES) {
    const s = sides[name]
    if (
      s === null ||
      s.color !== top.color ||
      s.widthPx !== top.widthPx ||
      s.dashType !== top.dashType ||
      s.alpha !== top.alpha
    )
      return null
  }
  const line: LineSpec = {
    color: top.color,
    width: pxToPoints(top.widthPx * scale),
    dashType: top.dashType,
  }
  const transparency = alphaToTransparency(top.alpha)
  if (transparency > 0) line.transparency = transparency
  return line
}

type Placement = { x: number; y: number; w: number; h: number; rotate?: number; scale: number }
type PxBox = { x: number; y: number; w: number; h: number }

/** `box` moved so that its centre is rotated `deg` clockwise about (cx, cy). Size unchanged. */
function rotateAbout(box: PxBox, cx: number, cy: number, deg: number | undefined): PxBox {
  if (deg === undefined) return box
  const rad = (deg * Math.PI) / 180
  const bx = box.x + box.w / 2 - cx
  const by = box.y + box.h / 2 - cy
  const rx = bx * Math.cos(rad) - by * Math.sin(rad)
  const ry = bx * Math.sin(rad) + by * Math.cos(rad)
  return { x: cx + rx - box.w / 2, y: cy + ry - box.h / 2, w: box.w, h: box.h }
}

/**
 * Each painted side of a non-uniform border as a filled rect along that edge of the unrotated box,
 * carried around with the element's rotation. Dashed sides become solid — a partial dashed border is
 * rare and a solid rule beats no rule.
 */
function edgeRects(sides: PaintedSides, place: Placement): ShapeSpec[] {
  const out: ShapeSpec[] = []
  const cx = place.x + place.w / 2
  const cy = place.y + place.h / 2
  for (const name of SIDES) {
    const side = sides[name]
    if (side === null) continue
    const t = side.widthPx * place.scale
    const local: PxBox =
      name === 'borderTop'
        ? { x: place.x, y: place.y, w: place.w, h: t }
        : name === 'borderBottom'
          ? { x: place.x, y: place.y + place.h - t, w: place.w, h: t }
          : name === 'borderLeft'
            ? { x: place.x, y: place.y, w: t, h: place.h }
            : { x: place.x + place.w - t, y: place.y, w: t, h: place.h }
    const transparency = alphaToTransparency(side.alpha)
    const shape: Extract<ShapeSpec, { kind: 'rect' | 'roundRect' | 'ellipse' }> = {
      kind: 'rect',
      box: boxToInches(rotateAbout(local, cx, cy, place.rotate)),
      fill: transparency > 0 ? { color: side.color, transparency } : { color: side.color },
    }
    if (place.rotate !== undefined) shape.rotate = place.rotate
    out.push(shape)
  }
  return out
}

/** Split a computed `box-shadow` list on the commas between shadows, not the ones inside `rgba()`. */
function splitShadows(value: string): string[] {
  const out: string[] = []
  let depth = 0
  let start = 0
  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i]
    if (ch === '(') depth += 1
    else if (ch === ')') depth -= 1
    else if (ch === ',' && depth === 0) {
      out.push(value.slice(start, i))
      start = i + 1
    }
  }
  out.push(value.slice(start))
  return out.map((s) => s.trim()).filter((s) => s !== '')
}

/**
 * The first outer `box-shadow` as a PowerPoint outer shadow. Chromium serializes each shadow as
 * `<color> <dx> <dy> <blur> <spread>[ inset]`. Spread has no OOXML equivalent and is dropped; inset
 * shadows are scored, not emitted. CSS offsets are y-down, so `atan2(dy, dx)` is already clockwise —
 * the OOXML convention.
 */
function toShadow(boxShadow: string, opacity: number): ShadowSpec | null {
  if (boxShadow === '' || boxShadow === 'none') return null
  for (const part of splitShadows(boxShadow)) {
    if (/\binset\b/.test(part)) continue
    const colorMatch = /^(rgba?\([^)]*\)|#[0-9a-f]{3,8}|[a-z]+)\s+/i.exec(part)
    const color = parseCssColor(colorMatch?.[1])
    if (colorMatch === null || color === null) continue
    const [dx = 0, dy = 0, blur = 0] = part
      .slice(colorMatch[0].length)
      .split(/\s+/)
      .map((n) => parseFloat(n))
    const alpha = color.alpha * opacity
    if (alpha < OPAQUE_ENOUGH) return null
    // Chromium's serialization is always well-formed, but these four numbers are the only values
    // that reach pptxgenjs without passing through `parseCssColor` or the clamped
    // `alphaToTransparency`, so they are guarded like every other forwarded number.
    if (![dx, dy, blur].every((n) => Number.isFinite(n))) return null
    return {
      color: color.hex,
      blurPt: pxToPoints(Math.max(0, blur)),
      offsetPt: pxToPoints(Math.hypot(dx, dy)),
      angleDeg: ((((Math.atan2(dy, dx) * 180) / Math.PI) % 360) + 360) % 360,
      opacity: alpha,
    }
  }
  return null
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

function textRunFor(node: SlideNode, scale: number): TextRunSpec {
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
  if (color !== null) {
    run.color = color.hex
    const transparency = alphaToTransparency(color.alpha * node.effectiveOpacity)
    if (transparency > 0) run.transparency = transparency
  }
  const family = firstFontFamily(s.fontFamily)
  if (family !== '') run.fontFace = family
  if (s.fontSize > 0) run.fontSize = pxToPoints(s.fontSize * scale)
  // `list-style: none` is how a chip/tag/nav row is built out of a `<ul>`; emitting a bullet there
  // invents a glyph the reader never saw (review r2).
  if (s.listStyleType !== 'none') {
    if (node.listType === 'ol') run.bullet = { type: 'number' }
    else if (node.listType === 'ul') run.bullet = true
  }
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

/**
 * Total clockwise rotation and uniform scale of a node: its own transform composed with every
 * transformed ancestor's. `null` when any of them is not a similarity (skew/flip/3D) — then there is
 * no single angle to emit and the measured bounds are the best available box.
 */
function effectiveTransform(node: SlideNode): { deg: number; scale: number } | null {
  let deg = 0
  let scale = 1
  for (const spec of [node.style, ...node.ancestorTransforms]) {
    const d = decomposeTransformSpec(spec)
    if (d.kind === 'other') return null
    if (d.kind === 'similarity') {
      deg += d.deg
      scale *= d.scale
    }
  }
  return { deg, scale }
}

/**
 * Where a node's shape goes, in px. Untransformed: the measured rect, exactly. Rotated/scaled: the
 * layout box times the scale, centred on the measured bounds' centre (see the module docstring), plus
 * the angle in [0, 360).
 */
function placement(node: SlideNode): Placement {
  const t = effectiveTransform(node)
  const rotated = t !== null && Math.abs(t.deg) >= ROTATION_EPSILON_DEG
  const scaled = t !== null && Math.abs(t.scale - 1) >= SCALE_EPSILON
  if (t === null || (!rotated && !scaled)) {
    return { x: node.x, y: node.y, w: node.w, h: node.h, scale: 1 }
  }
  // A scale within the epsilon is Chromium's 6-decimal serialization of a pure rotation, not a
  // scale: using it would move the box by microns and make the emitted geometry angle-dependent.
  const scale = scaled ? t.scale : 1
  const w = node.layoutW * scale
  const h = node.layoutH * scale
  const cx = node.x + node.w / 2
  const cy = node.y + node.h / 2
  const place: Placement = { x: cx - w / 2, y: cy - h / 2, w, h, scale }
  if (rotated) place.rotate = ((t.deg % 360) + 360) % 360
  return place
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
    const opacity = node.effectiveOpacity
    const fill = toFill(node.style.backgroundColor, opacity)
    const sides = paintedSides(node, opacity)
    const line = uniformLine(sides, place.scale)
    const edges = line === null ? edgeRects(sides, place) : []
    const radius = radiusFraction(firstRadiusPx(node.style.borderRadius), place.w, place.h)
    const shadow = toShadow(node.style.boxShadow, opacity)
    // A gradient/image background paints pixels the pure walk does not have: the node's text and
    // border still go out, but its area counts as uncovered (and the scorer deducts for it).
    const covered = !paintsImage(node.style.backgroundImage)

    if (node.isLeaf && node.text !== '') {
      const spacing = lineSpacingMultiple(node.style.lineHeight, node.style.fontSize)
      const letter = parseFloat(node.style.letterSpacing)
      const shape: Extract<ShapeSpec, { kind: 'text' }> = {
        kind: 'text',
        box,
        runs: [textRunFor(node, place.scale)],
        align: toAlign(node.style.textAlign),
        valign: 'top',
      }
      if (fill !== null) shape.fill = fill
      if (line !== null) shape.line = line
      if (shadow !== null) shape.shadow = shadow
      if (radius > 0) shape.rectRadius = radius
      if (place.rotate !== undefined) shape.rotate = place.rotate
      if (spacing !== undefined) shape.lineSpacingMultiple = spacing
      if (Number.isFinite(letter) && letter !== 0)
        shape.charSpacing = pxToPoints(letter * place.scale)
      shapes.push(shape, ...edges)
      note(node, covered)
      continue
    }

    // Paint rule: a shape for anything that paints, leaf or not.
    if (fill !== null || line !== null || edges.length > 0) {
      const isEllipse = radius >= 0.5
      const shape: Extract<ShapeSpec, { kind: 'rect' | 'roundRect' | 'ellipse' }> = {
        kind: isEllipse ? 'ellipse' : radius > 0 ? 'roundRect' : 'rect',
        box,
      }
      if (fill !== null) shape.fill = fill
      if (line !== null) shape.line = line
      if (shadow !== null) shape.shadow = shadow
      if (!isEllipse && radius > 0) shape.rectRadius = radius
      if (place.rotate !== undefined) shape.rotate = place.rotate
      shapes.push(shape, ...edges)
      note(node, covered)
    } else if (!covered) {
      note(node, false)
    }
    // Pure layout wrappers contribute neither a shape nor content area — they are invisible in PPTX.
  }

  return {
    shapes,
    background: toFill(body.backgroundColor, 1),
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
