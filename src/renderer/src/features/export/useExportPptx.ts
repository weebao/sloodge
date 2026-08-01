/**
 * The renderer's PPTX-export trigger (M4.3). Like `useExportPdf`, the deck is authoritative here, so
 * export starts here: gather each slide's *wrapped* HTML (the exact bytes the canvas publishes to
 * `slide://`) plus its title and the current index, and invoke `exportPptx` with the chosen fidelity.
 * Main owns the save dialog, the offscreen render/measure/capture, the structured-vs-raster decision,
 * and the file write; this hook only assembles the request and reports the outcome.
 *
 * `buildExportPptxRequest` is split out and pure so the load-bearing detail — that export sends the
 * *wrapped* HTML plus the fidelity — is unit-testable without a bridge or a window.
 */

import { useCallback, useRef } from 'react'
import { getBridge } from '../../host/bridge'
import { wrapSlideHtml } from '../canvas/wrapSlideHtml'
import type { SlideView } from '../../stores/deckStore'
import type { ExportPptxRequest, PptxFidelity } from '../../../../shared/export/pptx/types'
import type { SlideRange } from '../../../../shared/export/types'

/** Build the PPTX export request: wrap each slide as the canvas would, carry title + range + fidelity. */
export function buildExportPptxRequest(
  slides: readonly SlideView[],
  currentIndex: number,
  deckTitle: string,
  range: SlideRange,
  fidelity: PptxFidelity,
): ExportPptxRequest {
  return {
    slides: slides.map((slide) => ({ title: slide.title, html: wrapSlideHtml(slide.html) })),
    currentIndex,
    range,
    deckTitle,
    fidelity,
  }
}

export type UseExportPptxArgs = {
  slides: readonly SlideView[]
  currentIndex: number
  deckTitle: string
}

/**
 * Returns a trigger that exports the whole deck to PPTX at the given fidelity. Inert in a plain-browser
 * host with no bridge. Errors are logged rather than thrown — an export failing must not take down the
 * editor. The callback has a **stable identity for the life of the component** (args held in a ref,
 * read lazily at call time), so wiring it through the export dialog never rebuilds subscriptions.
 */
export function useExportPptx(args: UseExportPptxArgs): (fidelity: PptxFidelity) => void {
  const argsRef = useRef(args)
  argsRef.current = args
  return useCallback((fidelity: PptxFidelity) => {
    const { slides, currentIndex, deckTitle } = argsRef.current
    const bridge = getBridge()
    if (bridge?.exportPptx === undefined) return
    if (slides.length === 0) return
    // DEFERRED (§3.8): the dialog exposes fidelity only, so the whole deck is exported. The
    // range/per-slide-override controls are out of scope for M4.3 — but the range pipeline is complete
    // end to end (SlideRange, resolveRange, request validation, the orchestrator all honour it), so
    // this is the one line to change when the dialog grows an All/Current/`1-4` control: pass the
    // chosen SlideRange here instead of the hardcoded `all`. Delete this note when that lands.
    const request = buildExportPptxRequest(
      slides,
      currentIndex,
      deckTitle,
      { kind: 'all' },
      fidelity,
    )
    void bridge.exportPptx(request).then(
      (response) => {
        if (!response.canceled && response.report !== null && response.report.warnings.length > 0) {
          // oxlint-disable-next-line no-console -- interim export-report channel; replaced by the report UI.
          console.warn('PPTX export completed with notes:', response.report.warnings)
        }
      },
      (error: unknown) => {
        // oxlint-disable-next-line no-console -- the only signal a failed export produces today.
        console.error('PPTX export failed', error)
      },
    )
  }, [])
}
