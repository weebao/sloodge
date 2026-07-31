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
 * ## This is the only policy on the frame
 *
 * Slides are delivered as blob URLs (`useSlideUrl`), per §7. A blob-loaded frame is a real
 * navigation to its own document, so — unlike `srcdoc`, which inherits the embedder's CSP — nothing
 * else constrains it. That is what makes inline `<script>` work at all (the `interactive-js`
 * capability of the slide contract), and it is also why the injection below must be markup-aware:
 * an anchor swallowed by a comment used to be masked by the host page's inherited policy, and no
 * longer is.
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
 * Today that is masked by the host page's own CSP, which a `srcdoc` frame inherits. Blob delivery
 * (now live in `SlideFrame`) removes that accident, which makes this policy the only thing
 * enforcing `connect-src 'none'` — i.e. the only thing standing between a hostile slide and
 * exfiltrating the deck.
 *
 * So the anchor is located by walking the markup, skipping comments, `<script>`/`<style>` interiors
 * and quoted attribute values, and stopping at `<body>`. The walk yields a byte *offset* and the
 * caller slices the original string at it — author bytes are never rewritten, which is what keeps
 * Design Mode's byte-span patcher (§3.3 of 30-slide-format.md) valid.
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
const RAW_TEXT_ELEMENTS = new Set(['script', 'style'])

/** Offset at which to insert, or `null` for "no anchor — prepend". */
function findAnchorOffset(html: string): number | null {
  let htmlEnd: number | null = null
  let doctypeEnd: number | null = null
  let index = 0

  while (index < html.length) {
    const open = html.indexOf('<', index)
    if (open === -1) break

    if (html.startsWith('<!--', open)) {
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

    if (!closing && name === 'head') return end
    if (!closing && name === 'html' && htmlEnd === null) htmlEnd = end
    // Past the head, whatever we thought we saw. Injecting into <body> is worse than the
    // <html>/doctype fallbacks below, which are still inside the document's prologue.
    if (name === 'body') break

    if (!closing && RAW_TEXT_ELEMENTS.has(name)) {
      // Raw-text content is not markup: a `<head>` in a JS string or a CSS selector is data.
      const close = new RegExp(`</${name}\\s*>`, 'i').exec(html.slice(end))
      index = close === null ? html.length : end + close.index + close[0].length
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
