/**
 * The Electron edge of PPTX export (M4.3): the measurement + raster-capture seam that `buildSlidesPptx`
 * drives. It runs on the **same locked, secure hidden window** the PDF path uses — `createExportWindow`
 * and `loadAndSettleSlide` are shared verbatim (see `electron-renderer.ts` for the sandbox and
 * containment rationale), so there is no second, weaker render path for export and the slide settles
 * identically before it is measured or captured.
 *
 * Per slide it does two things in the one loaded window, after the settle barrier:
 *  1. runs the measurement script (`slideMeasurementScript`) → a serializable `MeasureResult` the pure
 *     walker/scorer consume;
 *  2. `capturePage()` → a full-slide PNG data URL, always captured (cheaply) so the planner can fall
 *     back to a picture for any slide without a second round-trip.
 *
 * All decision logic — scoring, tier choice, shape mapping — stays in the pure layer; this module only
 * produces the raw inputs and the picture.
 */

import { createExportWindow, loadAndSettleSlide } from './electron-renderer'
import { slideDocumentUrl } from '../../shared/slide-protocol'
import { slideMeasurementScript } from '../../shared/export/pptx/node'
import type { BrowserWindow } from 'electron'
import type { MeasureResult } from '../../shared/export/pptx/node'
import type { SlideRegistry } from '../slide/registry'

/** What the renderer produces for one slide: the measured nodes and a full-slide PNG (or `null`). */
export type PptxSlideRender = {
  measure: MeasureResult
  /** `data:image/png;base64,…` from `capturePage`, or `null` if capture threw. */
  rasterDataUrl: string | null
}

/** Renders one already-wrapped slide document for PPTX export. The Electron seam. */
export type SlidePptxRenderer = {
  renderSlide: (html: string, index: number) => Promise<PptxSlideRender>
  /** Close the window and release any documents it published. Idempotent. */
  dispose: () => void
}

const EMPTY_MEASURE: MeasureResult = {
  nodes: [],
  body: { backgroundColor: 'rgba(0, 0, 0, 0)', backgroundImage: 'none' },
  hasAnimation: false,
}

/**
 * Build an offscreen PPTX renderer bound to `registry`. The window is created lazily and reused for
 * the whole job; `dispose()` tears it down. A measurement-pass exception yields an empty node list (so
 * the planner sees "no structured content" and, with a capture in hand, routes to raster) rather than
 * failing the slide — matching the PDF path's degrade-don't-hang policy.
 */
export function createOffscreenPptxRenderer(registry: SlideRegistry): SlidePptxRenderer {
  let win: BrowserWindow | null = null

  const ensureWindow = (): BrowserWindow => {
    if (win === null || win.isDestroyed()) win = createExportWindow()
    return win
  }

  return {
    renderSlide: async (html: string): Promise<PptxSlideRender> => {
      const window = ensureWindow()
      const ownerId = window.webContents.id
      const published = registry.publish(html, ownerId)
      if (!published.ok) {
        throw new Error(`export could not publish slide (${published.refusal.reason})`)
      }
      const id = published.id
      const contents = window.webContents
      try {
        await loadAndSettleSlide(contents, slideDocumentUrl(id))

        let measure: MeasureResult
        try {
          measure = (await contents.executeJavaScript(
            slideMeasurementScript(),
            true,
          )) as MeasureResult
          if (measure === null || typeof measure !== 'object' || !Array.isArray(measure.nodes)) {
            measure = EMPTY_MEASURE
          }
        } catch {
          measure = EMPTY_MEASURE
        }

        let rasterDataUrl: string | null = null
        try {
          const image = await contents.capturePage()
          rasterDataUrl = `data:image/png;base64,${image.toPNG().toString('base64')}`
        } catch {
          rasterDataUrl = null
        }

        return { measure, rasterDataUrl }
      } finally {
        registry.revoke(id, ownerId)
      }
    },
    dispose: (): void => {
      if (win !== null && !win.isDestroyed()) {
        registry.revokeOwner(win.webContents.id)
        win.destroy()
      }
      win = null
    },
  }
}
