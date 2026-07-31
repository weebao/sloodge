import { app, BrowserWindow, Menu } from 'electron'
import { MENU_EVENT_CHANNEL, type MenuAction } from '../../shared/ipc-contract'
import { buildAppMenuTemplate, type MenuActionHandler } from './appMenuTemplate'
import { menuActionTarget, pickTargetWindow } from './menuRouting'

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
 * Deliver to the window the chord was pressed in. Which window that is, and
 * whether the action goes to the renderer at all, are decided by the pure
 * functions in `menuRouting.ts` — everything Electron-specific is right here,
 * and it is three lines on purpose.
 */
export function sendMenuAction(action: MenuAction): void {
  const target = pickTargetWindow(BrowserWindow.getFocusedWindow(), BrowserWindow.getAllWindows())
  if (target === null) return
  target.webContents.send(MENU_EVENT_CHANNEL, action)
}

const defaultHandler: MenuActionHandler = (action: MenuAction) => {
  if (menuActionTarget(action) === 'renderer') {
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
