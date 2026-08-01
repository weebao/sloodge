/**
 * Wire the PDF export channel (M4.2): menu → renderer → `file:exportPdf` → here. The thin Electron
 * half — resolve the sender's window, own the native save dialog (main-only, so the renderer never
 * *chooses or supplies* the destination it could tamper with, 60-export.md §1.5; the report does echo
 * the chosen `outPath` back for display), then hand the validated request
 * to the pure orchestrator and write its bytes atomically. Registered once from the app-ready handler,
 * alongside the slide and present IPC, and given the same `SlideRegistry` so export slides are served
 * over the identical `slide://` path as the editor canvas.
 */

import { BrowserWindow, dialog, ipcMain } from 'electron'
import {
  FILE_EXPORT_HTML_CHANNEL,
  FILE_EXPORT_PDF_CHANNEL,
  FILE_EXPORT_PPTX_CHANNEL,
} from '../../shared/ipc-contract'
import type { ExportHtmlResponse, ExportPdfResponse } from '../../shared/export/types'
import type { ExportPptxResponse } from '../../shared/export/pptx/types'
import { parseExportHtmlRequest, parseExportPdfRequest } from '../../shared/export/request'
import { parseExportPptxRequest } from '../../shared/export/pptx/request'
import { buildHtmlBundle } from '../../shared/export/html-bundle'
import { buildSlidesPdf } from './pdf-export'
import { buildSlidesPptx } from './pptx-export'
import { createOffscreenPdfRenderer } from './electron-renderer'
import { createOffscreenPptxRenderer } from './pptx-renderer'
import { createPptxWriter } from './pptx-writer'
import { bundleRootName, defaultHtmlFileName, zipHtmlBundle } from './html-export'
import { writeExportAtomic } from './write'
import type { SlideRegistry } from '../slide/registry'

/** A filesystem-safe default filename stem from the deck title, with the given extension. */
function defaultFileName(deckTitle: string, ext: string): string {
  const stem = deckTitle
    .trim()
    .replace(/[^\p{L}\p{N} _-]+/gu, '')
    .replace(/\s+/g, '-')
    .slice(0, 80)
  return `${stem === '' ? 'deck' : stem}.${ext}`
}

/** A filesystem-safe default PDF filename stem from the deck title. */
export function defaultPdfFileName(deckTitle: string): string {
  return defaultFileName(deckTitle, 'pdf')
}

/** A filesystem-safe default PPTX filename stem from the deck title. */
export function defaultPptxFileName(deckTitle: string): string {
  return defaultFileName(deckTitle, 'pptx')
}

/**
 * Run the native save dialog and return the chosen path, or `null` if the user dismissed it.
 *
 * Parented to the sender's window when there is one so the sheet is modal to the editor rather than
 * a free-floating dialog; falls back to an unparented dialog when the sender has no window (which
 * only happens in teardown races, but throwing there would surface as a broken menu item).
 *
 * Factored out at M4.4 and now used by all three formats: each needs the identical flow with only a
 * different default filename and filter. Duplicating it would be three places to forget the
 * empty-`filePath` check that stands between a dismissed dialog and an export written to `''` —
 * `showSaveDialog` can report `canceled: false` with an empty path, so the check is load-bearing
 * rather than defensive.
 */
async function chooseSavePath(
  sender: Electron.WebContents,
  defaultPath: string,
  filter: { name: string; extensions: string[] },
): Promise<string | null> {
  const senderWindow = BrowserWindow.fromWebContents(sender)
  const options = { defaultPath, filters: [filter] }
  const result = await (senderWindow === null
    ? dialog.showSaveDialog(options)
    : dialog.showSaveDialog(senderWindow, options))

  if (result.canceled || result.filePath === undefined || result.filePath === '') return null
  return result.filePath
}

export function installExportIpc(registry: SlideRegistry): void {
  ipcMain.handle(
    FILE_EXPORT_PDF_CHANNEL,
    async (event, payload: unknown): Promise<ExportPdfResponse> => {
      const request = parseExportPdfRequest(payload)
      if (request === null) {
        throw new Error('file:exportPdf requires a well-formed export request')
      }

      const outPath = await chooseSavePath(event.sender, defaultPdfFileName(request.deckTitle), {
        name: 'PDF',
        extensions: ['pdf'],
      })
      if (outPath === null) return { canceled: true }

      const renderer = createOffscreenPdfRenderer(registry)
      try {
        const { pdfBytes, report } = await buildSlidesPdf({
          slides: request.slides,
          range: request.range,
          currentIndex: request.currentIndex,
          outPath,
          deckTitle: request.deckTitle,
          renderer,
        })
        // Nothing to write: an empty range, or every slide failed. The report says which; no file is
        // created (never a truncated PDF at the user's chosen path).
        if (pdfBytes === null) {
          return { canceled: false, report }
        }
        await writeExportAtomic(outPath, pdfBytes)
        return { canceled: false, report }
      } finally {
        renderer.dispose()
      }
    },
  )

  ipcMain.handle(
    FILE_EXPORT_PPTX_CHANNEL,
    async (event, payload: unknown): Promise<ExportPptxResponse> => {
      const request = parseExportPptxRequest(payload)
      if (request === null) {
        throw new Error('file:exportPptx requires a well-formed export request')
      }

      const outPath = await chooseSavePath(event.sender, defaultPptxFileName(request.deckTitle), {
        name: 'PowerPoint',
        extensions: ['pptx'],
      })
      if (outPath === null) return { canceled: true }

      const renderer = createOffscreenPptxRenderer(registry)
      try {
        const { pptxBytes, report } = await buildSlidesPptx({
          slides: request.slides,
          range: request.range,
          currentIndex: request.currentIndex,
          fidelity: request.fidelity,
          outPath,
          deckTitle: request.deckTitle,
          renderer,
          writer: createPptxWriter(),
        })
        // Nothing to write: an empty range, or every slide failed. No file is created.
        if (pptxBytes === null) {
          return { canceled: false, report }
        }
        await writeExportAtomic(outPath, pptxBytes)
        return { canceled: false, report }
      } finally {
        renderer.dispose()
      }
    },
  )

  /**
   * HTML export (M4.4). Note what is *absent* compared to the PDF handler: no offscreen window, no
   * renderer, no `slide://` registry. The bundle is the slide bytes the renderer already wrapped, so
   * there is nothing to render — which is exactly why HTML export is the highest-fidelity target and
   * also the fastest. The whole job is a pure build plus a zip plus the same atomic write.
   */
  ipcMain.handle(
    FILE_EXPORT_HTML_CHANNEL,
    async (event, payload: unknown): Promise<ExportHtmlResponse> => {
      const request = parseExportHtmlRequest(payload)
      if (request === null) {
        throw new Error('file:exportHtml requires a well-formed export request')
      }

      const outPath = await chooseSavePath(event.sender, defaultHtmlFileName(request.deckTitle), {
        name: 'HTML bundle (zip)',
        extensions: ['zip'],
      })
      if (outPath === null) return { canceled: true }

      const { files, report } = buildHtmlBundle({
        slides: request.slides,
        range: request.range,
        currentIndex: request.currentIndex,
        outPath,
        deckTitle: request.deckTitle,
      })
      // An empty range, or every slide failed: the report says which, and no file is created.
      if (files === null) return { canceled: false, report }

      await writeExportAtomic(outPath, zipHtmlBundle(files, bundleRootName(request.deckTitle)))
      return { canceled: false, report }
    },
  )
}
