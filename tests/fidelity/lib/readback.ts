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
  fill: string | null
  line: string | null
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
  const spPrNoLine = spPr.replace(/<a:ln\b[\s\S]*?<\/a:ln>/, '')
  const ln = /<a:ln\b[\s\S]*?<\/a:ln>/.exec(spPr)?.[0] ?? ''
  const txBody = /<p:txBody>[\s\S]*?<\/p:txBody>/.exec(xml)?.[0] ?? ''
  const runs = parseRuns(txBody)
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
    fill: firstSrgb(spPrNoLine),
    line: ln === '' ? null : firstSrgb(ln),
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
