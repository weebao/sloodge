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
 *   an editable element has focus      -> the field's own undo stack
 *   a caret is open in the slide frame -> that field's own undo stack, forwarded
 *                                         over the bridge (see below)
 *   anything else                      -> the document's undo stack
 *
 * The parent-field branch runs Blink's `undo` editing command, which is exactly
 * what the `{ role: 'undo' }` item this replaced did (`webContents.undo()`
 * executes the same command in the focused frame), so replacing the role costs
 * the chat composer nothing. `execCommand` is deprecated-but-implemented and
 * there is no replacement for programmatic undo of a native field; the day it
 * goes, the fallback is a `role: 'undo'` item with `registerAccelerator: false`.
 *
 * The frame branch exists because `document.activeElement` cannot see into the
 * slide frame: with a `contenteditable` focused inside it, the parent's active
 * element is the `<iframe>` itself, which no editable-target test recognises.
 * Before M3.11's fix round that fell through to the document stack — Ctrl+Z
 * mid-typing rolled back an unrelated deck change, reloaded the frame and lost
 * the typed text. The open session registers itself (`textEditSession.ts`) and
 * the router asks it to step the frame field's own stack instead, which is the
 * same behaviour a browser host gives for free when the keystroke lands in the
 * frame. Order matters: a focused parent field wins over a frame session, so a
 * chord arriving in the instant between a frame blur and the session's end
 * still goes to the field that has focus.
 */

import type { EditMenuAction } from '../../../shared/ipc-contract'
import {
  activeTextEditSession,
  type FrameTextEditSession,
} from '../features/design/textEditSession'
import { isEditableTarget } from './useUndoRedoKeys'

export type EditActionHandlers = {
  undo: () => unknown
  redo: () => unknown
}

/** The bits of the host this needs, injected so the routing is testable. */
export type EditActionHost = {
  activeElement: EventTarget | null
  execCommand: (command: string) => boolean
  /** The open in-frame text session, or `null`. */
  frameSession: FrameTextEditSession | null
}

/** Which stack answered — returned so callers and tests can tell them apart. */
export type EditActionRoute = 'text' | 'frame' | 'document'

export function runEditAction(
  action: EditMenuAction,
  handlers: EditActionHandlers,
  host: EditActionHost,
): EditActionRoute {
  const undo = action === 'edit.undo'
  if (isEditableTarget(host.activeElement)) {
    host.execCommand(undo ? 'undo' : 'redo')
    return 'text'
  }
  if (host.frameSession !== null) {
    if (undo) host.frameSession.undo()
    else host.frameSession.redo()
    return 'frame'
  }
  if (undo) handlers.undo()
  else handlers.redo()
  return 'document'
}

/** The live host, bound to the real document and the design feature's session slot. */
export function documentEditHost(): EditActionHost {
  return {
    activeElement: document.activeElement,
    execCommand: (command) => document.execCommand(command),
    frameSession: activeTextEditSession(),
  }
}
