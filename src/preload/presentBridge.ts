import {
  PRESENT_SET_FULLSCREEN_CHANNEL,
  type PresentFullscreenResponse,
} from '../shared/ipc-contract'

/**
 * The renderer's end of Present mode's fullscreen toggle (M4.1), as a plain function over an injected
 * `invoke` — same shape and same reason as `slideBridge.ts`: this file's decisions are testable
 * because they do not import `electron`, and the one line that does lives in `index.ts`.
 *
 * Validation on the way back matters: the boolean the renderer gets is the window's *actual*
 * fullscreen state, so the surface can trust it to decide whether its exit path needs to undo a
 * toggle. A malformed response is read as `false` (not fullscreen) rather than thrown — Present
 * failing to go fullscreen must still present, in a maximized window, not crash on entry.
 */

export type PresentInvoke = (channel: string, payload: unknown) => Promise<unknown>

export type PresentBridge = {
  /** Toggle real OS fullscreen; resolves with the window's actual fullscreen state after the call. */
  setPresentFullscreen: (fullscreen: boolean) => Promise<boolean>
}

export function createPresentBridge(invoke: PresentInvoke): PresentBridge {
  return {
    setPresentFullscreen: async (fullscreen) => {
      const response = await invoke(PRESENT_SET_FULLSCREEN_CHANNEL, { fullscreen })
      return (response as Partial<PresentFullscreenResponse> | null)?.fullscreen === true
    },
  }
}
