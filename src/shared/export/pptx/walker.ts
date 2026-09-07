/**
 * The structured DOM→PPTX walker (M4.3 / 60-export.md §3.2–§3.3). Pure: it maps a measured
 * `SlideNode[]` to a `ShapeSpec[]` the pptxgenjs writer emits, with no browser, no `electron`, and no
 * pptxgenjs — so the load-bearing mapping (which contract element becomes which PowerPoint object,
 * with what position, size and style) is unit-tested directly.
 *
 * ## The two structural rules (§3.2)
 *
 * - **Block-root text rule (M4.8b).** Every block root — an element whose computed `display` is not
 *   `inline` — that carries text becomes **one text box, with one run per text node** inside it, each
 *   run in the computed style of its own parent element: `<p>a <strong>b</strong> c</p>` is one box
 *   and three runs. A text node has exactly one block root, so nothing is emitted twice — the
 *   guarantee the old leaf-text rule bought at the price of dropping the bare text beside an inline
 *   element (research §1.3(c)). Nested blocks are their own boxes at their own rects; a `<br>` is a
 *   hard line break inside the box.
 * - **Paint rule.** Any element that paints something of its own — a non-transparent background or a
 *   visible border — contributes a shape, whether or not it has children or text. Pure layout
 *   wrappers (flex/grid with no paint) are skipped; PowerPoint has no concept of them. (Until M4.8a
 *   this rule required children, so an empty `<div class="divider">` or `<hr>` vanished silently.)
 *
 * Emission order is `(zIndex, domIndex)` ascending, approximating paint order — with one deliberate
 * exception: an inline element that paints (a highlighted `<span>`) is emitted with its block root,
 * *between* the root's own decoration and the root's text box, so its background sits under the
 * paragraph's glyphs rather than over them.
 *
 * ## White space and text (M4.8b)
 *
 * HTML collapses white space and PowerPoint does not, so the walker applies CSS's white-space
 * processing itself (`layOutInline`): runs of document white space collapse to one space under
 * `white-space-collapse: collapse`, a collapsible space is dropped at the start of a line, after
 * another collapsible space (across run boundaries), and at the end of a line; `pre` keeps every
 * character and turns its newlines into line breaks; `pre-line` does both halves. A `<br>` at the very
 * end of a block does not add a line, exactly as in Chromium. `text-transform` is applied afterwards,
 * per run, with `capitalize` carrying the word boundary across run boundaries. The resulting box text
 * equals the block's rendered `innerText`, which the fidelity oracle checks line by line.
 *
 * The box is the block's border box (measured), and its runs start at the block's **content box**:
 * padding plus border width become the text shape's inset, so a padded pill's label lands where
 * Chromium put it and PowerPoint wraps within the same width Chromium wrapped within. Line spacing is
 * the block's computed `line-height` as a multiple of the block's font size; runs larger than the
 * block's font get PowerPoint's proportional line height, as a unitless CSS line-height would give
 * them — which is exact only for a unitless `line-height`; a length/em/% value over a larger inline
 * run is mis-mapped by construction (60-export.md §3.3), and only the pixel step can see it.
 * Nothing is auto-fitted: the box keeps Chromium's height and, where PowerPoint's line breaking
 * differs, the text overflows rather than shrinks — the reflow gap the pixel step measures.
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
import {
  decomposeTransformSpec,
  firstFontFamily,
  paintsImage,
  ROTATION_EPSILON_DEG,
} from './confidence'
import { hasOwnText } from './node'
import type { BorderSide, InlineItem, NodeStyle, RunStyle, SlideNode, MeasureResult } from './node'
import type {
  BoxInches,
  FillSpec,
  LineSpec,
  ShadowSpec,
  ShapeSpec,
  TextAlign,
  TextInset,
  TextRunSpec,
} from './types'

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

// --- Run-level text (M4.8b) ---------------------------------------------------------------------

type TextItem = Extract<InlineItem, { kind: 'text' }>

/** One run after white-space processing and `text-transform`; `text` may be '' only on an empty line. */
export type LaidRun = {
  text: string
  style: RunStyle
  opacity: number
  href: string | null
  /** A hard break (`<br>`, a preserved newline) precedes this run within its paragraph. */
  lineBreakBefore: boolean
}

