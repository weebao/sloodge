/**
 * The scripted session: open → scroll rail → rapid slide switching → present → export.
 *
 * Every phase drives the app the way a user does — real clicks on real selectors, the real
 * `app:menu` event for export — rather than reaching into internals. The two exceptions are called
 * out inline, and both exist because the product has no user path for them yet:
 *
 *  1. **Opening a deck.** `File ▸ Open` is routed to a `console.log` today (`menuRouting.ts`), and
 *     `readDeck`/`writeDeck` in `src/main/document/store.ts` have no callers. So the session pushes
 *     the deck over `deck:updated`, which *is* a production transport — the same one the agent path
 *     uses, landing in `deckStore.applyRemoteDeck`, which the store documents as the `doc:open`
 *     path. The unzip half of a real open is measured separately (see `deckReadMs`), so the report
 *     can state a projected open cost without pretending it measured a wired feature.
 *  2. **The export save dialog.** `dialog.showSaveDialog` blocks on a native modal no harness can
 *     dismiss. It is patched from the main process for the duration of the export phase and
 *     restored afterwards, which changes where the file lands and nothing else.
 */

import { access, stat } from 'node:fs/promises'
import { setTimeout as sleep } from 'node:timers/promises'
import type { CdpClient } from './cdp'
import { waitFor } from './cdp'
import {
  INSTALL_RECORDER,
  READ_FRAMES,
  READ_LONG_TASKS,
  READ_SWITCHES,
  RECORDER_GLOBAL,
  RESET_FRAMES,
  SELECTORS,
} from './page-recorder'
import { toIntervals } from '../lib/stats'
import type { Sampler } from './sampler'

export type SwitchRecord = {
  readonly index: number
  readonly clickAt: number
  readonly loadAt: number | null
  readonly latencyMs: number | null
}

/** Poll interval for shell detection. The resulting error is the cold-start upper bound's precision. */
const SHELL_POLL_MS = 25

export type SessionResult = {
  /** Upper bound: spawn -> `#sloodge-shell` observed, +/- SHELL_POLL_MS. */
  readonly coldStartMs: number
  /** Lower bound: spawn -> the renderer's navigation `loadEventEnd`. */
  readonly documentLoadedMs: number
  readonly deckPublishMs: number
  readonly deckRenderMs: number
  readonly switches: readonly SwitchRecord[]
  readonly activeSlideFrameIntervalsMs: readonly number[]
  /** Frames the shell actually served during the animation dwell. */
  readonly animationFrameCount: number
  /** Wall-clock length of the animation dwell window, for frame-rate maths. */
  readonly animationWindowMs: number
  readonly longTaskCount: number
  readonly longTaskTotalMs: number
  readonly presentMs: number
  readonly exportHtmlMs: number | null
  /** Summed round-trip of the rail's scroll steps, settle sleeps excluded. */
  readonly railScrollMs: number
  readonly processCountPeak: number
  readonly warnings: readonly string[]
}

export type SessionOptions = {
  readonly page: CdpClient
  readonly main: CdpClient
  readonly sampler: Sampler
  readonly spawnedAtMs: number
  readonly slideCount: number
  /** Absolute path to a JSON file holding the `DeckUpdate` payload. */
  readonly deckPayloadPath: string
  /** Where the HTML export should be written (the patched save dialog returns this). */
  readonly exportPath: string
  readonly switchCount: number
  /** Milliseconds to dwell on an animation-heavy slide while recording frame cadence. */
  readonly animationDwellMs: number
  /**
   * Milliseconds to sit idle after the shell is up and before the deck is pushed. Establishes the
   * app's at-rest cost, which turned out to be the single most useful number in the baseline: it
   * separates "Electron plus the shell" from "what the deck adds".
   */
  readonly idleDwellMs: number
  readonly runExport: boolean
  /** Throws if the app process has died; checked on every polling tick. */
  readonly assertAlive: () => void
}

/** Wait until a path exists and its size has stopped growing. */
async function waitForStableFile(path: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  let lastSize = -1
  let stableTicks = 0
  while (Date.now() < deadline) {
    try {
      await access(path)
      const size = (await stat(path)).size
      if (size > 0 && size === lastSize) {
        stableTicks += 1
        if (stableTicks >= 3) return true
      } else {
        stableTicks = 0
      }
      lastSize = size
    } catch {
      stableTicks = 0
    }
    await sleep(250)
  }
  return false
}

