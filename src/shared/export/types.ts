/**
 * Export types and the exact geometry constants, shared by all three build targets (M4.2).
 *
 * `src/shared` stays dependency-free: this file is types plus a handful of `as const` numbers, no
 * runtime imports. The PDF pipeline itself (pdf-lib, the offscreen window, `printToPDF`) lives in
 * `src/main/export`; the renderer only assembles a request and the preload only forwards it.
 *
 * ## Why the geometry is a constant, not an option
 *
 * A slide is a self-contained 1280×720 document (30-slide-format.md §0). 1280 / 720 CSS px at
 * Chromium's 96 dpi print baseline is exactly 13.333in × 7.5in, which is 960 × 540 PostScript points
 * (× 72). No scaling is ever needed, so page size, margins and `printBackground` are locked here
 * rather than exposed — every one of them can only make the output wrong (60-export.md §2.5).
 */

/** Chromium's print baseline: CSS pixels are 96 per inch. */
export const CSS_PX_PER_INCH = 96
/** PDF/PostScript user-space unit: 72 points per inch. */
export const PDF_POINTS_PER_INCH = 72

/** The slide canvas, in CSS px (mirrors `CANVAS_WIDTH`/`CANVAS_HEIGHT` in document/types.ts). */
export const SLIDE_WIDTH_PX = 1280
export const SLIDE_HEIGHT_PX = 720

/** The slide as a PDF page: 1280 px → 13.333…in, 720 px → 7.5in. Exact, DPR-independent. */
export const SLIDE_WIDTH_INCHES = SLIDE_WIDTH_PX / CSS_PX_PER_INCH
export const SLIDE_HEIGHT_INCHES = SLIDE_HEIGHT_PX / CSS_PX_PER_INCH

/** The slide's page box in PDF points: 1280 × 0.75 = 960, 720 × 0.75 = 540. */
export const SLIDE_WIDTH_PT = (SLIDE_WIDTH_PX * PDF_POINTS_PER_INCH) / CSS_PX_PER_INCH
export const SLIDE_HEIGHT_PT = (SLIDE_HEIGHT_PX * PDF_POINTS_PER_INCH) / CSS_PX_PER_INCH

/**
 * Chromium rounds the page box it emits at ~13.333in to the nearest hundredth of an inch, so the
 * measured PDF box is within a fraction of a point of 960 × 540 rather than exactly it. The
 * geometry check (`merge.ts`) allows this slack; anything wider means `preferCSSPageSize` /
 * `@page` injection failed and the export is a genuinely mis-sized document.
 */
export const PDF_PAGE_SIZE_TOLERANCE_PT = 2

/**
 * One slide to export: its title (for the report and, later, the outline) and the *wrapped* HTML —
 * the exact bytes the editor canvas publishes to `slide://` (`wrapSlideHtml`), so the offscreen
 * print renders byte-identically to what the user saw. The renderer wraps because `wrapSlideHtml`
 * is renderer code main may not import; main serves whatever it is handed over the same registry.
 */
export type SlideExportInput = {
  title: string
  html: string
  /**
   * The deck slide id, optional because PDF has no use for it — a PDF page has no identity to carry.
   * HTML export records it in the bundle manifest (M4.4) so a re-import can match each exported file
   * back to the slide it came from rather than guessing from the filename slug.
   */
  id?: string
}

/**
 * The slide range, mirroring the wireframe's radios (20-ui-wireframes.md): All, Current, or an
 * inclusive 1-based `from`–`to`. Kept as a tagged union so the parser (`range.ts`) and the resolver
 * are total and testable without a live deck.
 */
export type SlideRange =
  { kind: 'all' } | { kind: 'current' } | { kind: 'range'; from: number; to: number }

/** The request the renderer sends across the bridge to start a PDF export. */
export type ExportPdfRequest = {
  slides: SlideExportInput[]
  /** 0-based index the presenter/editor is on, used by the `current` range. */
  currentIndex: number
  range: SlideRange
  /** Deck title, used for the default save filename and the PDF's `/Title`. */
  deckTitle: string
}

/** Per-slide outcome in the report. `failed` means that one slide is absent from the PDF. */
export type SlideExportOutcome = {
  /** 0-based index within the resolved range's slide list. */
  index: number
  title: string
  status: 'ok' | 'failed'
  /** Present on `failed`; a human-readable reason (render/print threw). */
  error?: string
}

/**
 * What an export produced. `pageCount` is read back from the finished PDF, so it is proof the file
 * is real rather than a claim — a passing export has `pageCount` equal to the number of `ok` slides.
 */
export type ExportReport = {
  format: 'pdf'
  outPath: string
  /** Slides in the resolved range (attempted). */
  slideCount: number
  /** Pages in the written PDF. */
  pageCount: number
  slides: SlideExportOutcome[]
  /** Non-fatal notes: overflow clipping, an empty range, a slide that failed. */
  warnings: string[]
}

/**
 * The bridge response. `canceled` is the save-dialog dismissal — not an error, just nothing to do.
 * A `report` with any `failed` slide still succeeded in writing a PDF of the rest; a request whose
 * range resolved to zero slides, or where every slide failed, resolves with `report: null`.
 */
export type ExportPdfResponse =
  { canceled: true } | { canceled: false; report: ExportReport | null }

/**
 * The request to start an HTML export (M4.4). Structurally identical to the PDF request — same
 * slides, same range semantics, same current index — because the two pipelines differ only in what
 * they do with the slides, not in what they need to be told. Kept as a distinct named type rather
 * than an alias so the two can diverge (HTML options: package-as-folder, include-shell) without a
 * rename, and so the IPC map reads honestly.
 */
export type ExportHtmlRequest = ExportPdfRequest

/**
 * What an HTML export produced. Parallel to `ExportReport` but with `fileCount` where PDF has
 * `pageCount`: the proof-of-work for a zip is the number of members written, and a passing export has
 * `fileCount` equal to the number of `ok` slides plus the two generated files (`index.html`,
 * `deck.json`). A separate type rather than a widened `ExportReport` because `pageCount` is
 * meaningless here and an always-zero field is worse than no field.
 */
export type ExportHtmlReport = {
  format: 'html'
  outPath: string
  /** Slides in the resolved range (attempted). */
  slideCount: number
  /** Members in the written bundle. */
  fileCount: number
  slides: SlideExportOutcome[]
  warnings: string[]
}

/** The bridge response for HTML export; `canceled` is the save-dialog dismissal, not an error. */
export type ExportHtmlResponse =
  { canceled: true } | { canceled: false; report: ExportHtmlReport | null }
