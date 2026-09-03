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
pnpm perf:isolation        # M8.2: containment probe for the shipped slide:// hosts (see below)
```

The 100-slide tier is the headline. **Do not run 500 or 1000 before M8.2 lands**: on this machine
they exhaust RAM and swap (see "The result"). The harness now fails fast when the app dies instead
of hanging, but the machine still has to survive the attempt.

`perf:diff` is the whole of what M8.7's CI job has to do: it loads two committed reports and applies
the pure rules in `perf/lib/report.ts` — no build, no Electron, no deck. It exits `1` on a budget
failure or a regression beyond `--tolerance` (default 10 %), `2` on mismatched inputs (it refuses to
compare runs of different deck sizes or different RAM bases).

Useful flags for `perf:run`:

| Flag           | Default                       | Meaning                                                                                                                                                     |
| -------------- | ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--slides=N`   | `100`                         | Which generated deck to use                                                                                                                                 |
| `--runs=N`     | `3`                           | Whole-session repetitions; the report keeps per-run headlines                                                                                               |
| `--ram-basis=` | `app-metrics-working-set-sum` | `proc-pss-sum` is the honest basis on Linux — see below                                                                                                     |
| `--switches=N` | `20`                          | Slide switches to time. Targets are strided across the deck, and the stride is capped so even `--switches=1` lands on a different slide than the active one |
| `--dwell=MS`   | `5000`                        | How long to record frame cadence on an animating slide                                                                                                      |
| `--no-export`  | off                           | Skip the export phase                                                                                                                                       |
| `--display=`   | `:0`                          | X display. The ambient `DISPLAY` on this WSL2 box points at a VcXsrv that is not running; WSLg's socket is `:0`                                             |
| `--out=PATH`   | `perf/results/run-<N>.json`   | Report path                                                                                                                                                 |

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

