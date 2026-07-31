/**
 * The `slide://` scheme: names, limits and validators shared by all three build targets.
 *
 * ## Why a custom scheme exists at all
 *
 * Slide documents are delivered to their iframe over a scheme the main process serves, rather than
 * as a `blob:` URL, for exactly one reason: **`blob:` inherits the embedder's CSP and a custom
 * scheme does not.** Measured in Chromium on 2026-07-31
 * (`experiments/init/harness/csp-blob-inheritance.mjs`): with the host page carrying
 * `script-src 'self'`, a `sandbox="allow-scripts"` frame pointed at a `text/html` blob URL has its
 * inline `<script>` blocked — *"Executing inline script violates the following Content Security
 * Policy directive 'script-src 'self''"* — identically to a `srcdoc` control. HTML's *determine
 * navigation params policy container* step is why: a navigation whose response URL uses a **local
 * scheme** (Fetch defines those as exactly `about`, `blob` and `data`) inherits a clone of the
 * initiator's policy container, CSP list included.
 *
 * `slide:` is not in that set, so a slide document served from it gets its own policy container and
 * the policy that governs it is the one *we* send — the `Content-Security-Policy` response header
 * plus `wrapSlideHtml`'s injected `<meta>`. That is what unblocks the slide contract's
 * `interactive-js` capability (§3.2 SL-I* of 30-slide-format.md), and it is the whole point of M2.0.
 *
 * It also **removes a safety net**. Until now the inherited host policy was a second, stricter
 * opinion on every slide; a bug in the CSP injection could not open a hole because the host policy
 * still denied remote fetches. From here the slide's own policy is the only policy, so it is sent
 * twice — as a response header *and* as the injected meta — and neither is decorative.
 *
 * ## Identifiers are opaque, and that is a security property
 *
 * A slide is addressed by a 128-bit random id and by nothing else. There is no filesystem path
 * anywhere in the scheme, so there is no path-traversal surface to get wrong: the handler cannot be
 * talked into reading `/etc/passwd` because it never reads anything, it looks up a `Map`. Ids come
 * from a CSPRNG rather than a counter or a ULID so that one slide cannot guess another's URL —
 * relevant because every slide is an opaque origin that can still *navigate*, and `slide://<id>/`
 * would otherwise be a readable address for a sibling's document.
 */

/** The scheme, without its colon — the form `protocol.handle` and `registerSchemesAsPrivileged` take. */
export const SLIDE_SCHEME = 'slide'

/**
 * The slide document's Content-Security-Policy — §7 layer 3 of 10-architecture.md, verbatim.
 *
 * It lives here rather than next to `wrapSlideHtml` because it is now sent from **two** places in
 * two different build targets: the main process puts it on the `slide://` response as a header, and
 * the renderer injects it as a `<meta>` into the document body. Those must be the same string; a
 * lint rule forbids main from importing renderer code, so a single shared constant is the only way
 * to make "the same string" a fact rather than a convention.
 *
 * ## `script-src 'unsafe-inline'`, deliberately, and not a nonce
 *
 * A nonce is the textbook answer and it is the wrong one here. The slide contract (§3.2 SL-I* of
 * 30-slide-format.md) specifies model-authored slides carrying *"a single `<script>` as the last
 * element of `<body>`"*, written by a model that has no way to know a nonce we mint at delivery
 * time. Making a nonce work would mean rewriting author markup to stamp `nonce="…"` onto every
 * script tag — which breaks `wrapSlideHtml`'s contract that delivery is a **constant-length prefix
 * insertion and nothing else**, the property Design Mode's byte-span patcher (§3.3) is built on. It
 * would also require parsing semi-untrusted HTML in order to find the script tags, replacing a
 * problem we have with a class of problem (parser differentials) we do not.
 *
 * And it would buy nothing. A nonce defends against *injected* script in a document whose author
 * you trust. Here the author is the untrusted party: every byte of the document is model-generated,
 * so script the model wrote and script an attacker smuggled into the model's output are the same
 * bytes and a nonce cannot tell them apart. The containment that actually matters is elsewhere —
 * `default-src 'none'` plus `connect-src 'none'` (the slide cannot phone home, exfiltrate the deck,
 * or pull remote code) and the opaque origin from `sandbox="allow-scripts"` with no
 * `allow-same-origin` (the slide cannot reach the app). Inside those two walls, running arbitrary
 * inline script is the feature, not the vulnerability.
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

/**
 * Ceiling on a single published slide document, in UTF-8 bytes.
 *
 * Deliberately the same number as the document model's per-member ceiling
 * (`DEFAULT_ARCHIVE_LIMITS.maxEntryBytes` in `src/main/document/store.ts`), because it is a ceiling
 * on the same object: a slide's HTML is one `slides/<id>.html` member of the deck archive. A
 * document that would be refused on open must not become publishable by way of the renderer. A unit
 * test pins the two numbers together so neither can drift alone.
 */
export const MAX_SLIDE_HTML_BYTES = 64 * 1024 * 1024

/** 16 bytes = 128 bits of entropy, rendered as 32 lowercase hex characters. */
export const SLIDE_DOCUMENT_ID_BYTES = 16
export const SLIDE_DOCUMENT_ID_LENGTH = SLIDE_DOCUMENT_ID_BYTES * 2

