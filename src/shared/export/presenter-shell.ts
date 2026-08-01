/**
 * The generated presenter shell — `index.html` of an exported HTML bundle (M4.4, 60-export.md §5.2).
 *
 * ## What this is
 *
 * A single self-contained page with no build step, no dependencies, and no server: the user unzips
 * the bundle, double-clicks `index.html`, and gets the deck at 1280×720 scaled-to-fit with the same
 * keyboard navigation Present mode has. Because the slides are the source — not a flattened frame —
 * **animations and interactivity keep working**, which is the entire reason HTML export exists next
 * to PDF and PPTX.
 *
 * ## The `file://` threat model — why the iframe sandbox is not optional
 *
 * Inside the app a slide is protected by four layers (10-architecture.md §7). Exported, **two of
 * them are gone**: there is no `slide://` response header and no host-renderer CSP, because the page
 * is now a `file://` document in someone else's browser. What survives into the bundle is exactly
 * two things, and the shell is responsible for one of them:
 *
 *  1. **The slide's own injected CSP meta** (`wrapSlideHtml`, layer 3) — it travels *in the slide
 *     bytes*, so it is still enforced. This is why the bundle stores wrapped slide HTML rather than
 *     raw author source; see `html-bundle.ts` for that decision and its round-trip consequence.
 *  2. **The `sandbox="allow-scripts"` iframe** (layer 2) — emitted here, by this file.
 *
 * The second one is load-bearing in a way it is not inside the app. A `file://` document that framed
 * a slide *with* `allow-same-origin`, or ran it top-level, would in some browser configurations give
 * that slide same-origin access to other `file://` URLs — i.e. the user's filesystem — plus DOM
 * access to the shell itself. `allow-scripts` **without** `allow-same-origin` forces the slide into
 * an opaque origin: its scripts run (they must — that is the feature), but it cannot read the
 * shell's DOM, cannot reach `parent`, cannot read sibling slides, and cannot read local files.
 *
 * The two tokens are load-bearing in opposite directions and both are pinned by tests: dropping
 * `allow-scripts` silently kills every animated slide, and adding `allow-same-origin` silently
 * dissolves the sandbox (the pair is explicitly documented as equivalent to no sandbox at all).
 * `SHELL_SLIDE_SANDBOX` is therefore a single constant with a test that asserts its exact value and
 * a second test that asserts the emitted markup contains no `allow-same-origin` anywhere.
 *
 * We also never inject anything into the slide documents themselves. The shell talks *to* nothing in
 * the frame and listens to nothing from it — there is no `postMessage` channel — so the sandbox has
 * no hole to keep open.
 *
 * ## Why the shell's logic is generated rather than retyped
 *
 * The shell is emitted JavaScript: it cannot import `keyToPresentIntent`. Rather than hand-write a
 * second copy of Present mode's key semantics (which would drift the first time a key is added), the
 * key→intent table is **generated** by calling the real function over `PRESENT_KEYS`, and the
 * clamping reducer is emitted as a small chunk whose behaviour a test verifies against
 * `reducePresent` by evaluating it. Semantics have one source; only the transport differs.
 */

import {
  keyToPresentIntent,
  PRESENT_CONTROLS_HIDE_MS,
  PRESENT_KEYS,
  type PresentIntent,
} from '../present/machine'
import { encodeJsonForScriptBlock, escapeHtmlAttribute, escapeHtmlText } from './html-escape'
import { SLIDE_HEIGHT_PX, SLIDE_WIDTH_PX } from './types'

/**
 * The complete sandbox token list for a slide frame in the exported shell. Mirrors `SLIDE_SANDBOX`
 * in `SlideFrame.tsx` — the app's canvas frame — and a test pins the two to the same string so the
 * exported bundle can never end up laxer than the editor. **Never widen it**, and in particular
 * never add `allow-same-origin`: combined with `allow-scripts` that is documented by the HTML
 * standard as equivalent to removing the sandbox, and here it would hand a slide the user's
 * filesystem over `file://`.
 */
