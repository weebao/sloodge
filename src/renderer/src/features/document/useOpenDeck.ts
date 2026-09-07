/**
 * The renderer's File ▸ Open trigger (M4.5).
 *
 * Mirrors the export hooks' shape — a stable callback over an injected bridge — for the same reason:
 * `useMenuActions` lists it in an effect dependency array, so a callback whose identity changed with
 * the deck would tear down and rebuild the `app:menu` subscription on every keystroke.
 *
 * The direction is inverted from export, though. Export gathers state and sends it; open *receives*
 * a whole document and adopts it with `doc:open` semantics: `applyRemoteDeck` resets the
 * `DocumentHistory`, so the undo stack from the previous document cannot be used to "undo" past the
 * open into a deck that is no longer on screen.
 *
 * Nothing here names a file. The bridge takes no path — main runs the native chooser — so a
 * cancelled dialog and a successful open are the only two outcomes the renderer can cause.
 */

import { useCallback, useRef } from 'react'
import { getBridge } from '../../host/bridge'
import type { OpenDeckPayload } from '../../../../shared/document/open'
import type { DeckUpdate } from '../../../../shared/document/deck-update'

export type UseOpenDeckArgs = {
  /** The store's `doc:open` adoption. Returns false when the manifest fails validation. */
  applyRemoteDeck: (update: DeckUpdate) => boolean
  /** Called after a successful adoption, for the title bar and the import report. */
  onOpened?: (payload: OpenDeckPayload) => void
  /** Called when the file could not be read. The dialog being dismissed is not an error. */
  onError?: (error: { code: string; message: string }) => void
}

export function useOpenDeck(args: UseOpenDeckArgs): () => void {
  const argsRef = useRef(args)
  argsRef.current = args
  // One open at a time. The native dialog is modal to the window, so a second Ctrl+O cannot reach
  // here in practice; the guard is for the scripted double invoke, where two concurrent opens would
  // otherwise race into `applyRemoteDeck` last-write-wins.
  const inFlight = useRef(false)

  return useCallback(() => {
    const bridge = getBridge()
    // A plain-browser host has no file system to open from; the menu item simply does nothing there.
    if (bridge?.openDeck === undefined) return
    if (inFlight.current) return
    inFlight.current = true

    void (async () => {
      const { applyRemoteDeck, onOpened, onError } = argsRef.current
      let response
      try {
        response = await bridge.openDeck?.()
      } catch (error) {
        // An open that fails must not take down the editor — same policy as the export hooks.
        onError?.({ code: 'io', message: String(error) })
        return
      }
      if (response === undefined || response.canceled) return
      if (!response.ok) {
        onError?.(response.error)
        return
      }
      if (!applyRemoteDeck(response.payload.deck)) {
        // The manifest failed validation in the store. Main validated it too, so this is a
        // version-skew or corruption signal rather than a routine outcome — report it rather than
        // leaving the user looking at the previous deck wondering whether the open worked.
        onError?.({
          code: 'manifest-invalid',
          message: `${response.payload.fileName} could not be adopted: its manifest failed validation`,
        })
        return
      }
      onOpened?.(response.payload)
    })().finally(() => {
      inFlight.current = false
    })
  }, [])
}
