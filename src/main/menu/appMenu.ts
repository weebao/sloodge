import { app, Menu } from 'electron'
import type { MenuAction } from '../../shared/ipc-contract'
import { buildAppMenuTemplate, type MenuActionHandler } from './appMenuTemplate'

/**
 * Installs the native application menu (File / Edit).
 *
 * M0.4: File items log their action id; the real wiring lands with the
 * document + export milestones, where the ids become the `app:menu` event
 * payload (see src/shared/ipc-contract.ts). Edit is all Electron roles.
 */

const logAction: MenuActionHandler = (action: MenuAction) => {
  // eslint-disable-next-line no-console -- placeholder until the IPC wiring lands
  console.log(`[menu] ${action}`)
}

export function installAppMenu(onAction: MenuActionHandler = logAction): Menu {
  const menu = Menu.buildFromTemplate(buildAppMenuTemplate({ onAction, appName: app.name }))
  Menu.setApplicationMenu(menu)
  return menu
}
