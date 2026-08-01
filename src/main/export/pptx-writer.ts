/**
 * The pptxgenjs emission edge (M4.3 / 60-export.md §3.7). This is the *only* module that imports
 * pptxgenjs; it turns a fully-decided `DeckPptxPlan` (produced by the pure planner) into a `.pptx`
 * byte buffer. Because pptxgenjs is pure JS with no `electron` dependency, this module is unit-tested
 * directly: a test builds a plan, calls `writeDeckPptx`, unzips the result with fflate, and asserts on
 * the OPC parts — the `[Content_Types].xml`, one `ppt/slides/slideN.xml` per slide, `<a:t>` text on
 * structured slides, and a `ppt/media/*` image on raster slides. The orchestrator sees it only through
 * the injected `PptxWriter` seam, so its own logic can be tested with a fake writer.
 *
 * The layout is defined to the exact 16:9 slide box (13.333in × 7.5in = the 1280×720 slide at 96 dpi),
 * so positions handed over in inches by the walker land pixel-for-pixel. No slide master is used
 * (§3.7): Sloodge slides are independently authored and carry their own backgrounds.
 *
 * ## XML sanitization — EVERY inbound string, not just slide text
 *
 * OOXML parts are XML 1.0, and pptxgenjs writes our strings through verbatim apart from the five
 * metacharacters. So **every** value that originates from agent- or user-authored text is passed
 * through `sanitizeXmlText` here: text runs, hyperlink URLs, speaker notes, *and the deck metadata*
 * (`pptx.title` / `pptx.author` → `docProps/core.xml`). Round 1 covered only the slide/notes parts,
 * which left the metadata path able to produce the identical silent corruption; the writer test now
 * scans **every** `.xml`/`.rels` part in the produced zip so a newly-added property cannot regress
 * this class unnoticed. If you add another pptxgenjs property fed from our data, sanitize it here.
 */

import PptxGenJS from 'pptxgenjs'
import { SLIDE_HEIGHT_INCHES, SLIDE_WIDTH_INCHES } from '../../shared/export/types'
import { sanitizeXmlText } from '../../shared/export/pptx/sanitize'
import type {
  DeckPptxPlan,
  ShapeSpec,
  SlidePlan,
  TextRunSpec,
} from '../../shared/export/pptx/types'

/** The seam the orchestrator drives; the fake in tests returns canned bytes. */
export type PptxWriter = {
  write: (plan: DeckPptxPlan) => Promise<Uint8Array>
}

const LAYOUT_NAME = 'SLOODGE_16x9'

type PptxSlide = ReturnType<PptxGenJS['addSlide']>

function fillOpt(
  fill: { color: string; transparency?: number } | undefined,
): { color: string; transparency?: number } | undefined {
  if (fill === undefined) return undefined
  return fill.transparency !== undefined
    ? { color: fill.color, transparency: fill.transparency }
    : { color: fill.color }
}

function runOptions(run: TextRunSpec): Record<string, unknown> {
  return {
    ...(run.bold === true ? { bold: true } : {}),
    ...(run.italic === true ? { italic: true } : {}),
    ...(run.underline === true ? { underline: true } : {}),
    ...(run.strike === true ? { strike: true } : {}),
    ...(run.color !== undefined ? { color: run.color } : {}),
    ...(run.fontFace !== undefined ? { fontFace: run.fontFace } : {}),
    ...(run.fontSize !== undefined ? { fontSize: run.fontSize } : {}),
    ...(run.bullet !== undefined ? { bullet: run.bullet } : {}),
    ...(run.hyperlink !== undefined ? { hyperlink: { url: sanitizeXmlText(run.hyperlink) } } : {}),
  }
}

function lineProps(line: {
  color: string
  width: number
  dashType?: 'solid' | 'dash'
}): Record<string, unknown> {
  return { color: line.color, width: line.width, dashType: line.dashType ?? 'solid' }
}

