import { useEffect, useState } from 'react'
import { wrapSlideHtml } from './wrapSlideHtml'

/**
 * Blob-URL delivery for slide documents — layer 2's transport, per §7 of 10-architecture.md:
 * `<iframe sandbox="allow-scripts" … src={blobUrl}>`, explicitly *rather than* `srcdoc`.
 *
 * Three reasons the plan gives, all of which hold:
 *
 *  1. **Opaque origin, cleanly.** A `srcdoc` document inherits the embedder's CSP on top of its
 *     own, and the host page ships `script-src 'self'` (src/renderer/index.html). That silently
 *     breaks every slide with an inline `<script>` — i.e. the whole `interactive-js` capability of
 *     the slide contract. A blob-loaded frame is a real navigation to its own document, so the
 *     policy that governs it is the one `wrapSlideHtml` injects. `index.html` already allows this
 *     with `frame-src 'self' blob:`.
 *  2. **A real document URL**, which Design Mode's DevTools work needs (M2).
 *  3. **No HTML-escaping the whole document into an attribute**, which `srcdoc` requires.
 *
 * Because the injected policy is now the *only* policy on the frame, `wrapSlideHtml`'s anchor has
 * to be markup-aware rather than a regex — see the note at the head of that module. The two
 * changes belong together: blob delivery without the anchor fix would turn a hidden `<head>` in
 * model-authored HTML into an unrestricted `connect-src`.
 *
 * ## Lifecycle
 *
 * A blob URL is a document-lifetime resource: created explicitly, and leaked until revoked. This
 * hook owns exactly that — one live URL per mounted frame, revoked when the html changes and when
 * the component unmounts. The effect's cleanup is what makes it correct under StrictMode's
 * double-invoke, where the first URL would otherwise leak.
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
