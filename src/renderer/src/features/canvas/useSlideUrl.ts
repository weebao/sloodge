import { useEffect, useState } from 'react'
import { wrapSlideHtml } from './wrapSlideHtml'

/**
 * Blob-URL delivery for slide documents — layer 2's transport, per §7 of 10-architecture.md:
 * `<iframe sandbox="allow-scripts" … src={blobUrl}>`, explicitly *rather than* `srcdoc`.
 *
 * ## Correction: blob does NOT escape the host CSP
 *
 * An earlier revision of this file claimed that a blob-loaded frame, being a real navigation to
 * its own document, is governed only by the policy `wrapSlideHtml` injects — and therefore that
 * the switch unblocked the slide contract's `interactive-js` capability. **That was never executed
 * against a browser, and it is false.**
 *
 * Measured 2026-07-31 in Chromium via Playwright
 * (`experiments/init/harness/csp-blob-inheritance.mjs`, rerunnable): a host page carrying
 * `script-src 'self'` embeds a `sandbox="allow-scripts"` iframe pointed at a `text/html` blob URL
 * whose body holds an inline `<script>`. The script does **not** run —
 * *"Executing inline script violates the following Content Security Policy directive
 * 'script-src 'self''. … The action has been blocked."* — identically to the `srcdoc` control.
 * Per HTML's "determine navigation params policy container", a navigation whose response URL uses
 * a *local* scheme (Fetch defines those as `about`, `blob` and `data`) inherits a clone of the
 * initiator's policy container, CSP list included.
 *
 * **Therefore, today: inline slide JS is blocked, whatever the delivery.** Static, CSS-animated and
 * SMIL-animated slides — everything M1.3 renders — are unaffected, because the host policy allows
 * inline `<style>` and the slide format inlines all of its assets as `data:` URIs. Unblocking
 * `interactive-js` needs a **non-local** scheme: `slide://` registered with `protocol.handle` in
 * the main process, which escapes policy-container inheritance and gives each slide a real
 * per-document CSP. Tracked in 80-roadmap.md as an M2 prerequisite.
 *
 * ## Why blob delivery stays anyway
 *
 * It is empirically no worse than `srcdoc`, and the plan's own three reasons (§7) never depended on
 * the false claim: a cleanly opaque origin, a real document URL for Design Mode's DevTools work,
 * and not HTML-escaping an entire document into an attribute. It is also the right shape for the
 * `slide://` migration — that swap replaces what `create` returns and touches nothing else.
 *
 * ## Lifecycle
 *
 * A blob URL is a document-lifetime resource: created explicitly, and leaked until revoked. This
 * hook owns exactly that — one live URL per mounted frame, revoked when the html changes and when
 * the component unmounts. The effect's cleanup is what makes it correct under StrictMode's
 * double-invoke, where the first URL would otherwise leak.
 *
 * Ordering note: React runs the previous effect's cleanup *before* the next effect, so an edit is
 * revoke-old-then-create-new, not create-swap-revoke. That is safe because the replacement `src`
 * lands in the same commit — the old document has already painted, and a still-in-flight load is
 * immediately superseded — but it is the opposite of what someone adding a `load`/`error` handler
 * to the frame would assume, so it is written down rather than left to be rediscovered.
 */

/**
 * The seam. The DOM implementation is one line, and injecting it is what makes revocation
 * *provable* in a test: happy-dom's `URL.createObjectURL` is not a real browser blob store, so
 * asserting on the strings a stub hands out is the only way to pin "the previous URL was revoked,
 * exactly once, before the new one was used".
 */
export type SlideUrlFactory = {
  /** Returns an object URL for a complete HTML document. */
  create: (html: string) => string
  revoke: (url: string) => void
}

export const domSlideUrls: SlideUrlFactory = {
  create: (html) => URL.createObjectURL(new Blob([html], { type: 'text/html' })),
  revoke: (url) => {
    URL.revokeObjectURL(url)
  },
}

/**
 * The object URL for `html`, or `null` on the very first render before the effect has run.
 *
 * Created in an effect rather than during render on purpose: a URL minted in render bodies (or in
 * `useMemo`, which React may discard and recompute) has no reliable cleanup partner, and every
 * discarded one is a leaked document. The cost is that the frame paints `about:blank` for one
 * frame; the benefit is that every URL this hook creates is revoked exactly once.
 */
export function useSlideUrl(html: string, urls: SlideUrlFactory = domSlideUrls): string | null {
  const [url, setUrl] = useState<string | null>(null)

  useEffect(() => {
    const created = urls.create(wrapSlideHtml(html))
    setUrl(created)
    return () => {
      urls.revoke(created)
      // Deliberately *not* clearing the state here. Revoking only invalidates future loads; the
      // document already painted in the frame stays put, so leaving the old `src` in place until
      // the next effect writes the new one avoids a blank flash on every edit.
    }
  }, [html, urls])

  return url
}
