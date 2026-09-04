/**
 * `Ctrl/⌘+D` to duplicate the selected element — roadmap M3.6.
 *
 * ## Disambiguating a shared chord
 *
 * `Ctrl/⌘+D` already toggles Design Mode (`useDesignModeKey`, §4.2), and the roadmap also assigns it
 * to duplicate. They cannot both fire, so this is the resolution: **when Design Mode is on and an
 * element is selected, `Ctrl/⌘+D` duplicates that element; otherwise it still toggles Design Mode.**
 * That keeps the toggle-*on* path (mode off → the chord turns it on) and the toggle-*off* path when
 * nothing is selected, and matches the PowerPoint muscle memory that `Ctrl+D` duplicates the current
 * object. To toggle Design Mode off while an element is selected, deselect first (`Esc`).
 *
 * The preemption is made order-independent by registering in the **capture** phase and calling
 * `stopImmediatePropagation`: a capture-phase `window` listener runs before every bubble-phase one
 * (which is where `useDesignModeKey` binds), so stopping propagation there reliably prevents the
 * toggle from also firing, regardless of which effect mounted first. When no element is selected this
 * hook does nothing and the event falls through to the toggle untouched.
 */

import { useEffect } from 'react'
import { isEditableTarget } from '../../app/useUndoRedoKeys'
import { matchDesignModeKey } from './useDesignModeKey'

/**
 * Bind `Ctrl/⌘+D` to `duplicate` while `enabled` (an element is selected). `duplicate` is read
 * through a per-render effect dependency so a changed handler re-binds rather than firing stale.
 */
export function useDuplicateKey(duplicate: () => void, enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return
    const handler = (event: KeyboardEvent): void => {
      if (!matchDesignModeKey(event)) return
      // Never steal the chord from a focused text field — a `Ctrl/⌘+D` there is the browser's own
      // edit (or nothing), and duplicating the slide element under the user's cursor would surprise
      // them. Same rule (and shared predicate) as the undo/redo keys (§5 of 10-architecture.md); the
      // event falls through to the Design Mode toggle untouched.
      if (isEditableTarget(event.target)) return
      // Preempt the Design Mode toggle (bubble phase) and the browser bookmark accelerator.
      event.preventDefault()
      event.stopImmediatePropagation()
      duplicate()
    }
    window.addEventListener('keydown', handler, { capture: true })
    return () => {
      window.removeEventListener('keydown', handler, { capture: true })
    }
  }, [duplicate, enabled])
}
