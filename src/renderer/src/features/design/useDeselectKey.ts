/**
 * `Esc` to deselect — the first stage of §4.2's three-stage escape ("deselect → exit text editing →
 * exit Design Mode"), and the reason Design Mode can no longer be entered into a state with no way
 * out.
 *
 * Before this, `Escape` with a selection did nothing at all. That was survivable while a selection
 * was a small box on an element you could click away from; it stopped being survivable when M3.11
 * turned Design Mode on by default, because one click on empty canvas selects the slide root, whose
 * selection box is the whole 1280×720 stage. The overlay now re-hit-tests through a stationary click
 * on that box (`SelectionOverlay`), so the mouse is no longer trapped either — but a mode with no
 * keyboard exit is still the wrong shape, and `Esc` is what the spec and PowerPoint both bind.
 *
 * ## What this hook deliberately does not do
 *
 * **It does not touch an open text-edit session.** While a caret is open the keystroke is the
 * frame's: focus is inside the iframe, so this `window` listener never sees it, and on the paths
 * where the parent *does* have focus with a session open (a property field, the Settings dialog) the
 * session's own commit rules apply. Deselecting out from under a caret would strand the frame's
 * `contenteditable`, so the hook is disarmed for as long as `editing` is set.
 *
 * **It does not exit Design Mode** (§4.2's third stage). Turning the mode off changes the canvas
 * layout and the document the frame is showing; making a stray `Esc` do that — with the mode now on
 * by default — is a bigger promise than "get me out of this selection", and it belongs with the
 * Present/mode work rather than a fix round. `Ctrl/⌘+D` remains the mode's own toggle.
 *
 * Bound in the **bubble** phase on purpose. The Settings dialog and the rail's context menu both
 * close on `Escape` and both `stopPropagation()` from inside React's tree, which sits below `window`
 * in the bubble path — so their `Esc` never reaches this listener, and a capture-phase binding would
 * have deselected behind an open modal.
 */

import { useEffect } from 'react'
import { isEditableTarget } from '../../app/useUndoRedoKeys'

/** Whether `event` asks to deselect: a bare `Escape`, no modifiers. */
export function matchDeselectKey(
  event: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'>,
): boolean {
  if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return false
  return event.key === 'Escape'
}

/**
 * Bind `Esc` to `clear` while `enabled` (Design Mode on, something selected, no caret open).
 * A focused text field keeps its own `Escape` — the same shared predicate as the undo/redo,
 * duplicate and text-edit keys.
 */
export function useDeselectKey(clear: () => void, enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return
    const handler = (event: KeyboardEvent): void => {
      if (!matchDeselectKey(event)) return
      if (isEditableTarget(event.target)) return
      event.preventDefault()
      clear()
    }
    window.addEventListener('keydown', handler)
    return () => {
      window.removeEventListener('keydown', handler)
    }
  }, [clear, enabled])
}
