/**
 * The decision half of Present mode's fullscreen toggle (M4.1), kept free of `electron` so it is a
 * unit test rather than an integration one — the same split `slideBridge.ts` and `menuRouting.ts`
 * use. The electron-touching one line lives in `install.ts`.
 *
 * ## Why validate a message main "trusts"
 *
 * The request comes from our own renderer, but "our own renderer" is exactly what an in-page XSS
 * would also be, and a slide's JS is explicitly hostile-by-assumption (it just cannot reach the
 * bridge — 10-architecture.md §7). So the payload is narrowed to `{ fullscreen: boolean }` before it
 * can reach `setFullScreen`, and a malformed one is dropped, not coerced: `setFullScreen(undefined)`
 * or `setFullScreen("true")` would flip the window into an irreversible fullscreen with no chrome to
 * escape from. The response reports the window's *actual* state after the call, so the renderer can
 * never desync from a toggle the OS refused.
 */

import type { PresentFullscreenResponse } from '../../shared/ipc-contract'

/** The minimal window surface this handler drives — a seam so the pure logic never imports electron. */
export type FullscreenWindow = {
  setFullScreen: (flag: boolean) => void
  isFullScreen: () => boolean
  isDestroyed: () => boolean
}

/** Narrow an untyped IPC payload to the fullscreen request, or `null` if it is not one. */
export function parsePresentFullscreenRequest(payload: unknown): { fullscreen: boolean } | null {
  if (payload === null || typeof payload !== 'object') return null
  const { fullscreen } = payload as { fullscreen?: unknown }
  return typeof fullscreen === 'boolean' ? { fullscreen } : null
}

/**
 * Apply a (possibly malformed) request to the sender's window and report the resulting state.
 *
 * `window` is `null` when the sender has no `BrowserWindow` (a detached view, or a teardown race);
 * an invalid payload is treated the same as "no change requested". Either way the response is the
 * honest current state — `false` when there is no window at all — never an assumed toggle.
 */
export function applyPresentFullscreen(
  window: FullscreenWindow | null,
  payload: unknown,
): PresentFullscreenResponse {
  if (window === null || window.isDestroyed()) return { fullscreen: false }
  const request = parsePresentFullscreenRequest(payload)
  if (request !== null) window.setFullScreen(request.fullscreen)
  return { fullscreen: window.isFullScreen() }
}
