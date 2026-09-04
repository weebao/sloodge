/**
 * `pnpm perf:isolation` — the containment and availability evidence behind M8.2's URL change.
 *
 * M8.2 moved slide documents from `slide://<id>/` (one host, therefore one *site* and one renderer
 * process per slide) to `slide://<host>/<id>/`, where the host is a process group: `stage-<id>` for
 * the stage (still one process per document, but the stage holds at most three) and one shared
 * `thumbnails` host for the rail. Two claims justify it, and this script tests both in the real,
 * built app rather than arguing them from the spec.
 *
 * **Containment.** Nothing keeping slides apart ever lived in the host: the frame's
 * `sandbox="allow-scripts"` makes every document an opaque origin whatever its URL. The script
 * launches the app exactly as `perf:run` does (fresh profile, no production hooks), pushes a
 * three-slide deck whose slides are probes, and from inside each running slide document attempts:
 *
 *  - the host: `parent.document`, `top.document`, `parent.sloodge` (the preload bridge)
 *  - every sibling frame: its `document`, its `localStorage`, and navigating it
 *  - its own storage: `localStorage`, `sessionStorage`, `indexedDB`, `document.cookie`
 *  - the network: `fetch` of its own `slide://` URL (CSP `connect-src 'none'`)
 *
 * Each slide posts its findings to the host with `parent.postMessage` — the one channel the design
 * permits — where the page records them together with `event.origin` and *which iframe element*
 * `event.source` is. That last field is the bridge's own identity check (`event.source ===
 * iframe.contentWindow`), shown to still resolve each message to exactly one frame when every
 * frame shares a host.
 *
 * **Availability.** With every stage document on one shared host (M8.2 round 0), a hidden
 * neighbour running `while (true) {}` froze the *active* slide's script for the whole observation
 * window — measured, and the reason the stage host became per-document. The second scenario pushes
 * a deck whose slides post a heartbeat every 50 ms and whose +1 neighbour hangs itself after 2.5 s,
 * then measures the longest gap in the active slide's heartbeat over the next six seconds. The
 * active slide must keep beating; the rail's miniature of the same slide is *expected* to stall,
 * because every miniature shares the hung slide's thumbnail process — that residual is reported,
 * not asserted, and is the documented trade (see `slideDocumentHost`).
 *
 * The run ends by asking main for `app.getAppMetrics()`, so the same report that shows containment
 * also shows the process count the change is for. Exit status is non-zero if any reach succeeded or
 * if the hung neighbour stalled the active slide.
 *
 * Local-only tooling, like the rest of `perf/`: it needs a display and the built app.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { launchApp } from '../harness/app'
import { waitFor } from '../harness/cdp'
import { kbToMb, takeSample } from '../harness/sampler'
import { buildStressDeck } from '../lib/deck'

const CDP_PORT = 9700
const INSPECT_PORT = 9800
const REPORTS_GLOBAL = '__sloodgeIsolationReports'
const MESSAGE_KEY = '__sloodgeIsolationProbe'
const BEATS_GLOBAL = '__sloodgeHeartbeats'
const HEARTBEAT_KEY = '__sloodgeHeartbeat'
const HANG_KEY = '__sloodgeHang'
const HEARTBEAT_INTERVAL_MS = 50
/** How long the neighbour behaves before it hangs itself; the stage must have warmed it by then. */
const HANG_AFTER_MS = 2500
/** How long the active slide's heartbeat is watched once the neighbour has hung. */
const HANG_OBSERVE_MS = 6000
/**
 * The longest heartbeat gap the active slide may show while its neighbour hangs. Under a shared
 * stage host the measured gap was the whole window (5.7–9.9 s); a healthy 50 ms beat on a loaded
 * developer box shows gaps of a few hundred ms. Two seconds separates the two by an order of
 * magnitude either way.
 */
const HEARTBEAT_STALL_MS = 2000

