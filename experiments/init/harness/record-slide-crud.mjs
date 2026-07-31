/**
 * M1.4 evidence recorder: drives the built renderer through the rail's CRUD gestures — add,
 * duplicate, context menu, delete, drag-to-reorder, undo/redo — and writes a webm + a screenshot
 * into docs/media/. Same shape as record-slide-renderer.mjs (M1.3) and record-shell.mjs (M0.4).
 *
 * Usage:
 *   pnpm exec electron-vite build
 *   (cd out/renderer && python3 -m http.server 4173 --bind 127.0.0.1) &
 *   node experiments/init/harness/record-slide-crud.mjs [baseUrl]
 *
 * Playwright is not a dependency of the repo; install it in this directory (`pnpm i playwright`)
 * or symlink an existing `node_modules` here. Throwaway tooling — not part of the app build.
 */
import { mkdir, readdir, rename, rm } from 'node:fs/promises'
import path from 'node:path'
import { chromium } from 'playwright'

const BASE_URL = process.argv[2] ?? 'http://127.0.0.1:4173/'
const REPO = path.resolve(import.meta.dirname, '../../..')
const MEDIA = path.join(REPO, 'docs/media')
const RAW = path.join(REPO, 'experiments/init/harness/.video-raw')

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

await mkdir(MEDIA, { recursive: true })
await rm(RAW, { recursive: true, force: true })
await mkdir(RAW, { recursive: true })

const browser = await chromium.launch()
const context = await browser.newContext({
  viewport: { width: 1280, height: 800 },
  deviceScaleFactor: 1,
  recordVideo: { dir: RAW, size: { width: 1280, height: 800 } },
})
const page = await context.newPage()

await page.goto(BASE_URL, { waitUntil: 'networkidle' })
await page.waitForSelector('#sloodge-shell')
await page.waitForFunction(
  () =>
    [...document.querySelectorAll('iframe')].filter((f) => f.src.startsWith('blob:')).length >= 4,
)
await sleep(1200)

const rail = page.getByRole('navigation', { name: 'Slides' })
const status = page.getByRole('contentinfo', { name: 'Status bar' })
const card = (n) => rail.getByRole('button', { name: new RegExp(`Slide ${n} thumbnail`) })

const say = async (what) => {
  console.log(`${what.padEnd(28)} ${(await status.textContent()).slice(0, 14)}`)
}

await say('boot')

// 1. [+ New] appends a slide and selects it — the counter goes to 4 of 4.
await rail.getByRole('button', { name: '+ New' }).click()
await sleep(1300)
await say('after + New')

// 2. Right-click the second slide: the context menu, then Duplicate. The copy lands directly
//    after the original and becomes the selection.
await card(2).click({ button: 'right' })
await sleep(1100)
await page.screenshot({ path: path.join(MEDIA, 'm14-slide-crud.png') })
await page.getByRole('menuitem', { name: 'Duplicate' }).click()
await sleep(1300)
await say('after Duplicate')

// 3. Right-click the copy and Delete it; the selection falls to its neighbour.
await card(3).click({ button: 'right' })
await sleep(900)
await page.getByRole('menuitem', { name: 'Delete' }).click()
await sleep(1300)
await say('after Delete')

// 4. Drag the first thumbnail onto the last one. Chromium's HTML5 drag needs a real press and at
//    least two moves; `dragTo` would do it in one frame and film as a jump cut.
const source = await card(1).boundingBox()
const target = await card(4).boundingBox()
await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2)
await page.mouse.down()
for (let step = 1; step <= 14; step += 1) {
  const t = step / 14
  await page.mouse.move(
    source.x + source.width / 2,
    source.y + source.height / 2 + (target.y - source.y) * t,
    { steps: 2 },
  )
  await sleep(45)
}
await sleep(700)
await page.mouse.up()
await sleep(1300)
await say('after drag-reorder')

// 5. Undo the whole session, one Ctrl+Z per edit, then redo the last one.
for (const _ of [0, 1, 2, 3]) {
  await page.keyboard.press('Control+z')
  await sleep(950)
}
await say('after 4x undo')
await page.keyboard.press('Control+y')
await sleep(1200)
await say('after redo')

const video = page.video()
await context.close()
await browser.close()

const recorded = video ? await video.path() : path.join(RAW, (await readdir(RAW))[0])
await rename(recorded, path.join(MEDIA, 'm14-slide-crud.webm'))
await rm(RAW, { recursive: true, force: true })

console.log('wrote docs/media/m14-slide-crud.webm and .png')
