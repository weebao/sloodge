import type { MenuItemConstructorOptions } from 'electron'
import type { MenuAction } from '../../shared/ipc-contract'

/**
 * The pure File/Edit menu template.
 *
 * Nothing here imports the `electron` module at runtime (the type import is
 * erased), so the template is unit-testable in plain Node. `appMenu.ts` owns
 * the electron-side installation.
 */

export type MenuActionHandler = (action: MenuAction) => void

export type AppMenuTemplateOptions = {
  onAction: MenuActionHandler
  /** Defaults to the host platform; injectable so tests can cover both. */
  platform?: NodeJS.Platform
  /** Label of the macOS application menu. Ignored off darwin. */
  appName?: string
}

/** One menu item that forwards a shared action id; the only kind we hand-roll. */
function actionItem(
  label: string,
  action: MenuAction,
  accelerator: string | undefined,
  onAction: MenuActionHandler,
): MenuItemConstructorOptions {
  return {
    label,
    ...(accelerator === undefined ? {} : { accelerator }),
    click: () => {
      onAction(action)
    },
  }
}

/**
 * Redo's accelerator, per platform — deliberately the *same* chord Electron's
 * own `redo` role registers (`lib/browser/api/menu-item-roles.ts`): Ctrl+Y on
 * Windows, Shift+CmdOrCtrl+Z everywhere else. Replacing the role must not
 * silently move a user's keyboard shortcut; only who handles it changes.
 */
export function redoAccelerator(platform: NodeJS.Platform): string {
  return platform === 'win32' ? 'Ctrl+Y' : 'Shift+CmdOrCtrl+Z'
}

export function buildAppMenuTemplate({
  onAction,
  platform = process.platform,
  appName,
}: AppMenuTemplateOptions): MenuItemConstructorOptions[] {
  const isMac = platform === 'darwin'

  // The menu bar is File + Edit only, per 00-overview.md — replacing the default
  // menu drops Electron's View/Window menus (and their accelerators) on purpose.
  const fileMenu: MenuItemConstructorOptions = {
    label: '&File',
    submenu: [
      actionItem('New', 'file.new', 'CmdOrCtrl+N', onAction),
      actionItem('Open…', 'file.open', 'CmdOrCtrl+O', onAction),
      { type: 'separator' },
      {
        label: 'Export',
        submenu: [
          actionItem('Export as PPTX…', 'file.export.pptx', undefined, onAction),
          actionItem('Export as PDF…', 'file.export.pdf', undefined, onAction),
          actionItem('Export as HTML…', 'file.export.html', undefined, onAction),
        ],
      },
      { type: 'separator' },
      // Settings lives on File on every platform (M2.7). On macOS its conventional home is the app
      // menu, but that is `{ role: 'appMenu' }` here — an opaque Electron-built submenu we cannot
      // insert into without hand-rolling the whole thing. `CmdOrCtrl+,` is the chord users actually
      // reach for, and registering it here means it works on macOS regardless of where the item sits.
      actionItem('Settings…', 'app.settings', 'CmdOrCtrl+,', onAction),
      { type: 'separator' },
      { role: isMac ? 'close' : 'quit' },
    ],
  }

  // Clipboard stays on roles, so Electron routes cut/copy/paste/selectAll to the
  // focused webContents and native editing keeps working in text inputs.
  //
  // Undo and Redo are NOT roles, and that is a reversal of what this comment said
  // through M0.4 ("never by replacing these roles wholesale"). The intent behind
  // that line — never break native undo in a focused text field — is kept; the
  // letter could not be. A role registers CmdOrCtrl+Z with the OS menu
  // (`registerAccelerator` defaults to true), so it consumes the chord and the
  // renderer's keydown handler never runs: document undo by keyboard would be
  // dead in the packaged app while every test stayed green. Two owners of one
  // accelerator cannot be ordered from the renderer side, so there is exactly
  // one owner — this menu — and it forwards the intent to the renderer, which
  // routes to native text undo or to the document by the same editable-focus
  // rule the role was there to protect (§5 of 10-architecture.md;
  // `renderer/src/app/editActions.ts`).
  //
  // Measured, not assumed, in a real Electron window under WSLg
  // (`experiments/init/harness/smoke-menu-undo.mjs`, 8/8): the live menu reports
  // Undo:CmdOrCtrl+Z and Redo:Shift+CmdOrCtrl+Z with `registerAccelerator: true`
  // — i.e. the OS really does hold these chords — and firing the item rewinds
  // the deck through IPC, while a renderer-level Ctrl+Z does nothing at all
  // (the keydown handler is unbound when the bridge is present) and the same
  // item with the chat composer focused leaves the deck untouched. The one link
  // that remains unverified by environment is the OS delivering the physical
  // keystroke to the item: that needs window-server input injection (xdotool),
  // which is not installed here. It is also the link Electron itself owns and
  // the one the replaced roles depended on identically.
  const editMenu: MenuItemConstructorOptions = {
    label: '&Edit',
    submenu: [
      actionItem('Undo', 'edit.undo', 'CmdOrCtrl+Z', onAction),
      actionItem('Redo', 'edit.redo', redoAccelerator(platform), onAction),
      { type: 'separator' },
      { role: 'cut' },
      { role: 'copy' },
      { role: 'paste' },
      ...(isMac ? [{ role: 'pasteAndMatchStyle' } as const] : []),
      { role: 'delete' },
      { role: 'selectAll' },
    ],
  }

  const macAppMenu: MenuItemConstructorOptions[] = isMac
    ? [{ role: 'appMenu', ...(appName === undefined ? {} : { label: appName }) }]
    : []

  return [...macAppMenu, fileMenu, editMenu]
}