/** One attempted reach: either it produced a value (the boundary failed) or it threw. */
type Outcome = { ok: true; value: string } | { ok: false; error: string }

type SiblingReport = {
  index: number
  document: Outcome
  localStorage: Outcome
  navigate: Outcome
}

type SlideReport = {
  probe: number
  origin: Outcome
  parentDocument: Outcome
  topDocument: Outcome
  parentBridge: Outcome
  localStorage: Outcome
  sessionStorage: Outcome
  indexedDB: Outcome
  cookie: Outcome
  fetchSelf: Outcome
  frameCount: number
  siblings: SiblingReport[]
}

type HostReport = {
  /** `event.origin` as the host saw it — `"null"` for an opaque-origin sender. */
  origin: string
  /** Index of the `<iframe>` whose `contentWindow` is `event.source`, or -1 if none matched. */
  sourceFrame: number
  report: SlideReport
}

/** The probe document, numbered so a report names the slide it came from. */
function probeSlideHtml(probe: number): string {
  return `<!doctype html>
<html lang="en" data-sl-slide="probe-${String(probe)}">
<head><meta charset="utf-8"><title>Probe ${String(probe)}</title>
<style>html,body{margin:0;width:1280px;height:720px;overflow:hidden;background:#fff;font:48px sans-serif}</style></head>
<body><div style="padding:80px">isolation probe ${String(probe)}</div>
<script>
// Deferred so the sibling frames exist by the time this slide reaches for them: the stage mounts
// the neighbour after the active slide has loaded, and the rail's miniatures arrive a beat later.
setTimeout(() => {
  const outcome = (fn) => {
    try { const v = fn(); return { ok: true, value: String(v) }; }
    catch (e) { return { ok: false, error: e && e.name ? e.name : String(e) }; }
  };
  let frameCount = -1;
  try { frameCount = parent.frames.length; } catch (e) { frameCount = -1; }
  const siblings = [];
  for (let i = 0; i < frameCount; i += 1) {
    const f = parent.frames[i];
    if (f === window) continue;
    siblings.push({
      index: i,
      document: outcome(() => f.document.title),
      localStorage: outcome(() => f.localStorage.length),
      navigate: outcome(() => { f.location.href = 'about:blank#hijacked'; return 'assigned'; }),
    });
  }
  const report = {
    probe: ${String(probe)},
    origin: outcome(() => location.origin),
    parentDocument: outcome(() => parent.document.title),
    topDocument: outcome(() => top.document.title),
    parentBridge: outcome(() => typeof parent.sloodge),
    localStorage: outcome(() => localStorage.length),
    sessionStorage: outcome(() => sessionStorage.length),
    indexedDB: outcome(() => indexedDB.open('probe').readyState),
    cookie: outcome(() => document.cookie),
    fetchSelf: { ok: false, error: 'not-run' },
    frameCount,
    siblings,
  };
  const finish = (fetchSelf) => {
    report.fetchSelf = fetchSelf;
    parent.postMessage({ ${MESSAGE_KEY}: report }, '*');
  };
  try {
    fetch(location.href).then(
      (r) => finish({ ok: true, value: String(r.status) }),
      (e) => finish({ ok: false, error: e && e.name ? e.name : String(e) }),
    );
  } catch (e) {
    finish({ ok: false, error: e && e.name ? e.name : String(e) });
  }
}, 2000);
</script>
</body>
</html>
`
}

const INSTALL_HOST_LISTENER = `(() => {
  const w = globalThis;
  if (w.${REPORTS_GLOBAL}) return 'already-installed';
  const reports = [];
  w.${REPORTS_GLOBAL} = reports;
  window.addEventListener('message', (event) => {
    const data = event.data;
    if (!data || typeof data !== 'object' || !data.${MESSAGE_KEY}) return;
    const frames = Array.from(document.querySelectorAll('iframe'));
    reports.push({
      origin: String(event.origin),
      sourceFrame: frames.findIndex((f) => f.contentWindow === event.source),
      report: data.${MESSAGE_KEY},
    });
  });
  return 'installed';
})()`

