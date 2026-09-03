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
  // The rail and canvas mount before any deck arrives, but re-attach on demand in case they did not.
  state.reattach = () => {
    state.canvasAttached = attach(document.querySelector('${SELECTORS.canvas}'), state.canvasLoads);
    state.railAttached = attach(document.querySelector('${SELECTORS.rail}'), state.railLoads);
  };

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
 * Resolve each recorded switch to its latency by pairing the click with the first canvas-frame
 * `load` that followed it. Runs in page context so both timestamps stay on the page clock.
 */
export const READ_SWITCHES = `(() => {
  const state = globalThis.${RECORDER_GLOBAL};
  if (!state) return [];
  return state.switches.map((s) => {
    const load = state.canvasLoads[s.loadsBefore];
    return {
      index: s.index,
      clickAt: s.clickAt,
      loadAt: load === undefined ? null : load,
      latencyMs: load === undefined ? null : load - s.clickAt,
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
