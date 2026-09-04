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
 * `default-src 'none'` plus `connect-src 'none'` deny the network reads CSP *does* govern (fetch,
 * XHR, WebSocket, EventSource, beacon, subresources), and the opaque origin from
 * `sandbox="allow-scripts"` with no `allow-same-origin` keeps the slide out of the app. Inside those
 * walls, running arbitrary inline script is the feature, not the vulnerability.
 *
 * ## What CSP does *not* cover — WebRTC
 *
 * "The slide cannot phone home" is **not** something this policy delivers on its own, and an earlier
 * version of this comment overclaimed it. No CSP directive governs WebRTC (`webrtc-src` was never
 * shipped), so `connect-src 'none'` does nothing to a `new RTCPeerConnection({iceServers:[…]})` —
 * measured, real STUN packets left a running slide to an arbitrary host. That channel is closed
 * instead by the socket-API guard in `wrapSlideHtml`'s injected bootstrap (`SLIDE_RUNTIME_GUARD`),
 * which removes the RTC constructors (and `WebTransport`) before author script runs. The "no network"
 * guarantee is therefore CSP **plus** that guard, not CSP alone.
 *
 * ## What `bypassCSP`/`supportFetchAPI` do *not* do
 *
 * The scheme is registered with both `false` (see `protocol.ts`), which is correct hygiene, but they
 * are defence in depth, not the operative mechanism — flipping both to `true` was measured to leave
 * containment intact, because a slide document's outbound requests are governed by the slide's *own*
 * policy regardless of how its scheme is registered. `bypassCSP` governs whether *other* pages may
 * load `slide://` resources despite their CSP; `supportFetchAPI` governs whether the scheme answers
 * `fetch`, but `connect-src 'none'` already blocks a slide from fetching a sibling. The real
 * boundaries are this policy, the guard above, and the opaque origin.
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
 * Hex rather than base64url so the validator is a character-class regexp with no normalization in
 * front of it, and lowercase so the value survives both URL parsers it passes through unchanged —
 * it is a path segment everywhere and, on the stage, part of the **host** as well, where Chromium
 * lower-cases and Node does not. Hex is 4 bits per character against base64url's 6, which costs 32
 * characters instead of 22.
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
 * Which *surface* a slide document is delivered to. The surface decides the URL's host, and the
 * host decides the renderer process — see `slideDocumentHost`.
 */
export type SlideSurface = 'stage' | 'thumbnails'

/**
 * The host every rail miniature is served from. Stage documents have no shared host; theirs is
 * derived from the id (`stage-<id>`), one per document.
 */
export const SLIDE_THUMBNAIL_HOST = 'thumbnails'
const SLIDE_STAGE_HOST_PREFIX = 'stage-'