/** A paragraph: the runs between two nested-block boundaries, in order. */
export type LaidParagraph = LaidRun[]

/** A piece of one text node on one line: collapsible under `collapse`/`pre-line`, verbatim under `pre`. */
type Segment = { text: string; collapsible: boolean; item: TextItem }

const COLLAPSIBLE_RUN = /[ \t\n\r\f]+/g
const SEGMENT_BREAK = /\r\n?|\n/

/** Non-breaking, zero-width and other Unicode spaces are NOT collapsible; only the document white space is. */
const LEADING_SPACES = /^ +/
const TRAILING_SPACES = / +$/

/**
 * CSS Text §4.1 white-space processing over one line, after collapsing within each text node: a
 * collapsible space at the start of the line, after another collapsible space (even one in the
 * previous run), or at the end of the line is removed. Empty segments vanish.
 */
function trimLine(line: readonly Segment[]): Segment[] {
  const out: Segment[] = []
  for (const seg of line) {
    let text = seg.text
    if (seg.collapsible) {
      const prev = out[out.length - 1]
      if (prev === undefined || (prev.collapsible && prev.text.endsWith(' ')))
        text = text.replace(LEADING_SPACES, '')
    }
    if (text === '') continue
    out.push({ ...seg, text })
  }
  while (out.length > 0) {
    const last = out[out.length - 1]!
    if (!last.collapsible) break
    const text = last.text.replace(TRAILING_SPACES, '')
    if (text !== '') {
      out[out.length - 1] = { ...last, text }
      break
    }
    out.pop()
  }
  return out
}

