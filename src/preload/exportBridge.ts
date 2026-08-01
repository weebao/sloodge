/**
 * The renderer's end of PDF export (M4.2), as a plain function over an injected `invoke` — same shape
 * and same reason as `presentBridge.ts` / `slideBridge.ts`: the decision (what shape crosses) is
 * testable here because it does not import `electron`, and the one line that does lives in `index.ts`.
 *
 * The request carries the *wrapped* slide HTML (the exact bytes the canvas publishes to `slide://`)
 * so main renders byte-identically to what the user saw. Main owns the save dialog and the file
 * write; this bridge only forwards the request and hands back main's report.
 */

import { FILE_EXPORT_PDF_CHANNEL } from '../shared/ipc-contract'
import type { ExportPdfRequest, ExportPdfResponse } from '../shared/export/types'

export type ExportInvoke = (channel: string, payload: unknown) => Promise<unknown>

export type ExportBridge = {
  /** Start a PDF export. Resolves with main's report, or `{ canceled: true }` if the user dismissed the save dialog. */
  exportPdf: (request: ExportPdfRequest) => Promise<ExportPdfResponse>
}

export function createExportBridge(invoke: ExportInvoke): ExportBridge {
  return {
    exportPdf: async (request) => {
      const response = await invoke(FILE_EXPORT_PDF_CHANNEL, request)
      return response as ExportPdfResponse
    },
  }
}
