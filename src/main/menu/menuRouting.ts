import type { MenuAction } from '../../shared/ipc-contract'

/**
 * Where a menu action goes, decided without touching Electron.
 *
 * This file exists because of what M1.4 moved: undo is no longer a renderer
 * keydown, it is a main-process hop (menu item -> focused window -> preload ->
 * dispatcher), which makes this the single point of failure for keyboard undo —
 * and the one part of the feature CI could not see. Anything reachable only
 * inside a running Electron app is logic the unit suite can never protect
 * (70-testing-ci.md), so the decisions live here as pure functions over plain
 * values and `appMenu.ts` keeps only the two lines that call Electron.
 */

/**
 * `renderer` — the renderer owns this action and must be told about it.
 * `log`      — nothing consumes it yet; its milestone will claim it.
 */
export type MenuDelivery = 'renderer' | 'log'

/**
 * Only `edit.*` crosses to the renderer today.
 *
 * The File ids are deliberately *not* forwarded: nothing in the renderer
 * handles them, and a channel that delivers actions no one consumes trains the
 * next reader to think the renderer is already wired for File ▸ New. When M5.1
 * claims them, this predicate is the one line that changes.
 */
export function menuActionTarget(action: MenuAction): MenuDelivery {
  return action.startsWith('edit.') ? 'renderer' : 'log'
}

/** The bit of `BrowserWindow` the choice below depends on. */
export type WindowLike = {
  isDestroyed: () => boolean
}

/**
 * Which window receives it: the focused one, else the first live window.
 *
 * Focused-first, never a broadcast — undo is per document, so once Present
 * (M4.1) opens a second window, telling every window to undo would rewind a
 * deck the user is not looking at.
 *
 * **Revisit at M4.1.** The fallback is right while there is exactly one window
 * and wrong the moment there are two: `getFocusedWindow()` is null more often
 * than "all windows minimised" — a focused DevTools window is the everyday case
 * — so Edit ▸ Undo typed at the DevTools console picks the window behind it.
 * That is the only deck today and therefore correct; with a Present window open
 * it is a coin flip. When that lands, either drop the fallback (a menu action
 * with no focused window becomes a no-op) or track the last-focused *editor*
 * window explicitly.
 *
 * Destroyed windows are skipped rather than merely null-checked: a window can
 * close between the click and the send, and `webContents.send` on a destroyed
 * window throws.
 */
export function pickTargetWindow<W extends WindowLike>(
  focused: W | null | undefined,
  windows: readonly W[],
): W | null {
  if (focused && !focused.isDestroyed()) return focused
  return windows.find((window) => !window.isDestroyed()) ?? null
}
