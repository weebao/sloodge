/**
 * The `file:open` wire contract (M4.5) — File ▸ Open, for `.sloodge`, `.pptx` and `.potx`.
 *
 * **The renderer never names a path.** The request is empty: main owns the native dialog, so the
 * only file that can be opened is one the *user* picked in an OS-trusted chooser. A renderer-supplied
 * path would be an arbitrary-file-read primitive reachable from a compromised renderer, and it would
 * buy nothing — this is the same reasoning that keeps `showSaveDialog` in main for the three export
 * channels (60-export.md §1.5), applied to the read direction.
 *
 * The response deliberately carries the *document*, not a handle: the renderer's `DocumentHistory`
 * is authoritative for an open deck, so `file:open` is a one-shot "here is a new document, reset
 * your history" — the `doc:open` semantics `applyRemoteDeck` already implements.
 *
 * ## What does not cross
 *
 * `DeckBundle.extras` — including the retained `import/original.pptx` — stays in main and is
 * deliberately absent from `OpenDeckPayload`. A whole PPTX archive is not something to serialize
 * across an IPC boundary on every open, the renderer has no use for it, and round-trip export is a
 * main-side concern. Main keeps the full bundle (see `openDocumentSession`), which is also what
 * makes the retained archive available to the exporter without a second read.
 */

import type { DeckUpdate } from './deck-update'

/** Empty by design: main owns the dialog, so there is no path for the renderer to supply. */
export type OpenDeckRequest = Record<string, never>

/** How the opened file was interpreted. */
export type OpenDeckSource = 'sloodge' | 'pptx' | 'potx'

/**
 * The PPTX-specific half of the report, present only for an imported package. Kept structural (plain
 * data, no main-process types) so `src/shared` stays importable from the renderer.
 */
export type PptxImportSummary = {
  readonly slideCount: number
  /** Slides converted structurally rather than replaced by the text-only fallback. */
  readonly convertedCount: number
  readonly fallbackCount: number
  /** Hex sha256 of the retained archive — the value M4.6's identity assertion compares against. */
  readonly sourceSha256: string
  readonly retainedBytes: number
  readonly partCount: number
  /** Everything the converter could not represent. Surfaced so fidelity loss is never silent. */
  readonly conversionNotes: readonly string[]
}

export type OpenDeckPayload = {
  readonly path: string
  /** The file's own name, for the title bar. */
  readonly fileName: string
  readonly source: OpenDeckSource
  readonly deck: DeckUpdate
  /** Non-fatal observations: a repaired slide, a dropped external link, a capped slide count. */
  readonly warnings: readonly string[]
  /** Present iff `source` is `pptx` or `potx`. */
  readonly import?: PptxImportSummary
}

export type OpenDeckError = {
  readonly code: string
  readonly message: string
}

export type OpenDeckResponse =
  | { readonly canceled: true }
  | { readonly canceled: false; readonly ok: true; readonly payload: OpenDeckPayload }
  | { readonly canceled: false; readonly ok: false; readonly error: OpenDeckError }

/** The dialog filters, shared so the menu, the handler and its tests cannot drift apart. */
export const OPEN_DECK_FILTERS: readonly { name: string; extensions: string[] }[] = [
  { name: 'Presentations', extensions: ['sloodge', 'pptx', 'potx'] },
  { name: 'Sloodge deck', extensions: ['sloodge'] },
  { name: 'PowerPoint', extensions: ['pptx', 'potx'] },
  { name: 'All files', extensions: ['*'] },
]

/**
 * Decide how to read a chosen file **by extension**, not by sniffing its bytes.
 *
 * Both formats are zips, so magic bytes cannot tell them apart, and the discriminator that could —
 * the presence of `manifest.json` versus `[Content_Types].xml` — would mean opening the archive
 * twice or threading a half-parsed package between two readers. The extension is what the user's
 * own file chooser filtered on, and a mislabelled file fails with a specific, honest error
 * (`manifest-missing` or `not-a-presentation`) rather than being silently reinterpreted.
 */
export function openSourceForPath(path: string): OpenDeckSource {
  const lower = path.toLowerCase()
  if (lower.endsWith('.potx')) return 'potx'
  if (lower.endsWith('.pptx') || lower.endsWith('.ppsx')) return 'pptx'
  return 'sloodge'
}
