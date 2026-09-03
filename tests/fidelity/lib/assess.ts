/**
 * The §5.2 fidelity targets, computed from three inputs per slide: the independent ground truth,
 * the exporter's measurement pass, and the `.pptx` read back from disk. Every number the milestone
 * reports comes from here — the same function feeds the local harness's table and the vitest corpus
 * assertions, so "the harness measured X" and "the test asserts X" cannot drift apart.
 */

import { SLIDE_HEIGHT_PX, SLIDE_WIDTH_PX } from '../../../src/shared/export/types'
import { pxToPoints } from '../../../src/shared/export/pptx/geometry'
import type { MeasureResult, SlideNode } from '../../../src/shared/export/pptx/node'
import type { SlideTier } from '../../../src/shared/export/pptx/types'
import type { CorpusSlide } from './corpus'
import { normalizeWhitespace, type ReadbackShape, type ReadbackSlide } from './readback'
import type { GroundTruth, TruthText } from './truth'

/** A slide at or above this confidence is trusted to be structured; losing a construct here is the lie. */
export const HIGH_CONFIDENCE = 90
/** Rotation must land within this many degrees of the authored angle. */
export const ROTATION_TOLERANCE_DEG = 0.1
/** Emitted box vs DOM box: worst deviation allowed, as a percentage of the slide dimension. */
export const BOX_TOLERANCE_PCT = 0.5
/** Font size must match to this many points (`px * 0.75`). */
export const SIZE_TOLERANCE_PT = 0.02

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
    const wantPt = pxToPoints(t.fontSizePx)
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

  const constructsLost: string[] = []
  if (structured) {
    for (const t of lostText) constructsLost.push(`text: ${t}`)
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
    `| Rotated elements carrying a correct \`rot\` (±${String(ROTATION_TOLERANCE_DEG)}°) | ${String(s.rotationsOk)}/${String(s.rotationsExpected)} |`,
    `| Gradient/image body backgrounds preserved | ${String(s.bodyImagePreserved)}/${String(s.bodyImageSlides)} |`,
    `| Slides scoring ≥ ${String(HIGH_CONFIDENCE)} that drop a construct | ${String(s.silentLies.length)}/${String(s.slides)}${s.silentLies.length > 0 ? ` (${s.silentLies.join(', ')})` : ''} |`,
  ].join('\n')
}

/** Per-slide rows, as Markdown. */
export function formatSlides(assessments: readonly SlideAssessment[]): string {
  const rows = assessments.map((a) => {
    const lost = a.constructsLost.length === 0 ? '' : a.constructsLost.join('; ')
    return `| ${a.file} | ${a.tier} | ${String(a.score)} | ${a.tier === 'structured' ? `${String(a.textKept)}/${String(a.textTotal)}` : `raster (${String(a.textTotal)} in source)`} | ${String(a.rotationsOk)}/${String(a.rotationsExpected)} | ${a.bodyImageExpected ? (a.bodyImagePreserved ? 'kept' : 'LOST') : '—'} | ${a.boxWorstPct.toFixed(3)}% | ${a.silentLie ? '**YES**' : 'no'} | ${lost} |`
  })
  return [
    '| Slide | Tier | Score | Text kept | Rot | Body bg | Box worst | Silent lie | Lost |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...rows,
  ].join('\n')
}
