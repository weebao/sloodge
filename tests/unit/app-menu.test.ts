import type { MenuItemConstructorOptions } from 'electron'
import { describe, expect, it } from 'vitest'
import { buildAppMenuTemplate } from '../../src/main/menu/appMenuTemplate'
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
  it('builds Edit from Electron roles, with no click handlers', () => {
    const edit = submenuOf(buildAppMenuTemplate({ onAction: noop, platform: 'win32' }), '&Edit')

    expect(edit.filter((item) => item.type !== 'separator').map((item) => item.role)).toEqual([
      'undo',
      'redo',
      'cut',
      'copy',
      'paste',
      'delete',
      'selectAll',
    ])
    const macEdit = submenuOf(buildAppMenuTemplate({ onAction: noop, platform: 'darwin' }), '&Edit')
    expect(macEdit.filter((item) => item.type !== 'separator').map((item) => item.role)).toEqual([
      'undo',
      'redo',
      'cut',
      'copy',
      'paste',
      'pasteAndMatchStyle',
      'delete',
      'selectAll',
    ])
    // A custom click here would shadow the role and break native undo/clipboard
    // in the chat textarea — this is the regression this test exists for.
    for (const item of edit) {
      expect(item.click).toBeUndefined()
      expect(item.accelerator).toBeUndefined()
    }
  })

  it('emits the shared action ids from every File item', () => {
    const fired: MenuAction[] = []
    const file = submenuOf(
      buildAppMenuTemplate({
        onAction: (action) => fired.push(action),
        platform: 'win32',
      }),
      '&File',
    )

    clickEverything(file)
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