type Beat = {
  t: number
  probe: number
  /** Host of the iframe `event.source` belongs to: `stage-<id>` or `thumbnails`. */
  host: string
}

type HangMark = { t: number; probe: number; host: string }

type HeartbeatSeries = {
  beats: number
  /** Longest silence, in ms, between window start, consecutive beats and window end. */
  maxGapMs: number
}

/**
 * A slide that posts a heartbeat every `HEARTBEAT_INTERVAL_MS`; the one with `hangAfterMs` announces
 * itself and then spins forever. The announcement is what pins the observation window to the moment
 * the process actually stopped, rather than to the deck push.
 */
function heartbeatSlideHtml(probe: number, hangAfterMs: number | null): string {
  const hang =
    hangAfterMs === null
      ? ''
      : `setTimeout(() => {
  parent.postMessage({ ${HANG_KEY}: { probe: ${String(probe)} } }, '*');
  for (;;) {}
}, ${String(hangAfterMs)});`
  return `<!doctype html>
<html lang="en" data-sl-slide="heartbeat-${String(probe)}">
<head><meta charset="utf-8"><title>Heartbeat ${String(probe)}</title>
<style>html,body{margin:0;width:1280px;height:720px;overflow:hidden;background:#fff;font:48px sans-serif}</style></head>
<body><div style="padding:80px">heartbeat probe ${String(probe)}</div>
<script>
let n = 0;
setInterval(() => {
  parent.postMessage({ ${HEARTBEAT_KEY}: { probe: ${String(probe)}, n: n++ } }, '*');
}, ${String(HEARTBEAT_INTERVAL_MS)});
${hang}
</script>
</body>
</html>
`
}

const INSTALL_HEARTBEAT_LISTENER = `(() => {
  const w = globalThis;
  if (w.${BEATS_GLOBAL}) return 'already-installed';
  const state = { beats: [], hangs: [] };
  w.${BEATS_GLOBAL} = state;
  const hostOf = (source) => {
    const frame = Array.from(document.querySelectorAll('iframe')).find((f) => f.contentWindow === source);
    const src = frame ? frame.getAttribute('src') : null;
    try { return src ? new URL(src).hostname : ''; } catch (e) { return ''; }
  };
  window.addEventListener('message', (event) => {
    const data = event.data;
    if (!data || typeof data !== 'object') return;
    if (data.${HEARTBEAT_KEY}) {
      state.beats.push({ t: performance.now(), probe: data.${HEARTBEAT_KEY}.probe, host: hostOf(event.source) });
    } else if (data.${HANG_KEY}) {
      state.hangs.push({ t: performance.now(), probe: data.${HANG_KEY}.probe, host: hostOf(event.source) });
    }
  });
  return 'installed';
})()`

function heartbeatSeries(
  beats: readonly Beat[],
  probe: number,
  onStage: boolean,
  windowStart: number,
  windowEnd: number,
): HeartbeatSeries {
  const times = beats
    .filter(
      (b) =>
        b.probe === probe &&
        b.host.startsWith('stage-') === onStage &&
        b.t >= windowStart &&
        b.t <= windowEnd,
    )
    .map((b) => b.t)
    .toSorted((a, b) => a - b)
  const edges = [windowStart, ...times, windowEnd]
  let maxGapMs = 0
  for (let i = 1; i < edges.length; i += 1) {
    maxGapMs = Math.max(maxGapMs, edges[i]! - edges[i - 1]!)
  }
  return { beats: times.length, maxGapMs: Math.round(maxGapMs) }
}

