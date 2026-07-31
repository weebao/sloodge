/**
 * Layer 3 of the four-layer slide sandbox (§7 of 10-architecture.md): the slide document's *own*
 * Content-Security-Policy, injected ahead of all author markup so the policy governs every byte
 * the model wrote.
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
 * ## The safety net is gone as of M2.0
 *
 * Through M1.x slides were delivered as blob URLs, and a blob frame **inherits** the embedder's
 * CSP: `experiments/init/harness/csp-blob-inheritance.mjs` (Chromium, 2026-07-31) shows a sandboxed
 * blob frame's inline `<script>` blocked by the host page's `script-src 'self'`, exactly like the
 * `srcdoc` control. Local schemes — `about`, `blob`, `data` — inherit a clone of the initiator's
 * policy container, CSP list included. So an injection that missed still could not open a hole: the
 * inherited host policy denied remote fetches anyway. That was a safety net, not a design, and the
 * previous revision of this comment said so.
 *
 * M2.0 removes it. Slides are now served from `slide://` (`slideUrlFactory.ts`), a non-local scheme
 * that escapes policy-container inheritance — which is the entire point, because it is what lets a
 * slide's inline `<script>` run. **There is no longer a host policy underneath to catch a miss.**
 * What remains is this injection plus the identical `Content-Security-Policy` response header main
 * sends (`src/main/slide/slideResponse.ts`), and the header is the reason a missed injection is
 * survivable rather than fatal. Belt and braces, both load-bearing, neither sufficient alone.
 */

/**
 * §7 layer 3, verbatim. `connect-src 'none'` is the load-bearing directive: a slide cannot phone
 * home, exfiltrate deck content, or pull remote code. `'unsafe-inline'` for script and style is
 * unavoidable — inline model-authored `<style>`/`<script>` *is* the format — but with
 * `default-src 'none'` and an opaque origin it buys an attacker nothing outside their own document.
 *
 * The definition moved to `src/shared/slide-protocol.ts` in M2.0, because main now sends the same
 * policy as a response header on `slide://` and a lint rule forbids main from importing renderer
 * code. Re-exported here so that this module — where the policy is *injected* — remains the obvious
 * place to find it. The full rationale for `'unsafe-inline'` over a nonce lives with the definition.
 */
import { SLIDE_CSP } from '../../../../shared/slide-protocol'

export { SLIDE_CSP }

/**
 * The APIs the injected guard neutralizes: the ones that open a network socket **outside CSP's
 * reach**.
 *
 * CSP has no directive for WebRTC — `webrtc-src` was proposed and never shipped in Chromium — so a
 * running slide's `new RTCPeerConnection({iceServers:[{urls:'stun:attacker'}]})` reaches an
 * arbitrary host regardless of `connect-src 'none'`. Measured: five real STUN Binding Requests left
 * a `slide://` frame onto a loopback UDP socket. That falsifies the "a slide cannot phone home"
 * guarantee this milestone rests on, and M2.0 is what opened it — inline slide JS never ran before.
 *
 * `WebTransport` *is* nominally covered by `connect-src`, but it opens a UDP/QUIC socket and the
 * cost of neutralizing it alongside the RTC family is one array entry, so it is included rather than
 * trusted to a directive whose coverage of a socket primitive is worth not depending on.
 *
 * The IANA/WHATWG spelling variants (`webkit`/`moz` prefixes) are included because a slide runs in
 * Chromium today but the guard should not silently lapse if the engine ever exposes a prefixed
 * alias. `RTCDataChannel` cannot be constructed without a peer connection, so removing the
 * constructors is sufficient; it is listed for defence in depth and costs nothing.
 */
export const SLIDE_BLOCKED_SOCKET_APIS = [
  'RTCPeerConnection',
  'webkitRTCPeerConnection',
  'mozRTCPeerConnection',
  'RTCDataChannel',
  'WebTransport',
] as const

