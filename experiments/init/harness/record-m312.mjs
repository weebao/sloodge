/**
 * M3.12 evidence recorder: drives the property panel's Content field against a built renderer and
 * films the entity round trip — type `Revenue & Growth <2026>`, commit, read the field back, commit
 * again unchanged. On the unfixed build the field reads back `Revenue &amp; Growth &lt;2026&gt;` and
 * the second commit puts the entities on the slide; on the fixed build both are no-ops.
 *
 * Usage: node record-m312.mjs <rendererDir> <label> <outBase>
 *   rendererDir  an `out/renderer` directory (main's for "before", the branch's for "after")
 *   label        banner text painted over the shell
 *   outBase      path prefix for the .webm and .png written
 *
 * The static server strips the host page's CSP `<meta>`: a plain-browser host falls back to `blob:`
 * frames, which inherit the embedder's `script-src 'self'` and would block the injected bridge script
 * the panel's selection depends on (see `useSlideUrl.ts`). Throwaway tooling — not part of the app.
 */
import { createServer } from 'node:http'
import { mkdir, readFile, readdir, rename, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'

const require = createRequire(import.meta.url)
const { chromium } = require('playwright')

const [RENDERER, LABEL, OUT_BASE] = process.argv.slice(2)
if (!RENDERER || !LABEL || !OUT_BASE) {
  console.error('usage: node record-m312.mjs <rendererDir> <label> <outBase>')
  process.exit(2)
}
const RAW = path.join(import.meta.dirname, '.video-raw-m312')
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' }
const server = createServer(async (req, res) => {
  const rel = (req.url ?? '/').split('?')[0].replace(/^\/+/, '') || 'index.html'
  try {
    let body = await readFile(path.join(RENDERER, rel))
    if (rel === 'index.html') {
      body = Buffer.from(body.toString('utf8').replace(/<meta\s+http-equiv="Content-Security-Policy"[\s\S]*?\/>/, ''))
    }
    res.setHeader('content-type', MIME[path.extname(rel)] ?? 'application/octet-stream')
    res.end(body)
  } catch {
    res.statusCode = 404
    res.end('not found')
  }
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const BASE_URL = `http://127.0.0.1:${server.address().port}/`

await mkdir(path.dirname(OUT_BASE), { recursive: true })
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
await page.waitForFunction(() => [...document.querySelectorAll('iframe')].some((f) => f.src.startsWith('blob:')))
await sleep(1500)

await page.evaluate((label) => {
  const banner = document.createElement('div')
  banner.textContent = label
  banner.style.cssText =
    'position:fixed;top:8px;left:50%;transform:translateX(-50%);z-index:99999;padding:6px 14px;border-radius:8px;background:#111827;color:#fff;font:600 15px system-ui;box-shadow:0 2px 8px rgba(0,0,0,.4);pointer-events:none'
  document.body.append(banner)
}, LABEL)

// Select the starter slide's <h1>: padding 48px, 48px type → its box starts at (48, 48) in slide space.
const frame = page.locator('main[aria-label="Slide canvas"] [data-slide-role="active"] iframe')
const box = await frame.boundingBox()
const scale = box.width / 1280
const clickAt = async (sx, sy) => {
  await page.mouse.move(box.x + sx * scale, box.y + sy * scale)
  await sleep(150)
  await page.mouse.down()
  await page.mouse.up()
}
await clickAt(120, 75)
const text = page.getByTestId('prop-text')
await text.waitFor({ timeout: 5000 })
const log = []
const readField = async (step) => {
  const value = await page.getByTestId('prop-text').inputValue()
  log.push(`${step}: field = ${JSON.stringify(value)}`)
  return value
}
await readField('selected')
await sleep(900)

// 1. Type an ampersand and angle brackets into the Content field and commit.
await text.click()
await text.fill('')
await text.type('Revenue & Growth <2026>', { delay: 40 })
await sleep(500)
await text.press('Enter')
await sleep(1200)
await readField('after first commit')

// 2. Commit the field again as it reads back — should be a no-op.
await page.getByTestId('prop-text').click()
await sleep(400)
await page.getByTestId('prop-text').press('Enter')
await sleep(1200)
await readField('after second commit')

// 3. And a third, to make the drift (if any) unmistakable on the slide.
await page.getByTestId('prop-text').click()
await sleep(300)
await page.getByTestId('prop-text').press('Enter')
await sleep(1400)
await readField('after third commit')
const slideText = await page.frames().find((f) => f.url().startsWith('blob:') && f !== page.mainFrame())?.evaluate(() => document.querySelector('h1')?.textContent ?? null).catch(() => null)
log.push(`slide h1 textContent = ${JSON.stringify(slideText)}`)
const undo = await page.evaluate(() => document.querySelector('[data-testid="prop-text"]') !== null)
log.push(`panel present = ${String(undo)}`)

await page.screenshot({ path: `${OUT_BASE}.png` })
await sleep(500)

const video = page.video()
await context.close()
await browser.close()
server.close()
const recorded = video ? await video.path() : path.join(RAW, (await readdir(RAW))[0])
await rename(recorded, `${OUT_BASE}.webm`)
await rm(RAW, { recursive: true, force: true })
console.log(log.join('\n'))
console.log(`wrote ${OUT_BASE}.webm and .png`)
