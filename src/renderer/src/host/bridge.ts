import type { MenuAction } from '../../../shared/ipc-contract'
import type { ExportPdfRequest, ExportPdfResponse } from '../../../shared/export/types'
import type { ExportPptxRequest, ExportPptxResponse } from '../../../shared/export/pptx/types'
import type { AgentBridge } from '../../../preload/agentBridge'

/**
 * `window.sloodge` — the preload surface — and the single place the `Window` augmentation for it
 * lives.
 *
 * It is a module of its own rather than a field on whichever feature happened to need it first.
 * TypeScript merges `declare global` blocks by *name*, so two features each declaring
 * `sloodge?: …` with their own idea of the shape is a compile error, and the fix under deadline is
 * always to widen one of them to `any`. One declaration, imported by every consumer, makes that
 * impossible.
 *
 * ## Everything on it is optional, deliberately
 *
 * This type describes what the renderer *hopes* is there, not what the preload guarantees. The two
 * are built as separate bundles and, once the app is packaged and updatable, may not be the same
 * version. A renderer that destructures a function the running preload never exposed throws at
 * module scope and shows a blank window; a renderer that checks first degrades to the browser
 * fallback. So consumers narrow at runtime — see `getBridge` and `getSlideProtocolBridge` — and the
 * optionality here is what forces them to.
 */
export type SloodgeBridge = {
  /** M1.4: native-menu actions. Returns an unsubscribe function. */
  onMenuAction: (listener: (action: MenuAction) => void) => () => void
  /** M2.0: publish a slide document into main's `slide://` registry; resolves with its opaque id. */
  publishSlide?: (html: string) => Promise<string>
  /** M2.0: release a published document. */
  revokeSlide?: (id: string) => Promise<boolean>
  /** M2.1: the agent surface — key management, turns, streaming events, deck hot-updates. */
  agent?: AgentBridge
  /**
   * M4.1: toggle real OS fullscreen for Present mode; resolves with the window's actual state after
   * the call. Absent in a plain-browser host, where the surface falls back to a maximized overlay.
   */
  setPresentFullscreen?: (fullscreen: boolean) => Promise<boolean>
  /**
   * M4.2: export the deck (or a slide range) to PDF. The renderer hands over the wrapped slide HTML;
   * main runs the save dialog and the offscreen print and resolves with a report. Absent in a
   * plain-browser host, where there is no main process to print.
   */
  exportPdf?: (request: ExportPdfRequest) => Promise<ExportPdfResponse>
  /**
   * M4.3: export the deck (or a slide range) to PPTX — structured conversion where the slide is
   * faithfully convertible, a full-slide raster fallback where it is not, chosen per slide by
   * confidence unless the caller forces a fidelity. Absent in a plain-browser host.
   */
  exportPptx?: (request: ExportPptxRequest) => Promise<ExportPptxResponse>
}

declare global {
  interface Window {
    sloodge?: SloodgeBridge
  }
}

/** The bridge, or `undefined` when this renderer is not running inside Electron. */
export function getBridge(): SloodgeBridge | undefined {
  return typeof window === 'undefined' ? undefined : window.sloodge
}
