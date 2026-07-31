import type { MenuItemConstructorOptions } from 'electron'
import { describe, expect, it } from 'vitest'
import { buildAppMenuTemplate, redoAccelerator } from '../../src/main/menu/appMenuTemplate'
import { MENU_ACTIONS, type MenuAction } from '../../src/shared/ipc-contract'

type Template = MenuItemConstructorOptions[]

function submenuOf(template: Template, label: string): MenuItemConstructorOptions[] {
  const entry = template.find((item) => item.label === label)
  expect(entry, `no "${label}" menu`).toBeDefined()
  const submenu = entry?.submenu
  expect(Array.isArray(submenu)).toBe(true)
  return submenu as MenuItemConstructorOptions[]
}

/** Depth-first: fires every `click` handler in a submenu tree, in menu order. */
function clickEverything(items: MenuItemConstructorOptions[]): void {
  for (const item of items) {
    if (typeof item.click === 'function') (item.click as (...args: never[]) => void)()
    if (Array.isArray(item.submenu)) {
      clickEverything(item.submenu)
    }
  }
}

const noop = (): void => {}

describe('buildAppMenuTemplate', () => {
  it('keeps the clipboard on Electron roles, with no click handlers', () => {
    const edit = submenuOf(buildAppMenuTemplate({ onAction: noop, platform: 'win32' }), '&Edit')
    const clipboard = edit.filter((item) => item.role !== undefined)

    expect(clipboard.map((item) => item.role)).toEqual([
      'cut',
      'copy',
      'paste',
      'delete',
      'selectAll',
    ])
    const macEdit = submenuOf(buildAppMenuTemplate({ onAction: noop, platform: 'darwin' }), '&Edit')
    expect(macEdit.filter((item) => item.role !== undefined).map((item) => item.role)).toEqual([
      'cut',
      'copy',
      'paste',
      'pasteAndMatchStyle',
      'delete',
      'selectAll',
    ])
    // A custom click on a clipboard role would shadow it and break native
    // cut/copy/paste in the chat textarea — this is the regression this pins.
    for (const item of clipboard) {
      expect(item.click).toBeUndefined()
      expect(item.accelerator).toBeUndefined()
    }
  })

  /**
   * Undo/Redo are the one place the menu is not a passthrough: they own
   * CmdOrCtrl+Z, because in Electron a menu accelerator is registered with the
   * OS and would otherwise consume the chord before the renderer ever saw a
   * keydown. If these lose their `click` or their accelerator, keyboard undo
   * stops existing in the packaged app and no other test can notice.
   */
  it('owns the undo/redo accelerators and forwards them as edit.* actions', () => {
    for (const [platform, redoChord] of [
      ['win32', 'Ctrl+Y'],
      ['darwin', 'Shift+CmdOrCtrl+Z'],
      ['linux', 'Shift+CmdOrCtrl+Z'],
    ] as const) {
      const fired: MenuAction[] = []
      const edit = submenuOf(
        buildAppMenuTemplate({ onAction: (action) => fired.push(action), platform }),
        '&Edit',
      )
      const [undo, redo] = edit

      expect([undo?.label, redo?.label]).toEqual(['Undo', 'Redo'])
      // Not roles: a role would re-register the same chord and swallow it.
      expect([undo?.role, redo?.role]).toEqual([undefined, undefined])
      expect(undo?.accelerator).toBe('CmdOrCtrl+Z')
      // The same chord Electron's own redo role registers — replacing the role
      // must not move a user's shortcut, only change who handles it.
      expect(redo?.accelerator).toBe(redoChord)
      expect(redoAccelerator(platform)).toBe(redoChord)

      clickEverything([undo, redo].filter((item) => item !== undefined))
      expect(fired).toEqual(['edit.undo', 'edit.redo'])
    }
  })

  it('emits the shared action ids from every File and Edit item', () => {
    const fired: MenuAction[] = []
    const template = buildAppMenuTemplate({
      onAction: (action) => fired.push(action),
      platform: 'win32',
    })

    clickEverything(submenuOf(template, '&File'))
    clickEverything(submenuOf(template, '&Edit'))
    // Every id in the shared union has exactly one menu item, and nothing else
    // fires one — the contract the renderer's switch is written against.
    expect(fired).toEqual([...MENU_ACTIONS])
  })

  it('gives New and Open accelerators and closes with the platform role', () => {
    const win = submenuOf(buildAppMenuTemplate({ onAction: noop, platform: 'win32' }), '&File')
    expect(win.find((item) => item.label === 'New')?.accelerator).toBe('CmdOrCtrl+N')
    expect(win.find((item) => item.label === 'Open…')?.accelerator).toBe('CmdOrCtrl+O')
    expect(win.at(-1)?.role).toBe('quit')

    const mac = submenuOf(buildAppMenuTemplate({ onAction: noop, platform: 'darwin' }), '&File')
    expect(mac.at(-1)?.role).toBe('close')
  })

  it('prepends the application menu on macOS only', () => {
    const mac = buildAppMenuTemplate({ onAction: noop, platform: 'darwin', appName: 'sloodge' })
    expect(mac[0]).toEqual({ role: 'appMenu', label: 'sloodge' })
    expect(mac.map((item) => item.label)).toEqual(['sloodge', '&File', '&Edit'])

    const linux = buildAppMenuTemplate({ onAction: noop, platform: 'linux', appName: 'sloodge' })
    expect(linux.map((item) => item.label)).toEqual(['&File', '&Edit'])
  })
})
