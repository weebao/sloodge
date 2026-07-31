import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { isMenuAction, type MenuAction } from '../shared/ipc-contract'

/**
 * The entire renderer-visible surface. Every future capability (doc, agent,
 * export, present) hangs off this one object — see src/shared/ipc-contract.ts.
 *
 * M1.4 adds the first real channel: the native Edit menu's Undo/Redo. In
 * Electron the renderer cannot bind CmdOrCtrl+Z for itself (the menu owns the
 * accelerator), so this subscription *is* the keyboard path to document undo,
 * not a convenience.
 */

/**
 * Subscribe to native-menu actions. Returns an unsubscribe function.
 *
 * The payload is validated here rather than trusted: `contextBridge` is the
 * boundary past which the renderer can no longer check anything about where a
 * value came from, and an unknown id must not reach a `switch` written against
 * the union. Only the action string crosses the bridge — the `IpcRendererEvent`
 * (which carries `sender`, a live `ipcRenderer` handle) never does.
 */
function onMenuAction(listener: (action: MenuAction) => void): () => void {
  const handler = (_event: IpcRendererEvent, action: unknown): void => {
    if (isMenuAction(action)) listener(action)
  }
  ipcRenderer.on('app:menu', handler)
  return () => {
    ipcRenderer.removeListener('app:menu', handler)
  }
}

const api = {
  version: '0.0.0',
  onMenuAction,
} as const

export type SloodgeApi = typeof api

contextBridge.exposeInMainWorld('sloodge', api)
