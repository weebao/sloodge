/**
 * The in-page readiness + animation-settle barrier for PDF export (M4.2), as a source string so the
 * one thing a unit test *can* pin about it — that it waits on fonts, image decode, the `__slideReady`
 * contract hook, and settles animations to their final frame — is asserted here rather than buried in
 * an Electron `executeJavaScript` call. The script runs in the slide's own sandboxed context; it can
 * touch only the slide's DOM, never the app or main.
 *
 * ## Why a barrier at all (60-export.md §1.3)
 *
 * `did-finish-load` fires before webfonts settle, before `<img>` decode, and before slide JS that
 * builds its own DOM. Printing early produces blank charts and fallback fonts — intermittently,
 * which is the worst failure mode. So every render waits on an explicit barrier before `printToPDF`.
 *
 * ## Final-frame policy (60-export.md §4)
 *
 * Neither PDF nor PPTX can run animation. A slide's exported representation is its steady state: we
 * let finite entrance animations finish (bounded), pin looping ones at a representative 25% phase
 * (t=0 stacks every orbiting element at its start angle, which reads as a bug), settle SMIL, then
 * commit two frames. Interactivity exports in its default state — no hovers, no clicks.
 *
 * ## Defensive `@page` (60-export.md §2.3)
 *
 * `preferCSSPageSize: true` is only meaningful if the slide declares its page. Compliant slides carry
 * `@page { size: 1280px 720px; margin: 0 }`; older/hand-edited ones may not, so the barrier appends a
 * `<style data-sloodge-print>` with it (idempotent, never touching the stored source) before the
 * final commit.
 */

/** The defensive print stylesheet, injected if the slide lacks its own `@page`. */
export const SLIDE_PRINT_STYLE = [
  '@page { size: 1280px 720px; margin: 0; }',
  '@media print {',
  '  html, body { width: 1280px; height: 720px; margin: 0; overflow: hidden; }',
  '  :root { --slide-w: 1280px; --slide-h: 720px; }',
  '  * { -webkit-print-color-adjust: exact; print-color-adjust: exact; }',
  '}',
].join('\n')

/** Bounds, matching 60-export.md: 6 s for the whole barrier, 3 s for entrance animations. */
export const EXPORT_READINESS_TIMEOUT_MS = 6000
const ANIMATION_SETTLE_MS = 3000
/** Looping animations are pinned a quarter-cycle in — a non-degenerate, intentional-looking still. */
const LOOP_PHASE_FRACTION = 0.25
/** Representative SMIL time to pin timeline-driven `<animate>` at. */
const SMIL_SETTLE_SECONDS = 2

/**
 * The barrier source. Wrapped by the Electron side in a timeout (`EXPORT_READINESS_TIMEOUT_MS`); on
 * timeout the slide is still printed (a degraded export beats a hung one) and flagged in the report.
 * Returns `true` when the slide is settled and committed.
 */
export function slideReadinessScript(): string {
  return `(async () => {
  await new Promise((r) => (document.readyState === 'complete' ? r() : addEventListener('load', r, { once: true })));
  try { await document.fonts.ready; } catch {}
  await Promise.all([...document.images]
    .filter((img) => !img.complete)
    .map((img) => img.decode().catch(() => {})));
  if (window.__slideReady) { try { await window.__slideReady; } catch {} }

  const anims = typeof document.getAnimations === 'function' ? document.getAnimations() : [];
  const finite = anims.filter((a) => {
    const t = a.effect && a.effect.getComputedTiming ? a.effect.getComputedTiming() : null;
    return t && t.iterations !== Infinity;
  });
  await Promise.race([
    Promise.all(finite.map((a) => a.finished.catch(() => {}))),
    new Promise((r) => setTimeout(r, ${String(ANIMATION_SETTLE_MS)})),
  ]);
  finite.forEach((a) => { try { a.finish(); } catch {} });
  anims.filter((a) => !finite.includes(a)).forEach((a) => {
    try {
      const d = a.effect.getComputedTiming().duration || 0;
      a.currentTime = d * ${String(LOOP_PHASE_FRACTION)};
      a.pause();
    } catch {}
  });
  document.querySelectorAll('svg').forEach((svg) => {
    try { svg.setCurrentTime(${String(SMIL_SETTLE_SECONDS)}); svg.pauseAnimations(); } catch {}
  });

  if (!document.querySelector('style[data-sloodge-print]')) {
    const style = document.createElement('style');
    style.setAttribute('data-sloodge-print', '');
    style.textContent = ${JSON.stringify(SLIDE_PRINT_STYLE)};
    document.head.appendChild(style);
  }

  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  return true;
})()`
}
