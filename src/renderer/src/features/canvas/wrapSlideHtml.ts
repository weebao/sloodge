/**
 * Layer 3 of the four-layer slide sandbox (§7 of 10-architecture.md): the slide document's *own*
 * Content-Security-Policy, injected as the first child of `<head>` — before any author content, so
 * the policy governs every byte the model wrote.
 *
 * Layer 1 is the host renderer's own CSP + `contextIsolation`; layer 2 is the `sandbox="allow-scripts"`
 * iframe with **no** `allow-same-origin` (see `SlideFrame.tsx`); layer 4 is the postMessage protocol
 * (M2+, Design Mode). This module is only layer 3, and it is deliberately a pure string function:
 * no DOM, no `DOMParser`. Re-serializing model-authored HTML through a parser would silently
 * normalize the very bytes that Design Mode's byte-span patcher (§3.3 of 30-slide-format.md) is
 * built to preserve.
 *
 * ## Why an *added* policy is safe
 *
 * CSP composes by intersection: a document with several policies must satisfy all of them, so a
 * hostile slide that ships its own permissive `<meta http-equiv="Content-Security-Policy">` cannot
 * widen ours — it can only narrow its own document further. That is why nothing here strips or
 * rewrites an existing meta: there is no bypass to close, and rewriting would mutate author bytes.
 *
 * ## Known gap under `srcdoc` delivery
 *
 * A `srcdoc` frame **inherits the embedder's CSP** on top of its own. The host page ships
 * `script-src 'self'` (see `src/renderer/index.html`), so today a slide's inline `<script>` — legal
 * under the contract, and required by `capabilities: ["interactive-js"]` — is blocked no matter what
 * this function injects. Static and CSS/SMIL-animated slides are unaffected. §7 of the architecture
 * anticipates this and specifies **blob URLs** as the delivery mechanism for exactly this reason: a
 * blob-loaded frame gets a fresh policy rather than an inherited one. `slideFrameSource` in
 * `SlideFrame.tsx` is the single seam that swap goes through; this policy is already the one the
 * blob path needs, so the migration is a delivery change and not a security change.
 */

/**
 * §7 layer 3, verbatim. `connect-src 'none'` is the load-bearing directive: a slide cannot phone
 * home, exfiltrate deck content, or pull remote code. `'unsafe-inline'` for script and style is
 * unavoidable — inline model-authored `<style>`/`<script>` *is* the format — but with
 * `default-src 'none'` and an opaque origin it buys an attacker nothing outside their own document.
 */
export const SLIDE_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  'img-src data: blob:',
  'font-src data:',
  'media-src data: blob:',
  "connect-src 'none'",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ')

const CSP_META = `<meta http-equiv="Content-Security-Policy" content="${SLIDE_CSP}">`

/**
 * Anchors are tried in order and the meta goes immediately *after* the first one that matches.
 *
 * The ordering is what keeps the document in standards mode: a meta prepended ahead of a
 * `<!doctype html>` would push Chromium into quirks mode, where the slide's box model no longer
 * matches the 1280x720 the contract measured. So `<head>` first (the contract guarantees one),
 * then `<html>`, then the doctype, and only a document with none of the three gets a prepend.
 */
const ANCHORS: readonly RegExp[] = [
  /<head(?:\s[^>]*)?>/i,
  /<html(?:\s[^>]*)?>/i,
  /<!doctype[^>]*>/i,
]

/** Inject the slide CSP into a complete slide document. Idempotent-safe, allocation-cheap. */
export function wrapSlideHtml(html: string): string {
  for (const anchor of ANCHORS) {
    const match = anchor.exec(html)
    if (match) {
      const at = match.index + match[0].length
      return `${html.slice(0, at)}\n${CSP_META}${html.slice(at)}`
    }
  }
  return `${CSP_META}\n${html}`
}
