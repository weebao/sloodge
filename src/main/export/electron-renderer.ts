/**
 * The Electron edge of PDF export (M4.2): a single reusable hidden `BrowserWindow` that loads each
 * slide over the **same `slide://` delivery** the editor canvas uses and prints it to a single-page
 * PDF. This is the only export module that touches `electron`; it implements the `SlidePdfRenderer`
 * seam that `buildSlidesPdf` drives, so all the decision logic stays in the unit-tested pure layer.
 *
 * ## Secure sandbox reuse (task requirement 3 / 60-export.md §1.2)
 *
 * There is no weaker render path for export. The slide HTML is published into the *same*
 * `SlideRegistry` the canvas publishes to, served from `slide://<id>/` with the identical CSP
 * response header, and the window's `webPreferences` are as locked as the editor's: `sandbox: true`,
 * `contextIsolation: true`, `nodeIntegration: false`, and no preload — so the slide's own scripts run
 * (that is what `slide://` is for) but reach neither the app nor the network (`connect-src 'none'`
 * plus the runtime socket guard baked into the wrapped HTML).
 *
 * Three non-obvious window settings, each a bug if omitted (§1.2):
 *  - `backgroundThrottling: false` — Chromium throttles rAF/timers in hidden windows, so a slide's
 *    animations would stall at ~1 fps and the "final frame" we capture would be wrong.
 *  - `useContentSize: true` — otherwise the OS frame is subtracted from 1280×720 and every
 *    vw/vh-relative layout shifts by a few px.
 *  - `offscreen: false` — a normal hidden window shares the visible editor's compositor, so what you
 *    saw in the canvas is what you export; OSR has known font/effect rasterization differences.
 *
 * Slides are rendered strictly one at a time in this one window (the orchestrator awaits each), and
 * each published document is revoked the moment its page is printed, so peak memory is one slide.
 */

import { BrowserWindow } from 'electron'
import { slideDocumentUrl } from '../../shared/slide-protocol'
import { EXPORT_READINESS_TIMEOUT_MS, slideReadinessScript } from '../../shared/export/readiness'
import { slidePrintToPdfOptions } from '../../shared/export/page-size'
import type { SlidePdfRenderer } from './pdf-export'
import type { SlideRegistry } from '../slide/registry'

export type OffscreenPdfRenderer = SlidePdfRenderer & {
  /** Close the window and release any documents it published. Idempotent. */
  dispose: () => void
}

function createExportWindow(): BrowserWindow {
  const win = new BrowserWindow({
    show: false,
    width: 1280,
    height: 720,
    useContentSize: true,
    webPreferences: {
      offscreen: false,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
      webviewTag: false,
    },
  })
  win.webContents.setZoomFactor(1)
  return win
}

/**
 * Build an offscreen renderer bound to `registry`. The window is created lazily on the first render
 * and reused for the rest of the job; `dispose()` tears it down. Documents are published with the
 * export window's `webContents.id` as owner so `dispose` can `revokeOwner` anything a mid-print
 * failure left behind.
 */
export function createOffscreenPdfRenderer(registry: SlideRegistry): OffscreenPdfRenderer {
  let win: BrowserWindow | null = null

  const ensureWindow = (): BrowserWindow => {
    if (win === null || win.isDestroyed()) win = createExportWindow()
    return win
  }

  return {
    renderToPdf: async (html: string): Promise<Uint8Array> => {
      const window = ensureWindow()
      const ownerId = window.webContents.id
      const published = registry.publish(html, ownerId)
      if (!published.ok) {
        throw new Error(`export could not publish slide (${published.refusal.reason})`)
      }
      const id = published.id
      const contents = window.webContents
      try {
        await contents.loadURL(slideDocumentUrl(id))
        // The barrier settles fonts/images/animations and injects the defensive @page. Bounded: on
        // timeout we print the slide anyway (a degraded still beats a hung export), and a slide whose
        // own script throws inside the barrier must not fail the whole slide either.
        await Promise.race([
          contents.executeJavaScript(slideReadinessScript(), true).catch(() => undefined),
          new Promise((resolve) => setTimeout(resolve, EXPORT_READINESS_TIMEOUT_MS)),
        ])
        const pdf = await contents.printToPDF(slidePrintToPdfOptions())
        return new Uint8Array(pdf)
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