| Metric               | Definition                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `coldStartMs`        | **Upper bound.** Spawn → `#sloodge-shell` in the DOM, polled every 25 ms                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `documentLoadedMs`   | **Lower bound.** Spawn → the renderer's navigation `loadEventEnd`, converted through `performance.timeOrigin`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `deckOpenMs`         | `deck:updated` dispatched → every **mounted** rail frame has fired `load`. Since M8.2 the rail mounts a frame only for the cards in its scroll window, so this is the rail's first paint, not the whole deck              |
| `deckPublishMs`      | `deck:updated` dispatched → every mounted rail frame has a `slide://` src (main holds the bytes)                                                                                                                          |
| `deckReadMs`         | The shipped `readDeck` unzipping the `.sloodge` from disk                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `slideSwitchMs`      | Rail click → the canvas iframe's `load`. **Both timestamps are taken in page context**, so CDP round-trip jitter delays only when a number is read, never the number. A load is a click's only if it landed before the next click — a click on the already-active slide fires no `load`, and a `src` swap cancels the navigation in flight, so the one `load` that follows belongs to the later click. The harness waits up to 2 s for each click's own load and then settles 220 ms before the next, so the click window of ~2.2 s — not the 220 ms settle — is the slowest switch this can see. **`count + unmeasuredSwitches` should equal `--runs` × `--switches`**; a shortfall means a rail item was missing from the DOM and the run's `notes` say which |
| `unmeasuredSwitches` | Switches whose `load` never arrived before the next click. They are **censored, not dropped**: kept out of `slideSwitchMs` (their true latency is unknown, bounded below by the 2 s wait) and counted here instead, so a series that is short is short visibly. Expected 0 on a healthy run; any other value is a slow-switch signal a median alone cannot show, which is why the budget table says `WARN` and `perf:diff` treats **any non-zero value in the candidate** as a slide-switch regression — against 0, not against the baseline's own count, so a baseline that censored switches cannot buy a candidate that many slow switches for free                                                                                                          |
| `frameIntervalMs`    | Gaps between `requestAnimationFrame` callbacks in the **app shell** while an animating slide is active. `null` if the dwell recorded no frames                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `droppedFrames`      | Frames **missed against a 60 Hz ideal** over the dwell window (`missedFrames` in `stats.ts`). The budgeted number; lower is better                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `longFrameIntervals` | Intervals longer than 1.5 × the 60 Hz budget, i.e. > 25 ms. Kept as a secondary signal; not monotonic once the frame stream collapses (see Known limits #9)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `frameRateFps`       | Frames served ÷ dwell seconds. Reported, never a budget; meaningless when `hostContention.contended` is true                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `railScrollMs`       | Summed round-trip of 25 `scrollTop` assignments on the rail, the 120 ms settle between steps **excluded** — each assignment forces a layout flush and is serviced only when the renderer's main thread is free                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `rendererHeapMb`     | `JSHeapUsedSize` from CDP `Performance.getMetrics`, host renderer only. `null` if no read succeeded                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `processTypes`       | Per Chromium process type (Browser / GPU / Tab / Utility): process count and memory on `ramBasis`, per sample, for the whole session and for the idle window. A type's `processes.min` of 0 means it was not always alive. A sample's memory counts when ≥ 90 % of the type's processes had a `/proc` reading — the same rule as the per-sample totals — so `memoryMb.count` can be below `processes.count`                                                                                                                                                                                                                                                                                                                                                     |

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

`perf:run` **checks the record before it measures**: the `.deck-update.json` payload it is about to
push is hashed and compared to the committed `contentSha256`, and the `.sloodge`'s slides are compared
against the payload's. A `perf/decks/` left behind by an older generator, or a `--force --seed=1`
regeneration, fails the run with `run pnpm perf:generate` instead of producing a report labelled with
the committed seed and hash. (The `.sloodge` itself cannot be hashed the same way — `readDeck` returns
its manifest through zod, which normalises it — hence the two-step comparison.)

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
    open-ended hang (the earlier 500-slide "20 minutes of silence" was this hang). A `waitFor` bounds
    each tick by what is left of its own deadline and names the last swallowed error, so a frozen
    renderer fails a 2.5 s wait in 2.5 s with "got no reply", not in 30 s with "timed out waiting".
    `perf:diff` validates both reports against a zod schema and names the missing field of a
    truncated one rather than crashing inside the budget maths, and `perf:run` validates the report
    it just wrote against that same schema: a run that cannot serve as a baseline — an idle window
    with no samples (`--idle-dwell=0`), a run with a null per-run median — is still written to disk,
    but the command names the field and exits non-zero instead of printing a PASS table and exiting 0. A run so empty that it cannot be summarized at all (no RAM sample on the chosen basis, or
    every switch censored — a 1-slide deck does this) has no honest report to write, so it writes
    the **trace** alone and exits non-zero: the samples a multi-minute session did collect are never
    thrown away for want of a summary.
11. **The session median weights phases by sample count.** Every sample reads `/proc` for every
    process, so at 200+ processes under heavy host load one sample can take seconds and the loaded
    phase ends up under-sampled relative to the cheap idle phase. One 200-slide run taken at a load
    of 21 reported a 605 MB "median" and a `processCount.median` of 8 for exactly that reason, while
    its trace shows 205 processes for the whole loaded phase. A report whose `processCount.median` is
    far below `processCount.max` did not measure the loaded deck; `processTypes.session` and the
    trace show which phase the median landed in.
12. **Switch latency has a ceiling, and the ceiling is reported.** A click's `load` is only its own
    if it lands before the next click, so the inter-click gap is the slowest switch the instrument
    can resolve. Each click therefore waits for its own load — up to 2 s — before the 220 ms settle
    and the next click, which makes the real ceiling the ~2.2 s window, well past the 100 ms budget.
    (A load landing during the settle is still its click's, which is why the ceiling is the window
    and not the wait; the censored `latencyMs` is the window, so it is always ≥ the 2 s wait.) A
    switch that outlasts the window is **counted in `unmeasuredSwitches`, never dropped**, because the failure
    this guards against is a regression that is _too slow to see_: with a fixed gap and a silent
    drop, a deck that switched in 60 ms most of the time and stalled for 400 ms every fourth click
    would have shed exactly its slow samples and passed the median gate with a shorter series.

---

## The result: we are far over the RAM budget, and the cause is structural

Committed baseline: `perf/results/baseline-main.json` (100-slide deck, 3 runs, PSS basis), with
`perf/results/baseline-scaling-*.json` for the other tiers. All taken by the harness at commit
`ef07cf4`; two fields were then re-derived from the traces without re-running the app, and each JSON
says so in its `notes`: `slideSwitchMs`, after the r2 review found that every run's first switch was
a phantom (the click on the already-selected slide 0 fired no `load` and borrowed the next click's —
one sample per run, and the p95/max of the 100-slide baseline fell from 151/280 ms to 110/145 ms
while the median moved 54.4 → 53.8), and `processTypes`, under the per-type coverage rule described
above (the 300-slide `Tab` median rose from 2750 to 3042 MB; every other type and the whole idle
block are unchanged). Their `unmeasuredSwitches` (3 on the main tier, 1 per scaling tier) is that
same phantom, counted rather than dropped — one per run, and **not reproducible on the current
harness**, whose clicks start at `stride` instead of slide 0. It is left as measured rather than
zeroed so `slideSwitchMs.count + unmeasuredSwitches` still equals the clicks issued; `perf:diff`
ignores it entirely, judging a candidate against 0, so these files would themselves be flagged if
one were submitted as a candidate. Each says so in its `notes`. Every one of them is labelled `contended` (see below); the memory columns are
the trustworthy ones.

That r2 re-derivation also rewrote each `*.trace.json` in place, so the traces now agree with the
reports by construction and are **no longer an independent witness** to the correction: each
report's `notes` block is the record of what was re-derived and from what. The traces are gitignored
and local, so nothing in the changeset depends on them; a re-run regenerates both from the app.

**Median RAM is 1685 MB against a 200 MB budget — 8.4x over.** That is not a tuning problem; no
amount of trimming allocations reaches 200 MB from here. The cause is architectural, and it shows up
first in the process count:

> Every slide is published at `slide://<unique-id>/` (`src/shared/slide-protocol.ts`,
> `slideDocumentUrl`). The document id is the URL **host**, so every slide is a distinct _origin_,
> and Chromium's site isolation gives each origin its own renderer process. A 100-slide deck runs
> **105 Electron processes** (1 Browser, 1 GPU, 1 Utility, 102 renderers: shell, canvas, 100 rail
> thumbnails); a 300-slide deck runs 305.

Each of those carries its own renderer heap, compositor, and per-process Blink/V8 overhead. The
`processTypes.session` block of the baseline puts the number on it: the `Tab` processes alone hold a
median **1203 MB PSS** on the 100-slide deck (max 1320 MB), against ~230 MB for the Browser process
and ~220 MB for the GPU process when it is alive. The measured marginal cost is roughly **11-14 MB PSS
per mounted slide**, on top of a large fixed floor.

### Scaling

| Slides | Processes | Median PSS | Working-set sum | Cold start | Deck open | Slide switch |
| -----: | --------: | ---------: | --------------: | ---------: | --------: | -----------: |
|     25 |        30 |     805 MB |         3019 MB |    1754 ms |    513 ms |       105 ms |
|     50 |        55 |    1164 MB |         5395 MB |    1366 ms |   1433 ms |        48 ms |
|    100 |       105 |    1685 MB |         9875 MB |    1528 ms |   1794 ms |        54 ms |
|    200 |       205 |    3092 MB |        17715 MB |    1340 ms |   3908 ms |        67 ms |
|    300 |       305 |    3971 MB |        12395 MB |    1344 ms |  11920 ms |        84 ms |

PSS and process count scale cleanly and are the trustworthy columns. The working-set sum is kept only
to show how far the naive basis is from physical reality (it exceeds the 6.8 GB VM from 200 slides
up); under memory pressure some processes report a zero working set, making that basis incoherent
exactly where it matters — another reason PSS is the headline basis.

Two consequences worth stating plainly, because they set up M8.2:

1. **The app is over budget before a stress deck is opened at all.** Idle on its 3-slide starter
   deck it sits at **270–480 MB PSS**, and the whole spread is one process. Under WSLg the GPU
   process is SwiftShader; it holds 160–200 MB PSS and is alive in some idle windows and not others
   (`processTypes.idle.GPU.processes.min` is 0 in two of the five committed baselines). Without it
   the floor is Browser ~120 MB + five renderers (shell, canvas, three thumbnails) ~125 MB + Utility
   ~25 MB ≈ **270 MB**; with it ≈ **440–480 MB**. Even the GPU-less floor is 1.35x the budget with
   three slides on screen. An earlier claim of "448–453 MB, spread under 1 %" was measuring the GPU
   process's presence in those particular windows, not the app's stability, and is withdrawn.
2. **The 500- and 1000-slide tiers do not run on this machine.** A 500-slide deck spawns ~507
   processes; observed directly, `MemAvailable` fell to 0 MB, all 2 GB of swap was consumed, and the
   session never reached a loaded state before it was killed. (The 20 minutes it took to notice was
   the CDP hang fixed in this round; the harness now fails within seconds of the app dying.) The
   decks generate and validate fine — the app cannot hold them. There is therefore **no harness JSON
   for 500 or 1000**, and the roadmap's "open a 500-slide deck in under 5 s" is currently not a
   timing question at all.

M8.2 ("lazy slide mounting — only the active slide's iframe is live, ±1 neighbours pre-warmed") is
therefore not an optimization but the fix for a hard ceiling. This harness will show it directly as a
collapse in `processCount`, `ramMb` and `processTypes.session.Tab`.

### What passes today

Cold start (1.3–2.3 s contended, ~0.8–1.0 s in quieter runs, against 3 s) passes at every tier.
Slide switch sits at 50–60 ms at 50–100 slides; the 105 ms at 25 slides is contention (41 ms for the
same tier one sweep earlier). Deck open passes to 100 slides (1.8 s), reaches 3908 ms at 200 and
fails at 300 (11920 ms) — three tiers below the deck size that budget was written for.

Rail scroll — the summed round-trip of 25 `scrollTop` assignments, sleeps excluded — is the number
M8.3 will move: 249 ms at 25 slides, 227 ms at 50, 420–750 ms at 100, 5757 ms at 200 and
29093 ms at 300. Every assignment forces a layout over every mounted thumbnail, so it grows
faster than linearly with the deck.

### Contention, and which numbers survive it

Every committed baseline was taken while other agents ran test suites and their own harness runs on
the same machine; `hostContention.contended` is `true` in all five, with median 1-minute loads of
6–18 on 16 cores, and each one says so in its own `notes`. What survives that:

| 100-slide median PSS    | Harness revision | Load (median) |
| ----------------------- | ---------------- | ------------: |
| 1725 MB (superseded)    | `e2a3a20`        |          12.6 |
| 1680 MB                 | `7dda941`        |           9.8 |
| 1662 MB                 | `ef07cf4`        |           7.8 |
| **1685 MB** (committed) | `ef07cf4`        |           6.3 |

**Memory reproduces within 4 % across four sweeps and three harness revisions; the process count is
identical every time.** Timing does not: cold start ranged 0.75–2.3 s and slide switch 41–117 ms per
run across the same sweeps, and the earlier quiet-window comparison (25-slide switch 54 ms quiet vs
118 ms contended) still stands. The RAM conclusion — the headline of this milestone — is safe. The
timing columns should be re-taken on a quiet machine before M8.2 diffs against them.

`frameRateFps` and `droppedFrames` in the contended baselines are **not usable**: the three runs of
the committed 100-slide baseline recorded 49.4, 2.4 and 55.6 fps, because rAF delivery is exactly
what a loaded host disrupts. Contended reports now carry that caveat in `notes`. The quiet-window
series taken during M8.1 development is the one to believe, and it degrades cleanly with deck size:

| Slides | Shell frame rate (quiet) |
| -----: | -----------------------: |
|     25 |                 13.5 fps |
|     50 |                  9.4 fps |
|    100 |                  7.1 fps |
|    200 |                  1.9 fps |

At 200 slides the shell served 9 frames in 4.8 s, and those frames spanned only 268 ms of that
window — the renderer was not producing frames at all for the remaining ~4.5 s.

---

## M8.2 — lazy mounting, and what it did to these numbers

M8.2 changed what the harness measures in two places, both disclosed in the metric table above:
`deckOpenMs`/`deckPublishMs` now wait for every **mounted** rail frame rather than one frame per
slide, because the rail only mounts frames inside its scroll window; and a canvas frame is created
only once its URL exists, so a switch's first `load` is the slide's (a bare `<iframe>` fires `load`
for `about:blank` first, which made a switch look like 6 ms in an early run).

### Before / after, 100-slide deck, `proc-pss-sum`, 3 runs each

| Metric                        | M8.1 baseline |  M8.2 (shipped) | Note                          |
| ----------------------------- | ------------: | --------------: | ----------------------------- |
| Electron processes (median)   |           105 |           **6** | peak 106 → 6                  |
| Median PSS during the session |       1680 MB |      **527 MB** | p95 1903 → 624                |
| Idle PSS (starter deck)       |        460 MB |          442 MB | unchanged — see "the floor"   |
| Deck open (`deckOpenMs`)      |       1943 ms |          500 ms | definition changed, see above |
| Slide switch (median / p95)   |   61 / 288 ms | **38 / 210 ms** | timing; contended host        |
| Cold start                    |       1158 ms |         1083 ms | timing; contended host        |

Both runs were taken on a contended host (median 1-minute load 5.7 for the M8.2 run, 9.8
for the baseline, on 16 cores), so the timing rows are indicative only; the process and PSS rows
reproduce within a few percent under load (see "Contention" above) and are the claim.

### The three URL shapes that were measured

All three runs use the same lazy mounting; only `slideDocumentUrl` differs. Taken with the harness at
`0c3bc6d`, before the M8.1 round-1 fix — that fix changed how the harness fails and what it reports
per process type, not how it counts processes or sums PSS.

| URL shape                       | Processes (median / peak) | PSS median | Switch median / p95 | Long shell frames |
| ------------------------------- | ------------------------: | ---------: | ------------------: | ----------------: |
| `slide://<id>/` (per document)  |                   14 / 26 |     640 MB |         54 / 268 ms |                53 |
| `slide://slides/<id>/` (one)    |                     5 / 5 |     583 MB |   **360 / 1691 ms** |               125 |
| `slide://<surface>/<id>/` (two) |                     6 / 6 |     551 MB |         40 / 135 ms |                83 |

One host for everything is the smallest and the slowest: the canvas frame, its two pre-warmed
neighbours and every visible thumbnail — a dozen animating documents — share one renderer main
thread, so a cold switch's parse queues behind them. Per-surface hosts (`slides` for the stage,
Present and export; `thumbnails` for the rail) cost one more process and keep the thumbnails' work
off the stage's thread. That is what shipped. Containment for the shipped hosts is demonstrated by
`pnpm perf:isolation` — see below.

