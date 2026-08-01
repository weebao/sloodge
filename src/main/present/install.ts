import { BrowserWindow, ipcMain } from 'electron'
import {
  PRESENT_SET_FULLSCREEN_CHANNEL,
  type PresentFullscreenResponse,
} from '../../shared/ipc-contract'
import { applyPresentFullscreen } from './presentFullscreen'

/**
 * Wire Present mode's fullscreen channel (M4.1). The thin electron half: resolve the sender's window
 * and hand it to `applyPresentFullscreen`, which owns the validation and the state read. Registered
 * once from the app-ready handler, alongside the slide and agent IPC.
 *
 * The window is taken from `event.sender`, not a captured handle, so the toggle always lands on the
 * window that asked — the correct target even once a second window exists (menuRouting.ts's
 * "Revisit at M4.1" note is about *event* routing to a focused window; a request already carries its
 * own sender).
 */
export function installPresentIpc(): void {
  ipcMain.handle(
    PRESENT_SET_FULLSCREEN_CHANNEL,
    (event, payload: unknown): PresentFullscreenResponse => {
      const window = BrowserWindow.fromWebContents(event.sender)
      return applyPresentFullscreen(window, payload)
    },
  )
}