/** A character inside a word for `capitalize`: letters, digits, and the apostrophes of "don't". */
const WORD_CHAR = /[\p{L}\p{N}'’]/u

/** `text-transform: capitalize` over one segment, given the character that precedes it on the line. */
function capitalize(text: string, before: string): string {
  let out = ''
  let prev = before
  for (const ch of text) {
    out += prev === '' || !WORD_CHAR.test(prev) ? ch.toUpperCase() : ch
    prev = ch
  }
  return out
}

/** `text-transform`, per segment, with the word boundary carried across runs on the same line. */
function transformLine(line: readonly Segment[]): Segment[] {
  let before = ''
  return line.map((seg) => {
    const mode = seg.item.style.textTransform
    let text = seg.text
    if (mode === 'uppercase') text = text.toUpperCase()
    else if (mode === 'lowercase') text = text.toLowerCase()
    else if (mode === 'capitalize') text = capitalize(text, before)
    before = seg.text.slice(-1)
    return { ...seg, text }
  })
}

/** The style an empty line is emitted in: the block's own, so its height matches the block's font. */
function runStyleOf(style: NodeStyle): RunStyle {
  return {
    fontFamily: style.fontFamily,
    fontSize: style.fontSize,
    fontWeight: style.fontWeight,
    fontStyle: style.fontStyle,
    textDecorationLine: style.textDecorationLine,
    color: style.color,
    textTransform: style.textTransform,
    letterSpacing: style.letterSpacing,
    textShadow: style.textShadow,
  }
}

/**
 * Lay out one block root's inline content into paragraphs of runs — see the module docstring for
 * the white-space rules. `fallback` styles an empty line that no text node contributes to (the
 * middle line of `a<br><br>b`). Returns no paragraph for content that is only formatting white space.
 */
export function layOutInline(items: readonly InlineItem[], fallback: RunStyle): LaidParagraph[] {
  const paragraphs: LaidParagraph[] = []
  let lines: Segment[][] = [[]]
  let hardBreaks = 0
  const flush = (): void => {
    const trimmed = lines.map((line) => transformLine(trimLine(line)))
    // A `<br>` (or preserved newline) at the very end of a block ends the last line without
    // starting another, so a trailing empty line is Chromium's too and is dropped — but only one:
    // `a<br><br>` does render an empty second line.
    if (trimmed.length > 1 && trimmed[trimmed.length - 1]!.length === 0) trimmed.pop()
    lines = [[]]
    const breaks = hardBreaks
    hardBreaks = 0
    if (trimmed.every((line) => line.length === 0) && breaks === 0) return
    const paragraph: LaidParagraph = []
    trimmed.forEach((line, i) => {
      if (line.length === 0) {
        paragraph.push({
          text: '',
          style: fallback,
          opacity: 1,
          href: null,
          lineBreakBefore: i > 0,
        })
        return
      }
      line.forEach((seg, j) => {
        paragraph.push({
          text: seg.text,
          style: seg.item.style,
          opacity: seg.item.opacity,
          href: seg.item.href,
          lineBreakBefore: i > 0 && j === 0,
        })
      })
    })
    paragraphs.push(paragraph)
  }
  for (const item of items) {
    if (item.kind === 'block') {
      flush()
      continue
    }
    if (item.kind === 'box') continue
    if (item.kind === 'br') {
      lines.push([])
      hardBreaks += 1
      continue
    }
    if (item.whiteSpace === 'collapse') {
      lines[lines.length - 1]!.push({
        text: item.text.replace(COLLAPSIBLE_RUN, ' '),
        collapsible: true,
        item,
      })
      continue
    }
    // `pre` and `pre-line`: every segment break is a line break; `pre-line` still collapses the
    // spaces and tabs within a segment.
    item.text.split(SEGMENT_BREAK).forEach((piece, i) => {
      if (i > 0) {
        lines.push([])
        hardBreaks += 1
      }
      const preserveBreaksOnly = item.whiteSpace === 'preserve-breaks'
      lines[lines.length - 1]!.push({
        text: preserveBreaksOnly ? piece.replace(/[ \t\f]+/g, ' ') : piece,
        collapsible: preserveBreaksOnly,
        item,
      })
    })
  }
  flush()
  return paragraphs
}

/** The paragraphs a block root emits, or none when it carries no text. */
function paragraphsOf(node: SlideNode): LaidParagraph[] {
  if (!hasOwnText(node)) return []
  return layOutInline(node.inlineContent, runStyleOf(node.style))
}

/**
 * A block's text as the reader sees it, lines joined with `\n` — the string the fidelity oracle
 * compares against the block's `innerText`, and the speaker-notes text layer.
 */
export function renderedBlockText(node: SlideNode): string {
  return paragraphsOf(node)
    .map((p) => p.map((r) => (r.lineBreakBefore ? `\n${r.text}` : r.text)).join(''))
    .join('\n')
}

function runSpec(run: LaidRun, scale: number): TextRunSpec {
  const s = run.style
  const spec: TextRunSpec = { text: run.text }
  const weight = parseInt(s.fontWeight, 10)
  if (
    Number.isFinite(weight) ? weight >= 600 : s.fontWeight === 'bold' || s.fontWeight === 'bolder'
  )
    spec.bold = true
  if (s.fontStyle === 'italic' || s.fontStyle === 'oblique') spec.italic = true
  if (s.textDecorationLine.includes('underline')) spec.underline = true
  if (s.textDecorationLine.includes('line-through')) spec.strike = true
  const color = parseCssColor(s.color)
  if (color !== null) {
    spec.color = color.hex
    const transparency = alphaToTransparency(color.alpha * run.opacity)
    if (transparency > 0) spec.transparency = transparency
  }
  const family = firstFontFamily(s.fontFamily)
  if (family !== '') spec.fontFace = family
  if (s.fontSize > 0) spec.fontSize = pxToPoints(s.fontSize * scale)
  const letter = parseFloat(s.letterSpacing)
  if (Number.isFinite(letter) && letter !== 0) spec.charSpacing = pxToPoints(letter * scale)
  if (run.href !== null && run.href !== '') spec.hyperlink = run.href
  if (run.lineBreakBefore) spec.lineBreakBefore = true
  return spec
}

/** The runs of a block's paragraphs as writer specs; the list marker goes on the first run only. */
function runSpecs(
  node: SlideNode,
  paragraphs: readonly LaidParagraph[],
  scale: number,
): TextRunSpec[] {
  const out: TextRunSpec[] = []
  paragraphs.forEach((paragraph, i) => {
    paragraph.forEach((run, j) => {
      const spec = runSpec(run, scale)
      if (i > 0 && j === 0) spec.paragraphBreakBefore = true
      out.push(spec)
    })
  })
  // `list-style: none` is how a chip/tag/nav row is built out of a `<ul>`; emitting a bullet there
  // invents a glyph the reader never saw (review r2). Only the first paragraph carries the marker —
  // Chromium draws one per `<li>`, not one per line.
  const first = out[0]
  if (first !== undefined && node.style.listStyleType !== 'none') {
    if (node.listType === 'ol') first.bullet = { type: 'number' }
    else if (node.listType === 'ul') first.bullet = true
  }
  return out
}

/** line-height as a multiple of font-size, or `undefined` for `normal` / unresolved. */
function lineSpacingMultiple(lineHeight: string, fontSize: number): number | undefined {
  if (lineHeight === 'normal' || fontSize <= 0) return undefined
  const px = parseFloat(lineHeight)
  if (!Number.isFinite(px) || px <= 0) return undefined
  return Math.round((px / fontSize) * 100) / 100
}

/** A computed length in px, or 0 for anything that is not a positive length. */
function lengthPx(value: string): number {
  const n = parseFloat(value)
  return Number.isFinite(n) && n > 0 ? n : 0
}

/** Padding plus border width per side, in points at the placed scale; `undefined` when all zero. */
function textInset(style: NodeStyle, scale: number): TextInset | undefined {
  const edge = (padding: string, border: BorderSide): number =>
    pxToPoints((lengthPx(padding) + (border.style === 'none' ? 0 : lengthPx(border.width))) * scale)
  const inset: TextInset = {
    left: edge(style.paddingLeft, style.borderLeft),
    top: edge(style.paddingTop, style.borderTop),
    right: edge(style.paddingRight, style.borderRight),
    bottom: edge(style.paddingBottom, style.borderBottom),
  }
  return inset.left > 0 || inset.top > 0 || inset.right > 0 || inset.bottom > 0 ? inset : undefined
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

/** Everything a node paints of its own, resolved once and shared by the text and the paint branches. */
type Decoration = {
  place: Placement
  box: BoxInches
  fill: FillSpec | null
  line: LineSpec | null
  edges: ShapeSpec[]
  shadow: ShadowSpec | null
  radius: number
  /** False when the node paints a gradient/image the pure walk has no pixels for. */
  covered: boolean
}

function decorationOf(node: SlideNode): Decoration {
  const place = placement(node)
  const opacity = node.effectiveOpacity
  const sides = paintedSides(node, opacity)
  const line = uniformLine(sides, place.scale)
  return {
    place,
    box: boxToInches(place),
    fill: toFill(node.style.backgroundColor, opacity),
    line,
    edges: line === null ? edgeRects(sides, place) : [],
    shadow: toShadow(node.style.boxShadow, opacity),
    radius: radiusFraction(firstRadiusPx(node.style.borderRadius), place.w, place.h),
    covered: !paintsImage(node.style.backgroundImage),
  }
}

/** The paint rule: a shape for anything that paints, leaf or not; nothing for a pure layout wrapper. */
function paintShapes(d: Decoration): ShapeSpec[] {
  if (d.fill === null && d.line === null && d.edges.length === 0) return []
  const isEllipse = d.radius >= 0.5
  const shape: Extract<ShapeSpec, { kind: 'rect' | 'roundRect' | 'ellipse' }> = {
    kind: isEllipse ? 'ellipse' : d.radius > 0 ? 'roundRect' : 'rect',
    box: d.box,
  }
  if (d.fill !== null) shape.fill = d.fill
  if (d.line !== null) shape.line = d.line
  if (d.shadow !== null) shape.shadow = d.shadow
  if (!isEllipse && d.radius > 0) shape.rectRadius = d.radius
  if (d.place.rotate !== undefined) shape.rotate = d.place.rotate
  return [shape, ...d.edges]
}

/**
 * The text box for a block root. `decorated` puts the block's own fill/outline/shadow/radius on the
 * box itself; when an inline descendant paints, those went out as separate shapes beneath it and the
 * text box is bare.
 */
function textShape(
  node: SlideNode,
  d: Decoration,
  paragraphs: readonly LaidParagraph[],
  decorated: boolean,
): ShapeSpec {
  const shape: Extract<ShapeSpec, { kind: 'text' }> = {
    kind: 'text',
    box: d.box,
    runs: runSpecs(node, paragraphs, d.place.scale),
    align: toAlign(node.style.textAlign),
    valign: 'top',
  }
  if (decorated) {
    if (d.fill !== null) shape.fill = d.fill
    if (d.line !== null) shape.line = d.line
    if (d.shadow !== null) shape.shadow = d.shadow
    if (d.radius > 0) shape.rectRadius = d.radius
  }
  if (d.place.rotate !== undefined) shape.rotate = d.place.rotate
  const spacing = lineSpacingMultiple(node.style.lineHeight, node.style.fontSize)
  if (spacing !== undefined) shape.lineSpacingMultiple = spacing
  const inset = textInset(node.style, d.place.scale)
  if (inset !== undefined) shape.inset = inset
  return shape
}

/**
 * Walk the measured nodes into shape specs. `body` supplies the slide background: a solid colour maps
 * to `slide.background`; a gradient/image is flagged (`bodyImage`) for the planner to supply as a
 * full-bleed picture from the capture, since the pure walker has no pixels for it.
 */
export function walkSlide(measure: MeasureResult): WalkResult {
  const { nodes, body } = measure
  const ordered = [...nodes].toSorted((a, b) => (a.z !== b.z ? a.z - b.z : a.domIndex - b.domIndex))
  const inlinesOf = new Map<number, SlideNode[]>()
  for (const n of ordered) {
    if (n.inlineOf === null) continue
    const list = inlinesOf.get(n.inlineOf)
    if (list === undefined) inlinesOf.set(n.inlineOf, [n])
    else list.push(n)
  }

  const shapes: ShapeSpec[] = []
  const emitted = new Set<SlideNode>()
  let contentArea = 0
  let coveredArea = 0
  const note = (node: SlideNode, covered: boolean): void => {
    const area = Math.max(0, node.w) * Math.max(0, node.h)
    contentArea += area
    if (covered) coveredArea += area
  }

  for (const node of ordered) {
    if (emitted.has(node)) continue
    emitted.add(node)
    // Media the pure path cannot embed: counts as content, not covered → drags coverage down.
    if (node.tag === 'img' || node.tag === 'svg' || node.tag === 'canvas') {
      note(node, false)
      continue
    }

    const d = decorationOf(node)
    const paragraphs = paragraphsOf(node)

    if (paragraphs.some((p) => p.some((r) => r.text !== ''))) {
      // An inline descendant that paints — a highlighted span — must sit under this block's glyphs
      // and over its background, so it is emitted here, between the two, rather than at its own
      // (later) DOM position where it would cover the text.
      const inlines = (inlinesOf.get(node.domIndex) ?? [])
        .filter((n) => !emitted.has(n))
        .map((n) => ({ node: n, decoration: decorationOf(n) }))
        .filter((i) => paintShapes(i.decoration).length > 0)
      if (inlines.length === 0) {
        shapes.push(textShape(node, d, paragraphs, true), ...d.edges)
      } else {
        shapes.push(...paintShapes(d))
        for (const inline of inlines) {
          shapes.push(...paintShapes(inline.decoration))
          emitted.add(inline.node)
          note(inline.node, inline.decoration.covered)
        }
        shapes.push(textShape(node, d, paragraphs, false))
      }
      note(node, d.covered)
      continue
    }

    const painted = paintShapes(d)
    if (painted.length > 0) {
      shapes.push(...painted)
      note(node, d.covered)
    } else if (!d.covered) {
      // A gradient/image background paints pixels the pure walk does not have: its area counts as
      // uncovered (and the scorer deducts for it).
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
    .map(renderedBlockText)
    .filter((text) => text.trim() !== '')
    .join('\n')
    .trim()
}
