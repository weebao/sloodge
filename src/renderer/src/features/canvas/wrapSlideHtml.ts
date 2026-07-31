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
 * ## This is *not* the only policy on the frame — today
 *
 * Slides are delivered as blob URLs (`useSlideUrl`), per §7. An earlier revision of this file
 * claimed that a blob-loaded frame therefore escapes the embedder's CSP. **That was measured and
 * is false**: `experiments/init/harness/csp-blob-inheritance.mjs` (Chromium, 2026-07-31) shows a
 * sandboxed blob frame's inline `<script>` blocked by the host page's `script-src 'self'`, exactly
 * like the `srcdoc` control. Local schemes — `about`, `blob`, `data` — inherit a clone of the
 * initiator's policy container, CSP list included.
 *
 * So a slide document is governed by the intersection of the host policy and this one, and this
 * one is currently the *stricter* of the two on everything that matters. Two consequences:
 *
 *  - An injection that misses does not currently open a hole — the inherited host policy still
 *    denies remote fetches. That is a safety net, not a design.
 *  - `slide://` delivery, which the roadmap tracks as an M2 prerequisite for interactive slides,
 *    removes the net: a non-local scheme escapes inheritance, so this becomes the only policy on
 *    the frame. **This injection has to be right before that lands, not after.**
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

/** The exact markup inserted, including its leading newline. Its length *is* the offset shift. */
export const SLIDE_CSP_INJECTION = `\n<meta http-equiv="Content-Security-Policy" content="${SLIDE_CSP}">`

/** A byte-order mark is only stripped by the parser when it is the very first thing in the stream. */
const BOM = '﻿'

/**
 * Where the injection goes: just past the doctype, or the front of the document.
 *
 * The scan covers exactly what HTML's "initial" insertion mode accepts *before* a doctype, which is
 * a closed and very short list: a BOM, whitespace, and comment tokens — where "comment token"
 * includes `<!-- … -->`, the abrupt `<!-->` / `<!--->` forms, and bogus declarations such as
 * `<!foo>`, all of which the tokenizer emits as comments. Anything else (a tag, text) means the
 * parser has already left "initial", so a doctype later in the document is a parse error it
 * discards — the document is already quirks and the front is the right place.
 *
 * The BOM is skipped rather than injected before: displacing it would stop it being a BOM and turn
 * it into a zero-width character in the rendered document.
 */
export function cspInjectionOffset(html: string): number {
  const start = html.startsWith(BOM) ? BOM.length : 0
  let index = start

  while (index < html.length) {
    const char = html[index]!

    if (/\s/.test(char)) {
      index += 1
      continue
    }

    if (html.startsWith('<!--', index)) {
      // Abrupt-closing forms are complete comments; searching for `-->` would run past them.
      if (html.startsWith('<!-->', index)) {
        index += 5
        continue
      }
      if (html.startsWith('<!--->', index)) {
        index += 6
        continue
      }
      const close = html.indexOf('-->', index + 4)
      if (close === -1) break // unterminated: nothing after it can be a doctype
      index = close + 3
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
 * corpus that found them is kept as the regression net — 22 probes in
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
