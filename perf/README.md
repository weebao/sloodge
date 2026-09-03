# M8.1 — Stress decks and the perf harness

The measurement instrument for Milestone 8. M8.2–M8.7 each have to show before/after numbers from
this harness in their PR description, so the priority here is **accuracy and reproducibility**, not
breadth of features. If this measures the wrong thing, every optimization gated on it is
unfalsifiable.

**This suite is local-only.** Nothing here runs on GitHub Actions — CI stays unit-tests-only by
explicit directive. M8.7 will add a cheap CI job that diffs _committed numbers_ using
`perf/lib/report.ts`, which is pure and never launches anything.

---

## Quick start

```bash
pnpm build                 # the harness drives out/main/index.js; it does not build for you
pnpm perf:generate         # writes perf/decks/stress-{25,50,100,200,300,500,1000} (+ deck-update payloads)
pnpm perf:run --slides=100 --runs=3 --ram-basis=proc-pss-sum
pnpm perf:diff perf/results/baseline-main.json perf/results/run-100.json
```

The 100-slide tier is the headline. **Do not run 500 or 1000 before M8.2 lands**: on this machine
they exhaust RAM and swap (see "The result"). The harness now fails fast when the app dies instead
of hanging, but the machine still has to survive the attempt.

`perf:diff` is the whole of what M8.7's CI job has to do: it loads two committed reports and applies
the pure rules in `perf/lib/report.ts` — no build, no Electron, no deck. It exits `1` on a budget
failure or a regression beyond `--tolerance` (default 10 %), `2` on mismatched inputs (it refuses to
compare runs of different deck sizes or different RAM bases).

Useful flags for `perf:run`:

| Flag           | Default                       | Meaning                                                                                                         |
| -------------- | ----------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `--slides=N`   | `100`                         | Which generated deck to use                                                                                     |
| `--runs=N`     | `3`                           | Whole-session repetitions; the report keeps per-run headlines                                                   |
| `--ram-basis=` | `app-metrics-working-set-sum` | `proc-pss-sum` is the honest basis on Linux — see below                                                         |
| `--switches=N` | `20`                          | Slide switches to time                                                                                          |
| `--dwell=MS`   | `5000`                        | How long to record frame cadence on an animating slide                                                          |
| `--no-export`  | off                           | Skip the export phase                                                                                           |
| `--display=`   | `:0`                          | X display. The ambient `DISPLAY` on this WSL2 box points at a VcXsrv that is not running; WSLg's socket is `:0` |
| `--out=PATH`   | `perf/results/run-<N>.json`   | Report path                                                                                                     |

---

## How it drives the app: zero production code changes

The app measured is the app that ships, byte for byte. There is **no `SLOODGE_PERF` env hook in
`src/main`, no dev-only branch, and no `window.__deckStore` escape hatch.** The harness attaches to
the running process from outside, over two debugger endpoints:

- `--remote-debugging-port` → the **renderer**'s CDP (`Runtime`, `Page`, `Performance`, `Input`).
- `--inspect` → the **main process**'s Node inspector.

The seam that makes the main-process half work is `process.mainModule.require('electron')`. The main
bundle is ESM, so the inspector's evaluation context has no bare `require` and dynamic `import()`
fails with _"A dynamic import callback was not specified"_ — but `process.mainModule` is a CJS module
record whose `require` reaches the whole Electron main API. That gives `app.getAppMetrics()`,
`process.memoryUsage()`, `webContents.send(...)`, and the save-dialog patch without touching `src/`.

Playwright's `_electron.launch()` was the alternative and was rejected: it is a ~150 MB
devDependency added to the same install CI runs, for a suite CI is forbidden to run. Node 22+ ships a
global `WebSocket` and CDP is plain JSON-RPC, so the client is ~130 lines and zero dependencies
(`perf/harness/cdp.ts`).

### Two places the harness cannot use a user path

Both are consequences of features that are not wired yet, and both are disclosed in the report:

