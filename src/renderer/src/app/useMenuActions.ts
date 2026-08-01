/**
 * The renderer's end of the native menu, and the one place that decides which
 * of the two undo paths is live.
 *
 * There are two hosts for this renderer, and exactly one of them has a menu:
 *
 *   Electron  — `window.sloodge` exists. The application menu owns CmdOrCtrl+Z
 *               (an accelerator is registered with the OS), so undo arrives as
 *               an `app:menu` event and the window keydown handler must stay
 *               out of it.
 *   A browser — `window.sloodge` is undefined: the evidence recorder serves the
 *               built renderer over http, and the unit tests mount it in
 *               happy-dom. No menu exists, so nothing would handle the chord at
 *               all unless the keydown handler does.
 *
 * `useUndoRedoKeys` is therefore enabled *iff* the bridge is absent. That is
 * what makes double-undo impossible by construction rather than by timing: the
 * two paths are selected by a static fact about the host, not raced against
 * each other, so no keypress can ever reach both. A guard that de-duplicated by
 * timestamp would have to guess how long "the same keypress" lasts.
 */

import { useEffect } from 'react'
import { getBridge, type SloodgeBridge } from '../host/bridge'
import { documentEditHost, runEditAction, type EditActionHandlers } from './editActions'

/**
 * The preload surface and its accessor moved to `../host/bridge` in M2.0, when a second feature
 * (`slide://` delivery) needed to augment the same `Window` property — two `declare global` blocks
 * for one name do not merge, they collide. Re-exported here so this module stays the obvious entry
 * point for the menu half.
 */
export { getBridge, type SloodgeBridge }

/**
 * True when a native menu owns the Edit accelerators, i.e. the renderer must
 * not bind them itself.
 */
export function menuOwnsEditAccelerators(): boolean {
  return getBridge() !== undefined
}

/**
 * Route `app:menu` events. Inert — and unsubscribed — when there is no bridge.
 *

 * `onExportPdf` (M4.2), `onExportPptx` (M4.3) and `onExportHtml` (M4.4) are the File-menu consumers: the ids are forwarded
 * to the renderer (`menuRouting.ts`) because the deck lives here, and this is where they are claimed.
 * The remaining File ids still belong to their milestones.
 *
 * Both handlers must have stable identities — they are effect dependencies, so a new function per
 * render would resubscribe `app:menu` on every keystroke. `useExportPdf` / `useExportHtml` guarantee
 * that with a ref; see their docstrings.
 */
export function useMenuActions(
  handlers: EditActionHandlers,
  onExportPdf?: () => void,
  onExportPptx?: () => void,
  onExportHtml?: () => void,
  onOpenSettings?: () => void,
): void {
  const { undo, redo } = handlers
  useEffect(() => {
    const bridge = getBridge()
    if (bridge === undefined) return
    return bridge.onMenuAction((action) => {
      if (action === 'edit.undo' || action === 'edit.redo') {
        runEditAction(action, { undo, redo }, documentEditHost())
        return
      }
      if (action === 'file.export.pdf') {
        onExportPdf?.()
        return
      }
      if (action === 'file.export.pptx') {
        onExportPptx?.()
        return
      }
      if (action === 'file.export.html') {
        onExportHtml?.()
        return
      }
      // M2.7: File ▸ Settings… and the native `Ctrl/⌘+,` accelerator arrive here as one id, so the
      // dialog has exactly one entry point rather than a second in-renderer key handler.
      if (action === 'app.settings') {
        onOpenSettings?.()
        return
      }
      // Every other id belongs to File; its milestone will claim it here.
    })
  }, [undo, redo, onExportPdf, onExportPptx, onExportHtml, onOpenSettings])
}