/**
 * The neutralizing bootstrap, injected ahead of every slide's own script.
 *
 * It defines each blocked global as a **non-configurable, non-writable `undefined`**, so
 * `new RTCPeerConnection()` throws "not a constructor", `if (window.RTCPeerConnection)` reads false
 * (a legitimate feature-detect degrades rather than crashes), and neither `delete` nor reassignment
 * can bring it back. The usual escape — resurrecting the constructor from a fresh `about:blank`
 * child frame's `contentWindow` — fails in this sandbox for two independent reasons already in
 * place: `frame-src 'none'` forbids the child frame, and the slide's opaque origin means any frame
 * it did create would get its own opaque origin and throw `SecurityError` on cross-frame access.
 * `default-src 'none'` closes the Worker variant the same way. Verified end-to-end (packet count
 * zero with the guard, non-zero with it reverted) by `experiments/init/harness/slide-protocol-smoke.mjs`.
 *
 * Applied to **every** slide, not gated on `capabilities: ["interactive-js"]`. The gate lives in
 * the validator (SL-H01 rejects an undeclared `<script>`), but delivery must not depend on the
 * validator having run — a slide that declares `static` and ships a script anyway still gets the
 * guard. The cost to a script-free slide is one inert IIFE.
 *
 * It runs before author script because it is part of the prefix inserted at the doctype offset:
 * the parser places it, like the meta, as an early child of the implied `<head>`, and scripts
 * execute in document order. `script-src 'unsafe-inline'` (declared by the meta just before it)
 * permits it.
 */
export const SLIDE_RUNTIME_GUARD =
  '<script>(function(){var a=' +
  JSON.stringify(SLIDE_BLOCKED_SOCKET_APIS) +
  ';for(var i=0;i<a.length;i++){try{Object.defineProperty(window,a[i],{configurable:false,writable:false,value:undefined})}catch(e){}}})();</script>'

/**
 * The exact markup inserted, including its leading newline. Its length *is* the offset shift, and it
 * is a compile-time constant — the meta (layer 3) followed by the socket-API guard — so the
 * insertion stays a single fixed-length prefix and Design Mode's byte-span map keeps working by
 * adding one constant. The meta comes first so its `script-src 'unsafe-inline'` governs the guard.
 */
export const SLIDE_CSP_INJECTION = `\n<meta http-equiv="Content-Security-Policy" content="${SLIDE_CSP}">${SLIDE_RUNTIME_GUARD}`

/** A byte-order mark is only stripped by the parser when it is the very first thing in the stream. */
const BOM = '﻿'

/**
 * HTML whitespace: TAB, LF, FF, CR, SPACE. Exactly five characters, and **not** JavaScript's `\s`.
 *
 * `\s` also matches U+000B VERTICAL TAB, U+00A0 NO-BREAK SPACE, U+1680, U+2000-U+200A, U+2028,
 * U+2029, U+202F, U+205F, U+3000 and U+FEFF. None of those is HTML whitespace: the tokenizer emits
 * each as an ordinary character token, which in "initial" is "anything else" — set the quirks flag,
 * switch to "before html", reprocess. A doctype after one of them is therefore *discarded*, and a
 * scan that skipped it as whitespace would inject past a doctype that no longer exists, putting the
 * meta inside `<body>` where CSP pragma processing drops the policy entirely.
 *
 * That is the r1-r5 policy-drop class reappearing through a JS-native shorthand that did not match
 * the spec set the docstring cited. The correct handling is to stop: these characters are content,
 * so the injection belongs in front of them.
 */
const HTML_WHITESPACE = new Set(['\t', '\n', '\f', '\r', ' '])

/**
 * Offset just past a comment's closing delimiter, or `null` if it never closes.
 *
 * HTML closes a comment on `-->` **or** `--!>` (the comment-end-bang state), whichever comes first.
 * Only recognising `-->` makes `<!-- c --!><!doctype html>` look unterminated, so the scan bails to
 * the front and injects ahead of a doctype the parser honours — a silent quirks-mode flip.
 */
