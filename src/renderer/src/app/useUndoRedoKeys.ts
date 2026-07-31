/**
 * Ctrl/⌘+Z and Ctrl+Y / Shift+⌘+Z, bound on the window.
 *
 * The native Edit menu keeps its `undo`/`redo` *roles* (see the comment in
 * `main/menu/appMenuTemplate.ts`), which is what makes text fields' own undo work; §5 of
 * 10-architecture.md then says the renderer binds the same chords "*only* when focus is not inside
 * a text input that has its own native undo". So this handler's first job is to decline: if the
 * event came from an editable element, it does nothing at all — no `preventDefault`, no document
 * undo — and the platform's field-local undo runs untouched. Getting that backwards would rewind
 * the whole deck while the user was trying to take back three characters of a slide title.
 *
 * The pieces are exported separately from the hook because the guard *is* the feature: a keyboard
 * handler is only testable through a real event, and `isEditableTarget` / `matchUndoRedoKey` are
 * where the decisions live.
 */

import { useEffect } from 'react'

export type UndoRedoAction = 'undo' | 'redo'

/** Elements whose own undo stack owns Ctrl+Z while they have focus. */
const EDITABLE_TAGS = new Set(['input', 'textarea', 'select'])

/**
 * Structural, not `instanceof`: an `Element` from another realm (a slide frame's document, a
 * portal into a detached document) fails `instanceof Element` against this window's constructor
 * while being every bit as editable. Duck-typing the two properties we actually read cannot get
 * that wrong.
 *
 * Every `<input>` counts, not just the textual ones. A checkbox has nothing to undo, but "the
 * focused control might own this chord" is the safe way to be wrong: declining costs the user one
 * keystroke they can repeat, and acting wrongly costs them a document-wide rewind.
 */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (target === null || typeof target !== 'object') return false
  const element = target as Partial<HTMLElement>
  if (typeof element.tagName !== 'string') return false
  if (EDITABLE_TAGS.has(element.tagName.toLowerCase())) return true
  if (element.isContentEditable === true) return true
  // `isContentEditable` is only defined for rendered elements, and the event target inside a
  // rich-text host is usually a descendant of the element carrying the attribute.
  return (
    typeof element.closest === 'function' &&
    element.closest('[contenteditable]:not([contenteditable="false"])') !== null
  )
}

/**
 * Which document action a keystroke asks for, or `null`.
 *
 * `Ctrl+Y` is the Windows/Linux redo and is deliberately *not* accepted with ⌘ — on macOS that
 * chord belongs to the system, and redo there is Shift+⌘+Z.
 */
export function matchUndoRedoKey(event: KeyboardEvent): UndoRedoAction | null {
  if (event.altKey) return null
  const key = event.key.toLowerCase()
  if (key === 'z' && (event.ctrlKey || event.metaKey)) return event.shiftKey ? 'redo' : 'undo'
  if (key === 'y' && event.ctrlKey && !event.metaKey && !event.shiftKey) return 'redo'
  return null
}

/**
 * Run `undo` / `redo` for the chords above, unless an editable element has the event.
 *
 * Bound on `window` rather than the shell element so a chord still works when focus has fallen to
 * `<body>` — which is where it lands after the rail deletes the button the user just clicked.
 */
export function useUndoRedoKeys(undo: () => unknown, redo: () => unknown): void {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      // A handler closer to the action already dealt with it (a dialog, a future inline editor).
      if (event.defaultPrevented) return
      if (isEditableTarget(event.target)) return
      const action = matchUndoRedoKey(event)
      if (action === null) return
      event.preventDefault()
      if (action === 'undo') undo()
      else redo()
    }

    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [undo, redo])
}