export async function runSession(options: SessionOptions): Promise<SessionResult> {
  const {
    page,
    main,
    sampler,
    spawnedAtMs,
    slideCount,
    deckPayloadPath,
    exportPath,
    switchCount,
    animationDwellMs,
    idleDwellMs,
    runExport,
    assertAlive,
  } = options
  const warnings: string[] = []

  // --- Phase: cold start ------------------------------------------------------------------------
  //
  // Cold start is reported as a *bracket*, because no single signal is both available and exact:
  //
  //  - **Lower bound** `documentLoadedMs`: the renderer's `loadEventEnd`, converted to Unix time via
  //    `performance.timeOrigin`, minus the spawn instant. Exact, but it is when the document
  //    finished loading — React 19's concurrent root schedules the first render, so `#sloodge-shell`
  //    can appear slightly after this.
  //  - **Upper bound** `coldStartMs`: polling for `#sloodge-shell` at `SHELL_POLL_MS`. Carries the
  //    poll granularity as error, which against a 3000 ms budget is under 1 %.
  //
  // First Contentful Paint is deliberately *not* used, though it would be the ideal signal: the main
  // window is created with `show: false` and revealed on `ready-to-show`, and Chromium does not
  // record paint-timing entries for a page that paints while hidden. Measured on this app —
  // `PerformanceObserver.supportedEntryTypes` includes `paint`, yet
  // `performance.getEntriesByType('paint')` is empty for the whole session. Anything reading FCP
  // here would silently report a fallback rather than a paint.
  await waitFor(
    page,
    `!!document.querySelector('${SELECTORS.shell}')`,
    60_000,
    SHELL_POLL_MS,
    assertAlive,
  )
  const coldStartMs = Date.now() - spawnedAtMs
  const timing = await page.evaluate<{ timeOrigin: number; loadEventEnd: number | null }>(`(() => {
    const nav = performance.getEntriesByType('navigation')[0];
    return {
      timeOrigin: performance.timeOrigin,
      loadEventEnd: nav ? nav.loadEventEnd : null,
    };
  })()`)
  const documentLoadedMs =
    timing.loadEventEnd === null
      ? Number.NaN
      : timing.timeOrigin + timing.loadEventEnd - spawnedAtMs
  if (Number.isNaN(documentLoadedMs)) {
    warnings.push('No navigation-timing entry; the cold-start lower bound is unavailable.')
  }

  const installed = await page.evaluate<string>(INSTALL_RECORDER)
  if (installed !== 'installed') warnings.push(`Recorder install returned "${installed}".`)
  // Both `load` sinks must be attached, or the switch latencies and deckRenderMs are measured
  // against nothing: every `latencyMs` comes back null and the run would either report an empty
  // series or wait the full render timeout. A selector rename in the app (M8b touches exactly these
  // surfaces) has to fail the run here, in the first second, not after a multi-minute session.
  const attached = await page.evaluate<{ canvas: boolean; rail: boolean }>(
    `({ canvas: globalThis.${RECORDER_GLOBAL}.canvasAttached, rail: globalThis.${RECORDER_GLOBAL}.railAttached })`,
  )
  const unattached = [
    ...(attached.canvas ? [] : [`canvas (${SELECTORS.canvas})`]),
    ...(attached.rail ? [] : [`rail (${SELECTORS.rail})`]),
  ]
  if (unattached.length > 0) {
    throw new Error(
      `Recorder could not attach to ${unattached.join(' or ')}; the app's selectors have changed.`,
    )
  }
  sampler.mark('shell-ready')

  // --- Phase: idle baseline ---------------------------------------------------------------------
  // The app is up with its default starter deck and nothing else. Sampling here is what makes the
  // deck's marginal cost attributable rather than guessed.
  sampler.mark('idle:start')
  await sleep(idleDwellMs)
  sampler.mark('idle:end')

  // --- Phase: open the deck ---------------------------------------------------------------------
  sampler.mark('open:start')
  const openStart = Date.now()
  const sent = await main.evaluate<string>(`(() => {
    const { BrowserWindow } = process.mainModule.require('electron');
    const fs = process.mainModule.require('fs');
    const windows = BrowserWindow.getAllWindows();
    if (windows.length === 0) return 'no-window';
    const payload = JSON.parse(fs.readFileSync(${JSON.stringify(deckPayloadPath)}, 'utf8'));
    windows[0].webContents.send('deck:updated', payload);
    return 'sent';
  })()`)
  if (sent !== 'sent') throw new Error(`Could not push the deck: ${sent}`)

  // Published = every rail frame has a `slide://` src (main accepted it into the registry).
  await waitFor(
    page,
    `document.querySelectorAll('${SELECTORS.rail} iframe[src]').length >= ${String(slideCount)}`,
    600_000,
    150,
    assertAlive,
  )
  const deckPublishMs = Date.now() - openStart

  // Rendered = every rail frame has fired `load`. This is the number that reflects what the user
  // waits for; publishing only means main holds the bytes.
  const rendered = await page
    .evaluate<boolean>(`globalThis.${RECORDER_GLOBAL}.railLoads.length >= ${String(slideCount)}`)
    .catch(() => false)
  if (!rendered) {
    await waitFor(
      page,
      `globalThis.${RECORDER_GLOBAL}.railLoads.length >= ${String(slideCount)}`,
      600_000,
      250,
      assertAlive,
    ).catch((error: unknown) => {
      if (
        error instanceof Error &&
        (error.name === 'AppExitedError' || error.name === 'CdpClosedError')
      ) {
        throw error
      }
      warnings.push(
        'Not every rail frame fired `load` before the timeout; deckRenderMs is a floor.',
      )
    })
  }
  const deckRenderMs = Date.now() - openStart
  sampler.mark('open:end')

  // --- Phase: scroll the rail -------------------------------------------------------------------
  // `railScrollMs` is the summed round-trip of the 25 `scrollTop` assignments, with the 120 ms
  // settle between steps *excluded*. Each assignment forces a synchronous style/layout flush and the
  // evaluate can only be serviced when the renderer's main thread is free, so the sum tracks what
  // the rail costs to scroll rather than how long the harness chose to sleep. (Wall time of the
  // phase had a 3000 ms floor made of sleeps, which is what M8.3 would have been diffing.)
  sampler.mark('rail-scroll:start')
  await page.evaluate<boolean>(`(() => {
    const el = document.querySelector('${SELECTORS.railScroller}');
    if (el) el.scrollTop = 0;
    return true;
  })()`)
  const steps = 24
  let railScrollMs = 0
  for (let step = 0; step <= steps; step += 1) {
    const stepStart = Date.now()
    await page.evaluate<boolean>(`(() => {
      const el = document.querySelector('${SELECTORS.railScroller}');
      if (!el) return false;
      el.scrollTop = (el.scrollHeight - el.clientHeight) * ${String(step / steps)};
      return true;
    })()`)
    railScrollMs += Date.now() - stepStart
    await sleep(120)
  }
  sampler.mark('rail-scroll:end')

  // --- Phase: rapid slide switching -------------------------------------------------------------
  // Indices are spread across the deck rather than sequential, so the measurement includes the cost
  // of jumping to a slide whose frame is far outside the rail's current scroll window.
  sampler.mark('switch:start')
  await page.evaluate<boolean>(`(() => {
    const el = document.querySelector('${SELECTORS.railScroller}');
    if (el) el.scrollTop = 0;
    return true;
  })()`)
  const stride = Math.max(1, Math.floor(slideCount / switchCount))
  for (let n = 0; n < switchCount; n += 1) {
    // Starts at `stride`, not 0: `applyRemoteDeck` keeps slide 0 selected after the push, and a
    // click on the already-active slide fires no canvas `load`, so it measures nothing.
    const index = ((n + 1) * stride) % slideCount
    // The rail is not virtualized today, so every item is in the DOM regardless of scroll position;
    // if that changes (M8.3), this needs to scroll the item into view first.
    const clicked = await page.evaluate<number | null>(
      `globalThis.${RECORDER_GLOBAL}.clickSlide(${String(index)})`,
    )
    if (clicked === null) {
      warnings.push(`Rail item ${String(index)} was not in the DOM; switch skipped.`)
      continue
    }
    await sleep(220)
  }
  await sleep(1000)
  const switches = await page.evaluate<SwitchRecord[]>(READ_SWITCHES)
  sampler.mark('switch:end')

  // --- Phase: frame cadence on an animation-heavy active slide ----------------------------------
  // Slide 0 is always the `svg-animation` archetype (the cycle is fixed), so this dwells on
  // continuous SMIL + CSS motion rather than on a static slide.
  sampler.mark('animation:start')
  await page.evaluate<number | null>(`globalThis.${RECORDER_GLOBAL}.clickSlide(0)`)
  await sleep(800)
  await page.evaluate<boolean>(RESET_FRAMES)
  const animationDwellStart = Date.now()
  await sleep(animationDwellMs)
  const animationWindowMs = Date.now() - animationDwellStart
  const frameTimestamps = await page.evaluate<number[]>(READ_FRAMES)
  const longTasks = await page.evaluate<{ start: number; duration: number }[]>(READ_LONG_TASKS)
  sampler.mark('animation:end')

  const activeSlideFrameIntervalsMs = toIntervals(frameTimestamps)
  if (activeSlideFrameIntervalsMs.length === 0) {
    warnings.push('No frames were recorded during the animation dwell; the window may be occluded.')
  }

  // --- Phase: present ---------------------------------------------------------------------------
  sampler.mark('present:start')
  const presentStart = Date.now()
  const presentClicked = await page.evaluate<boolean>(`(() => {
    const bar = document.querySelector('${SELECTORS.statusBar}');
    if (!bar) return false;
    const buttons = Array.from(bar.querySelectorAll('button'));
    const present = buttons.find((b) => /present/i.test(b.textContent || ''));
    if (!present) return false;
    present.click();
    return true;
  })()`)
  if (!presentClicked) {
    warnings.push('Present button not found; present phase skipped.')
  } else {
    await waitFor(
      page,
      `!!document.querySelector('${SELECTORS.presentSurface}')`,
      30_000,
      100,
      assertAlive,
    ).catch(() => {
      warnings.push('Present surface never mounted.')
    })
    for (let n = 0; n < 10; n += 1) {
      await dispatchKey(page, 'ArrowRight')
      await sleep(180)
    }
    await dispatchKey(page, 'Escape')
    await waitFor(
      page,
      `!document.querySelector('${SELECTORS.presentSurface}')`,
      15_000,
      100,
      assertAlive,
    ).catch(() => {
      warnings.push('Present surface did not unmount after Escape.')
    })
  }
  const presentMs = Date.now() - presentStart
  sampler.mark('present:end')

  // --- Phase: export ----------------------------------------------------------------------------
  let exportHtmlMs: number | null = null
  if (runExport) {
    sampler.mark('export:start')
    const patched = await main.evaluate<boolean>(`(() => {
      const electron = process.mainModule.require('electron');
      if (!globalThis.__perfOriginalShowSaveDialog) {
        globalThis.__perfOriginalShowSaveDialog = electron.dialog.showSaveDialog;
      }
      electron.dialog.showSaveDialog = () =>
        Promise.resolve({ canceled: false, filePath: ${JSON.stringify(exportPath)} });
      return true;
    })()`)
    if (!patched) warnings.push('Could not patch showSaveDialog; export skipped.')
    else {
      const exportStart = Date.now()
      await main.evaluate<string>(`(() => {
        const { BrowserWindow } = process.mainModule.require('electron');
        const windows = BrowserWindow.getAllWindows();
        if (windows.length === 0) return 'no-window';
        windows[0].webContents.send('app:menu', 'file.export.html');
        return 'sent';
      })()`)
      const done = await waitForStableFile(exportPath, 600_000)
      exportHtmlMs = Date.now() - exportStart
      if (!done) {
        warnings.push('HTML export did not produce a stable file before the timeout.')
        exportHtmlMs = null
      }
      await main.evaluate<boolean>(`(() => {
        const electron = process.mainModule.require('electron');
        if (globalThis.__perfOriginalShowSaveDialog) {
          electron.dialog.showSaveDialog = globalThis.__perfOriginalShowSaveDialog;
        }
        return true;
      })()`)
    }
    sampler.mark('export:end')
  }

  const processCountPeak = sampler.samples.reduce(
    (peak, sample) => Math.max(peak, sample.processes.length),
    0,
  )

  return {
    coldStartMs,
    documentLoadedMs,
    deckPublishMs,
    deckRenderMs,
    switches,
    activeSlideFrameIntervalsMs,
    animationFrameCount: frameTimestamps.length,
    animationWindowMs,
    longTaskCount: longTasks.length,
    longTaskTotalMs: longTasks.reduce((sum, t) => sum + t.duration, 0),
    presentMs,
    exportHtmlMs,
    railScrollMs,
    processCountPeak,
    warnings,
  }
}

async function dispatchKey(page: CdpClient, key: string): Promise<void> {
  const codes: Record<string, { code: string; keyCode: number }> = {
    ArrowRight: { code: 'ArrowRight', keyCode: 39 },
    Escape: { code: 'Escape', keyCode: 27 },
  }
  const info = codes[key]
  if (info === undefined) throw new Error(`Unmapped key ${key}`)
  await page.send('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key,
    code: info.code,
    windowsVirtualKeyCode: info.keyCode,
    nativeVirtualKeyCode: info.keyCode,
  })
  await page.send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key,
    code: info.code,
    windowsVirtualKeyCode: info.keyCode,
    nativeVirtualKeyCode: info.keyCode,
  })
}