const SLIDE_DOCUMENT_ID_PATTERN = new RegExp(`^[0-9a-f]{${String(SLIDE_DOCUMENT_ID_LENGTH)}}$`)

/**
 * A fresh document id from the platform CSPRNG.
 *
 * Hex rather than base64url because the id is a URL **host** (see `slideDocumentUrl`), and the two
 * URL parsers this value passes through disagree about host case. Chromium canonicalizes the host —
 * lowercasing it — for a registered `standard:` scheme, which is what `protocol.handle` receives.
 * Node's WHATWG `URL`, which main and the tests also use, treats `slide:` as a *non-special* scheme
 * and so runs the opaque-host parser, which preserves case: `new URL('slide://ABC/').hostname` is
 * `'ABC'` on Node 24. A lowercase-only alphabet sidesteps the disagreement entirely rather than
 * requiring every call site to know which parser it is talking to. Hex is 4 bits per character
 * against base64url's 6, which costs 32 characters instead of 22 and buys a validator that is a
 * character-class regexp with no normalization step in front of it.
 *
 * `globalThis.crypto` rather than `node:crypto` so this stays importable from every build target —
 * `src/shared` may not depend on anything, and the Web Crypto API is present in Node 24, in the
 * renderer, and in a sandboxed preload alike.
 */
export function createSlideDocumentId(): string {
  const bytes = new Uint8Array(SLIDE_DOCUMENT_ID_BYTES)
  globalThis.crypto.getRandomValues(bytes)

  let out = ''
  for (const byte of bytes) {
    out += byte.toString(16).padStart(2, '0')
  }
  return out
}

/** Whether an untyped value is a well-formed slide document id. */
export function isSlideDocumentId(value: unknown): value is string {
  return typeof value === 'string' && SLIDE_DOCUMENT_ID_PATTERN.test(value)
}

/**
 * The cheap, allocation-free screen on publishable HTML, run in the preload before anything crosses
 * the bridge.
 *
 * It compares `String.length` — UTF-16 code units — against a limit expressed in UTF-8 **bytes**,
 * which is deliberately conservative in the safe direction: UTF-8 encodes every code point in at
 * least as many bytes as UTF-16 does code units, so `length > MAX` proves `byteLength > MAX` and
 * the rejection is sound. The converse does not hold, which is why this is a screen and not the
 * check: main re-measures the real byte length with `Buffer.byteLength`, which is exact and, unlike
 * `TextEncoder.encode(...).byteLength`, does not allocate a 64 MB copy of the string to count it.
 * The preload cannot do that — a sandboxed preload has no `Buffer` — hence the split.
 *
 * `limit` is injectable purely so the boundary is testable: asserting the real 64 MB edge would
 * mean allocating a 64 Mi-character string (128 MB in UTF-16) inside the unit suite, and a test
 * that instead passes a non-string to get a `false` proves only the type check.
 */
export function isPublishableSlideHtml(
  value: unknown,
  limit: number = MAX_SLIDE_HTML_BYTES,
): value is string {
  return typeof value === 'string' && value.length <= limit
}

/**
 * The URL a published slide is served from.
 *
 * The id is the **host**, not a path segment, so every slide document gets a distinct
 * `slide://<id>` origin. The frame is an opaque origin regardless (no `allow-same-origin`), so this
 * is belt-and-braces rather than the boundary — but it means that if the sandbox attribute is ever
 * lost, two slides still cannot script each other, and it keeps the path component constant so the
 * handler has exactly one legal path to accept.
 *
 * The belt turns out to matter more than expected. Measured in the real app
 * (`experiments/init/harness/slide-protocol-smoke.mjs`), a sandboxed `slide://` frame reports
 * `location.origin` as `slide://<id>` rather than `"null"`: Chromium derives that string from the
 * URL for a `standard:` custom scheme even when the document's security origin is opaque. The
 * document *is* opaque — in the same run `localStorage` throws `SecurityError` and every reach into
 * `parent` fails — so the string is cosmetic. But it is exactly the kind of cosmetic detail a
 * future change could start trusting, and putting the id in the host means that even a reader who
 * trusts it reaches the right conclusion.
 */
export function slideDocumentUrl(id: string): string {
  return `${SLIDE_SCHEME}://${id}/`
}

/** The only path the handler serves. Anything else is a 404. */
export const SLIDE_DOCUMENT_PATH = '/'

/**
 * The id inside a `slide://` URL, or `null` if this is not one.
 *
 * Used by the renderer's revoke path, which is handed back the URL it was given rather than the id
 * it never saw. Parsing rather than string-slicing because the value has round-tripped through the
 * DOM (an iframe `src` attribute) and a check-then-use across two different parsers is how
 * allow-lists leak — the same reasoning as `toSafeExternalUrl` in `src/main/security/externalUrls.ts`.
 */
export function slideDocumentIdFromUrl(url: string): string | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.protocol !== `${SLIDE_SCHEME}:`) return null
  return isSlideDocumentId(parsed.hostname) ? parsed.hostname : null
}
