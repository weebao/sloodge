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
import { FILE_EXPORT_PDF_CHANNEL, FILE_EXPORT_PPTX_CHANNEL } from '../../shared/ipc-contract'
import type { ExportPdfResponse } from '../../shared/export/types'
import type { ExportPptxResponse } from '../../shared/export/pptx/types'
import { parseExportPdfRequest } from '../../shared/export/request'
import { parseExportPptxRequest } from '../../shared/export/pptx/request'
import { buildSlidesPdf } from './pdf-export'
import { buildSlidesPptx } from './pptx-export'
import { createOffscreenPdfRenderer } from './electron-renderer'
import { createOffscreenPptxRenderer } from './pptx-renderer'
import { createPptxWriter } from './pptx-writer'
import { writePdfAtomic } from './write'
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

export function installExportIpc(registry: SlideRegistry): void {
  ipcMain.handle(
    FILE_EXPORT_PDF_CHANNEL,
    async (event, payload: unknown): Promise<ExportPdfResponse> => {
      const request = parseExportPdfRequest(payload)
      if (request === null) {
        throw new Error('file:exportPdf requires a well-formed export request')
      }

      const senderWindow = BrowserWindow.fromWebContents(event.sender)
      const saveResult = await (senderWindow === null
        ? dialog.showSaveDialog({
            defaultPath: defaultPdfFileName(request.deckTitle),
            filters: [{ name: 'PDF', extensions: ['pdf'] }],
          })
        : dialog.showSaveDialog(senderWindow, {
            defaultPath: defaultPdfFileName(request.deckTitle),
            filters: [{ name: 'PDF', extensions: ['pdf'] }],
          }))

      if (saveResult.canceled || saveResult.filePath === undefined || saveResult.filePath === '') {
        return { canceled: true }
      }
      const outPath = saveResult.filePath

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
        await writePdfAtomic(outPath, pdfBytes)
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

      const senderWindow = BrowserWindow.fromWebContents(event.sender)
      const saveOptions = {
        defaultPath: defaultPptxFileName(request.deckTitle),
        filters: [{ name: 'PowerPoint', extensions: ['pptx'] }],
      }
      const saveResult = await (senderWindow === null
        ? dialog.showSaveDialog(saveOptions)
        : dialog.showSaveDialog(senderWindow, saveOptions))

      if (saveResult.canceled || saveResult.filePath === undefined || saveResult.filePath === '') {
        return { canceled: true }
      }
      const outPath = saveResult.filePath

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
        await writePdfAtomic(outPath, pptxBytes)
        return { canceled: false, report }
      } finally {
        renderer.dispose()
      }
    },
  )
}
