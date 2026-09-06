/**
 * Read a `.pptx` back into the few facts the fidelity targets are stated over: per slide, the
 * background kind, and per shape the EMU box, rotation, geometry, fill/line colour and text runs
 * (text, colour, size, bold, italic). This is the in-repo stand-in for the python-pptx oracle the
 * research used (§0), so the structural targets run in vitest with no Python and no app.
 *
 * It parses pptxgenjs's own output, which is regular enough for anchored patterns; it is not a
 * general OOXML reader and must not be used as one.
 */

import { strFromU8, unzipSync } from 'fflate'
import { EMU_PER_CSS_PX } from '../../../src/shared/export/pptx/geometry'
import { SLIDE_HEIGHT_PX, SLIDE_WIDTH_PX } from '../../../src/shared/export/types'

export type ReadbackRun = {
  text: string
  /** 6-digit uppercase hex, or null when the run inherits. */
  color: string | null
  sizePt: number | null
  bold: boolean
  underline: boolean
  /** Alpha the run paints at, 0–1, from `<a:alpha>`; 1 when the fill is fully opaque. */
  opacity: number
}

export type ReadbackShape = {
  kind: 'sp' | 'pic'
  /** `prstGeom` name (`rect`, `roundRect`, `ellipse`, `line`) or null. */
  geom: string | null
  /** Box in CSS px (EMU / 9525). */
  x: number
  y: number
  w: number
  h: number
  /** Clockwise degrees in [0, 360). */
  rot: number
  runs: ReadbackRun[]
  /** All run text joined, whitespace-normalized. */
  text: string
  /**
   * The text as PowerPoint lays it out, one entry per visual line: paragraphs (`<a:p>`) and soft
   * breaks (`<a:br/>`) both end a line; run text is joined RAW, so a doubled or eaten space between
   * two runs is visible here and not in `text` (M4.8b).
   */
  lines: string[]
  /** `<a:bodyPr>` left/top insets in CSS px — where the first run starts inside the box. */
  insetLeft: number
  insetTop: number
  /** `<a:bodyPr anchor>`: `t`/`ctr`/`b`, or null when absent. */
  anchor: string | null
  /**
   * The first paragraph's `<a:lnSpc><a:spcPct>` as a multiple (1.6 for `val="160000"`), or null
   * when the paragraph has no line spacing — PowerPoint's single spacing (M4.8b r1).
   */
  lineSpacing: number | null
  fill: string | null
  /** Alpha of the shape fill, 0–1. */
  fillOpacity: number
  line: string | null
  /** True when the shape carries an outer shadow (`<a:outerShdw>`). */
  hasOuterShadow: boolean
  /**
   * Paragraphs carrying a bullet glyph (`<a:buChar>`) or auto-number (`<a:buAutoNum>`). Parsed so
   * `assess.ts` can see a bullet the reader never had — a `list-style: none` chip row used to ship
   * three of them with nothing in the metric able to notice (review r2).
   */
  bullets: number
}

export type ReadbackSlide = {
  index: number
  background: 'none' | 'solid' | 'picture'
  shapes: ReadbackShape[]
  /** Pictures covering the whole 1280×720 slide (±1 px). */
  fullBleedPictures: number
}

const OOXML_ROT_PER_DEGREE = 60000

export function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

function unescapeXml(text: string): string {
  return text
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

function attr(tag: string, name: string): string | null {
  const m = new RegExp(`\\s${name}="([^"]*)"`).exec(tag)
  return m?.[1] ?? null
}

function emuAttrToPx(value: string | null): number {
  return value === null ? 0 : parseInt(value, 10) / EMU_PER_CSS_PX
}

function firstSrgb(xml: string): string | null {
  const m = /<a:srgbClr val="([0-9A-Fa-f]{6})"/.exec(xml)
  return m?.[1]?.toUpperCase() ?? null
}

/**
 * The alpha of the first colour in `xml`, 0–1. pptxgenjs writes `transparency: t` as
 * `<a:alpha val="(100 − t) × 1000"/>` and omits the element entirely when opaque.
 */
function firstAlpha(xml: string): number {
  const m = /<a:alpha val="(\d+)"\s*\/>/.exec(xml)
  return m?.[1] === undefined ? 1 : parseInt(m[1], 10) / 100000
}

/** The first paragraph's percentage line spacing, as a multiple; null when it carries none. */
function parseLineSpacing(txBody: string): number | null {
  const pPr = /<a:pPr\b[\s\S]*?<\/a:pPr>/.exec(txBody)?.[0] ?? ''
  const m = /<a:lnSpc><a:spcPct val="(\d+)"\/><\/a:lnSpc>/.exec(pPr)
  return m?.[1] === undefined ? null : parseInt(m[1], 10) / 100000
}

/** Visual lines: each `<a:p>` is one or more lines, split again at every `<a:br/>`. */
function parseLines(txBody: string): string[] {
  const lines: string[] = []
  for (const p of txBody.matchAll(/<a:p>([\s\S]*?)<\/a:p>/g)) {
    for (const segment of (p[1] ?? '').split(/<a:br\s*\/>/)) {
      lines.push(
        [...segment.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)]
          .map((t) => unescapeXml(t[1] ?? ''))
          .join(''),
      )
    }
  }
  return lines
}

