/**
 * The Electron edge of PPTX export (M4.3): the measurement + raster-capture seam that `buildSlidesPptx`
 * drives. It runs on the **same locked, secure hidden window** the PDF path uses — `createExportWindow`
 * and `loadAndSettleSlide` are shared verbatim (see `electron-renderer.ts` for the sandbox and
 * containment rationale), so there is no second, weaker render path for export and the slide settles
 * identically before it is measured or captured.
 *
 * Per slide it does three things in the one loaded window, after the settle barrier:
 *  1. runs the measurement script (`slideMeasurementScript`) → a serializable `MeasureResult` the pure
 *     walker/scorer consume;
 *  2. `capturePage()` → a full-slide PNG data URL, always captured (cheaply) so the planner can fall
 *     back to a picture for any slide without a second round-trip;
 *  3. when the body paints a gradient/image (M4.8a), hides every descendant and captures again → the
 *     body's own paint alone, which the planner emits as the full-bleed background under the editable
 *     runs (60-export.md §3.3). Hiding rather than capturing the full slide keeps the text from being
 *     baked into the background beneath its own editable copy.
 *
 * All decision logic — scoring, tier choice, shape mapping — stays in the pure layer; this module only
 * produces the raw inputs and the picture.
 */

import { createExportWindow, loadAndSettleSlide } from './electron-renderer'
import { slideDocumentUrl } from '../../shared/slide-protocol'
import { slideMeasurementScript } from '../../shared/export/pptx/node'
import { paintsImage } from '../../shared/export/pptx/confidence'
import { EXPORT_READINESS_TIMEOUT_MS } from '../../shared/export/readiness'
import type { BrowserWindow, WebContents } from 'electron'
import type { MeasureResult, RootPaint } from '../../shared/export/pptx/node'
import type { SlideRegistry } from '../slide/registry'

/** What the renderer produces for one slide: the measured nodes and a full-slide PNG (or `null`). */
export type PptxSlideRender = {
  measure: MeasureResult
  /** `data:image/png;base64,…` from `capturePage`, or `null` if capture threw. */
  rasterDataUrl: string | null
  /**
   * The body's own paint with all descendants hidden, or `null`: the body is solid (not attempted), or
   * the capture threw. Only ever non-null when `measure.body.backgroundImage` is a gradient/`url()`.
   */
  backgroundDataUrl: string | null
}

/** Renders one already-wrapped slide document for PPTX export. The Electron seam. */
export type SlidePptxRenderer = {
  renderSlide: (html: string, index: number) => Promise<PptxSlideRender>
  /** Close the window and release any documents it published. Idempotent. */
  dispose: () => void
}

/**
 * Hide everything inside `<body>` so a capture shows only the body's own background. `visibility`
 * (not `display`) so layout is untouched; `body *` (not `body > *`) so a descendant's explicit
 * `visibility: visible` cannot re-show it. Resolves after two frames so the change has painted.
 */
const HIDE_DESCENDANTS_SCRIPT = `(() => {
  const s = document.createElement('style');
  s.textContent = 'body * { visibility: hidden !important; }';
  document.documentElement.appendChild(s);
  return new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true))));
})()`

function pngDataUrl(image: Electron.NativeImage): string {
  return `data:image/png;base64,${image.toPNG().toString('base64')}`
}

const TIMED_OUT = Symbol('timed out')

/**
 * Run a script in the (untrusted) slide, bounded by the same budget as the settle barrier. Both
 * scripts here await the slide's cooperation — the measurement pass walks its DOM, the hide step
 * resolves from its `requestAnimationFrame` — so a slide that stubs `requestAnimationFrame` or loops
 * must degrade the slide, not hang the export. A throw or timeout resolves to `TIMED_OUT`.
 */
async function runInSlide(contents: WebContents, script: string): Promise<unknown> {
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      contents.executeJavaScript(script, true).catch(() => TIMED_OUT),
      new Promise<typeof TIMED_OUT>((resolve) => {
        timeoutHandle = setTimeout(() => resolve(TIMED_OUT), EXPORT_READINESS_TIMEOUT_MS)
      }),
    ])
  } finally {
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle)
  }
}

const NO_ROOT_PAINT: RootPaint = {
  backgroundColor: 'rgba(0, 0, 0, 0)',
  backgroundImage: 'none',
  filter: 'none',
  backdropFilter: 'none',
  mixBlendMode: 'normal',
  clipPath: 'none',
  unmodelledProperties: [],
}

const EMPTY_MEASURE: MeasureResult = {
  nodes: [],
  body: NO_ROOT_PAINT,
  root: NO_ROOT_PAINT,
  hasAnimation: false,
}

/**
 * Build an offscreen PPTX renderer bound to `registry`. The window is created lazily and reused for
 * the whole job; `dispose()` tears it down. A measurement-pass exception yields an empty node list
 * rather than failing the slide — matching the PDF path's degrade-don't-hang policy. Note where that
 * lands: an empty measurement scores 100, emits nothing and reports no coverage shortfall, so the
 * slide ships structured and *blank* rather than as the capture taken beside it (measured in M4.8a
 * r5, 60-export.md §3.4). Rastering it instead is a trade-off — a deliberately empty slide would
 * become a picture — so it is written down rather than changed in passing.
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

        const measured = (await runInSlide(contents, slideMeasurementScript())) as
          MeasureResult | typeof TIMED_OUT | null
        const measure =
          measured !== TIMED_OUT &&
          measured !== null &&
          typeof measured === 'object' &&
          Array.isArray(measured.nodes)
            ? measured
            : EMPTY_MEASURE

        let rasterDataUrl: string | null = null
        try {
          rasterDataUrl = pngDataUrl(await contents.capturePage())
        } catch {
          rasterDataUrl = null
        }

        // Only when the hide step reports it painted: capturing after a timeout could bake the
        // still-visible text into the background beneath its own editable copy.
        let backgroundDataUrl: string | null = null
        if (
          paintsImage(measure.body.backgroundImage) &&
          (await runInSlide(contents, HIDE_DESCENDANTS_SCRIPT)) === true
        ) {
          try {
            backgroundDataUrl = pngDataUrl(await contents.capturePage())
          } catch {
            backgroundDataUrl = null
          }
        }

        return { measure, rasterDataUrl, backgroundDataUrl }
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
