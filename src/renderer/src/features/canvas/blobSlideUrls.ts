import type { SlideUrlFactory } from './useSlideUrl'

/**
 * Blob-URL delivery — the fallback transport, used when the renderer is not running inside Electron
 * (the evidence recorder over http, and the component tests in happy-dom). See `slideUrlFactory.ts`
 * for the host gate and `useSlideUrl.ts` for the lifecycle both transports share.
 *
 * What it cannot do is run a slide's inline `<script>`. `blob:` is one of Fetch's three *local*
 * schemes, so a blob-loaded frame inherits a clone of the embedder's policy container — measured in
 * Chromium, `experiments/init/harness/csp-blob-inheritance.mjs` — and the host page's
 * `script-src 'self'` blocks the slide's script exactly as it would in a `srcdoc` frame. Everything
 * below the slide contract's `interactive-js` capability (static, CSS-animated, SMIL-animated)
 * renders identically to the `slide://` path.
 *
 * The import above is type-only and therefore erased, which is what keeps this module a leaf:
 * `useSlideUrl` → `slideUrlFactory` → here, with no runtime cycle.
 */
export const blobSlideUrls: SlideUrlFactory = {
  create: (html) => URL.createObjectURL(new Blob([html], { type: 'text/html' })),
  revoke: (url) => {
    URL.revokeObjectURL(url)
  },
}