function judge(reports: readonly HostReport[]): { failures: string[]; checks: number } {
  const failures: string[] = []
  let checks = 0
  const expectDenied = (label: string, outcome: Outcome): void => {
    checks += 1
    if (outcome.ok) failures.push(`${label}: reachable (${outcome.value})`)
  }
  for (const { origin, sourceFrame, report } of reports) {
    const who = `probe ${String(report.probe)} in frame ${String(sourceFrame)}`
    checks += 2
    if (origin !== 'null') failures.push(`${who}: host saw origin ${origin}, expected "null"`)
    if (sourceFrame < 0) failures.push(`${who}: event.source matched no iframe`)
    expectDenied(`${who}: parent.document`, report.parentDocument)
    expectDenied(`${who}: top.document`, report.topDocument)
    expectDenied(`${who}: parent.sloodge`, report.parentBridge)
    expectDenied(`${who}: localStorage`, report.localStorage)
    expectDenied(`${who}: sessionStorage`, report.sessionStorage)
    expectDenied(`${who}: indexedDB`, report.indexedDB)
    expectDenied(`${who}: document.cookie`, report.cookie)
    expectDenied(`${who}: fetch(own url)`, report.fetchSelf)
    for (const sibling of report.siblings) {
      expectDenied(`${who}: frames[${String(sibling.index)}].document`, sibling.document)
      expectDenied(`${who}: frames[${String(sibling.index)}].localStorage`, sibling.localStorage)
      expectDenied(`${who}: navigate frames[${String(sibling.index)}]`, sibling.navigate)
    }
  }
  return { failures, checks }
}

function arg(argv: readonly string[], name: string, fallback: string): string {
  const hit = argv.find((a) => a.startsWith(`--${name}=`))
  return hit === undefined ? fallback : hit.slice(name.length + 3)
}

