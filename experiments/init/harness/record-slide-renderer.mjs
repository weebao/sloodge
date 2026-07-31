/**
 * M1.3 evidence recorder: loads the built renderer from a local static server and demonstrates the
 * sandboxed slide renderer — live slide documents in the canvas and in the rail, thumbnail
 * selection, and scale-to-fit as the window resizes. Writes a webm + a screenshot into docs/media/.
 *
 * Usage: node record-slide-renderer.mjs [baseUrl]
 * Throwaway tooling — not part of the app build. Same shape as record-shell.mjs (M0.4).
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

// Every slide is a real document in its own sandboxed frame — wait for all four (three rail
// thumbnails + the canvas) to have been handed a blob URL before filming.
await page.waitForFunction(
  () => [...document.querySelectorAll('iframe')].filter((f) => f.src.startsWith('blob:')).length >= 4,
)
await sleep(1400)

const rail = page.getByRole('navigation', { name: 'Slides' })

// 1. The rail: three live mini-renders of the boot deck, not placeholders.
await rail.hover()
await sleep(900)

// 2. Click through the thumbnails; the canvas follows, and so does the status bar.
for (const number of [2, 3]) {
  await rail.getByRole('button', { name: new RegExp(`Slide ${number} thumbnail`) }).click()
  await sleep(1100)
}
await rail.getByRole('button', { name: /Slide 1 thumbnail/ }).click()
await sleep(900)

// 3. Scale-to-fit: the frame stays an intrinsic 1280x720 document and is CSS-scaled to whatever
//    room the canvas has, letterboxed. Narrow the window, then widen it past the 1:1 cap.
for (const size of [
  { width: 1040, height: 800 },
  { width: 900, height: 640 },
  { width: 1280, height: 800 },
]) {
  await page.setViewportSize(size)
  await sleep(1200)
}

await page.screenshot({ path: path.join(MEDIA, 'm13-slide-renderer.png') })
await sleep(400)

const video = page.video()
await context.close()
await browser.close()

const recorded = video ? await video.path() : path.join(RAW, (await readdir(RAW))[0])
await rename(recorded, path.join(MEDIA, 'm13-slide-renderer.webm'))
await rm(RAW, { recursive: true, force: true })

console.log('wrote docs/media/m13-slide-renderer.webm and .png')
