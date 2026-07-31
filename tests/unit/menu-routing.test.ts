/**
 * The main-process half of the undo hop.
 *
 * M1.4 moved undo off a renderer keydown and onto menu item -> focused window ->
 * preload -> dispatcher, which makes this routing the single point of failure
 * for keyboard undo — and, until these tests, the only part of the feature with
 * no coverage. The Electron-only half is exercised by
 * experiments/init/harness/smoke-menu-undo.mjs, which needs a display and is not
 * in CI; what CI can protect is exactly what lives in `menuRouting.ts`.
 */
import { describe, expect, it } from 'vitest'
import { menuActionTarget, pickTargetWindow } from '../../src/main/menu/menuRouting'
import { createMenuActionHandler } from '../../src/preload/menuActionHandler'
import { MENU_ACTIONS, MENU_EVENT_CHANNEL, type MenuAction } from '../../src/shared/ipc-contract'

/** A stand-in for `BrowserWindow`, carrying only what the routing reads. */
const fakeWindow = (destroyed = false): { isDestroyed: () => boolean } => ({
  isDestroyed: () => destroyed,
})

describe('menuActionTarget', () => {
  it('forwards the edit actions to the renderer', () => {
    expect(menuActionTarget('edit.undo')).toBe('renderer')
    expect(menuActionTarget('edit.redo')).toBe('renderer')
  })

  it('does not forward the actions nothing consumes yet', () => {
    // A channel that delivers ids no one handles reads as though File ▸ New
    // were already wired; M5.1 flips these when it claims them.
    for (const action of ['file.new', 'file.open', 'file.export.pdf'] as const) {
      expect(menuActionTarget(action)).toBe('log')
    }
  })

  it('classifies every id in the shared union, so a new one cannot be forgotten', () => {
    const routed = MENU_ACTIONS.map((action) => [action, menuActionTarget(action)] as const)
    expect(routed.filter(([, target]) => target === 'renderer').map(([action]) => action)).toEqual([
      'edit.undo',
      'edit.redo',
    ])
    expect(routed).toHaveLength(MENU_ACTIONS.length)
  })
})

describe('pickTargetWindow', () => {
  it('prefers the focused window', () => {
    const focused = fakeWindow()
    const other = fakeWindow()
    expect(pickTargetWindow(focused, [other, focused])).toBe(focused)
  })

  it('falls back to the first live window when nothing has focus', () => {
    const first = fakeWindow()
    expect(pickTargetWindow(null, [first, fakeWindow()])).toBe(first)
    expect(pickTargetWindow(undefined, [first])).toBe(first)
  })

  it('skips a window that was destroyed between the click and the send', () => {
    // `webContents.send` throws on a destroyed window, and a menu click can
    // outlive the window it was clicked over.
    const live = fakeWindow()
    expect(pickTargetWindow(fakeWindow(true), [fakeWindow(true), live])).toBe(live)
    expect(pickTargetWindow(null, [fakeWindow(true), live])).toBe(live)
  })

  it('returns null when there is nothing live to send to', () => {
    expect(pickTargetWindow(null, [])).toBeNull()
    expect(pickTargetWindow(fakeWindow(true), [fakeWindow(true)])).toBeNull()
  })
})

describe('createMenuActionHandler', () => {
  it('passes a known action through', () => {
    const seen: MenuAction[] = []
    createMenuActionHandler((action) => seen.push(action))({}, 'edit.undo')
    expect(seen).toEqual(['edit.undo'])
  })

  it('drops anything that is not one of ours', () => {
    const seen: MenuAction[] = []
    const handler = createMenuActionHandler((action) => seen.push(action))
    for (const bad of ['edit.undo ', 'edit.destroy', '', null, undefined, 7, { t: 'edit.undo' }]) {
      handler({}, bad)
    }
    expect(seen).toEqual([])
  })

  it('never forwards the ipc event itself', () => {
    // The event carries `sender`, a live ipcRenderer handle; handing it across
    // contextBridge would expose the whole IPC surface to the page.
    const args: unknown[][] = []
    createMenuActionHandler((...received: unknown[]) => args.push(received))(
      { sender: 'ipcRenderer' },
      'edit.redo',
    )
    expect(args).toEqual([['edit.redo']])
  })
})

describe('MENU_EVENT_CHANNEL', () => {
  it('is the channel both ends use', () => {
    expect(MENU_EVENT_CHANNEL).toBe('app:menu')
  })
})
