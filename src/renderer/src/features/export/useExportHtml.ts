/**
 * The renderer's HTML-export trigger (M4.4). Mirrors `useExportPdf.ts` exactly — same deck source,
 * same wrapped-HTML rule, same stable-callback contract — because the two menu items should differ
 * only in which channel they invoke.
 *
 * ## The wrapped HTML is not an implementation detail here
 *
 * For PDF, sending `wrapSlideHtml(slide.html)` is about fidelity: main prints the same bytes the
 * canvas rendered. For HTML it is about **security**. These bytes are written into a zip the user
 * will send to someone else, who will open it from `file://` in a browser that has no `slide://`
 * response header and no host CSP to fall back on. The CSP meta the wrapper injects is the only
 * policy that survives into that file. Sending raw source here would ship unpoliced documents to
 * third parties — see the long note in `shared/export/html-bundle.ts`.
 *
 * `id` is sent too (PDF omits it): the bundle manifest records which slide each file came from, so a
 * future re-import matches on identity rather than on a filename slug.
 */

import { useCallback, useRef } from 'react'
import { getBridge } from '../../host/bridge'
import { wrapSlideHtml } from '../canvas/wrapSlideHtml'
import type { SlideView } from '../../stores/deckStore'
import type { ExportHtmlRequest, SlideRange } from '../../../../shared/export/types'

/** Build the export request: wrap each slide as the canvas would, and carry id + title + range. */
export function buildExportHtmlRequest(
  slides: readonly SlideView[],
  currentIndex: number,
  deckTitle: string,
  range: SlideRange,
): ExportHtmlRequest {
  return {
    slides: slides.map((slide) => ({
      id: slide.id,
      title: slide.title,
      html: wrapSlideHtml(slide.html),
    })),
    currentIndex,
    range,
    deckTitle,
  }
}

export type UseExportHtmlArgs = {
  slides: readonly SlideView[]
  currentIndex: number
  deckTitle: string
}

/**
 * Returns a trigger that exports the whole deck to an HTML bundle. Inert in a plain-browser host with
 * no bridge. Errors are logged rather than thrown — an export failing must not take down the editor.
 *
 * The callback identity is **stable for the life of the component**, via a ref holding the latest
 * args: `useMenuActions` lists it in an effect dependency array, so a callback that changed with the
 * deck would tear down and rebuild the `app:menu` subscription on every keystroke.
 */
export function useExportHtml(args: UseExportHtmlArgs): () => void {
  const argsRef = useRef(args)
  argsRef.current = args
  return useCallback(() => {
    const { slides, currentIndex, deckTitle } = argsRef.current
    const bridge = getBridge()
    if (bridge?.exportHtml === undefined) return
    if (slides.length === 0) return
    const request = buildExportHtmlRequest(slides, currentIndex, deckTitle, { kind: 'all' })
    void bridge.exportHtml(request).then(
      (response) => {
        if (!response.canceled && response.report !== null && response.report.warnings.length > 0) {
          // The sole surfacing of degraded/failed slides until the report UI lands.
          // oxlint-disable-next-line no-console -- interim export-report channel; replaced by the dialog.
          console.warn('HTML export completed with notes:', response.report.warnings)
        }
      },
      (error: unknown) => {
        // oxlint-disable-next-line no-console -- the only signal a failed export produces today.
        console.error('HTML export failed', error)
      },
    )
  }, [])
}
