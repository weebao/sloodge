/**
 * The PDF export orchestrator (M4.2) — the decision half, kept free of `electron` and of the
 * filesystem so the properties that matter are unit-testable with a fake renderer:
 *
 *  - **range selection**: which slides, in what order (`resolveRange`).
 *  - **order preserved**: page k of the PDF is slide k of the range.
 *  - **error isolation**: a slide that fails to render/print does not abort the export — it is
 *    collected, reported, and the PDF of the remaining slides is still produced (60-export.md §6.3).
 *  - **overflow reporting**: a per-slide PDF with >1 page is clipped to its first page and flagged.
 *
 * The one thing it cannot do itself — turn slide HTML into a per-slide PDF — is an injected
 * `SlidePdfRenderer`. In production that is the offscreen `BrowserWindow` + `printToPDF`
 * (`electron-renderer.ts`); in tests it is a fake returning canned PDF bytes, over which the real
 * `pdf-lib` merge runs.
 */

import { resolveRange } from '../../shared/export/range'
import type {
  ExportReport,
  SlideExportInput,
  SlideExportOutcome,
  SlideRange,
} from '../../shared/export/types'
import { isSlidePageSize, mergeSlidePdfs, pdfGeometry } from './merge'

/** Renders one already-wrapped slide document to a single-page PDF. The Electron seam. */
export type SlidePdfRenderer = {
  /**
   * `index` is the slide's 0-based position in the resolved range, for logging/progress only.
   * Resolves with the per-slide PDF bytes; rejects if the slide could not be rendered or printed.
   */
  renderToPdf: (html: string, index: number) => Promise<Uint8Array>
}

export type ExportProgress = {
  phase: 'rendering' | 'assembling'
  /** 1-based, for display. `0` during `assembling`. */
  slideIndex: number
  total: number
  slideTitle: string
}

export type BuildPdfArgs = {
  slides: readonly SlideExportInput[]
  range: SlideRange
  currentIndex: number
  outPath: string
  deckTitle: string
  renderer: SlidePdfRenderer
  onProgress?: (progress: ExportProgress) => void
  /** Injectable so the merged PDF is byte-deterministic in tests. */
  creationDate?: Date
}

export type BuildPdfResult = {
  /** `null` when the range was empty or every slide failed — nothing to write. */
  pdfBytes: Uint8Array | null
  report: ExportReport
}

/**
 * Render the resolved range sequentially and merge. Sequential by construction (never `Promise.all`):
 * parallel hidden windows contend for the GPU process and make the animation "final frame" capture
 * nondeterministic (60-export.md §1.4), and each per-slide PDF is released as soon as it is merged so
 * a large deck does not hold every render in memory at once.
 *
 * Always resolves — a failed slide is a report entry, never a rejection — except that a corrupt merge
 * (a renderer that resolved with non-PDF bytes) propagates, because that is a pipeline defect the
 * user cannot act on and must not be silently written as a truncated file.
 */
export async function buildSlidesPdf(args: BuildPdfArgs): Promise<BuildPdfResult> {
  const { slides, range, currentIndex, outPath, deckTitle, renderer, onProgress, creationDate } =
    args

  const indices = resolveRange(range, slides.length, currentIndex)
  const outcomes: SlideExportOutcome[] = []
  const warnings: string[] = []
  const okBuffers: Uint8Array[] = []

  if (indices.length === 0) {
    warnings.push('The selected range contains no slides.')
    return {
      pdfBytes: null,
      report: { format: 'pdf', outPath, slideCount: 0, pageCount: 0, slides: [], warnings },
    }
  }

  for (const [position, slideIndex] of indices.entries()) {
    const slide = slides[slideIndex]
    // `resolveRange` only ever returns in-bounds indices, so this is a guard, not a live branch.
    if (slide === undefined) continue
    onProgress?.({
      phase: 'rendering',
      slideIndex: position + 1,
      total: indices.length,
      slideTitle: slide.title,
    })

    try {
      // Sequential on purpose (see the function docstring): one window, one render at a time.
      // oxlint-disable-next-line no-await-in-loop
      const bytes = await renderer.renderToPdf(slide.html, position)
      // oxlint-disable-next-line no-await-in-loop
      const geometry = await pdfGeometry(bytes)
      if (geometry.pageCount > 1) {
        warnings.push(
          `Slide ${String(position + 1)} (${slide.title}) content extends past the slide edge and was clipped.`,
        )
      }
      const firstPage = geometry.pageSizes[0]
      if (firstPage !== undefined && !isSlidePageSize(firstPage)) {
        warnings.push(
          `Slide ${String(position + 1)} (${slide.title}) printed at an unexpected page size.`,
        )
      }
      okBuffers.push(bytes)
      outcomes.push({ index: position, title: slide.title, status: 'ok' })
    } catch (error) {
      outcomes.push({
        index: position,
        title: slide.title,
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
      })
      warnings.push(`Slide ${String(position + 1)} (${slide.title}) could not be exported.`)
    }
  }

  if (okBuffers.length === 0) {
    warnings.push('No slides could be exported.')
    return {
      pdfBytes: null,
      report: {
        format: 'pdf',
        outPath,
        slideCount: indices.length,
        pageCount: 0,
        slides: outcomes,
        warnings,
      },
    }
  }

  onProgress?.({ phase: 'assembling', slideIndex: 0, total: indices.length, slideTitle: '' })
  const merged = await mergeSlidePdfs(okBuffers, {
    title: deckTitle,
    ...(creationDate !== undefined ? { creationDate } : {}),
  })
  const mergedGeometry = await pdfGeometry(merged)

  return {
    pdfBytes: merged,
    report: {
      format: 'pdf',
      outPath,
      slideCount: indices.length,
      pageCount: mergedGeometry.pageCount,
      slides: outcomes,
      warnings,
    },
  }
}
