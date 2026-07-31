/**
 * M1.4 smoke check, in a real Electron window: does Edit ▸ Undo actually rewind the deck?
 *
 * This exists because the unit tests cannot see the thing that was most likely to be broken. They
 * mount the renderer in happy-dom and the evidence recording runs it in plain Chromium — neither
 * has an application menu, which is the entire risk: an Electron menu item registers its
 * accelerator with the OS, so `{ role: 'undo' }` would have eaten CmdOrCtrl+Z before the renderer
 * ever saw a keydown and document undo by keyboard would not exist in the packaged app.
 *
 * What this proves: the real installed menu's Undo/Redo handlers reach the real renderer through
 * the real preload and rewind the real store — main -> `app:menu` -> contextBridge -> dispatcher.
 * What it does NOT prove: that the OS routes the physical CmdOrCtrl+Z keystroke to that menu item.
 * That needs synthetic input at the window-server level (xdotool), which is not installed here;
 * `webContents.sendInputEvent` injects *below* the menu layer and would prove nothing.
 *
 * Usage:
 *   pnpm exec electron-vite build
 *   node experiments/init/harness/smoke-menu-undo.mjs
 * Needs a display (WSLg provides one) and playwright in this directory.
 */
import path from 'node:path'
import { _electron as electron } from 'playwright'

const REPO = path.resolve(import.meta.dirname, '../../..')

const app = await electron.launch({ args: [path.join(REPO, 'out/main/index.js')] })
const page = await app.firstWindow()
await page.waitForSelector('#sloodge-shell')

const status = () => page.getByRole('contentinfo', { name: 'Status bar' }).textContent()
const rail = page.getByRole('navigation', { name: 'Slides' })

const checks = []
const check = (name, actual, expected) => {
  const ok = actual === expected
  checks.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(42)} ${actual}${ok ? '' : ` != ${expected}`}`)
}

/** Fire a real installed menu item by label, in the main process. */
const clickMenuItem = (label) =>
  app.evaluate(({ Menu }, itemLabel) => {
    const menu = Menu.getApplicationMenu()
    const edit = menu.items.find((item) => item.label.replace('&', '') === 'Edit')
    const target = edit.submenu.items.find((item) => item.label === itemLabel)
    if (!target) throw new Error(`no Edit item labelled ${itemLabel}`)
    // The handler the accelerator would run, invoked the same way the menu does.
    target.click()
    return true
  }, label)

// The accelerators the OS registered, read back off the live menu rather than the template.
const accelerators = await app.evaluate(({ Menu }) => {
  const edit = Menu.getApplicationMenu().items.find((item) => item.label.replace('&', '') === 'Edit')
  return edit.submenu.items
    .filter((item) => item.label === 'Undo' || item.label === 'Redo')
    .map((item) => `${item.label}:${item.accelerator ?? 'none'}:${String(item.registerAccelerator)}`)
})
console.log(`menu accelerators: ${accelerators.join(' ')}`)
check('undo accelerator registered', accelerators[0], 'Undo:CmdOrCtrl+Z:true')
check('redo accelerator registered', accelerators[1], 'Redo:Shift+CmdOrCtrl+Z:true')

check('boot deck', (await status()).slice(0, 12), 'Slide 1 of 3')

await rail.getByRole('button', { name: '+ New' }).click()
await page.waitForTimeout(300)
check('after + New', (await status()).slice(0, 12), 'Slide 4 of 4')

await clickMenuItem('Undo')
await page.waitForTimeout(300)
check('after Edit > Undo', (await status()).slice(0, 12), 'Slide 3 of 3')

await clickMenuItem('Redo')
await page.waitForTimeout(300)
check('after Edit > Redo', (await status()).slice(0, 12), 'Slide 3 of 4')

// A renderer-level Ctrl+Z must do NOTHING here: `window.sloodge` exists, so the keydown handler
// is not bound and the menu is the only owner. This is the double-undo guard, observed in the
// real app — Playwright's key press is injected into the renderer (below the OS menu layer),
// which is exactly the path that would fire a second time if the handler were still bound.
await page.keyboard.press('Control+z')
await page.waitForTimeout(300)
check('renderer keydown is inert', (await status()).slice(0, 12), 'Slide 3 of 4')

// With focus in the chat composer the same menu action must go to the field, not the deck.
await page.getByPlaceholder('Ask Claude…').click()
await page.keyboard.type('hello')
await clickMenuItem('Undo')
await page.waitForTimeout(300)
check('composer focused: deck untouched', (await status()).slice(0, 12), 'Slide 3 of 4')

await app.close()

const failed = checks.filter((ok) => !ok).length
console.log(failed === 0 ? `ALL ${checks.length} CHECKS PASSED` : `${failed} CHECK(S) FAILED`)
process.exit(failed === 0 ? 0 : 1)
