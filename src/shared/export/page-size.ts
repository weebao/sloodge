/**
 * Page-sizing math and the locked `printToPDF` option set (M4.2), pure so the two settings that
 * account for nearly every "the PDF looks wrong" report — `printBackground` and zero margins
 * (60-export.md §2.2) — are asserted by a unit test rather than trusted to a call site.
 *
 * Nothing here imports `electron`; the returned object is a plain value that `webContents.printToPDF`
 * accepts as-is. The electron edge (`main/export/electron-renderer.ts`) passes it through unchanged.
 */

import {
  CSS_PX_PER_INCH,
  PDF_POINTS_PER_INCH,
  SLIDE_HEIGHT_INCHES,
  SLIDE_WIDTH_INCHES,
} from './types'

/** CSS px → PDF points. `px / 96 * 72`, i.e. `px * 0.75`. The only unit conversion in the pipeline. */
export function pxToPoints(px: number): number {
  return (px * PDF_POINTS_PER_INCH) / CSS_PX_PER_INCH
}

/**
 * The `printToPDF` options, mirroring 60-export.md §2.2. Every field is a constant with a reason:
 *
 * - `printBackground: true` — MANDATORY. Without it every background and gradient silently vanishes.
 * - `preferCSSPageSize: true` — honour the slide's own `@page { size: 1280px 720px; margin: 0 }`.
 * - `pageSize` (inches) — the fallback for a slide with no `@page`; also the exact 16:9 slide box.
 * - `margins: none` — the slide is the page; any browser margin shifts every layout inward.
 * - `scale: 1` — no scaling is ever needed (px/96 = inches is exact).
 * - `landscape: false` — irrelevant once the page size is explicit and already wide, kept explicit.
 * - `generateTaggedPDF: true` — structure tags keep text selectable/accessible; no visual cost.
 * - `generateDocumentOutline: false` — the outline, if any, is built at merge time from titles.
 *
 * Returned fresh each call so a caller cannot mutate a shared constant into a wrong export.
 */
export function slidePrintToPdfOptions(): {
  printBackground: true
  preferCSSPageSize: true
  pageSize: { width: number; height: number }
  margins: { top: 0; bottom: 0; left: 0; right: 0 }
  scale: 1
  landscape: false
  generateTaggedPDF: true
  generateDocumentOutline: false
} {
  return {
    printBackground: true,
    preferCSSPageSize: true,
    pageSize: { width: SLIDE_WIDTH_INCHES, height: SLIDE_HEIGHT_INCHES },
    margins: { top: 0, bottom: 0, left: 0, right: 0 },
    scale: 1,
    landscape: false,
    generateTaggedPDF: true,
    generateDocumentOutline: false,
  }
}