### Scaling after M8.2

| Slides | Processes (median / peak) | Median PSS | Idle PSS | Deck open | Slide switch (median) | Host load |
| -----: | ------------------------: | ---------: | -------: | --------: | --------------------: | --------: |
|    100 |                     6 / 6 |     527 MB |   442 MB |    500 ms |                    38 |       5.7 |
|    500 |                     6 / 6 |     594 MB |   447 MB |    480 ms |                    83 |      16.7 |
|   1000 |                     6 / 6 |     662 MB |   446 MB |    525 ms |                    46 |       8.8 |

The 500- and 1000-slide tiers, which could not be opened at all before (M8.1 watched `MemAvailable`
hit 0 and 2 GB of swap fill), now open in about half a second and produce reports. Process count is
flat at 6 from 3 slides to 1000; PSS grows with the deck only through the store's serialized source
and main's registry entries for the mounted documents.

### The floor, and what the 200 MB budget is made of

Idle on the 3-slide starter deck, measured per process from `/proc/<pid>/smaps_rollup` six seconds
after launch on a quiet machine (the harness's own idle window starts at 0.6 s and reads ~445 MB
while the app is still settling):

| Process                      |        PSS |
| ---------------------------- | ---------: |
| Browser (main)               |     117 MB |
| GPU                          |     162 MB |
| Utility (network service)    |      24 MB |
| Tab — the app's renderer     |      50 MB |
| Tab — sandboxed `slides`     |      24 MB |
| Tab — sandboxed `thumbnails` |      26 MB |
| **Total**                    | **403 MB** |