function addShape(slide: PptxSlide, shape: ShapeSpec): void {
  const { box } = shape
  if (shape.kind === 'text') {
    const opts: Record<string, unknown> = {
      x: box.x,
      y: box.y,
      w: box.w,
      h: box.h,
      align: shape.align,
      valign: shape.valign,
      margin: 0,
      wrap: true,
      shrinkText: false,
      ...(fillOpt(shape.fill) !== undefined ? { fill: fillOpt(shape.fill) } : {}),
      ...(shape.lineSpacingMultiple !== undefined
        ? { lineSpacingMultiple: shape.lineSpacingMultiple }
        : {}),
      ...(shape.charSpacing !== undefined ? { charSpacing: shape.charSpacing } : {}),
    }
    slide.addText(
      shape.runs.map((run) => ({ text: sanitizeXmlText(run.text), options: runOptions(run) })),
      opts,
    )
    return
  }

  if (shape.kind === 'line') {
    slide.addShape('line', { x: box.x, y: box.y, w: box.w, h: box.h, line: lineProps(shape.line) })
    return
  }

  if (shape.kind === 'image') {
    slide.addImage({ data: shape.dataUrl, x: box.x, y: box.y, w: box.w, h: box.h })
    return
  }

  // rect | roundRect | ellipse. pptxgenjs `rectRadius` is in inches; our spec carries a fraction of
  // the shorter side, so scale it back to inches here.
  const opts: Record<string, unknown> = {
    x: box.x,
    y: box.y,
    w: box.w,
    h: box.h,
    ...(fillOpt(shape.fill) !== undefined ? { fill: fillOpt(shape.fill) } : {}),
    ...(shape.line !== undefined ? { line: lineProps(shape.line) } : {}),
    ...(shape.rotate !== undefined ? { rotate: shape.rotate } : {}),
    ...(shape.kind === 'roundRect' && shape.rectRadius !== undefined
      ? { rectRadius: shape.rectRadius * Math.min(box.w, box.h) }
      : {}),
  }
  slide.addShape(shape.kind, opts)
}

function addSlideToDeck(pptx: PptxGenJS, plan: SlidePlan): void {
  const slide = pptx.addSlide()

  if (plan.background !== undefined) {
    slide.background =
      'dataUrl' in plan.background
        ? { data: plan.background.dataUrl }
        : { color: plan.background.color }
  }

  if (plan.tier === 'raster' && plan.rasterDataUrl !== undefined) {
    slide.addImage({
      data: plan.rasterDataUrl,
      x: 0,
      y: 0,
      w: SLIDE_WIDTH_INCHES,
      h: SLIDE_HEIGHT_INCHES,
    })
  } else {
    for (const shape of plan.shapes) addShape(slide, shape)
  }

  if (plan.notes !== '') slide.addNotes(sanitizeXmlText(plan.notes))
}

/**
 * Emit a whole deck to `.pptx` bytes. Slide order is plan order. The buffer is written with
 * `outputType: 'nodebuffer'`, then normalized to a `Uint8Array` for the atomic writer.
 */
export async function writeDeckPptx(plan: DeckPptxPlan): Promise<Uint8Array> {
  const pptx = new PptxGenJS()
  pptx.defineLayout({ name: LAYOUT_NAME, width: SLIDE_WIDTH_INCHES, height: SLIDE_HEIGHT_INCHES })
  pptx.layout = LAYOUT_NAME
  // Deck METADATA is agent-settable text too (the deck title comes from the agent's `set_title`
  // tool), and pptxgenjs writes it verbatim into `docProps/core.xml` (`<dc:title>`/`<dc:creator>`).
  // An unsanitized control char there malforms that part and PowerPoint calls the whole file corrupt
  // — the same silent failure as slide text, just via a part the first fix did not cover.
  pptx.author = sanitizeXmlText(plan.author)
  pptx.title = sanitizeXmlText(plan.title)

  for (const slidePlan of plan.slides) addSlideToDeck(pptx, slidePlan)

  const out = (await pptx.write({ outputType: 'nodebuffer' })) as Buffer
  return new Uint8Array(out.buffer, out.byteOffset, out.byteLength)
}

/** The production writer seam. */
export function createPptxWriter(): PptxWriter {
  return { write: writeDeckPptx }
}