export async function main(argv: readonly string[]): Promise<void> {
  const repoRoot = process.cwd()
  const display = arg(argv, 'display', ':0')
  const outFile = arg(argv, 'out', '')

  // Three slides with the first selected: the canvas mounts the active slide and its one
  // neighbour, the rail shows all three, so five documents are live and every probe has four
  // siblings to reach for.
  const deck = buildStressDeck({ slideCount: 3, seed: 1 })
  const slides: Record<string, string> = {}
  deck.manifest.slideOrder.forEach((id, index) => {
    slides[id] = probeSlideHtml(index)
  })
  const payload = { manifest: deck.manifest, slides, notes: deck.notes, theme: deck.theme }
  const scratch = await mkdtemp(join(tmpdir(), 'sloodge-isolation-'))
  const payloadPath = join(scratch, 'probe-deck.json')
  await writeFile(payloadPath, JSON.stringify(payload), 'utf8')

  const app = await launchApp({ repoRoot, cdpPort: CDP_PORT, inspectPort: INSPECT_PORT, display })
  try {
    await waitFor(
      app.page,
      `!!document.querySelector('#sloodge-shell')`,
      60_000,
      25,
      app.assertAlive,
    )
    const installed = await app.page.evaluate<string>(INSTALL_HOST_LISTENER)
    if (installed !== 'installed') throw new Error(`listener install returned ${installed}`)

    const sent = await app.main.evaluate<string>(`(() => {
      const { BrowserWindow } = process.mainModule.require('electron');
      const fs = process.mainModule.require('fs');
      const windows = BrowserWindow.getAllWindows();
      if (windows.length === 0) return 'no-window';
      const payload = JSON.parse(fs.readFileSync(${JSON.stringify(payloadPath)}, 'utf8'));
      windows[0].webContents.send('deck:updated', payload);
      return 'sent';
    })()`)
    if (sent !== 'sent') throw new Error(`could not push the probe deck: ${sent}`)

    // Every mounted frame reports once. Five is the steady state (see above); wait for at least
    // that many frames and for each of them to have reported.
    await waitFor(
      app.page,
      `(() => {
        const frames = document.querySelectorAll('iframe').length;
        return frames >= 5 && globalThis.${REPORTS_GLOBAL}.length >= frames;
      })()`,
      60_000,
      200,
      app.assertAlive,
    ).catch(async (error: unknown) => {
      // A missing report is itself a finding (a probe that navigated a sibling would silence it),
      // so surface what the page holds before rethrowing.
      const state = await app.page.evaluate<unknown>(`({
        frames: Array.from(document.querySelectorAll('iframe')).map((f) => f.getAttribute('src')),
        reports: globalThis.${REPORTS_GLOBAL},
      })`)
      console.error('probe did not settle:', JSON.stringify(state, null, 2))
      throw error
    })
    // A beat for any straggling report, then let processes settle before counting them.
    await sleep(1500)

    const reports = await app.page.evaluate<HostReport[]>(`globalThis.${REPORTS_GLOBAL}.slice()`)
    const frameSrcs = await app.page.evaluate<string[]>(
      `Array.from(document.querySelectorAll('iframe')).map((f) => f.getAttribute('src') || '')`,
    )
    const sample = await takeSample(app.main, app.page, app.spawnedAtMs)
    const byType: Record<string, number> = {}
    for (const proc of sample.processes) byType[proc.type] = (byType[proc.type] ?? 0) + 1

    const verdict = judge(reports)

    // --- Scenario 2: a hung neighbour --------------------------------------------------------------
    // Same app, second deck. Slide 0 is selected, so slide 1 is the +1 neighbour the stage keeps
    // warm behind it (and a live miniature in the rail); slide 1 hangs itself after HANG_AFTER_MS.
    const hangDeck = buildStressDeck({ slideCount: 3, seed: 2 })
    const hangSlides: Record<string, string> = {}
    hangDeck.manifest.slideOrder.forEach((id, index) => {
      hangSlides[id] = heartbeatSlideHtml(index, index === 1 ? HANG_AFTER_MS : null)
    })
    const hangPayloadPath = join(scratch, 'hang-deck.json')
    await writeFile(
      hangPayloadPath,
      JSON.stringify({
        manifest: hangDeck.manifest,
        slides: hangSlides,
        notes: hangDeck.notes,
        theme: hangDeck.theme,
      }),
      'utf8',
    )
    const beatsInstalled = await app.page.evaluate<string>(INSTALL_HEARTBEAT_LISTENER)
    if (beatsInstalled !== 'installed') {
      throw new Error(`heartbeat listener install returned ${beatsInstalled}`)
    }
    const hangSent = await app.main.evaluate<string>(`(() => {
      const { BrowserWindow } = process.mainModule.require('electron');
      const fs = process.mainModule.require('fs');
      const windows = BrowserWindow.getAllWindows();
      if (windows.length === 0) return 'no-window';
      const payload = JSON.parse(fs.readFileSync(${JSON.stringify(hangPayloadPath)}, 'utf8'));
      windows[0].webContents.send('deck:updated', payload);
      return 'sent';
    })()`)
    if (hangSent !== 'sent') throw new Error(`could not push the hang deck: ${hangSent}`)

    // The neighbour announces its hang from both of its frames (stage and rail); wait for the
    // stage one, which is the process under test.
    await waitFor(
      app.page,
      `globalThis.${BEATS_GLOBAL}.hangs.some((h) => h.host.startsWith('stage-'))`,
      60_000,
      100,
      app.assertAlive,
    )
    await sleep(HANG_OBSERVE_MS + 1000)

    const { beats, hangs } = await app.page.evaluate<{ beats: Beat[]; hangs: HangMark[] }>(
      `({ beats: globalThis.${BEATS_GLOBAL}.beats.slice(), hangs: globalThis.${BEATS_GLOBAL}.hangs.slice() })`,
    )
    const hungAt = hangs.find((h) => h.host.startsWith('stage-'))?.t ?? Number.NaN
    // Start the window half a second after the announcement so the spin has certainly begun.
    const windowStart = hungAt + 500
    const windowEnd = windowStart + HANG_OBSERVE_MS
    const activeStage = heartbeatSeries(beats, 0, true, windowStart, windowEnd)
    const activeRail = heartbeatSeries(beats, 0, false, windowStart, windowEnd)
    const hungStage = heartbeatSeries(beats, 1, true, windowStart, windowEnd)
    const hangSample = await takeSample(app.main, app.page, app.spawnedAtMs)
    const hangFrameSrcs = await app.page.evaluate<string[]>(
      `Array.from(document.querySelectorAll('iframe')).map((f) => f.getAttribute('src') || '')`,
    )

    const hangFailures: string[] = []
    if (hungStage.beats > 0) {
      hangFailures.push(
        `the hang probe kept beating (${String(hungStage.beats)} beats); the scenario did not run`,
      )
    }
    if (activeStage.maxGapMs > HEARTBEAT_STALL_MS) {
      hangFailures.push(
        `hung neighbour stalled the active slide: max heartbeat gap ${String(activeStage.maxGapMs)} ms ` +
          `over a ${String(HANG_OBSERVE_MS)} ms window (limit ${String(HEARTBEAT_STALL_MS)} ms)`,
      )
    }
    const hungNeighbour = {
      hangAfterMs: HANG_AFTER_MS,
      observeMs: HANG_OBSERVE_MS,
      stallLimitMs: HEARTBEAT_STALL_MS,
      activeSlideOnStage: activeStage,
      activeSlideInRail: activeRail,
      hungSlideOnStage: hungStage,
      railStalled: activeRail.maxGapMs > HEARTBEAT_STALL_MS,
      mountedFrames: hangFrameSrcs.length,
      distinctHosts: new Set(hangFrameSrcs.map((src) => new URL(src).host)).size,
      processes: hangSample.processes.length,
      failures: hangFailures,
    }

    const result = {
      urlShape: frameSrcs[0]?.replace(/[0-9a-f]{32}/g, '<id>') ?? '',
      mountedFrames: frameSrcs.length,
      distinctHosts: new Set(frameSrcs.map((src) => new URL(src).host)).size,
      processes: { total: sample.processes.length, byType },
      pssMb: sample.procPssKb === null ? null : Math.round(kbToMb(sample.procPssKb)),
      checks: verdict.checks,
      failures: verdict.failures,
      originsSeenBySlides: [...new Set(reports.map((r) => JSON.stringify(r.report.origin)))],
      hungNeighbour,
      reports,
    }

    const text = JSON.stringify(result, null, 2)
    if (outFile !== '') await writeFile(outFile, `${text}\n`, 'utf8')
    console.log(text)
    console.log(
      verdict.failures.length === 0
        ? `\nCONTAINED: ${String(verdict.checks)} reaches from ${String(reports.length)} live slide documents, all denied. ` +
            `${String(result.processes.total)} Electron processes for ${String(result.mountedFrames)} mounted frames on ${String(result.distinctHosts)} host(s).`
        : `\nBREACH: ${String(verdict.failures.length)} of ${String(verdict.checks)} reaches succeeded.`,
    )
    console.log(
      hangFailures.length === 0
        ? `ISOLATED: the active slide kept beating while its +1 neighbour hung — max gap ${String(activeStage.maxGapMs)} ms ` +
            `(${String(activeStage.beats)} beats in ${String(HANG_OBSERVE_MS)} ms). Rail miniature of the same slide: ` +
            `max gap ${String(activeRail.maxGapMs)} ms, ${String(activeRail.beats)} beats${hungNeighbour.railStalled ? ' (stalled, as documented)' : ''}.`
        : `STALLED: ${hangFailures.join('; ')}`,
    )
    if (verdict.failures.length > 0 || hangFailures.length > 0) process.exitCode = 1
  } finally {
    await app.dispose()
    await rm(scratch, { recursive: true, force: true })
  }
}
