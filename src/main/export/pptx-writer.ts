/**
 * The pptxgenjs emission edge (M4.3 / 60-export.md §3.7). It turns a fully-decided `DeckPptxPlan`
 * (produced by the pure planner) into a `.pptx` byte buffer — through `SafePptxDeck`, which is the
 * module that actually imports pptxgenjs (see the sanitization note below; this docstring used to
 * claim that role for itself, left stale when M4.3 extracted the boundary).
 *
 * Because pptxgenjs is pure JS with no `electron` dependency, this module is unit-tested directly: a
 * test builds a plan, calls `writeDeckPptx`, unzips the result with fflate, and asserts on
 * the OPC parts — the `[Content_Types].xml`, one `ppt/slides/slideN.xml` per slide, `<a:t>` text on
 * structured slides, and a `ppt/media/*` image on raster slides. The orchestrator sees it only through
 * the injected `PptxWriter` seam, so its own logic can be tested with a fake writer.
 *
 * The layout is defined to the exact 16:9 slide box (13.333in × 7.5in = the 1280×720 slide at 96 dpi),
 * so positions handed over in inches by the walker land pixel-for-pixel. No slide master is used
 * (§3.7): Sloodge slides are independently authored and carry their own backgrounds.
 *
 * ## XML sanitization is NOT done here
 *
 * This module builds plain option objects and hands them to `SafePptxDeck` (`safe-pptx.ts`), the sole
 * module allowed to touch pptxgenjs, which deep-sanitizes every string it forwards. Three review
 * rounds each found a *different* unsanitized path when the rule lived at call sites (slide text, then
 * `pptx.title`/`pptx.author`, then a run's `fontFace`), so the rule moved to a boundary that cannot be
 * bypassed: a field added to any option object below is sanitized automatically, and a
 * `tests/unit/export/pptx-boundary.test.ts` grep fails the build if anything else imports pptxgenjs.
 * Do not add `sanitizeXmlText` calls here — the boundary owns it.
 */

import { SLIDE_HEIGHT_INCHES, SLIDE_WIDTH_INCHES } from '../../shared/export/types'
import { MAX_IMAGE_DATA_URL_BYTES, isImageDataUrl } from '../../shared/export/pptx/image'
import { createSafePptxDeck, type SafePptxSlide } from './safe-pptx'
import type {
  DeckPptxPlan,
  LineSpec,
  ShadowSpec,
  ShapeSpec,
  SlidePlan,
  TextRunSpec,
} from '../../shared/export/pptx/types'

/** The seam the orchestrator drives; the fake in tests returns canned bytes. */
export type PptxWriter = {
  write: (plan: DeckPptxPlan) => Promise<Uint8Array>
}

const LAYOUT_NAME = 'SLOODGE_16x9'

type PptxSlide = SafePptxSlide

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
    ...(run.transparency !== undefined ? { transparency: run.transparency } : {}),
    ...(run.fontFace !== undefined ? { fontFace: run.fontFace } : {}),
    ...(run.fontSize !== undefined ? { fontSize: run.fontSize } : {}),
    ...(run.bullet !== undefined ? { bullet: run.bullet } : {}),
    ...(run.hyperlink !== undefined ? { hyperlink: { url: run.hyperlink } } : {}),
  }
}

/**
 * Every picture the writer embeds comes from our own `capturePage`, so a string that is not a PNG/JPEG
 * data URL within bounds is a pipeline defect. Thrown, not skipped: the orchestrator lets writer errors
 * propagate rather than write a package with a broken media part.
 */
function checkedImage(dataUrl: string, what: string): string {
  if (!isImageDataUrl(dataUrl)) {
    throw new Error(
      `${what} must be a PNG/JPEG data URL of at most ${String(MAX_IMAGE_DATA_URL_BYTES)} bytes`,
    )
  }
  return dataUrl
}

function lineProps(line: LineSpec): Record<string, unknown> {
  return {
    color: line.color,
    width: line.width,
    dashType: line.dashType ?? 'solid',
    ...(line.transparency !== undefined ? { transparency: line.transparency } : {}),
  }
}

/**
 * pptxgenjs substitutes its own defaults for any falsy shadow field (`angle || 270`, `blur || 8`,
 * `offset || 4`), so a shadow cast straight right (angle 0) or a sharp one (blur 0) would silently
 * change direction or soften. A hair above zero keeps the value ours; it rounds to a few EMU.
 */
