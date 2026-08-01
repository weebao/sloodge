/**
 * The renderer's PDF-export trigger (M4.2). The deck is authoritative here (`deckStore`), so export
 * starts here: gather each slide's *wrapped* HTML — the exact bytes the canvas publishes to `slide://`
 * (`wrapSlideHtml`) — plus its title and the current index, and invoke `exportPdf`. Main owns the save
 * dialog, the offscreen print, and the file write; this hook only assembles the request and reports
 * the outcome.
 *
 * `buildExportPdfRequest` is split out and pure so the load-bearing detail — that export sends the
 * *wrapped* HTML, not the raw source — is unit-testable without a bridge or a window.
 *
 * ## Dialog scope (deferred, deliberately)
 *
 * The full Export dialog (format radios, the All/Current/`1-4` range control, a live progress bar —
 * 20-ui-wireframes.md) is its own milestone. This hook ships the minimal path the wireframe's menu
 * item implies: File ▸ Export ▸ PDF → native save dialog → export the whole deck. The range plumbing
 * is complete end to end (`SlideRange`, `resolveRange`, request validation, the orchestrator), so the
 * dialog is a later UI over a pipeline that already accepts All / Current / a range.
 */

import { useCallback } from 'react'
import { getBridge } from '../../host/bridge'
import { wrapSlideHtml } from '../canvas/wrapSlideHtml'
import type { SlideView } from '../../stores/deckStore'
import type { ExportPdfRequest, SlideRange } from '../../../../shared/export/types'

/** Build the export request: wrap each slide as the canvas would, and carry title + range + index. */
export function buildExportPdfRequest(
  slides: readonly SlideView[],
  currentIndex: number,
  deckTitle: string,
  range: SlideRange,
): ExportPdfRequest {
  return {
    slides: slides.map((slide) => ({ title: slide.title, html: wrapSlideHtml(slide.html) })),
    currentIndex,
    range,
    deckTitle,
  }
}

export type UseExportPdfArgs = {
  slides: readonly SlideView[]
  currentIndex: number
  deckTitle: string
}

/**
 * Returns a stable trigger that exports the whole deck to PDF. Inert (a no-op) in a plain-browser
 * host with no bridge. Errors are logged rather than thrown — an export failing must not take down
 * the editor; the surfaced report/error UI is part of the deferred dialog milestone.
 */
export function useExportPdf({ slides, currentIndex, deckTitle }: UseExportPdfArgs): () => void {
  return useCallback(() => {
    const bridge = getBridge()
    if (bridge?.exportPdf === undefined) return
    if (slides.length === 0) return
    const request = buildExportPdfRequest(slides, currentIndex, deckTitle, { kind: 'all' })
    void bridge.exportPdf(request).then(
      (response) => {
        if (!response.canceled && response.report !== null && response.report.warnings.length > 0) {
          // The sole surfacing of degraded/failed slides until the report UI lands.
          // oxlint-disable-next-line no-console -- interim export-report channel; replaced by the dialog.
          console.warn('PDF export completed with notes:', response.report.warnings)
        }
      },
      (error: unknown) => {
        // oxlint-disable-next-line no-console -- the only signal a failed export produces today.
        console.error('PDF export failed', error)
      },
    )
  }, [slides, currentIndex, deckTitle])
}