1. **Opening a deck.** `File ▸ Open` routes to a `console.log` today (`src/main/menu/menuRouting.ts`),
   and `readDeck`/`writeDeck` in `src/main/document/store.ts` have **no callers at all**. So the
   session pushes the deck over `deck:updated` — a real production transport, the one the agent path
   uses — landing in `deckStore.applyRemoteDeck`, which the store's own docblock describes as the
   `doc:open` path. The unzip half of a real open is timed separately with the shipped `readDeck` and
   reported as `deckReadMs`, so a projected open cost can be stated without claiming to have measured
   a feature that does not exist.
2. **The export save dialog.** `dialog.showSaveDialog` blocks on a native modal. It is patched from
   the main process for the duration of the export phase and restored afterwards. That changes where
   the file lands and nothing else.

---

## What "RAM" means — read this before quoting a number

The budget is **median RAM < 200 MB**. On this app the answer depends enormously on how you sum, so
the harness records three bases every tick and the report keeps all three:

| Basis                         | 100-slide deck | What it is                                                   |
| ----------------------------- | -------------- | ------------------------------------------------------------ |
| `app-metrics-working-set-sum` | ~10.1 GB       | `app.getAppMetrics()` working set, summed over every process |
| `proc-rss-sum`                | ~10.2 GB       | Linux `/proc/<pid>/smaps_rollup` `Rss`, summed               |
| `proc-pss-sum`                | **~1.7 GB**    | Linux `Pss`, summed                                          |

The first two are **wrong as totals** here, and obviously so: they exceed the 6.8 GB the VM has.
Chromium runs ~105 processes for a 100-slide deck and they share most of their mapped memory — the
binary, the V8 snapshot, fonts. Summing per-process working set counts every shared page once per
process. PSS ("proportional set size") divides each shared page by its number of sharers and is the
only one of the three that is a physically honest total on Linux.

**So `proc-pss-sum` is the basis to quote on Linux**, and it is what the committed baseline uses.
`app-metrics-working-set-sum` remains the default flag value because it is the only basis that exists
on Windows and macOS, where the app actually ships; a cross-platform comparison has to use it, with
the same over-counting caveat. The basis is recorded in every report so a later run cannot silently
change it.

---

## What each metric means

