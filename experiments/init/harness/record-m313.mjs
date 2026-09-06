/**
 * M3.13 evidence recorder — drives the **built Electron app**, not a browser host, because the race
 * needs the app's per-slide `slide://` processes: turning Design Mode off re-navigates the stage
 * frame, and only when the new document commits in *another* process can the old one be torn down
 * while its script is still stalled. In a plain-browser host every `blob:` document shares the page's
 * process, the navigation waits for the stall to end, and the loss cannot be shown.
 *
 * Per build: open a caret on the title, type, schedule a busy loop in the slide frame, click the
 * Design Mode switch while it runs, and read what the slide shows afterwards. Two passes — a stall
 * inside `finish`'s 2 s timeout (the text must land) and one past it (the loss must be announced).
 *
 * Usage: node record-m313.mjs <repoRoot> <label> <outBase> [stallMs] [longStallMs]
 *   repoRoot   a checkout with `out/main/index.js` built and `node_modules/electron` installed
 *
 * Playwright's Electron driver resolves from this harness's node_modules; the app gets a fresh
 * `--user-data-dir` (the single-instance lock) and WSLg's display. Throwaway tooling — not the app.
 */
import { mkdir, mkdtemp, readdir, rename, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'

const require = createRequire(import.meta.url)
const { _electron: electron } = require('playwright')

const [REPO, LABEL, OUT_BASE, STALL = '800', LONG_STALL = '3000'] = process.argv.slice(2)
if (!REPO || !LABEL || !OUT_BASE) {
  console.error('usage: node record-m313.mjs <repoRoot> <label> <outBase> [stallMs] [longStallMs]')
  process.exit(2)
}
const RAW = path.join(import.meta.dirname, '.video-raw-m313')
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

await mkdir(path.dirname(OUT_BASE), { recursive: true })
await rm(RAW, { recursive: true, force: true })
await mkdir(RAW, { recursive: true })
const userDataDir = await mkdtemp(path.join(tmpdir(), 'sloodge-m313-'))

const electronBinary = createRequire(`${REPO}/`)('electron')
const app = await electron.launch({
  executablePath: electronBinary,
  args: [`--user-data-dir=${userDataDir}`, path.join(REPO, 'out/main/index.js')],
  cwd: REPO,
  env: { ...process.env, DISPLAY: ':0' },
  recordVideo: { dir: RAW, size: { width: 1280, height: 800 } },
})
const page = await app.firstWindow()
await page.waitForSelector('#sloodge-shell')
await page.waitForFunction(() => [...document.querySelectorAll('iframe')].some((f) => f.src.startsWith('slide://')))
await sleep(1500)

const log = []
const say = (line) => {
  log.push(line)
  console.log(line)
}

const setBanner = (text) =>
  page.evaluate((label) => {
    let banner = document.getElementById('m313-banner')
    if (!banner) {
      banner = document.createElement('div')
      banner.id = 'm313-banner'
      banner.style.cssText =
        'position:fixed;top:8px;left:50%;transform:translateX(-50%);z-index:99999;padding:6px 14px;border-radius:8px;background:#111827;color:#fff;font:600 15px system-ui;box-shadow:0 2px 8px rgba(0,0,0,.4);pointer-events:none;white-space:nowrap'
      document.body.append(banner)
    }
    banner.textContent = label
  }, text)

const activeFrameLocator = () => page.locator('main[aria-label="Slide canvas"] [data-slide-role="active"] iframe')
const activeFrame = async () => (await activeFrameLocator().elementHandle()).contentFrame()
const toggle = page.getByRole('switch')

/** The slide's <h1> as its frame renders it right now. */
const slideTitle = async () => {
  const frame = await activeFrame()
  return frame.evaluate(() => document.querySelector('h1')?.textContent ?? null)
}

async function pass(stallMs, typed) {
  if ((await toggle.getAttribute('aria-checked')) !== 'true') {
    await toggle.click()
    await sleep(1200)
  }
  // The starter title: padding 48px, 48px type — its box starts at (48, 48) in slide space.
  const box = await activeFrameLocator().boundingBox()
  const scale = box.width / 1280
  const x = box.x + 120 * scale
  const y = box.y + 75 * scale
  await page.mouse.click(x, y)
  await sleep(500)
  await page.mouse.dblclick(x, y)
  await sleep(800)
  await page.keyboard.type(typed, { delay: 45 })
  await sleep(600)
  say(`[stall ${stallMs} ms] typed ${JSON.stringify(typed)}; frame shows ${JSON.stringify(await slideTitle())}`)

  // Stall the slide's main thread, then turn Design Mode off while it is stalled.
  const frame = await activeFrame()
  await frame.evaluate((ms) => {
    setTimeout(() => {
      const end = performance.now() + ms
      while (performance.now() < end) {
        /* the slide's own JS, busy */
      }
    }, 80)
  }, stallMs)
  await sleep(160)
  await toggle.click()
  await sleep(stallMs + 2600)

  // Read after the settle: the frame has been re-navigated to the stored bytes by now, so what the
  // slide shows is what the document holds.
  const shown = await slideTitle()
  const notice = await page.getByTestId('design-notice').textContent().catch(() => null)
  say(`[stall ${stallMs} ms] after toggle: slide shows ${JSON.stringify(shown)}; notice = ${JSON.stringify(notice)}`)
  return { shown, notice }
}

await setBanner(`${LABEL} — stall ${STALL} ms across the toggle`)
const short = await pass(Number(STALL), `Kept under a ${STALL} ms stall`)
await sleep(800)
await page.screenshot({ path: `${OUT_BASE}-short.png` })

await setBanner(`${LABEL} — stall ${LONG_STALL} ms (past the 2 s finish timeout)`)
const long = await pass(Number(LONG_STALL), `Typed under a ${LONG_STALL} ms stall`)
await sleep(800)
await page.screenshot({ path: `${OUT_BASE}-long.png` })

const video = page.video()
await app.close()
await rm(userDataDir, { recursive: true, force: true }).catch(() => {})
const recorded = video ? await video.path() : path.join(RAW, (await readdir(RAW))[0])
await rename(recorded, `${OUT_BASE}.webm`)
await rm(RAW, { recursive: true, force: true })
console.log(JSON.stringify({ short, long }))
console.log(`wrote ${OUT_BASE}.webm, -short.png, -long.png`)
