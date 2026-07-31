import { contextBridge, ipcRenderer } from 'electron'
import { MENU_EVENT_CHANNEL, type MenuAction } from '../shared/ipc-contract'
import { createMenuActionHandler } from './menuActionHandler'

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
 * The channel is the shared constant, not a literal: the sender lives in a
 * different build target, so a typo here would type-check and ship as "keyboard
 * undo stopped working". What may cross is decided by
 * `createMenuActionHandler`, which is where that rule is testable.
 */
function onMenuAction(listener: (action: MenuAction) => void): () => void {
  const handler = createMenuActionHandler(listener)
  ipcRenderer.on(MENU_EVENT_CHANNEL, handler)
  return () => {
    ipcRenderer.removeListener(MENU_EVENT_CHANNEL, handler)
  }
}

const api = {
  version: '0.0.0',
  onMenuAction,
} as const

export type SloodgeApi = typeof api

contextBridge.exposeInMainWorld('sloodge', api)
