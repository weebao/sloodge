/**
 * File ▸ Open (M4.5): the native chooser, the read, and the hand-off to the renderer.
 *
 * Three formats arrive through one channel — `.sloodge` via M1.1's `readDeck`, `.pptx`/`.potx` via
 * M4.5's `importPptx` — and both paths end in the same place: a `DeckUpdate` the renderer adopts with
 * `doc:open` semantics (history reset, undo stack cleared).
 *
 * ## Main owns the path
 *
 * The request carries no filename. Main runs `showOpenDialog` and reads only what the user picked in
 * an OS-trusted chooser, so a compromised renderer cannot turn this channel into an arbitrary-file
 * read. Same reasoning as the three export channels owning `showSaveDialog` (60-export.md §1.5),
 * applied to the read direction — and it costs nothing, because a file picker is where the path was
 * always going to come from.
 *
 * ## Why main keeps the bundle
 *
 * `openDocumentSession` retains the full `DeckBundle` — including `extras`, and therefore the
 * retained `import/original.pptx` and its ledger — after the renderer has been handed the document.
 * Two reasons: the archive is far too large to ship across IPC for no consumer, and round-trip
 * export (M4.6) needs it on the main side anyway.
 *
 * **The round-trip exporter is not yet wired to this session, deliberately.** It needs the deck's
 * *current* slide HTML, and today the renderer's `DocumentHistory` is the sole authority for that —
 * main's copy is the one it read at open time and goes stale the moment the user types. Wiring the
 * two together is a document-ownership change (a renderer → main sync, or moving authority to main),
 * not a line of plumbing, so it belongs to its own milestone rather than being faked here with a
 * copy that silently drifts. Until then `exportPptxRoundTrip` is exercised by M4.6's tests against
 * bundles read straight off disk, which is exactly the state this session holds; the UI's PPTX
 * export continues to use M4.3's structured path.
 */

import { basename } from 'node:path'
import { BrowserWindow, dialog, ipcMain } from 'electron'
import { FILE_OPEN_CHANNEL } from '../../shared/ipc-contract'
import {
  OPEN_DECK_FILTERS,
  openSourceForPath,
  type OpenDeckPayload,
  type OpenDeckResponse,
} from '../../shared/document/open'
import { readDeck, type DeckBundle } from './store'
import { importPptx } from '../import/pptx-import'

/** The document main currently has on disk-read, kept for the reasons in the module docblock. */
export type OpenDocument = {
  readonly path: string
  readonly bundle: DeckBundle
}

let current: OpenDocument | null = null

/** The deck main last read, or `null` before any open. */
export function getOpenDocument(): OpenDocument | null {
  return current
}

/** Test seam, and what a future File ▸ Close will call. */
export function setOpenDocument(document: OpenDocument | null): void {
  current = document
}

/**
 * Run the native open dialog and return the chosen path, or `null` when dismissed.
 *
 * Parented to the sender's window so the sheet is modal to the editor. The empty-string check is the
 * same load-bearing guard `chooseSavePath` carries: `showOpenDialog` can report `canceled: false`
 * with an empty selection, and reading `''` would surface as an unactionable error.
 */
async function chooseOpenPath(sender: Electron.WebContents): Promise<string | null> {
  const senderWindow = BrowserWindow.fromWebContents(sender)
  const options = {
    properties: ['openFile' as const],
    filters: [...OPEN_DECK_FILTERS],
  }
  const result = await (senderWindow === null
    ? dialog.showOpenDialog(options)
    : dialog.showOpenDialog(senderWindow, options))

  if (result.canceled) return null
  const path = result.filePaths[0]
  return path === undefined || path === '' ? null : path
}

/**
 * Read a chosen file into a renderer payload plus the bundle main retains. Pure with respect to
 * Electron — no dialog, no IPC — so the whole open behaviour is unit-testable against real files.
 */
export async function openDeckAtPath(
  path: string,
): Promise<
  | { ok: true; payload: OpenDeckPayload; bundle: DeckBundle }
  | { ok: false; error: { code: string; message: string } }
> {
  const source = openSourceForPath(path)

  if (source === 'sloodge') {
    const result = await readDeck(path)
    if (!result.ok) return { ok: false, error: result.error }
    const { bundle, warnings } = result
    return {
      ok: true,
      bundle,
      payload: {
        path,
        fileName: basename(path),
        source,
        deck: {
          manifest: bundle.manifest,
          slides: bundle.slides,
          notes: bundle.notes,
          theme: bundle.theme,
        },
        warnings,
      },
    }
  }

  const result = await importPptx(path)
  if (!result.ok) return { ok: false, error: result.error }
  const { bundle, report } = result
  return {
    ok: true,
    bundle,
    payload: {
      path,
      fileName: basename(path),
      source: report.format,
      deck: {
        manifest: bundle.manifest,
        slides: bundle.slides,
        notes: bundle.notes,
        theme: bundle.theme,
      },
      warnings: report.warnings,
      import: {
        slideCount: report.slideCount,
        convertedCount: report.convertedCount,
        fallbackCount: report.fallbackCount,
        sourceSha256: report.sourceSha256,
        retainedBytes: report.retainedBytes,
        partCount: report.partCount,
        conversionNotes: report.conversionNotes,
      },
    },
  }
}

export function installDocumentIpc(): void {
  ipcMain.handle(FILE_OPEN_CHANNEL, async (event): Promise<OpenDeckResponse> => {
    const path = await chooseOpenPath(event.sender)
    if (path === null) return { canceled: true }

    const result = await openDeckAtPath(path)
    if (!result.ok) {
      // An unreadable file is a normal outcome the UI must render, not an exception to propagate:
      // throwing here would reject the renderer's `invoke` and lose the specific error code.
      return { canceled: false, ok: false, error: result.error }
    }
    setOpenDocument({ path, bundle: result.bundle })
    return { canceled: false, ok: true, payload: result.payload }
  })
}
