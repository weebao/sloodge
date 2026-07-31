import { contextBridge, ipcRenderer } from 'electron'
import { MENU_EVENT_CHANNEL, type MenuAction } from '../shared/ipc-contract'
import { createAgentBridge } from './agentBridge'
import { createMenuActionHandler } from './menuActionHandler'
import { createSlideBridge } from './slideBridge'

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

/**
 * M2.0's channels: slide documents are served from `slide://` by main, so the renderer must hand
 * main the HTML and get an id back. The presence of these two functions on `window.sloodge` is also
 * the renderer's host gate — see `slideUrlFactory.ts` — so they are exposed as one unit.
 */
const { publishSlide, revokeSlide } = createSlideBridge(async (channel, payload) =>
  ipcRenderer.invoke(channel, payload),
)

/**
 * M2.1's agent surface. Streaming events arrive on a one-way channel, so the bridge takes a
 * `subscribe` that wraps `ipcRenderer.on`/`removeListener` and hands the listener the payload only —
 * the same shape `onMenuAction` uses, kept local because the decisions live in `agentBridge.ts`.
 */
const agent = createAgentBridge(
  async (channel, payload) => ipcRenderer.invoke(channel, payload),
  (channel, handler) => {
    const wrapped = (_event: Electron.IpcRendererEvent, payload: unknown): void => handler(payload)
    ipcRenderer.on(channel, wrapped)
    return () => {
      ipcRenderer.removeListener(channel, wrapped)
    }
  },
)

const api = {
  version: '0.0.0',
  onMenuAction,
  publishSlide,
  revokeSlide,
  agent,
} as const

export type SloodgeApi = typeof api

contextBridge.exposeInMainWorld('sloodge', api)
