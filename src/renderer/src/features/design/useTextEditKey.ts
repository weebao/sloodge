/**
 * `Enter` (and `F2`) to start editing the selected element's text — the keyboard half of M3.11's
 * double-click, and §4.2's "`Enter` → enter text editing if editable".
 *
 * Double-click is not an accessible affordance on its own: it needs a pointer and it needs two
 * precise clicks. `Enter` is the spec's own binding and matches PowerPoint; `F2` is the
 * spreadsheet/file-manager convention for "rename/edit in place" and costs nothing to also accept.
 *
 * The symmetry with the commit keys is deliberate and worth stating: `Enter` *opens* a session from
 * the parent document, and `Enter` *closes* it from inside the frame. The two never race, because
 * once a session is open the caret has focus inside the iframe and this `window` listener no longer
 * sees the keystroke at all — the frame's own handler does.
 */

import { useEffect } from 'react'
import { isEditableTarget } from '../../app/useUndoRedoKeys'

/** Whether `event` asks to start editing: a bare `Enter` or `F2`, no modifiers. */
export function matchTextEditKey(
  event: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'>,
): boolean {
  if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return false
  return event.key === 'Enter' || event.key === 'F2'
}

/**
 * Bind the accelerator while `enabled` (Design Mode on, exactly one element selected, nothing being
 * edited yet). `begin` returns whether it opened a session; when it declines — the element holds
 * mixed content, or is locked — the event is left alone so `Enter` keeps whatever meaning it had.
 */
export function useTextEditKey(begin: () => boolean, enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return
    const handler = (event: KeyboardEvent): void => {
      if (!matchTextEditKey(event)) return
      // Never steal `Enter` from a focused control: the property panel's fields, the chat composer
      // and any button all own it. Same shared predicate as the undo/redo and duplicate keys.
      if (isEditableTarget(event.target)) return
      const target = event.target as Partial<HTMLElement> | null
      const tag = typeof target?.tagName === 'string' ? target.tagName.toLowerCase() : ''
      if (tag === 'button' || tag === 'a' || tag === 'select') return
      // Only consume the key if a session actually opened.
      if (begin()) event.preventDefault()
    }
    window.addEventListener('keydown', handler)
    return () => {
      window.removeEventListener('keydown', handler)
    }
  }, [begin, enabled])
}
