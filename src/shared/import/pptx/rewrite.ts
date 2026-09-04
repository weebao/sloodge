/**
 * Pushing an edit back into the *original* slide part (M4.6, `patched` mode).
 *
 * ## Why a byte splice rather than a serializer
 *
 * The guarantee M4.6 asserts is that an edited round-trip rewrites **only** the parts the edit
 * touched, and that every untouched part comes out byte-identical. Passthrough handles the other
 * parts; this module handles the touched one, and it holds the line inside that part too: the
 * output differs from the input only in the character data of the text spans that actually
 * changed. Attribute order, namespace declarations, whitespace, `<p:extLst>` blobs, the XML
 * declaration's exact spelling — all of it survives, because none of it is ever re-emitted.
 *
 * A round-trip through a DOM and a serializer would lose all of that. Not incorrectly — the
 * resulting XML would be equivalent — but *differently*, and a diff that shows every part rewritten
 * is indistinguishable from a bug. The splice keeps the diff honest: what changed in the file is
 * what the user changed on the slide.
 *
 * ## The two scans must agree, and a test pins them
 *
 * `convert.ts` numbers text runs by walking the parsed tree (`descendantsNamed(root, 't')`); this
 * module numbers them by scanning the raw source. Those are two different parsers looking at the
 * same document, which is precisely the shape of bug the zip layer's docblock spends a paragraph
 * on — and here a disagreement is worse than a crash, because it would write an edit into the wrong
 * text span and produce a plausible-looking wrong file.
 *
 * So the scanner mirrors the parser's rules between elements: it skips comments, CDATA sections and
 * processing instructions (a `<a:t>` inside a comment is not an element and must not be counted)
 * and it matches on *local* name so any namespace prefix works. *Inside* a `<a:t>` it assumes
 * character data only and takes the next `</` as the close — which the parser does not: a comment,
 * CDATA section or (illegal but parseable) child element inside the text moves the real close tag
 * past that `</`, and a splice at the scanner's offsets would emit a part that no longer parses
 * (M4.6 review round 5). Character data cannot contain a raw `<`, so a span whose `raw` does is
 * exactly that case; `rewriteSlideText` refuses it and the exporter falls back to a rebuild.
 * `tests/unit/import` asserts the two orderings against each other over every fixture and over
 * hand-built adversarial parts.
 */

import { parse } from 'parse5'
import type { DefaultTreeAdapterTypes } from 'parse5'
import { sanitizeXmlText } from '../../export/pptx/sanitize'

type Element = DefaultTreeAdapterTypes.Element
type ChildNode = DefaultTreeAdapterTypes.ChildNode

/** One `<*:t>` element's position in the source text. */
export type TextSpan = {
  /** Offset of the `<`. */
  readonly tagStart: number
  /** Offset just past the open tag's `>`; equals `innerEnd` for a self-closing tag. */
  readonly innerStart: number
  /** Offset of the `<` that begins the closing tag; equals `innerStart` when self-closing. */
  readonly innerEnd: number
  /** Offset just past the whole element. */
  readonly tagEnd: number
  readonly selfClosing: boolean
  /** The raw (still XML-escaped) character data between the tags. */
  readonly raw: string
}

const NAME_CHAR = /[-A-Za-z0-9_:.]/

/**
 * Find every `<*:t>` element in an OOXML part, in document order.
 *
 * Deliberately *not* a regex: a regex over `<(\w+:)?t[^>]*>` counts occurrences inside comments and
 * CDATA, which the tree walk does not, and a single such occurrence would shift every subsequent
 * run index by one.
 */