export const SHELL_SLIDE_SANDBOX = 'allow-scripts'

/** One slide as the shell sees it: where its file is and what to call it. */
export type BundleSlideEntry = {
  /** 0-based position in the exported range. */
  index: number
  /** The deck slide id, carried so a re-import can match files back to slides. */
  id: string
  /** Human title, shown in the counter's tooltip and used for the slide file's name. */
  title: string
  /** Bundle-relative path, e.g. `slides/001-title.html`. Always forward-slashed. */
  file: string
}

/** The inlined manifest — `deck.json`, and the same object embedded in `index.html`. */
export type BundleManifest = {
  formatVersion: 1
  generator: 'sloodge'
  /** Deck title. Untrusted text: escaped at every emission site. */
  title: string
  slideCount: number
  slides: BundleSlideEntry[]
}

/** The element id of the inlined manifest block. Exported so tests and a re-importer can find it. */
export const SHELL_MANIFEST_ELEMENT_ID = 'sloodge-deck'

/**
 * The generated key→intent table, as a JavaScript object literal.
 *
 * Built by calling the real `keyToPresentIntent` on every key in `PRESENT_KEYS`, so the emitted
 * mapping is a projection of the shipped function rather than a transcription of it. A key the
 * function declines (which would be a `PRESENT_KEYS` bug) is skipped rather than emitted as `null`,
 * keeping the lookup a pure "present means claimed".
 */
export function buildKeyIntentTable(): Record<string, PresentIntent> {
  const table: Record<string, PresentIntent> = {}
  for (const key of PRESENT_KEYS) {
    const intent = keyToPresentIntent(key)
    if (intent !== null) table[key] = intent
  }
  return table
}

/**
 * The shell's **pure** logic, as JavaScript source: the key lookup, the index clamp, and the intent
 * reducer. Emitted separately from the DOM wiring so a unit test can `eval` exactly these bytes and
 * assert they agree with `clampSlideIndex` / `reducePresent` / `keyToPresentIntent` for every key and
 * every intent — the tie that makes "shares M4.1's tested module" true of generated code.
 *
 * `Object.prototype.hasOwnProperty.call` rather than `KEY_INTENT[k]`: a key of `constructor` or
 * `toString` would otherwise resolve up the prototype chain to a function and be treated as an
 * intent.
 */
export function buildPresenterLogicJs(): string {
  return `var KEY_INTENT = ${JSON.stringify(buildKeyIntentTable())};
function keyToIntent(key) {
  return Object.prototype.hasOwnProperty.call(KEY_INTENT, key) ? KEY_INTENT[key] : null;
}
function clampIndex(index, slideCount) {
  if (slideCount <= 0) return 0;
  if (index < 0) return 0;
  if (index > slideCount - 1) return slideCount - 1;
  return index;
}
function reduce(state, intent) {
  var at = function (next) {
    return { index: clampIndex(next, state.slideCount), slideCount: state.slideCount, blank: state.blank };
  };
  if (intent === 'next') return at(state.index + 1);
  if (intent === 'prev') return at(state.index - 1);
  if (intent === 'first') return at(0);
  if (intent === 'last') return at(state.slideCount - 1);
  if (intent === 'toggle-blank') return { index: state.index, slideCount: state.slideCount, blank: !state.blank };
  return state;
}`
}