353 MB of that exists before a single slide document does. The two slide processes hold all five
of the starter deck's documents for ~50 MB together. Under a 100-slide deck the session median
sits ~100–150 MB above idle, which is the ~13 mounted documents (3 on the stage, ~10 thumbnails)
plus the deck's source in the renderer store and main's registry — roughly 1 MB per slide of
serialized HTML for the stress decks, and nothing per slide beyond that. The 200 MB median is
therefore no longer a question of deck size or of anything M8.2 could reach; it is Electron's fixed
multi-process baseline (the GPU process alone is 80 % of the budget). Whether that is M8.6's
startup/process audit or a budget revision is the next decision, and this report is the input to
it.

### `pnpm perf:isolation`

The URL change is safe only if nothing that keeps slides apart lived in the per-document host. This
probe launches the built app, pushes a three-slide deck whose slides are probes, and from inside each
running slide reaches for the host (`parent.document`, `top.document`, `parent.sloodge`), every
sibling frame (its `document`, `localStorage`, and navigating it), its own storage (`localStorage`,
`sessionStorage`, `indexedDB`, `document.cookie`) and the network (`fetch` of its own URL). Each
slide reports over `parent.postMessage`, and the page records `event.origin` and which iframe
`event.source` is. It exits non-zero if any reach succeeds. Results for the shipped hosts are in
`perf/results/isolation-m82.json` (110 of 110 denied, `event.origin === "null"` throughout, 6
processes for 5 mounted frames on 2 hosts); the per-document and single-host variants are in
`isolation-variant-per-document-host.json` and `isolation-variant-single-host.json` for comparison —
same 110 of 110, at 9 and 5 processes. (The two variants' `perf:run` reports were taken on the
pre-round-1 harness and are not committed; their numbers are the table above.)