function commentEnd(html: string, from: number): number | null {
  const plain = html.indexOf('-->', from)
  const bang = html.indexOf('--!>', from)
  if (plain === -1 && bang === -1) return null
  if (bang === -1 || (plain !== -1 && plain < bang)) return plain + 3
  return bang + 4
}

/**
 * Where the injection goes: just past the doctype, or the front of the document.
 *
 * ## The closed set of tokens that may precede a doctype
 *
 * "Initial" ignores exactly three kinds of token — whitespace characters, comments, and nothing
 * else — and processes a DOCTYPE. Anything else is "anything else": quirks mode, reprocess in
 * "before html". So the scan has to step over precisely the source forms that tokenize to
 * whitespace or to a comment, and stop at everything else. From the tokenizer's tag-open,
 * markup-declaration-open, end-tag-open and bogus-comment states, that set is closed and complete:
 *
 *  1. **HTML whitespace** — TAB, LF, FF, CR, SPACE, and *only* those five. See `HTML_WHITESPACE`:
 *     JavaScript's `\s` is a strictly larger set, and every extra character in it is content that
 *     takes the parser out of "initial".
 *  2. `<!-- … -->` — a comment. Closed by `-->` **or** `--!>` (the comment-end-bang state),
 *     whichever comes first; and including the abrupt-closing `<!-->` and `<!--->` forms, which are
 *     complete comments with no closer to search for.
 *  3. `<!` + anything that is not `--` and not `DOCTYPE` — *markup declaration open* falls through
 *     to **bogus comment**, e.g. `<!foo>`, `<![CDATA[…]]>` outside foreign content. Ends at `>`.
 *  4. `<?` … `>` — *tag open* sees `?`, which is a parse error
 *     (`unexpected-question-mark-instead-of-tag-name`) reconsumed as a **bogus comment**. This is
 *     why an XML declaration is a comment in HTML, not a processing instruction.
 *  5. `</` + a character that is not ASCII alpha and not `>` — *end tag open* reports
 *     `invalid-first-character-of-tag-name` and reconsumes as a **bogus comment**, e.g. `</ x>`,
 *     `</1>`. Ends at `>`.
 *  6. `</>` — *end tag open* sees `>`, reports `missing-end-tag-name`, and emits **nothing at all**.
 *     Three characters, no token, parser still in "initial".
 *  7. The **DOCTYPE** itself, which ends the scan.
 *
 * Everything else — a real start or end tag, a bare `<` (character data), any non-whitespace text —
 * takes the parser out of "initial", which means a doctype later in the document is a parse error it
 * discards. The document is already quirks at that point, so the front is the right place and
 * injecting there changes nothing.
 *
 * Forms 4-6, and the `--!>` comment closer, were each missed by an earlier version of this scan: the
 * injection landed ahead of a doctype the parser would have honoured, silently dropping the document
 * into quirks mode, where the slide's box model stops matching the 1280x720 the format contract
 * measured. Each is pinned by a unit test and by a Chromium probe.
 *
 * **The primitives have to match the citation.** This list is only worth having if the code
 * implements the sets it names — the whitespace rule cited HTML's five characters while the code
 * tested JavaScript's `\s`, and that gap was a full policy drop (a doctype after a U+00A0 is
 * discarded, so injecting past it put the meta in `<body>`). Where a spec set is named here, the
 * implementation uses an explicit set or an ASCII-restricted pattern, never a JS-native shorthand
 * that happens to look similar.
 *
 * The BOM is skipped rather than injected before: displacing it would stop it being a BOM and turn
 * it into a zero-width character in the rendered document.
 */