/** The shell's DOM wiring: scaling, the two-frame swap, keys, hash deep links, auto-hiding controls. */
function buildPresenterRuntimeJs(): string {
  return `(function () {
  'use strict';
  var manifest = JSON.parse(document.getElementById(${JSON.stringify(SHELL_MANIFEST_ELEMENT_ID)}).textContent);
  var slides = manifest.slides;
  var SLIDE_W = ${String(SLIDE_WIDTH_PX)};
  var SLIDE_H = ${String(SLIDE_HEIGHT_PX)};

${buildPresenterLogicJs()
  .split('\n')
  .map((line) => (line === '' ? '' : `  ${line}`))
  .join('\n')}

  var state = { index: 0, slideCount: slides.length, blank: false };

  var fit = document.getElementById('fit');
  var frames = [document.getElementById('frame-0'), document.getElementById('frame-1')];
  var activeAt = 0;
  var counter = document.getElementById('counter');
  var controls = document.getElementById('controls');
  var blanker = document.getElementById('blanker');

  // Letterboxed scale-to-fit: the frame stays exactly 1280x720 so the slide's own layout is never
  // re-run at a different viewport, and only the CSS transform changes. Same strategy as the editor
  // canvas, so a slide looks identical in both.
  function resize() {
    var scale = Math.min(window.innerWidth / SLIDE_W, window.innerHeight / SLIDE_H);
    fit.style.transform = 'translate(-50%, -50%) scale(' + scale + ')';
  }

  function loadInto(frame, file) {
    if (frame.getAttribute('data-file') === file) return;
    frame.setAttribute('data-file', file);
    frame.setAttribute('src', file);
  }

  function render() {
    var current = slides[state.index];
    if (!current) return;
    var standby = frames[1 - activeAt];
    // The next slide was preloaded into the standby frame on the previous render: adopt it rather
    // than reloading, so advancing is instant and the slide's JS is already warm. Any other target
    // (a jump, a step backwards) loads into the frame that is already showing.
    if (standby.getAttribute('data-file') === current.file) {
      activeAt = 1 - activeAt;
    } else {
      loadInto(frames[activeAt], current.file);
    }
    frames[activeAt].classList.add('is-active');
    frames[1 - activeAt].classList.remove('is-active');

    var next = slides[state.index + 1];
    if (next) loadInto(frames[1 - activeAt], next.file);

    counter.textContent = String(state.index + 1) + ' / ' + String(slides.length);
    counter.title = current.title;
    blanker.classList.toggle('is-on', state.blank);
    var hash = '#/' + String(state.index + 1);
    if (window.location.hash !== hash) window.history.replaceState(null, '', hash);
  }

  function apply(intent) {
    if (intent === 'exit') {
      // There is no app to leave — a browser tab *is* the surface. Esc drops fullscreen if we are in
      // it and is otherwise deliberately inert rather than, say, closing the window.
      if (document.fullscreenElement) document.exitFullscreen();
      return;
    }
    var next = reduce(state, intent);
    if (next !== state) {
      state = next;
      render();
    }
  }

  var hideTimer = null;
  function pokeControls() {
    controls.classList.add('is-visible');
    if (hideTimer !== null) window.clearTimeout(hideTimer);
    hideTimer = window.setTimeout(function () {
      controls.classList.remove('is-visible');
    }, ${String(PRESENT_CONTROLS_HIDE_MS)});
  }

  window.addEventListener('keydown', function (event) {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.key === 'f' || event.key === 'F') {
      event.preventDefault();
      if (document.fullscreenElement) document.exitFullscreen();
      else document.documentElement.requestFullscreen();
      return;
    }
    var intent = keyToIntent(event.key);
    // Unclaimed keys fall through untouched so an interactive slide keeps its own shortcuts.
    if (intent === null) return;
    event.preventDefault();
    apply(intent);
    pokeControls();
  });

  window.addEventListener('resize', resize);
  window.addEventListener('mousemove', pokeControls);
  document.getElementById('prev').addEventListener('click', function () { apply('prev'); pokeControls(); });
  document.getElementById('next').addEventListener('click', function () { apply('next'); pokeControls(); });

  // Deep link: #/3 is slide 3, 1-based, so a link into the deck is shareable and reload-stable.
  function fromHash() {
    var match = /^#\\/(\\d+)$/.exec(window.location.hash);
    if (!match) return;
    var wanted = clampIndex(Number(match[1]) - 1, state.slideCount);
    if (wanted !== state.index) {
      state = { index: wanted, slideCount: state.slideCount, blank: state.blank };
      render();
    }
  }
  window.addEventListener('hashchange', fromHash);

  resize();
  fromHash();
  render();
  pokeControls();
})();`
}