/**
 * The host a document is served from: `stage-<id>` for the stage, `thumbnails` for the rail.
 *
 * ## The host is a process group (M8.2)
 *
 * Through M8.1 the id was the host (`slide://<id>/`), so every slide document was its own origin.
 * That was described as belt-and-braces — the frame is opaque-origin regardless — but it had a cost
 * nobody had measured: Chromium's process model keys on a URL's **site**, and for a sandboxed frame
 * the site is that of its precursor URL, so a hundred distinct hosts meant a hundred sandboxed
 * renderer processes. Measured in M8.1: 105 processes and 1.7 GB PSS for a 100-slide deck, and the
 * 500-slide deck could not be opened at all.
 *
 * The other extreme was measured too and rejected. With *one* host for everything (`perf:run`,
 * 100 slides, quiet machine) the process count fell to 5 and PSS to 583 MB, but a cold slide switch
 * went from a 54 ms median to 360 ms with a 1.7 s p95: the canvas frame, its two pre-warmed
 * neighbours and every visible thumbnail — a dozen animating documents — were sharing one main
 * thread, and a new slide's parse queued behind all of them.
 *
 * So the host names the process group the document should land in, and the two surfaces need
 * different groupings:
 *
 * - **Stage** (the canvas, Present, export): one host — and so one process — **per document**.
 *   The stage holds at most three documents (the active slide and its ±1 neighbours), so this is
 *   three processes, not a hundred; and it is what keeps a runaway neighbour from stalling the
 *   slide the user is looking at. Measured with all stage documents on one shared host: a hidden
 *   neighbour running `while (true) {}` froze the active slide's script for the whole observation
 *   window, in the editor and in Present (where slide N+1 is pre-warmed behind slide N), and the
 *   only recovery was Chromium discarding the process when a far slide was selected. That is the
 *   "a hung slide must not freeze the talk" case the roadmap's M4.7 exists for, and it must not be
 *   introduced by a perf change. `pnpm perf:isolation` runs that exact scenario and asserts the
 *   active slide's heartbeat continues.
 * - **Thumbnails** (the rail): one shared host for every miniature. A rail of a dozen animating
 *   miniatures in one process is one process instead of a dozen, and their work can never delay
 *   the slide the user just clicked. What is accepted here is that a runaway *thumbnail* freezes
 *   the other miniatures while its card is in view — a frozen rail is tolerable where a frozen
 *   active slide is not. When M8.3 replaces live miniatures with cached bitmaps this process simply
 *   stops existing; nothing here needs to change.
 *
 * ## What the host never protected
 *
 * Nothing that keeps slides apart lives in the host. The frame is `sandbox="allow-scripts"` with no
 * `allow-same-origin`, so each document is an *opaque* origin — distinct from the app, from every
 * sibling, and from itself on reload — whatever its URL; that is what denies `parent.document`,
 * `localStorage` and a sibling's DOM. The per-document CSP is a per-**response** header from the
 * handler plus the injected `<meta>`, not a per-origin setting. The bridge validates messages by
 * `event.source` identity, not by origin. All of it is exercised in the real app, for these hosts, by
 * `pnpm perf:isolation` (`perf/cli/isolation-probe.ts`), which runs those reaches from inside running
 * slides and reports each one denied.
 *
 * What the unique host *did* buy on the thumbnails surface, stated rather than dropped silently:
 * had the `sandbox` attribute ever been lost, unique hosts would still have kept two miniatures from
 * scripting each other, whereas now two miniatures would be same-origin. The attribute is pinned by
 * `slide-frame.test.tsx` and by a repo-wide grep test, and `frame-src 'none'` on every slide means
 * no slide can frame a sibling to try. Slide-to-app isolation is unchanged: the app document is on a
 * different site and keeps its own process.
 *
 * ## The residual: a slide can move itself between surfaces
 *
 * The handler serves a registered id on either surface's host, so a slide can navigate itself from
 * `slide://stage-<id>/<id>/` to `slide://thumbnails/<id>/` or back. Nothing confidential changes —
 * it is the same document in the same opaque-origin frame — and the availability consequence is
 * small and stated: a stage document that moves to the thumbnails host can stall the rail, which
 * any thumbnail can already do; a thumbnail that moves to `stage-<its own id>` gets a process of
 * its own (~25 MB) and can stall nothing but itself. It cannot join the active slide's process,
 * because that host carries the active slide's 128-bit id, which it does not have.
 *
 * `location.origin` inside a stage slide reads `slide://stage-<its own id>` — a value the slide
 * already knows from `location.href`, and one nothing in the app trusts: the bridge authenticates
 * by `event.source`, never by origin (`frameScript.ts`, `useDesignBridge.ts`).
 */
export function slideDocumentHost(id: string, surface: SlideSurface): string {
  return surface === 'stage' ? `${SLIDE_STAGE_HOST_PREFIX}${id}` : SLIDE_THUMBNAIL_HOST
}

/** The URL a published slide is served from: `slide://<host>/<id>/`, the id as the only path segment. */
export function slideDocumentUrl(id: string, surface: SlideSurface = 'stage'): string {
  return `${SLIDE_SCHEME}://${slideDocumentHost(id, surface)}/${id}/`
}

/** The only path shape the handler serves: `/<id>/`, nothing more and nothing less. */
const SLIDE_DOCUMENT_PATH_PATTERN = new RegExp(
  `^/([0-9a-f]{${String(SLIDE_DOCUMENT_ID_LENGTH)}})/$`,
)

/**
 * The id inside an already-parsed `slide://` URL, or `null` if this is not one of ours — wrong
 * scheme, any path other than exactly `/<id>/`, or a host that is neither `thumbnails` nor the
 * stage host *for that id*. A stage URL therefore names its document twice and the two must agree;
 * `slide://stage-<a>/<b>/` is a 404, not document `b` in `a`'s process.
 *
 * Shared by the handler (`resolveSlideRequest`) and the renderer's revoke path so that what main
 * *accepts* and what the renderer *emits* are one definition. The pathname is matched after the
 * URL parser has normalized it, never as a raw string: `slide://thumbnails/<id>/x/../` is the same
 * resource as `slide://thumbnails/<id>/` and must be answered the same way, and a check-then-use
 * across two parsers is how allow-lists leak (the same reasoning as `toSafeExternalUrl` in
 * `src/main/security/externalUrls.ts`).
 */
export function slideDocumentIdFromParsedUrl(url: URL): string | null {
  if (url.protocol !== `${SLIDE_SCHEME}:`) return null
  const id = SLIDE_DOCUMENT_PATH_PATTERN.exec(url.pathname)?.[1]
  if (id === undefined) return null
  const host = url.hostname
  return host === SLIDE_THUMBNAIL_HOST || host === slideDocumentHost(id, 'stage') ? id : null
}

/**
 * The id inside a `slide://` URL string, or `null` if this is not one.
 *
 * Used by the renderer's revoke path, which is handed back the URL it was given rather than the id
 * it never saw, after that value has round-tripped through the DOM as an iframe `src`.
 */
export function slideDocumentIdFromUrl(url: string): string | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  return slideDocumentIdFromParsedUrl(parsed)
}
