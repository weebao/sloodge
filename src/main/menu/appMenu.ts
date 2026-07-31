import { app, BrowserWindow, Menu } from 'electron'
import type { MenuAction } from '../../shared/ipc-contract'
import { buildAppMenuTemplate, type MenuActionHandler } from './appMenuTemplate'

/**
 * Installs the native application menu (File / Edit).
 *
 * File items still only log their action id; the real wiring lands with the
 * document + export milestones. Edit's Undo/Redo do *not* log — since M1.4 they
 * are the only owner of CmdOrCtrl+Z, so they are delivered to the renderer as
 * `app:menu` events (see src/shared/ipc-contract.ts for why they stopped being
 * Electron roles).
 */

/**
 * Deliver to the window the chord was pressed in.
 *
 * `getFocusedWindow()`, not a broadcast: undo is per document, and once Present
 * (M4.1) opens a second window, broadcasting would rewind a deck the user is
 * not looking at. The fallback to the first window covers the case where a menu
 * fires with no focused window — the macOS app menu with every window
 * minimised.
 */
export function sendMenuAction(action: MenuAction): void {
  const target = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
  if (!target || target.isDestroyed()) return
  target.webContents.send('app:menu', action)
}

const defaultHandler: MenuActionHandler = (action: MenuAction) => {
  if (action.startsWith('edit.')) {
    sendMenuAction(action)
    return
  }
  // eslint-disable-next-line no-console -- placeholder until the file/export wiring lands
  console.log(`[menu] ${action}`)
}

export function installAppMenu(onAction: MenuActionHandler = defaultHandler): Menu {
  const menu = Menu.buildFromTemplate(buildAppMenuTemplate({ onAction, appName: app.name }))
  Menu.setApplicationMenu(menu)
  return menu
}
