/**
 * The renderer's end of File ▸ Open (M4.5), as a plain function over an injected `invoke` — same
 * shape and same reason as `exportBridge.ts` / `presentBridge.ts`: the decision (what shape crosses)
 * is testable here because it does not import `electron`, and the one line that does lives in
 * `index.ts`.
 *
 * `openDeck` takes no arguments, and that is the security property rather than an ergonomic choice:
 * main runs the native chooser, so there is no path parameter for a compromised renderer to point
 * anywhere it likes.
 */

import { FILE_OPEN_CHANNEL } from '../shared/ipc-contract'
import type { OpenDeckResponse } from '../shared/document/open'

export type DocumentInvoke = (channel: string, payload: unknown) => Promise<unknown>

export type DocumentBridge = {
  /**
   * Show the native open dialog and read the chosen `.sloodge` / `.pptx` / `.potx`. Resolves with
   * `{ canceled: true }` if the user dismissed it, or an `ok: false` response carrying a specific
   * error code for a file that could not be read.
   */
  openDeck: () => Promise<OpenDeckResponse>
}

export function createDocumentBridge(invoke: DocumentInvoke): DocumentBridge {
  return {
    openDeck: async () => {
      const response = await invoke(FILE_OPEN_CHANNEL, {})
      return response as OpenDeckResponse
    },
  }
}
