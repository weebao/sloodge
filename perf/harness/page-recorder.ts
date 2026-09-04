/**
 * The instrumentation injected into the renderer.
 *
 * This is a string rather than a module because it is evaluated inside the app's page through
 * `Runtime.evaluate`; it never runs in Node and is never bundled into the app. Keeping it here (and
 * not in `src/renderer`) is the point of the whole approach: the app under measurement is the app
 * that ships, byte for byte.
 *
 * Everything it records is timestamped **in page context** with `performance.now()`. That matters
 * for accuracy: the harness reads these buffers by polling over a WebSocket, and a CDP round-trip is
 * a millisecond-scale cost with tens of milliseconds of jitter. If the harness timed the click and
 * the load itself, that jitter would land squarely inside a 100 ms budget. Timing both ends in-page
 * means polling latency delays only *when* a number is read, never the number.
 */

export const RECORDER_GLOBAL = '__sloodgePerf'

/** Selectors the app exposes today. None of these were added for the harness. */
export const SELECTORS = {
  shell: '#sloodge-shell',
  rail: 'nav[aria-label="Slides"]',
  railScroller: 'nav[aria-label="Slides"] ol',
  canvas: 'main[aria-label="Slide canvas"]',
  statusBar: 'footer[aria-label="Status bar"]',
  presentSurface: '[role="dialog"][aria-label="Presentation"]',
} as const

export const INSTALL_RECORDER = `(() => {
  const w = globalThis;
  if (w.${RECORDER_GLOBAL}) return 'already-installed';
  const state = {
    frames: [],
    longTasks: [],
    canvasLoads: [],
    railLoads: [],
    switches: [],
    installedAt: performance.now(),
    timeOrigin: performance.timeOrigin,
  };
  w.${RECORDER_GLOBAL} = state;

  // Frame cadence of the app shell. rAF here is served by the renderer's main thread, which is the
  // same thread every mounted slide's script and style recalc contends for — so a stalled shell
  // frame is exactly the jank a user sees. It does NOT measure a slide's internal compositor rate.
  const onFrame = (t) => {
    state.frames.push(t);
    if (state.frames.length > 60000) state.frames.shift();
    requestAnimationFrame(onFrame);
  };
  requestAnimationFrame(onFrame);

  try {
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        state.longTasks.push({ start: entry.startTime, duration: entry.duration });
      }
    });
    observer.observe({ entryTypes: ['longtask'] });
  } catch (e) {
    state.longTaskError = String(e);
  }

  // iframe 'load' does not bubble, but it is observable in the capture phase on an ancestor.
  const attach = (root, sink) => {
    if (!root) return false;
    root.addEventListener('load', (ev) => {
      if (ev.target && ev.target.tagName === 'IFRAME') sink.push(performance.now());
    }, true);
    return true;
  };
  state.canvasAttached = attach(document.querySelector('${SELECTORS.canvas}'), state.canvasLoads);
  state.railAttached = attach(document.querySelector('${SELECTORS.rail}'), state.railLoads);
  state.clickSlide = (index) => {
    const item = document.querySelector('[data-slide-index="' + index + '"] button');
    if (!item) return null;
    const before = state.canvasLoads.length;
    const clickAt = performance.now();
    item.click();
    state.switches.push({ index: index, clickAt: clickAt, loadsBefore: before });
    return clickAt;
  };

  return 'installed';
})()`

/**
 * True once the most recent click's canvas `load` has landed. The harness waits on this (bounded)
 * before issuing the next click, so a slow switch is measured rather than cut off by the next click.
 */
export const LAST_SWITCH_LOADED = `(() => {
  const state = globalThis.${RECORDER_GLOBAL};
  const last = state.switches[state.switches.length - 1];
  return state.canvasLoads.length > last.loadsBefore;
})()`

/**
 * Resolve each recorded switch to its latency by pairing the click with the first canvas-frame
 * `load` that followed it **and landed before the next click** (or, for the last click, before this
 * read). Runs in page context so both timestamps stay on the page clock.
 *
 * The bound is what keeps a click that produced no load of its own from borrowing the next one. A
 * click on the already-active slide fires no `load` at all, and swapping the canvas `src` before the
 * previous navigation finished cancels that navigation, so the single `load` that follows belongs to
 * the later click. Without the bound every run's first switch was a phantom: it paired with the
 * second click's load and reported that latency plus the whole inter-click sleep.
 *
 * A click whose load did not land inside its window is **censored**, not dropped: its true latency
 * is at least the window's length, so that is what `latencyMs` carries, and `censored` says so. The
 * harness keeps censored records out of the latency series and counts them instead, so a switch too
 * slow to observe shows up as a number in the report rather than as a quietly shorter series.
 */
export const READ_SWITCHES = `(() => {
  const state = globalThis.${RECORDER_GLOBAL};
  if (!state) return [];
  return state.switches.map((s, i) => {
    const next = state.switches[i + 1];
    const windowEnd = next === undefined ? performance.now() : next.clickAt;
    const load = state.canvasLoads[s.loadsBefore];
    const own = load !== undefined && load < windowEnd;
    return {
      index: s.index,
      clickAt: s.clickAt,
      loadAt: own ? load : null,
      latencyMs: own ? load - s.clickAt : windowEnd - s.clickAt,
      censored: !own,
    };
  });
})()`

export const READ_FRAMES = `(() => {
  const state = globalThis.${RECORDER_GLOBAL};
  return state ? state.frames.slice() : [];
})()`

export const READ_LONG_TASKS = `(() => {
  const state = globalThis.${RECORDER_GLOBAL};
  return state ? state.longTasks.slice() : [];
})()`

export const RESET_FRAMES = `(() => {
  const state = globalThis.${RECORDER_GLOBAL};
  if (state) { state.frames.length = 0; state.longTasks.length = 0; }
  return true;
})()`
