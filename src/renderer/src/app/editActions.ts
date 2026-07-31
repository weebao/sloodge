/**
 * What Edit ▸ Undo / Redo means when it arrives from the native menu.
 *
 * In Electron the menu owns CmdOrCtrl+Z — a menu item's accelerator is
 * registered with the OS, so it fires before any renderer keydown — which means
 * this dispatcher, not `useUndoRedoKeys`, is the keyboard path to undo in the
 * packaged app. The menu therefore forwards *intent* (`edit.undo`) rather than
 * performing an action, and the routing rule of §5 lives here, at the single
 * point the keystroke arrives:
 *
 *   an editable element has focus -> the field's own undo stack
 *   anything else                 -> the document's undo stack
 *
 * The text branch runs Blink's `undo` editing command, which is exactly what
 * the `{ role: 'undo' }` item this replaced did (`webContents.undo()` executes
 * the same command in the focused frame), so replacing the role costs the chat
 * composer nothing. `execCommand` is deprecated-but-implemented and there is no
 * replacement for programmatic undo of a native field; the day it goes, the
 * fallback is a `role: 'undo'` item with `registerAccelerator: false`.
 */

import type { EditMenuAction } from '../../../shared/ipc-contract'
import { isEditableTarget } from './useUndoRedoKeys'

export type EditActionHandlers = {
  undo: () => unknown
  redo: () => unknown
}

/** The bits of `document` this needs, injected so the routing is testable. */
export type EditActionHost = {
  activeElement: EventTarget | null
  execCommand: (command: string) => boolean
}

/** Which stack answered — returned so callers and tests can tell them apart. */
export type EditActionRoute = 'text' | 'document'

export function runEditAction(
  action: EditMenuAction,
  handlers: EditActionHandlers,
  host: EditActionHost,
): EditActionRoute {
  if (isEditableTarget(host.activeElement)) {
    host.execCommand(action === 'edit.undo' ? 'undo' : 'redo')
    return 'text'
  }
  if (action === 'edit.undo') handlers.undo()
  else handlers.redo()
  return 'document'
}

/** The live host, bound to the real document. */
export function documentEditHost(): EditActionHost {
  return {
    activeElement: document.activeElement,
    execCommand: (command) => document.execCommand(command),
  }
}
