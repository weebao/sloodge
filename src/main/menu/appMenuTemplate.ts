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

function fileItem(
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
      fileItem('New', 'file.new', 'CmdOrCtrl+N', onAction),
      fileItem('Open…', 'file.open', 'CmdOrCtrl+O', onAction),
      { type: 'separator' },
      {
        label: 'Export',
        submenu: [
          fileItem('Export as PPTX…', 'file.export.pptx', undefined, onAction),
          fileItem('Export as PDF…', 'file.export.pdf', undefined, onAction),
          fileItem('Export as HTML…', 'file.export.html', undefined, onAction),
        ],
      },
      { type: 'separator' },
      { role: isMac ? 'close' : 'quit' },
    ],
  }

  // Roles only, so Electron routes these to the focused webContents and native
  // undo/clipboard keeps working in text inputs. When M1.2 adds document-level
  // undo, main-side handlers must forward to the document only when no editable
  // element owns focus — never by replacing these roles wholesale.
  // M1.4 bound the same chords in the renderer under exactly that rule
  // (`renderer/src/app/useUndoRedoKeys.ts`); a main-side Edit-menu handler (M5.1)
  // has to make the same check, and must not double-fire with it.
  const editMenu: MenuItemConstructorOptions = {
    label: '&Edit',
    submenu: [
      { role: 'undo' },
      { role: 'redo' },
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
