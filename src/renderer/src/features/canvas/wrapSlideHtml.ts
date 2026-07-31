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
 *  - An anchor that misses (see below) does not currently open a hole — the inherited host policy
 *    still denies remote fetches. That is a safety net, not a design.
 *  - `slide://` delivery, which the roadmap tracks as an M2 prerequisite for interactive slides,
 *    removes the net: a non-local scheme escapes inheritance, so this becomes the only policy on
 *    the frame. **The walk below has to be right before that lands, not after.**
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
 * Where the meta goes: immediately after `<head>` if there is one, else after `<html>`, else after
 * the doctype, else at the very front.
 *
 * That ordering is what keeps the document in standards mode — a meta prepended ahead of
 * `<!doctype html>` pushes Chromium into quirks mode, where the slide's box model no longer matches
 * the 1280x720 the contract measured.
 *
 * ## Why this is a scanner and not a regex
 *
 * A regex for `<head>` matches the first *textual* occurrence, which need not be a tag at all. For
 * model-authored HTML — and models emit comments freely — `<!-- <head> is below --> <head>…` puts
 * the anchor inside the comment, so the entire injected meta is swallowed by `<!-- … -->` and the
 * slide runs with **no layer-3 policy**, silently: the document still renders, nothing logs. The
 * same happens for `<script>var s = "<head>"</script>` and for an attribute value such as
 * `<html data-note="<head>">`.
 *
 * Today the inherited host policy (see above) still denies the fetch a swallowed policy would
 * permit, so a missed anchor is not currently exploitable. Under `slide://` delivery it would be —
 * this is the policy that carries `connect-src 'none'`, i.e. the only thing standing between a
 * hostile slide and exfiltrating the deck.
 *
 * So the anchor is located by walking the markup: comments (including the abrupt `<!-->` forms),
 * quoted attribute values, and the interiors of every element whose content model is text rather
 * than markup — RAWTEXT, RCDATA, script data including the double-escaped state, and `plaintext`.
 * It yields a byte *offset* and the caller slices the original string at it — author bytes are
 * never rewritten, which is what keeps Design Mode's byte-span patcher (§3.3 of 30-slide-format.md)
 * valid.
 *
 * ## Tag position is not enough: the implied body
 *
 * Finding a real `<head>` *tag* is necessary but not sufficient, because the tree builder may
 * discard it. Non-whitespace text, or any start tag that is not head content, closes the implied
 * head and opens the body; a `<head>` token after that is a parse error and is dropped. A meta
 * injected there is a child of `<body>`, and HTML's CSP pragma processing returns early for a meta
 * whose parent is not the head — so the policy is dropped in full, silently. Measured, not
 * reasoned: for `<!doctype html><html>hello<head>`, Chromium's `--dump-dom` showed an *empty*
 * `<head>` with the meta in the body, and an enforcement probe under `script-src 'none'` let the
 * inline script run. So the walk tracks whether the body has been implied, and stops seeking a
 * literal `<head>` once it has. See `experiments/init/harness/csp-meta-placement.mjs`.
 *
 * ## Fail-safe for *unrecognised* states — not unconditionally
 *
 * This is a hand-rolled tokenizer, and hand-rolled tokenizers diverge from the spec at the edges.
 * The bound is that every state it does not recognise sends it to the `<html>`/doctype fallback or
 * to a prepend, all three of which sit in "before head", where the parser hoists the meta into the
 * implied `<head>` — verified in Chromium for every probe input, including the fallbacks.
 *
 * That is a statement about *unknown* states only. An earlier revision of this comment claimed the
 * walk "cannot fail to inject" the policy, full stop; the implied-body case above is precisely a
 * state it recognised and got wrong, and there the policy landed nowhere the document honoured.
 * The guarantee is: unknown input degrades to a worse-looking but correct placement. A *wrong*
 * rule still produces a wrong answer, so each rule is pinned by a mutation-verified test.
 */

/**
 * End offset (exclusive) of the tag that starts at `from`, honouring quoted attribute values —
 * `<html data-note="a>b">` ends at the second `>`, not the first.
 *
 * `null` for an unterminated tag. A truncated document must not yield an anchor *inside* an open
 * tag, where the injected meta would be parsed as a pile of stray attributes rather than a policy.
 */
function tagEnd(html: string, from: number): number | null {
  let quote = ''
  for (let index = from; index < html.length; index += 1) {
    const char = html[index]!
    if (quote !== '') {
      if (char === quote) quote = ''
    } else if (char === '"' || char === "'") {
      quote = char
    } else if (char === '>') {
      return index + 1
    }
  }
  return null
}

const TAG_START = /^<(\/?)([a-zA-Z][^\s/>]*)/

/**
 * Elements whose content the HTML tokenizer treats as text rather than markup — RAWTEXT
 * (`style`, `noscript` with scripting enabled, `xmp`, `iframe`), RCDATA (`title`, `textarea`),
 * script data (`script`), and `plaintext`, which swallows the rest of the document.
 *
 * A `<head>` inside any of them is character data, so anchoring there injects the policy into a
 * text node where it does nothing. `noscript` is on the list precisely because slide frames are
 * `allow-scripts`: with scripting enabled its content is raw text, which is the parse a decoy
 * would be written against.
 *
 * Skipping these is a no-op for a well-formed slide — a real `<head>` always precedes all of them.
 */
const TEXT_CONTENT_ELEMENTS = new Set([
  'script',
  'style',
  'title',
  'textarea',
  'noscript',
  'iframe',
  'xmp',
  'plaintext',
])