export function scanTextSpans(xml: string): TextSpan[] {
  const spans: TextSpan[] = []
  let at = 0

  while (at < xml.length) {
    const lt = xml.indexOf('<', at)
    if (lt < 0) break

    if (xml.startsWith('<!--', lt)) {
      const end = xml.indexOf('-->', lt + 4)
      at = end < 0 ? xml.length : end + 3
      continue
    }
    if (xml.startsWith('<![CDATA[', lt)) {
      const end = xml.indexOf(']]>', lt + 9)
      at = end < 0 ? xml.length : end + 3
      continue
    }
    if (xml.startsWith('<?', lt)) {
      const end = xml.indexOf('?>', lt + 2)
      at = end < 0 ? xml.length : end + 2
      continue
    }
    if (xml.startsWith('<!', lt)) {
      const end = xml.indexOf('>', lt + 2)
      at = end < 0 ? xml.length : end + 1
      continue
    }
    if (xml.startsWith('</', lt)) {
      const end = xml.indexOf('>', lt + 2)
      at = end < 0 ? xml.length : end + 1
      continue
    }

    // Read the element name.
    let cursor = lt + 1
    while (cursor < xml.length && NAME_CHAR.test(xml[cursor] ?? '')) cursor += 1
    const name = xml.slice(lt + 1, cursor)
    if (name === '') {
      at = lt + 1
      continue
    }

    // Walk to the end of the open tag, honouring quoted attribute values so a `>` inside one does
    // not end the tag early.
    let quote: string | null = null
    let tagEnd = -1
    let selfClosing = false
    for (let index = cursor; index < xml.length; index += 1) {
      const ch = xml[index]
      if (quote !== null) {
        if (ch === quote) quote = null
        continue
      }
      if (ch === '"' || ch === "'") {
        quote = ch
        continue
      }
      if (ch === '>') {
        selfClosing = xml[index - 1] === '/'
        tagEnd = index + 1
        break
      }
    }
    if (tagEnd < 0) break // unterminated tag: nothing further is trustworthy

    const colon = name.indexOf(':')
    const local = colon < 0 ? name : name.slice(colon + 1)

    if (local !== 't') {
      at = tagEnd
      continue
    }

    if (selfClosing) {
      spans.push({
        tagStart: lt,
        innerStart: tagEnd,
        innerEnd: tagEnd,
        tagEnd,
        selfClosing: true,
        raw: '',
      })
      at = tagEnd
      continue
    }

    // `a:t` holds character data only, so the next `</` closes it.
    const closeStart = xml.indexOf('</', tagEnd)
    if (closeStart < 0) break
    const closeEnd = xml.indexOf('>', closeStart)
    if (closeEnd < 0) break
    spans.push({
      tagStart: lt,
      innerStart: tagEnd,
      innerEnd: closeStart,
      tagEnd: closeEnd + 1,
      selfClosing: false,
      raw: xml.slice(tagEnd, closeStart),
    })
    at = closeEnd + 1
  }

  return spans
}

/**
 * Prepare a string for splicing into an OOXML part: strip XML-1.0-illegal characters, then escape
 * the three that can end a text node. `>` is escaped too, so `]]>` cannot appear.
 *
 * **The stripping half is not this module's rule and must not be restated here.** It comes from
 * `src/shared/export/pptx/sanitize.ts`, which M4.3 spent three review rounds establishing as the
 * single definition of XML-1.0 legality for everything that enters a `.pptx`. Escaping alone is not
 * enough and the gap is not theoretical: a U+0001 or a lone surrogate in an edited text run passes
 * every gate upstream — Tier-1 is an *HTML* contract and accepts them — and lands verbatim in
 * `ppt/slides/slideN.xml`, which real XML parsers reject outright and PowerPoint calls corrupt.
 * The zip stays structurally valid, so a slide-count check still reports success: exactly the silent
 * failure `sanitize.ts`'s docblock describes.
 *
 * M4.3 reached that boundary after three rounds of patching individual paths, and this splice is a
 * fourth path that would have re-derived the same escape by hand. Calling the shared sanitizer means
 * the day the legality rules change, this path changes with them.
 *
 * Sanitizing does **not** disturb the byte-minimality property the round-trip depends on:
 * `sanitizeXmlText` is the identity for legal text, so a run whose content is unchanged still encodes
 * to bytes identical to the original span and is skipped rather than rewritten.
 */