export function cspInjectionOffset(html: string): number {
  const start = html.startsWith(BOM) ? BOM.length : 0
  let index = start

  while (index < html.length) {
    const char = html[index]!

    if (HTML_WHITESPACE.has(char)) {
      index += 1
      continue
    }

    if (html.startsWith('<!--', index)) {
      // Abrupt-closing forms are complete comments; searching for a closer would run past them.
      if (html.startsWith('<!-->', index)) {
        index += 5
        continue
      }
      if (html.startsWith('<!--->', index)) {
        index += 6
        continue
      }
      const close = commentEnd(html, index + 4)
      if (close === null) break // unterminated: nothing after it can be a doctype
      index = close
      continue
    }

    if (html.startsWith('<!', index)) {
      // The tokenizer ends a doctype at the first `>` even inside a quoted identifier (a parse
      // error there), so a plain search matches it. A bogus `<!foo>` comment ends the same way.
      const close = html.indexOf('>', index)
      if (close === -1) break
      if (/^<!doctype/i.test(html.slice(index, index + 9))) return close + 1
      index = close + 1
      continue
    }

    // `</>` emits no token whatsoever (missing-end-tag-name), so it is simply three characters.
    if (html.startsWith('</>', index)) {
      index += 3
      continue
    }

    // Forms 4 and 5: `<?…>` and `</` + a non-alpha, both reconsumed as bogus comments ending at `>`.
    // `</` at EOF is *not* one of these — the tokenizer emits it as character data, which leaves
    // "initial" — and correctly falls through to the break below.
    if (html.startsWith('<?', index) || /^<\/[^a-zA-Z>]/.test(html.slice(index, index + 3))) {
      const close = html.indexOf('>', index)
      if (close === -1) break
      index = close + 1
      continue
    }

    break
  }

  return start
}

/**
 * Inject the slide CSP into a slide document.
 *
 * ## The contract
 *
 * This is a **constant-length prefix insertion at a computed offset**. `SLIDE_CSP_INJECTION` goes
 * immediately after the document's doctype (or at the front when there is none) and nothing else
 * changes:
 *
 *  - every author byte before the offset keeps its position,
 *  - every author byte after it shifts by exactly `SLIDE_CSP_INJECTION.length`,
 *  - no author byte is rewritten, reordered or re-serialized.
 *
 * That is the whole guarantee, and it is what keeps Design Mode's byte-span patcher valid: a span
 * into the *file* maps into the *rendered document* by adding one known constant.
 *
 * ## Why the doctype is the right place, and why that is enough
 *
 * A meta here is parsed in the "before html" / "before head" insertion modes, where the tree builder
 * creates the implied `<html>` and `<head>` and inserts the meta *into that head* — and the author's
 * own `<head>`, wherever it appears, merges into the same element. So the policy is a head child for
 * every input, including documents whose `<head>` is missing, late, or discarded as a parse error.
 *
 * This replaced ~200 lines that walked the markup looking for a literal `<head>` to inject after.
 * Five consecutive review rounds each found one more input where that walk anchored somewhere the
 * tree builder did not honour — a `<head>` inside a comment, a script string, an attribute value,
 * RCDATA, `<noframes>`, a `<template>`; a `<head>` after text or a `<div>` had implicitly opened the
 * body; a `<head>` after `</br>` or `</html>` — and every miss silently dropped the whole policy.
 * All of them are handled by construction now, because nothing looks for `<head>` any more. The walk
 * was never load-bearing for correctness: it only made the meta land *inside* the author's literal
 * head rather than just before it. It was cosmetics, and all five defects lived in it. The Chromium
 * corpus that found them is kept as the regression net — 32 probes in
 * `experiments/init/harness/csp-meta-placement.mjs`, each asserting the policy is a head child, that
 * it is actually enforced, and that compat mode is unchanged.
 *
 * ## Standards mode
 *
 * The one thing this must not do is displace the doctype: a doctype that is no longer first puts
 * Chromium in quirks mode, where the slide's box model stops matching the 1280x720 the contract
 * measured. Hence "after the doctype", and hence the prologue scan. A document with *no* doctype is
 * already quirks before this function touches it — injecting at the front neither causes nor repairs
 * that. Repairing it belongs to the linter (SL-G* of 30-slide-format.md): silently inserting a
 * doctype would change how an author's document lays out, which is not this function's business.
 */
export function wrapSlideHtml(html: string): string {
  const at = cspInjectionOffset(html)
  return `${html.slice(0, at)}${SLIDE_CSP_INJECTION}${html.slice(at)}`
}