/**
 * Elements the parser accepts while the implied `<head>` is still open (HTML's "in head" insertion
 * mode), plus `html`/`head` themselves. A start tag outside this set closes the implied head and
 * opens the body — after which a literal `<head>` token is a parse error and is discarded, so it
 * must stop being treated as an anchor.
 */
const HEAD_CONTENT_ELEMENTS = new Set([
  'html',
  'head',
  'base',
  'basefont',
  'bgsound',
  'link',
  'meta',
  'noframes',
  'noscript',
  'script',
  'style',
  'template',
  'title',
])

/** Start and end offsets of the next `</name …>` end tag at or after `from`. */
function findEndTag(
  html: string,
  name: string,
  from: number,
): { start: number; end: number } | null {
  const pattern = new RegExp(`</${name}(?=[\\s/>])`, 'gi')
  pattern.lastIndex = from
  const match = pattern.exec(html)
  if (match === null) return null
  return { start: match.index, end: tagEnd(html, match.index) ?? html.length }
}

/**
 * The script-data-double-escaped state. Inside a `<script>`, once the tokenizer has seen `<!--`
 * followed by `<script`, the *next* `</script>` does not close the element — it returns the
 * tokenizer to the singly-escaped state, and the element runs to the one after that. So in
 * `<script>"<!--<script>"</script><head>` that `<head>` is still script text, where a scanner
 * stopping at the first `</script>` would happily anchor.
 */
function isDoubleEscaped(interior: string): boolean {
  const comment = interior.indexOf('<!--')
  if (comment === -1) return false
  return /<script(?=[\s/>])/i.test(interior.slice(comment))
}

/** Offset just past the text content of `name`, whose content starts at `contentStart`. */
function skipTextContent(html: string, name: string, contentStart: number): number {
  // `plaintext` has no end tag at all: everything after it is text, forever.
  if (name === 'plaintext') return html.length

  const first = findEndTag(html, name, contentStart)
  if (first === null) return html.length
  if (name !== 'script') return first.end

  if (!isDoubleEscaped(html.slice(contentStart, first.start))) return first.end
  const second = findEndTag(html, name, first.end)
  return second === null ? html.length : second.end
}

/** Offset at which to insert, or `null` for "no anchor — prepend". */
function findAnchorOffset(html: string): number | null {
  let htmlEnd: number | null = null
  let doctypeEnd: number | null = null
  let bodyImplied = false
  let index = 0

  while (index < html.length) {
    const open = html.indexOf('<', index)
    if (open === -1) break

    // Character data between tokens. Anything non-whitespace ends the "before head" insertion
    // mode: the parser closes the implied head and opens the body, so a `<head>` start tag after
    // this point is a parse error the tree builder discards. Whitespace alone is ignored.
    if (!bodyImplied && html.slice(index, open).trim() !== '') bodyImplied = true

    if (html.startsWith('<!--', open)) {
      // Abrupt-closing comments: `<!-->` and `<!--->` are complete comments, not the start of one.
      // Handled explicitly because searching for `-->` from `open + 4` cannot match either, and
      // the walk would blind itself to EOF and silently fall back past a perfectly good `<head>`.
      if (html.startsWith('<!-->', open)) {
        index = open + 5
        continue
      }
      if (html.startsWith('<!--->', open)) {
        index = open + 6
        continue
      }
      const close = html.indexOf('-->', open + 4)
      index = close === -1 ? html.length : close + 3
      continue
    }

    if (html.startsWith('<!', open)) {
      const end = tagEnd(html, open)
      if (end === null) break
      if (doctypeEnd === null && /^<!doctype\b/i.test(html.slice(open, end))) doctypeEnd = end
      index = end
      continue
    }

    const match = TAG_START.exec(html.slice(open, open + 32))
    if (!match) {
      // A bare `<` in text (`a < b`). Not markup; keep scanning past it.
      index = open + 1
      continue
    }

    const closing = match[1] === '/'
    const name = match[2]!.toLowerCase()
    const end = tagEnd(html, open)
    if (end === null) break

    // A literal `<head>` is only an anchor while the implied head is still open. Past that point
    // the tree builder ignores the token, and a meta injected after it is a child of `<body>`,
    // where CSP pragma processing drops the policy entirely. Falling back is what saves it.
    if (!closing && name === 'head') {
      if (bodyImplied) break
      return end
    }
    if (!closing && name === 'html' && htmlEnd === null) htmlEnd = end
    // Past the head, whatever we thought we saw. Injecting into <body> is worse than the
    // <html>/doctype fallbacks below, which are still inside the document's prologue.
    if (name === 'body' || (closing && name === 'head')) break
    // Any start tag that is not head content opens the body implicitly, exactly as text does.
    if (!closing && !HEAD_CONTENT_ELEMENTS.has(name)) bodyImplied = true

    if (!closing && TEXT_CONTENT_ELEMENTS.has(name)) {
      // Text content is not markup: a `<head>` in a JS string, a CSS selector or a <title> is data.
      index = skipTextContent(html, name, end)
      continue
    }

    index = end
  }

  return htmlEnd ?? doctypeEnd
}

/** Inject the slide CSP into a complete slide document. Pure; author bytes are never rewritten. */
export function wrapSlideHtml(html: string): string {
  const at = findAnchorOffset(html)
  if (at === null) return `${CSP_META}\n${html}`
  return `${html.slice(0, at)}\n${CSP_META}${html.slice(at)}`
}