export function escapeXmlText(value: string): string {
  return sanitizeXmlText(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
}

function isElement(node: ChildNode): node is Element {
  return 'tagName' in node
}

function attributeValue(element: Element, name: string): string | undefined {
  for (const attribute of element.attrs) if (attribute.name === name) return attribute.value
  return undefined
}

/** Concatenated text of an element's subtree. */
function elementText(element: Element): string {
  let out = ''
  const stack: ChildNode[] = element.childNodes.toReversed()
  while (stack.length > 0) {
    const node = stack.pop()
    if (!node) break
    if (node.nodeName === '#text' && 'value' in node) {
      out += node.value
      continue
    }
    if (isElement(node)) {
      for (let index = node.childNodes.length - 1; index >= 0; index -= 1) {
        const child = node.childNodes[index]
        if (child) stack.push(child)
      }
    }
  }
  return out
}

/**
 * Read the `data-sl-run="N"` provenance markers back out of a slide's HTML.
 *
 * Returns `null` when the markers are unusable — a duplicate index, a non-integer, or a negative —
 * because an ambiguous mapping must not be resolved by guessing. A slide whose markers are gone
 * entirely returns an empty map, which the patchability check then rejects against a part that has
 * text spans.
 */
export function extractRunTexts(html: string): Map<number, string> | null {
  const document = parse(html)
  const out = new Map<number, string>()
  const stack: ChildNode[] = []

  const seed = (node: { childNodes?: ChildNode[] }): void => {
    for (const child of node.childNodes ?? []) stack.push(child)
  }
  seed(document)

  while (stack.length > 0) {
    const node = stack.pop()
    if (!node || !isElement(node)) continue
    const marker = attributeValue(node, 'data-sl-run')
    if (marker !== undefined) {
      if (!/^\d+$/.test(marker)) return null
      const index = Number.parseInt(marker, 10)
      if (!Number.isSafeInteger(index)) return null
      if (out.has(index)) return null // two elements claiming one run: ambiguous, refuse
      out.set(index, elementText(node))
    }
    seed(node)
  }
  return out
}

export type RewriteResult =
  | { readonly ok: true; readonly xml: string; readonly changedRuns: readonly number[] }
  | { readonly ok: false; readonly reason: string }

/**
 * Substitute a slide's edited text back into its original part.
 *
 * Refuses (rather than doing its best) whenever the mapping is not exact: a missing marker, an
 * index with no matching span, or markers that do not cover every span. "Its best" here would mean
 * emitting a part whose text silently disagrees with the deck, which is the one outcome worse than
 * falling back to a full rebuild.
 */
export function rewriteSlideText(originalXml: string, html: string): RewriteResult {
  const spans = scanTextSpans(originalXml)
  const markup = spans.findIndex((span) => span.raw.includes('<'))
  if (markup >= 0) {
    return {
      ok: false,
      reason: `text span ${String(markup)} contains markup, so its extent cannot be trusted`,
    }
  }
  const runs = extractRunTexts(html)
  if (runs === null) return { ok: false, reason: 'slide HTML has ambiguous data-sl-run markers' }
  if (runs.size !== spans.length) {
    return {
      ok: false,
      reason: `slide HTML carries ${String(runs.size)} run markers but the original part has ${String(spans.length)} text spans`,
    }
  }
  for (const index of runs.keys()) {
    if (index < 0 || index >= spans.length) {
      return { ok: false, reason: `run marker ${String(index)} has no matching text span` }
    }
  }

  const changedRuns: number[] = []
  const pieces: string[] = []
  let cursor = 0
  for (const [index, span] of spans.entries()) {
    const replacement = runs.get(index)
    if (replacement === undefined) {
      return { ok: false, reason: `text span ${String(index)} has no run marker in the slide HTML` }
    }
    const encoded = escapeXmlText(replacement)
    // Compare the *encoded* form against the original bytes: text that differs only in how it was
    // escaped (`&#39;` vs `'`) is not an edit, and rewriting it would dirty a part for nothing.
    if (encoded === span.raw) continue

    changedRuns.push(index)
    pieces.push(originalXml.slice(cursor, span.tagStart))
    if (span.selfClosing) {
      // `<a:t/>` cannot carry content. Re-open it as a pair, preserving its attributes. The scanner
      // guarantees the tag ends in `/>`; trimming after a slice is linear in the tag's whitespace,
      // where `/\s*\/>$/` was quadratic (an attacker's 1 MB of attribute whitespace hung main).
      const openTag = originalXml.slice(span.tagStart, span.tagEnd)
      const inner = `${openTag.slice(0, -2).trimEnd()}>`
      const nameMatch = /^<([^\s/>]+)/.exec(openTag)
      const name = nameMatch?.[1]
      if (name === undefined) {
        return { ok: false, reason: 'could not read the element name of a self-closing text span' }
      }
      pieces.push(`${inner}${encoded}</${name}>`)
    } else {
      pieces.push(originalXml.slice(span.tagStart, span.innerStart))
      pieces.push(encoded)
      pieces.push(originalXml.slice(span.innerEnd, span.tagEnd))
    }
    cursor = span.tagEnd
  }
  pieces.push(originalXml.slice(cursor))

  return { ok: true, xml: pieces.join(''), changedRuns }
}

/** Whether an edit to this slide can be expressed as a text substitution on its original part. */
export function isPatchable(originalXml: string, html: string): boolean {
  return rewriteSlideText(originalXml, html).ok
}