| Metric               | Definition                                                                                                                                                                                                                |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `coldStartMs`        | **Upper bound.** Spawn → `#sloodge-shell` in the DOM, polled every 25 ms                                                                                                                                                  |
| `documentLoadedMs`   | **Lower bound.** Spawn → the renderer's navigation `loadEventEnd`, converted through `performance.timeOrigin`                                                                                                             |
| `deckOpenMs`         | `deck:updated` dispatched → every rail frame has fired `load`                                                                                                                                                             |
| `deckPublishMs`      | `deck:updated` dispatched → every rail frame has a `slide://` src (main holds the bytes)                                                                                                                                  |
| `deckReadMs`         | The shipped `readDeck` unzipping the `.sloodge` from disk                                                                                                                                                                 |
| `slideSwitchMs`      | Rail click → the canvas iframe's `load`. **Both timestamps are taken in page context**, so CDP round-trip jitter delays only when a number is read, never the number                                                      |
| `frameIntervalMs`    | Gaps between `requestAnimationFrame` callbacks in the **app shell** while an animating slide is active. `null` if the dwell recorded no frames                                                                            |
| `droppedFrames`      | Frames **missed against a 60 Hz ideal** over the dwell window (`missedFrames` in `stats.ts`). The budgeted number; lower is better                                                                                        |
| `longFrameIntervals` | Intervals longer than 1.5 × the 60 Hz budget, i.e. > 25 ms. Kept as a secondary signal; not monotonic once the frame stream collapses (see Known limits #9)                                                               |
| `frameRateFps`       | Frames served ÷ dwell seconds. Reported, never a budget; meaningless when `hostContention.contended` is true                                                                                                              |
| `railScrollMs`       | Summed round-trip of 25 `scrollTop` assignments on the rail, the 120 ms settle between steps **excluded** — each assignment forces a layout flush and is serviced only when the renderer's main thread is free            |
| `rendererHeapMb`     | `JSHeapUsedSize` from CDP `Performance.getMetrics`, host renderer only. `null` if no read succeeded                                                                                                                       |
| `processTypes`       | Per Chromium process type (Browser / GPU / Tab / Utility): process count and memory on `ramBasis`, per sample, for the whole session and for the idle window. A type's `processes.min` of 0 means it was not always alive |

Cold start is deliberately a bracket. First Contentful Paint would be the ideal signal and is
**unavailable**: the main window is created with `show: false` and revealed on `ready-to-show`, and
Chromium does not record paint-timing entries for a page that paints while hidden. Measured on this
app, `PerformanceObserver.supportedEntryTypes` includes `paint` while
`performance.getEntriesByType('paint')` stays empty for the whole session. Reading FCP here would
silently report a fallback rather than a paint.

---

## Determinism

Decks are reproducible from a single integer seed. `Math.random()` is banned in `perf/`; every
varying value comes from `mulberry32` (`perf/lib/prng.ts`), all timestamps are a fixed constant, and
ids are minted from the seed rather than from `crypto` (`newSlideId()` draws from
`crypto.getRandomValues` with no injection seam, so it cannot be used).

`perf/deck-hashes.json` is committed and records a **content** hash — SHA-256 over the manifest plus
the slide HTML in presentation order. It is deliberately not a hash of the `.sloodge` file:
`packDeck` calls fflate's `zipSync` without an `mtime`, so every ZIP local header carries the
wall-clock time of the write and two archives of identical content hash differently. That is a
property of the shipped writer, and M8.1 is not the milestone to change the product's file writer.
`archiveBytes` _is_ stable, since the timestamp lives in an uncompressed header field.

`perf:generate` **merges** into the committed hash file rather than rewriting it: tiers that were not
regenerated are kept, and a tier whose recorded seed differs from the requested one is refused
before any deck is built unless `--force` is passed. The default tier list is the full committed
one, so a plain `pnpm perf:generate` reproduces the record byte for byte.

Generated decks themselves are gitignored — they are large and exactly regenerable.

---

## The stress decks

Four archetypes in a fixed rotation, so slide N is the same archetype in every deck size:

| Archetype           | What it provokes                                                                                 |
| ------------------- | ------------------------------------------------------------------------------------------------ |
| `svg-animation`     | Continuous SMIL + CSS `@keyframes` motion, a gradient and a Gaussian blur filter                 |
| `interactive-graph` | A `requestAnimationFrame` canvas redraw plus hover/click listeners — the cost M8.4 must throttle |
| `image-laden`       | Four real PNGs as `data:` URIs: raster decode and decoded-bitmap cache residency                 |
| `component-dense`   | ~400 DOM nodes of cards and table rows: style recalc, layout, per-node memory                    |

Every generated slide is validated against the **shipped** Tier-1 linter
(`src/shared/document/slide-contract.ts`) before packing, and generation _throws_ if any slide fails.
A stress deck the app would reject on load measures nothing.

Two linter rules shape the generator in non-obvious ways:

- **SL-H01** requires declared `capabilities` to match content exactly, so the interactive archetype
  contains no `@keyframes` and no SMIL, and the static archetypes contain neither scripts nor
  animation.
- **SL-S04** substring-scans the whitespace-stripped, lowercased _whole source_ for tokens like
  `eval(`. That matches prose, not just code — "retrieval" followed by an opening parenthesis packs
  to `…ieval(` and trips it. Generated prose comes from a closed vocabulary and avoids parentheses.

The PNGs use filter type 1 ("Sub"). With filter 0 a smooth gradient compresses to almost nothing —
measured at ~104 KB per 240×150 image, which made deck _size_ rather than render cost dominate every
measurement. Sub brings them to a few KB while still decoding to a full-size bitmap.

---

## Known limits of this instrument

Stated plainly, because a measurement whose error bars are unknown is not evidence.

1. **The debuggers perturb what they measure.** Both `--remote-debugging-port` and `--inspect` are
   attached for the whole session, and `Performance.getMetrics` plus a main-process
   `Runtime.evaluate` run every 250 ms. Cold start in particular is measured _with the inspector
   attached_ and is therefore an upper bound on the shipped app's.
2. **Frame cadence is the shell's, not the slide's.** The `requestAnimationFrame` recorder lives in
   the top-level page. Because slides are same-thread subframes, a stalled shell frame does reflect
   real contention — but this does not measure a slide's internal compositor rate, and
   `droppedFrames` should be read as "the app janked", not "the animation dropped a frame".
3. **One machine, one platform.** All numbers below are WSL2 on a 6.8 GB VM with software rendering.
   Under WSLg the GPU process is SwiftShader and is **not reliably alive**: it was present at
   230–240 MB PSS in some idle windows and absent in others, which is why the idle figure is stated
   as a range below. The report's `processTypes` block records per-type presence and memory so this
   is visible from the artifact. Windows and macOS will differ, and the 200 MB budget is ultimately a
   Windows-desktop claim.
4. **Sampling is 250 ms and the session is short.** A ~35-sample run is enough for a median but thin
   in the tails; `p95` and `max` should be read with that in mind. Sample counts are in the report.
5. **`deckOpenMs` is not a wired File ▸ Open.** See above — it excludes the file dialog and folds in
   an IPC structured clone the real path may not have.
6. **Export coverage is partial.** Only HTML export is exercised. PDF and PPTX each spin up an
   offscreen `BrowserWindow` per run and PPTX additionally requires a renderer dialog interaction;
   both are deferred.
7. **Not isolated.** This box also runs other agents' test suites. Rather than leave that as a
   caveat nobody can check, every sample records the host's 1-minute load average and
   `MemAvailable`, and the report carries a `hostContention` block with a `contended` flag. A
   baseline whose `contended` is true should be re-taken before it is diffed against.
8. **The 500- and 1000-slide tiers have no harness JSON**, because the app does not survive them on
   this machine — see "The result" below. The decks are generated and valid; only the measurement is
   missing, and it is missing for a reason that is itself the headline finding.
9. **`droppedFrames` changed definition during M8.1.** It is now frames missed against a 60 Hz ideal
   over the dwell window, not a count of over-long intervals. The interval count is retained as
   `longFrameIntervals`. Any number quoted from before that change is not comparable.
10. **The instrument fails loudly, never quietly.** A budgeted series with no samples (no PSS
    readings off Linux, no canvas `load` after a switch) fails the run, prints `no samples | FAIL`
    in the budget table and `REGRESSED` in `perf:diff` — it never reports `0.0 MB PASS`. The recorder
    refuses to start if the canvas or rail selector no longer matches. The CDP client rejects every
    pending and future call with `CdpClosedError` the moment a socket closes, and every call carries
    a 30 s reply deadline, so a dead or frozen app surfaces within seconds rather than as an
    open-ended hang (the earlier 500-slide "20 minutes of silence" was this hang).

---

## The result: we are far over the RAM budget, and the cause is structural

Committed baseline: `perf/results/baseline-main.json` (100-slide deck, 3 runs, PSS basis), with
`perf/results/baseline-scaling-*.json` for the other tiers. All taken on commit `e2a3a20`.

**Median RAM is 1725 MB against a 200 MB budget — 8.6x over.** That is not a tuning problem; no
amount of trimming allocations reaches 200 MB from here. The cause is architectural, and it shows up
first in the process count:

> Every slide is published at `slide://<unique-id>/` (`src/shared/slide-protocol.ts`,
> `slideDocumentUrl`). The document id is the URL **host**, so every slide is a distinct _origin_,
> and Chromium's site isolation gives each origin its own renderer process. A 100-slide deck runs
> **105 Electron processes**; a 300-slide deck runs 305.

Each of those carries its own renderer heap, compositor, and per-process Blink/V8 overhead. The
measured marginal cost is roughly **11-14 MB PSS per mounted slide**, on top of a large fixed floor.

### Scaling

| Slides | Processes | Median PSS | Working-set sum | Cold start | Deck open | Slide switch |
| -----: | --------: | ---------: | --------------: | ---------: | --------: | -----------: |
|     25 |        30 |     776 MB |         3039 MB |     794 ms |    495 ms |       118 ms |
|     50 |        55 |    1091 MB |         5358 MB |     772 ms |   1185 ms |        52 ms |
|    100 |       105 |    1725 MB |         9890 MB |    1030 ms |   1927 ms |        58 ms |
|    200 |       205 |    2929 MB |        18812 MB |    1091 ms |   4982 ms |       101 ms |
|    300 |       305 |    3655 MB |             n/a |    1080 ms |   7793 ms |        92 ms |

PSS and process count scale cleanly and are the trustworthy columns. The 300-slide working-set sum is
omitted: under memory pressure some processes reported a zero working set, making that basis
incoherent exactly where it mattered — another reason PSS is the headline basis.

Two consequences worth stating plainly, because they set up M8.2:

1. **The app is over budget before a stress deck is opened at all.** Idle on its 3-slide starter
   deck, it sits at **448-453 MB PSS**, measured independently in all five runs above (a spread under
   1 %). That is 2.2x the 200 MB budget with three slides on screen. An earlier single-sample read of
   194 MB was taken ~1 s after launch, before the app had settled, and is superseded.
2. **The 500- and 1000-slide tiers do not run on this machine.** A 500-slide deck spawns ~507
   processes; observed directly, `MemAvailable` fell to 0 MB, all 2 GB of swap was consumed, and the
   session never reached a loaded state in 20 minutes before it was killed. The decks generate and
   validate fine — the app cannot hold them. There is therefore **no harness JSON for 500 or 1000**,
   and the roadmap's "open a 500-slide deck in under 5 s" is currently not a timing question at all.

M8.2 ("lazy slide mounting — only the active slide's iframe is live, ±1 neighbours pre-warmed") is
therefore not an optimization but the fix for a hard ceiling. This harness will show it directly as a
collapse in `processCount` and `ramMb`.

### What passes today

Cold start (~1.0 s against 3 s) passes comfortably at every tier. Slide switch passes at 50-100
slides and sits at the 100 ms budget by 200. Deck open passes to 100 slides, reaches 4982 ms at 200,
and fails at 300 (7793 ms) — three tiers below the deck size that budget was written for.

### Contention, and which numbers survive it

This baseline was taken while other agents ran test suites on the same machine.
`hostContention.contended` is `true`, median 1-minute load 12.6 on 16 cores. Comparing against an
earlier quiet window:

| Metric                       | Quiet   | Contended |
| ---------------------------- | ------- | --------- |
| 25-slide median RAM          | 796 MB  | 776 MB    |
| 50-slide median RAM          | 1146 MB | 1091 MB   |
| 25-slide median slide switch | 54 ms   | 118 ms    |

**Memory reproduces within a few percent; timing roughly doubles.** So the RAM conclusion — the
headline of this milestone — is safe. The timing columns above should be re-taken on a quiet machine
before M8.2 diffs against them, and any contended run now says so in its own `notes`.

`frameRateFps` in the contended baseline is **not usable**: it comes out non-monotonic across tiers
(21.8, 50.4, 12.2, 0.0, 23.2 fps) because rAF delivery is exactly what a loaded host disrupts. The
quiet-window series is the one to believe, and it degrades cleanly with deck size:

| Slides | Shell frame rate (quiet) |
| -----: | -----------------------: |
|     25 |                 13.5 fps |
|     50 |                  9.4 fps |
|    100 |                  7.1 fps |
|    200 |                  1.9 fps |

At 200 slides the shell served 9 frames in 4.8 s, and those frames spanned only 268 ms of that
window — the renderer was not producing frames at all for the remaining ~4.5 s.