function parseRuns(txBody: string): ReadbackRun[] {
  const runs: ReadbackRun[] = []
  for (const m of txBody.matchAll(/<a:r>([\s\S]*?)<\/a:r>/g)) {
    const body = m[1] ?? ''
    const rPrTag = /<a:rPr\b[^>]*>/.exec(body)?.[0] ?? ''
    const rPrBlock = /<a:rPr\b[\s\S]*?<\/a:rPr>/.exec(body)?.[0] ?? ''
    const text = /<a:t>([\s\S]*?)<\/a:t>/.exec(body)?.[1] ?? ''
    const sz = attr(rPrTag, 'sz')
    runs.push({
      text: unescapeXml(text),
      color: firstSrgb(rPrBlock),
      sizePt: sz === null ? null : parseInt(sz, 10) / 100,
      bold: attr(rPrTag, 'b') === '1',
      underline: attr(rPrTag, 'u') === 'sng',
      opacity: firstAlpha(rPrBlock),
    })
  }
  return runs
}

function parseShape(kind: 'sp' | 'pic', xml: string): ReadbackShape | null {
  const xfrm = /<a:xfrm\b[^>]*>[\s\S]*?<\/a:xfrm>/.exec(xml)?.[0]
  if (xfrm === undefined) return null
  const xfrmTag = /<a:xfrm\b[^>]*>/.exec(xfrm)?.[0] ?? ''
  const off = /<a:off\b[^>]*>/.exec(xfrm)?.[0] ?? ''
  const ext = /<a:ext\b[^>]*>/.exec(xfrm)?.[0] ?? ''
  const rotRaw = attr(xfrmTag, 'rot')
  const rot = rotRaw === null ? 0 : parseInt(rotRaw, 10) / OOXML_ROT_PER_DEGREE
  const spPr = /<p:spPr\b[\s\S]*?<\/p:spPr>/.exec(xml)?.[0] ?? ''
  // An outer shadow's colour sits in `<a:effectLst>` inside `<a:spPr>`; a shape with no solid fill
  // would otherwise report the SHADOW's colour as its fill, and `carrierOf` would pair a painted box
  // against it. Stripped for the line read too, symmetrically with `fillOpacity` below.
  const spPrNoLine = spPr
    .replace(/<a:ln\b[\s\S]*?<\/a:ln>/, '')
    .replace(/<a:effectLst>[\s\S]*?<\/a:effectLst>/, '')
  const ln = /<a:ln\b[\s\S]*?<\/a:ln>/.exec(spPr)?.[0] ?? ''
  const txBody = /<p:txBody>[\s\S]*?<\/p:txBody>/.exec(xml)?.[0] ?? ''
  const runs = parseRuns(txBody)
  const bodyPr = /<a:bodyPr\b[^>]*>/.exec(txBody)?.[0] ?? ''
  return {
    kind,
    geom: /<a:prstGeom prst="([^"]+)"/.exec(spPr)?.[1] ?? null,
    x: emuAttrToPx(attr(off, 'x')),
    y: emuAttrToPx(attr(off, 'y')),
    w: emuAttrToPx(attr(ext, 'cx')),
    h: emuAttrToPx(attr(ext, 'cy')),
    rot: ((rot % 360) + 360) % 360,
    runs,
    text: normalizeWhitespace(runs.map((r) => r.text).join('')),
    lines: parseLines(txBody),
    insetLeft: emuAttrToPx(attr(bodyPr, 'lIns')),
    insetTop: emuAttrToPx(attr(bodyPr, 'tIns')),
    anchor: attr(bodyPr, 'anchor'),
    lineSpacing: parseLineSpacing(txBody),
    fill: firstSrgb(spPrNoLine),
    fillOpacity: firstAlpha(spPrNoLine),
    line: ln === '' ? null : firstSrgb(ln),
    hasOuterShadow: /<a:outerShdw\b/.test(spPr),
    bullets: [...txBody.matchAll(/<a:buChar\b|<a:buAutoNum\b/g)].length,
  }
}

function backgroundKind(slideXml: string): ReadbackSlide['background'] {
  const bg = /<p:bg>[\s\S]*?<\/p:bg>/.exec(slideXml)?.[0]
  if (bg === undefined) return 'none'
  if (/<a:blipFill/.test(bg) || /<a:blip\b/.test(bg)) return 'picture'
  return 'solid'
}

function isFullBleed(shape: ReadbackShape): boolean {
  return (
    shape.kind === 'pic' &&
    Math.abs(shape.x) <= 1 &&
    Math.abs(shape.y) <= 1 &&
    Math.abs(shape.w - SLIDE_WIDTH_PX) <= 1 &&
    Math.abs(shape.h - SLIDE_HEIGHT_PX) <= 1
  )
}

function readbackSlideXml(index: number, slideXml: string): ReadbackSlide {
  const shapes: ReadbackShape[] = []
  for (const m of slideXml.matchAll(/<p:(sp|pic)\b[\s\S]*?<\/p:\1>/g)) {
    const shape = parseShape(m[1] === 'pic' ? 'pic' : 'sp', m[0])
    if (shape !== null) shapes.push(shape)
  }
  return {
    index,
    background: backgroundKind(slideXml),
    shapes,
    fullBleedPictures: shapes.filter(isFullBleed).length,
  }
}

/** Every `ppt/slides/slideN.xml` in the package, in slide order. */
export function readbackPptx(bytes: Uint8Array): ReadbackSlide[] {
  const parts = unzipSync(bytes)
  const names = Object.keys(parts)
    .map((name) => /^ppt\/slides\/slide(\d+)\.xml$/.exec(name))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => ({ name: m[0], index: parseInt(m[1] ?? '0', 10) }))
    .toSorted((a, b) => a.index - b.index)
  return names.map(({ name, index }) => readbackSlideXml(index, strFromU8(parts[name]!)))
}
