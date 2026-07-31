/**
 * The `Cmd/Ctrl+D` Design Mode toggle — §4.2 of `.claude/plans/init/40-design-mode.md`.
 *
 * The chord matcher is a pure function, split out for the same reason `matchUndoRedoKey` is: a
 * keyboard shortcut is a small pile of edge cases (which modifier on which platform, does the OS
 * already own the key) and a pure predicate is the only way to pin them without synthesizing events.
 * `Ctrl/⌘+D` is the browser's "bookmark" accelerator, so the handler calls `preventDefault` when it
 * fires — but only then, so an unmatched `D` still types normally.
 */

import { useEffect } from 'react'

/** Whether `event` is the Design Mode toggle chord: `Ctrl+D` or `⌘+D`, without `Alt`/`Shift`. */
export function matchDesignModeKey(
  event: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'>,
): boolean {
  if (event.altKey || event.shiftKey) return false
  if (!(event.ctrlKey || event.metaKey)) return false
  return event.key === 'd' || event.key === 'D'
}

/**
 * Bind the toggle to the window. `toggle` is expected to be stable (a store action reference is);
 * it is a dependency so a changed handler re-binds rather than firing a stale closure.
 */
export function useDesignModeKey(toggle: () => void): void {
  useEffect(() => {
    const handler = (event: KeyboardEvent): void => {
      if (!matchDesignModeKey(event)) return
      event.preventDefault()
      toggle()
    }
    window.addEventListener('keydown', handler)
    return () => {
      window.removeEventListener('keydown', handler)
    }
  }, [toggle])
}