/** The shell's stylesheet. Black surround so the letterbox reads as intentional, not as a gap. */
function buildPresenterCss(): string {
  return `:root { color-scheme: dark; }
* { box-sizing: border-box; }
html, body { margin: 0; height: 100%; background: #000; overflow: hidden; }
body { font: 14px/1.4 system-ui, -apple-system, Segoe UI, Roboto, sans-serif; color: #e5e7eb; }
#stage { position: relative; width: 100vw; height: 100vh; }
#fit {
  position: absolute; left: 50%; top: 50%;
  width: ${String(SLIDE_WIDTH_PX)}px; height: ${String(SLIDE_HEIGHT_PX)}px;
  transform-origin: 50% 50%; background: #fff;
}
#fit iframe {
  position: absolute; inset: 0; width: 100%; height: 100%;
  border: 0; opacity: 0; pointer-events: none;
}
#fit iframe.is-active { opacity: 1; pointer-events: auto; }
#blanker {
  position: absolute; inset: 0; background: #000; opacity: 0;
  pointer-events: none; transition: opacity 120ms linear;
}
#blanker.is-on { opacity: 1; pointer-events: auto; }
#controls {
  position: absolute; left: 50%; bottom: 24px; transform: translateX(-50%);
  display: flex; align-items: center; gap: 12px;
  padding: 8px 14px; border-radius: 999px;
  background: rgba(17, 24, 39, 0.82); border: 1px solid rgba(255, 255, 255, 0.14);
  opacity: 0; transition: opacity 160ms linear; pointer-events: none;
}
#controls.is-visible { opacity: 1; pointer-events: auto; }
#controls button {
  min-width: 34px; height: 30px; border-radius: 8px; cursor: pointer;
  background: rgba(255, 255, 255, 0.1); border: 1px solid rgba(255, 255, 255, 0.16);
  color: inherit; font: inherit;
}
#controls button:hover { background: rgba(255, 255, 255, 0.2); }
#counter { min-width: 68px; text-align: center; font-variant-numeric: tabular-nums; }
@media (prefers-reduced-motion: reduce) { * { transition: none !important; } }`
}

/**
 * Emit `index.html` for a bundle.
 *
 * Every interpolation of `manifest.title` goes through an escaper chosen for its context — text for
 * the `<title>`, attribute for `aria-label`, the script-block encoder for the inlined JSON — because
 * the title is untrusted text travelling into a document that will be opened outside our sandbox.
 *
 * The manifest is **inlined** rather than fetched: `fetch('deck.json')` from `file://` is blocked by
 * the opaque-origin rule, so a shell that fetched would work over http and be a blank page for the
 * user who did exactly what we told them and double-clicked the file.
 */
export function buildPresenterShell(manifest: BundleManifest): string {
  const safeTitle = escapeHtmlText(manifest.title)
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${safeTitle}</title>
<style>
${buildPresenterCss()}
</style>
</head>
<body>
<div id="stage">
  <div id="fit">
    <iframe id="frame-0" sandbox="${SHELL_SLIDE_SANDBOX}" referrerpolicy="no-referrer" allow="" title="${escapeHtmlAttribute(manifest.title)} slide"></iframe>
    <iframe id="frame-1" sandbox="${SHELL_SLIDE_SANDBOX}" referrerpolicy="no-referrer" allow="" title="${escapeHtmlAttribute(manifest.title)} slide (preloading)" aria-hidden="true"></iframe>
  </div>
  <div id="blanker"></div>
  <div id="controls" role="group" aria-label="${escapeHtmlAttribute(manifest.title)} presentation controls">
    <button id="prev" type="button" aria-label="Previous slide">&#8592;</button>
    <span id="counter" aria-live="polite"></span>
    <button id="next" type="button" aria-label="Next slide">&#8594;</button>
  </div>
</div>
<script type="application/json" id="${SHELL_MANIFEST_ELEMENT_ID}">${encodeJsonForScriptBlock(manifest)}</script>
<script>
${buildPresenterRuntimeJs()}
</script>
</body>
</html>
`
}
