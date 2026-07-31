/**
 * M0.4 evidence recorder: loads the built renderer shell from a local static
 * server, walks the chrome (toolbar hover, thumbnails, Present) and writes a
 * webm + a full-page screenshot into docs/media/.
 *
 * Usage: node record-shell.mjs [baseUrl]
 * Throwaway tooling — not part of the app build.
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
await sleep(1200)

// 1. Sweep the formatting toolbar.
for (const name of ['Bold', 'Italic', 'Underline', 'Strikethrough', 'Text color', 'Insert shape']) {
  await page.getByRole('button', { name, exact: true }).hover()
  await sleep(220)
}
await page.getByRole('button', { name: /design mode/i }).hover()
await sleep(700)

// 2. Click through the placeholder thumbnails.
const rail = page.getByRole('navigation', { name: 'Slides' })
for (const number of [2, 3, 1]) {
  await rail.getByText(`Slide ${number} thumbnail placeholder`).click()
  await sleep(700)
}
await rail.getByRole('button', { name: '+ New' }).hover()
await sleep(500)

// 3. Chat composer.
await page.getByPlaceholder('Ask Claude…').click()
await page.getByPlaceholder('Ask Claude…').type('Draft a deck about ocean currents', { delay: 35 })
await sleep(400)
await page.getByRole('button', { name: /send/i }).hover()
await sleep(600)

// 4. Present button.
await page.getByRole('button', { name: /present/i }).hover()
await sleep(1000)

await page.screenshot({ path: path.join(MEDIA, 'm04-app-shell.png'), fullPage: true })
await sleep(400)

const video = page.video()
await context.close()
await browser.close()

const recorded = video ? await video.path() : path.join(RAW, (await readdir(RAW))[0])
await rename(recorded, path.join(MEDIA, 'm04-app-shell.webm'))
await rm(RAW, { recursive: true, force: true })

console.log('wrote docs/media/m04-app-shell.webm and .png')
