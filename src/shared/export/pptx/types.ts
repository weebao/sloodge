/**
 * PPTX export types (M4.3 / 60-export.md §3), shared by the pure walker/scorer, the pptxgenjs writer,
 * and the renderer/preload wire. `src/shared` stays dependency-free: types only, no runtime imports.
 *
 * The design is two-tier with a per-slide decision (§3.1): **structured** conversion emits real,
 * editable PowerPoint shapes (`ShapeSpec[]`), and **raster** fallback places one full-slide PNG. The
 * `ShapeSpec` union is deliberately decoupled from the pptxgenjs API so the walker that produces it is
 * unit-testable without importing pptxgenjs, and the writer that consumes it is the only place the
 * library is touched.
 */

import type { SlideExportInput, SlideRange } from '../types'

/** A box in inches — pptxgenjs's positioning unit. Produced by `boxToInches` (geometry.ts). */
export type BoxInches = { x: number; y: number; w: number; h: number }

/** A solid fill: `color` is 6-digit uppercase hex; `transparency` is 0 (opaque) – 100 (invisible). */
export type FillSpec = { color: string; transparency?: number }

/** A shape outline: `color` hex, `width` in points. */
export type LineSpec = { color: string; width: number; dashType?: 'solid' | 'dash' }

/** One styled run inside a text box. `fontSize` is in points; `color` is 6-digit hex. */
export type TextRunSpec = {
  text: string
  bold?: boolean
  italic?: boolean
  underline?: boolean
  strike?: boolean
  color?: string
  fontFace?: string
  fontSize?: number
  bullet?: boolean | { type: 'number' }
  hyperlink?: string
}

export type TextAlign = 'left' | 'center' | 'right' | 'justify'

/**
 * A single emitted PowerPoint object. `text` becomes an editable text box; the geometric kinds become
 * autoshapes; `image` becomes an embedded picture (used for the raster fallback and, later, sub-region
 * rasterization). Every box is in inches, already mapped from the 1280×720 space.
 */
export type ShapeSpec =
  | {
      kind: 'text'
      box: BoxInches
      runs: TextRunSpec[]
      align: TextAlign
      valign: 'top' | 'middle' | 'bottom'
      fill?: FillSpec
      /** A rounded backing shape behind the text; PowerPoint text boxes cannot be rounded directly. */
      rounded?: boolean
      lineSpacingMultiple?: number
      charSpacing?: number
    }
  | {
      kind: 'rect' | 'roundRect' | 'ellipse'
      box: BoxInches
      fill?: FillSpec
      line?: LineSpec
      /** Corner radius as a fraction (0–1) of the shorter side, for `roundRect`. */
      rectRadius?: number
      /** Clockwise rotation in degrees, from a `transform: rotate()`. */
      rotate?: number
    }
  | { kind: 'line'; box: BoxInches; line: LineSpec }
  | { kind: 'image'; box: BoxInches; dataUrl: string }

/** The user's fidelity choice from the export dialog (§3.8). `auto` decides per slide by score. */
export type PptxFidelity = 'auto' | 'editable' | 'raster'

/** The tier chosen for one slide: editable shapes, or a flat picture. */
export type SlideTier = 'structured' | 'raster'

/** The plan for one slide — everything the writer needs, with no residual DOM or `electron` in it. */
export type SlidePlan = {
  tier: SlideTier
  /** Slide background: a solid colour, a full-bleed image (gradient/photo body bg), or nothing. */
  background?: FillSpec | { dataUrl: string }
  /** Structured shapes (`tier: 'structured'`). Empty for a raster slide. */
  shapes: ShapeSpec[]
  /** The full-slide PNG data URL (`tier: 'raster'`). */
  rasterDataUrl?: string
  /** Speaker notes: the slide's visible text (accessibility) plus any degradation note (§3.5). */
  notes: string
  /** 0–100 confidence from the scorer; recorded for the report even on a forced tier. */
  confidence: number
  /** Human-readable reasons the tier/score came out as it did. */
  reasons: string[]
}

/** The whole deck, ready for the pptxgenjs writer. */
export type DeckPptxPlan = { title: string; author: string; slides: SlidePlan[] }

/** The request the renderer sends to start a PPTX export. Mirrors `ExportPdfRequest` + `fidelity`. */
export type ExportPptxRequest = {
  slides: SlideExportInput[]
  currentIndex: number
  range: SlideRange
  deckTitle: string
  fidelity: PptxFidelity
}

/** Per-slide outcome in the PPTX report. */
export type PptxSlideOutcome = {
  index: number
  title: string
  status: 'ok' | 'failed'
  tier?: SlideTier
  confidence?: number
  notes: string[]
  error?: string
}

/**
 * What a PPTX export produced. `slideCount` is the resolved range (attempted); `emittedSlideCount` is
 * read back from the written `.pptx` by unzipping and counting `ppt/slides/slideN.xml` parts, so it is
 * proof the file is real rather than a claim — a passing export has it equal to the number of `ok`
 * slides.
 */
export type PptxExportReport = {
  format: 'pptx'
  outPath: string
  slideCount: number
  emittedSlideCount: number
  slides: PptxSlideOutcome[]
  warnings: string[]
}

/** The bridge response. `canceled` is the save-dialog dismissal; `report: null` = nothing written. */
export type ExportPptxResponse =
  { canceled: true } | { canceled: false; report: PptxExportReport | null }