const nonZero = (v: number): number => (v === 0 ? 1e-3 : v)

function shadowProps(shadow: ShadowSpec): Record<string, unknown> {
  return {
    type: 'outer',
    color: shadow.color,
    blur: nonZero(shadow.blurPt),
    offset: nonZero(shadow.offsetPt),
    angle: nonZero(shadow.angleDeg),
    opacity: nonZero(shadow.opacity),
  }
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
      ...(shape.line !== undefined ? { line: lineProps(shape.line) } : {}),
      ...(shape.shadow !== undefined ? { shadow: shadowProps(shape.shadow) } : {}),
      ...(shape.rotate !== undefined ? { rotate: shape.rotate } : {}),
      // A text box is itself a shape in pptxgenjs: give it roundRect geometry for a CSS radius.
      ...(shape.rectRadius !== undefined
        ? { shape: 'roundRect', rectRadius: shape.rectRadius * Math.min(box.w, box.h) }
        : {}),
      ...(shape.lineSpacingMultiple !== undefined
        ? { lineSpacingMultiple: shape.lineSpacingMultiple }
        : {}),
      ...(shape.charSpacing !== undefined ? { charSpacing: shape.charSpacing } : {}),
    }
    slide.addText(
      shape.runs.map((run) => ({ text: run.text, options: runOptions(run) })),
      opts,
    )
    return
  }

  if (shape.kind === 'line') {
    slide.addShape('line', { x: box.x, y: box.y, w: box.w, h: box.h, line: lineProps(shape.line) })
    return
  }

  if (shape.kind === 'image') {
    slide.addImage({
      data: checkedImage(shape.dataUrl, 'image shape'),
      x: box.x,
      y: box.y,
      w: box.w,
      h: box.h,
    })
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
    ...(shape.shadow !== undefined ? { shadow: shadowProps(shape.shadow) } : {}),
    ...(shape.rotate !== undefined ? { rotate: shape.rotate } : {}),
    ...(shape.kind === 'roundRect' && shape.rectRadius !== undefined
      ? { rectRadius: shape.rectRadius * Math.min(box.w, box.h) }
      : {}),
  }
  slide.addShape(shape.kind, opts)
}

function addSlideToDeck(deck: ReturnType<typeof createSafePptxDeck>, plan: SlidePlan): void {
  const slide = deck.addSlide()

  if (plan.background !== undefined) {
    slide.setBackground(
      'dataUrl' in plan.background
        ? { data: checkedImage(plan.background.dataUrl, 'slide background') }
        : { color: plan.background.color },
    )
  }

  if (plan.tier === 'raster' && plan.rasterDataUrl !== undefined) {
    slide.addImage({
      data: checkedImage(plan.rasterDataUrl, 'raster slide'),
      x: 0,
      y: 0,
      w: SLIDE_WIDTH_INCHES,
      h: SLIDE_HEIGHT_INCHES,
    })
  } else {
    for (const shape of plan.shapes) addShape(slide, shape)
  }

  if (plan.notes !== '') slide.addNotes(plan.notes)
}

/**
 * Emit a whole deck to `.pptx` bytes. Slide order is plan order. The buffer is written with
 * `outputType: 'nodebuffer'`, then normalized to a `Uint8Array` for the atomic writer.
 */
export async function writeDeckPptx(plan: DeckPptxPlan): Promise<Uint8Array> {
  // Everything below goes through `SafePptxDeck`, which deep-sanitizes every string it forwards
  // (including the deck metadata and per-run option fields like `fontFace`). This module therefore
  // carries no sanitize calls of its own — the boundary owns that rule, so a new field added here
  // cannot bypass it. See `safe-pptx.ts` for why the invariant is structural rather than reviewed.
  const deck = createSafePptxDeck({
    layoutName: LAYOUT_NAME,
    widthInches: SLIDE_WIDTH_INCHES,
    heightInches: SLIDE_HEIGHT_INCHES,
    author: plan.author,
    title: plan.title,
  })

  for (const slidePlan of plan.slides) addSlideToDeck(deck, slidePlan)

  return deck.write()
}

/** The production writer seam. */
export function createPptxWriter(): PptxWriter {
  return { write: writeDeckPptx }
}
