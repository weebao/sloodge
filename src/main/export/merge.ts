/**
 * The `pdf-lib` half of PDF export (M4.2 / 60-export.md §2.4): merge N single-page per-slide PDFs
 * into one deck document, order preserved, and read a finished PDF's page geometry back for the
 * integrity checks and the report.
 *
 * This is the only place `pdf-lib` is used. It touches no `electron` and no filesystem — it is bytes
 * in, bytes out — so it is unit-tested directly against real per-slide PDFs (generated with the same
 * library in the test), which is what makes "page order preserved" and "one page per slide" real
 * assertions rather than mocked ones.
 */

import { PDFDocument } from 'pdf-lib'
import {
  PDF_PAGE_SIZE_TOLERANCE_PT,
  SLIDE_HEIGHT_PT,
  SLIDE_WIDTH_PT,
} from '../../shared/export/types'

export type PdfPageSize = { width: number; height: number }

export type PdfGeometry = {
  pageCount: number
  /** One entry per page, in document order. */
  pageSizes: PdfPageSize[]
}

/** Read a PDF's page count and per-page box size in points. Used for proof and integrity checks. */
export async function pdfGeometry(bytes: Uint8Array): Promise<PdfGeometry> {
  const doc = await PDFDocument.load(bytes)
  const pageSizes = doc.getPages().map((page) => {
    const { width, height } = page.getSize()
    return { width, height }
  })
  return { pageCount: pageSizes.length, pageSizes }
}

/** Whether a page box is the 16:9 slide box (960 × 540 pt) within Chromium's rounding slack. */
export function isSlidePageSize(size: PdfPageSize): boolean {
  return (
    Math.abs(size.width - SLIDE_WIDTH_PT) <= PDF_PAGE_SIZE_TOLERANCE_PT &&
    Math.abs(size.height - SLIDE_HEIGHT_PT) <= PDF_PAGE_SIZE_TOLERANCE_PT
  )
}

export type MergeMeta = {
  title?: string
  /** Defaults to now; injectable so the merge is byte-deterministic in tests. */
  creationDate?: Date
}

/**
 * Merge per-slide PDFs into one, taking **exactly the first page** of each so a slide whose content
 * overflowed 720 px (a genuine authoring defect) contributes one page, not several — matching
 * reveal.js's `pdfMaxPagesPerSlide: 1` clipping. The caller detects and reports the overflow; this
 * function's contract is simply "one input PDF → one output page, in the order given".
 *
 * Throws if any input is not a loadable PDF or has zero pages — an empty per-slide buffer is a
 * pipeline bug, not a slide the merge should silently skip.
 */
export async function mergeSlidePdfs(
  perSlide: readonly Uint8Array[],
  meta: MergeMeta = {},
): Promise<Uint8Array> {
  const merged = await PDFDocument.create()
  // `setTitle` survives the save; `Producer` is left as pdf-lib's default (pdf-lib 1.17 rewrites it
  // on save and exposes no option to suppress that — not worth fighting for a cosmetic field).
  if (meta.title !== undefined) merged.setTitle(meta.title)
  merged.setCreationDate(meta.creationDate ?? new Date())

  for (const bytes of perSlide) {
    // Sequential on purpose: `addPage` order *is* the deck order, so pages must be copied one at a
    // time in sequence — `Promise.all` would race the appends and scramble the slides.
    // oxlint-disable-next-line no-await-in-loop
    const doc = await PDFDocument.load(bytes)
    if (doc.getPageCount() === 0) {
      throw new Error('per-slide PDF has no pages')
    }
    // oxlint-disable-next-line no-await-in-loop
    const [page] = await merged.copyPages(doc, [0])
    merged.addPage(page)
  }

  return merged.save({ useObjectStreams: true })
}
