/**
 * `buildSlideMap` — parse a slide's HTML once and produce every source span Design Mode needs.
 *
 * §1.2 of `.claude/plans/init/40-design-mode.md`. This module is pure: no Electron, no DOM, no
 * I/O, and — importantly — **it never executes the slide**. Slide HTML is model-generated and
 * treated as hostile (§7 of 10-architecture.md); the only thing that ever touches it here is
 * `parse5`, a tokenizer. Nothing is evaluated, no `<script>` is run, no URL is fetched, and the
 * parse cannot escape into the host: a hostile slide's worst case is a map with entries the
 * grabbable filter later refuses to select.
 *
 * Read `./types.ts` first for offset semantics — the spans are UTF-16 code-unit indices, not
 * bytes, and that distinction is load-bearing.
 */

import { parse } from 'parse5'
import type { DefaultTreeAdapterTypes } from 'parse5'

import type { AttrSpan, ElementSpan, SlideMap, SlideNamespace, Span } from './types'

type Element = DefaultTreeAdapterTypes.Element
type Template = DefaultTreeAdapterTypes.Template
type ChildNode = DefaultTreeAdapterTypes.ChildNode
type ParentNode = DefaultTreeAdapterTypes.ParentNode
type TextNode = DefaultTreeAdapterTypes.TextNode

/** parse5 reports `namespaceURI` as one of these URIs; the HTML parser can only produce three. */
const NAMESPACE_BY_URI: Readonly<Record<string, SlideNamespace>> = {
  'http://www.w3.org/1999/xhtml': 'html',
  'http://www.w3.org/2000/svg': 'svg',
  'http://www.w3.org/1998/Math/MathML': 'mathml',
}

/**
 * HTML elements that never have content or an end tag.
 *
 * The spec's void set plus the legacy tags the tree builder treats identically (`basefont`,
 * `bgsound`, `frame`, `keygen`, `param`). Membership decides `inner === null`, which is what
 * stops a patcher from splicing children into a `<br>`.
 */
const VOID_HTML_ELEMENTS: ReadonlySet<string> = new Set([
  'area',
  'base',
  'basefont',
  'bgsound',
  'br',
  'col',
  'embed',
  'frame',
  'hr',
  'img',
  'input',
  'keygen',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr',
])

/** The characters that terminate a tag name in the tokenizer's tag-name state. */
const TAG_NAME_TERMINATORS: ReadonlySet<string> = new Set(['\t', '\n', '\f', '\r', ' ', '/', '>'])

/** HTML whitespace — the five characters, not JavaScript's `\s`. See `wrapSlideHtml.ts`. */
const HTML_WHITESPACE: ReadonlySet<string> = new Set(['\t', '\n', '\f', '\r', ' '])

/** The attribute Design Mode owns. Lowercased, which is how the tokenizer reports every name. */
export const SL_ID_ATTR = 'data-sl-id'

/**
 * A 32-bit FNV-1a fingerprint of the source, hex, prefixed with the algorithm that produced it.
 *
 * **This is a change detector, not an integrity check**, and the prefix is there so a reader can
 * tell which it is holding. It answers "has this slide been edited since I computed my patch?"
 * (§1.4's staleness guard) against *accidental* concurrency — a local edit landing while an AI
 * turn is in flight — where the two candidate strings are revisions of one document and a
 * pairwise false match costs 2^-32.
 *
 * It is emphatically not a defence against an adversary who gets to *choose* both strings, and
 * §6.4 sends `sourceHash` out to the model, which is exactly such a boundary. Callers that cross
 * one must pass their own `sourceHash` — `node:crypto`'s synchronous `createHash('sha256')` in
 * the main process, or an awaited `crypto.subtle.digest` in the renderer. This default exists
 * because `buildSlideMap` is synchronous and there is no synchronous SHA-256 in both
 * environments; inventing one, or shipping a hand-rolled 64-bit construction whose independence
 * nobody has analysed, would be worse than being honest about 32 bits.
 *
 * Hashes UTF-16 code units — the same units the map's spans index — so the fingerprint and the
 * offsets always describe the same string.
 */
export function sourceFingerprint(source: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return `fnv1a32:${(hash >>> 0).toString(16).padStart(8, '0')}`
}

function isElement(node: ChildNode): node is Element {
  return 'tagName' in node
}

function isTextNode(node: ChildNode): node is TextNode {
  return node.nodeName === '#text'
}

function isTemplate(node: Element): node is Template {
  return node.tagName === 'template' && 'content' in node
}

/**
 * The children that count as the element's own, in tree terms.
 *
 * `<template>` is the exception: the parser puts its children in a separate `content` fragment
 * rather than in `childNodes`. Treating that fragment's children as the template's own is what
 * makes template contents addressable at all — and they need to be, because a slide can render
 * one by cloning it, and the author still has to be able to select and edit the markup.
 */
function childrenOf(node: ParentNode): ChildNode[] {
  if ('tagName' in node && isTemplate(node)) return node.content.childNodes
  return node.childNodes
}

/**
 * Offset just past the tag name in a start tag — the insertion point for a new attribute.
 *
 * Scanned from the source rather than derived from `tagName.length`, because the two can differ:
 * parse5 reports *adjusted* names in foreign content, so `<image>` inside `<svg>` is reported as
 * `img`, and adding a length would land mid-name. Scanning cannot drift.
 */
function tagNameEnd(source: string, startTagStart: number): number {
  let index = startTagStart + 1
  while (index < source.length && !TAG_NAME_TERMINATORS.has(source[index]!)) index += 1
  return index
}

/**
 * Split one attribute's source location into name / value / whole.
 *
 * The shapes handled are the four the tokenizer can emit — `name`, `name=value`, `name="value"`,
 * `name='value'` — with arbitrary whitespace around the `=`. The `=` search starts at index 1
 * rather than 0 because a name may legitimately *begin* with `=` (the tokenizer's
 * `unexpected-equals-sign-before-attribute-name` path makes `<div =a>` an attribute named `=a`),
 * and treating that `=` as the separator would produce an empty name span.
 */
function readAttrSpan(source: string, whole: Span): AttrSpan {
  const text = source.slice(whole.start, whole.end)
  const equals = text.indexOf('=', 1)

  if (equals === -1) {
    // Valueless: the whole thing is the name.
    return { sourceName: text, name: { ...whole }, value: null, whole: { ...whole } }
  }

  let nameEnd = equals
  while (nameEnd > 0 && HTML_WHITESPACE.has(text[nameEnd - 1]!)) nameEnd -= 1

  let valueStart = equals + 1
  while (valueStart < text.length && HTML_WHITESPACE.has(text[valueStart]!)) valueStart += 1

  const quote = text[valueStart]
  const quoted =
    (quote === '"' || quote === "'") && text.endsWith(quote) && text.length > valueStart + 1
  const value: Span = quoted
    ? { start: whole.start + valueStart + 1, end: whole.end - 1 }
    : { start: whole.start + valueStart, end: whole.end }

  return {
    sourceName: text.slice(0, nameEnd),
    name: { start: whole.start, end: whole.start + nameEnd },
    value,
    whole: { ...whole },
  }
}

/**
 * Whether the element is one that cannot hold content, so `inner` must be `null`.
 *
 * Two cases: the fixed HTML void set, and a foreign element the author self-closed (`<rect/>`),
 * which is detected from the source rather than the tree because parse5 does not flag it. The
 * `/` check is what separates `<rect/>` from `<rect>` left unclosed at EOF — the latter *can*
 * have content and its `inner` is a real, possibly non-empty span.
 */
function isContentless(
  source: string,
  node: Element,
  ns: SlideNamespace,
  outer: Span,
  startTag: Span,
  attrs: Record<string, AttrSpan>,
): boolean {
  if (ns === 'html') return VOID_HTML_ELEMENTS.has(node.tagName)
  if (startTag.end !== outer.end) return false

  const solidus = outer.end - 2
  if (source[solidus] !== '/') return false

  // In the attribute-value-unquoted state a `/` is an ordinary value character, so the `/` in
  // `<image href=a/>` closes nothing — the value is `a/`. Only a solidus outside every attribute
  // is the self-closing one. The attribute spans we just built are the authority on where that
  // boundary is, which is why this takes `attrs` rather than re-scanning the start tag: a second
  // scan would be a second, independently-wrong opinion about attribute syntax.
  for (const attr of Object.values(attrs)) {
    if (solidus >= attr.whole.start && solidus < attr.whole.end) return false
  }
  return true
}

/**
 * Elements whose leading newline the tree builder discards ("pre", "listing" and "textarea" start
 * tags: "if the next token is a U+000A LINE FEED character token, then ignore that token"). It is
 * the one place character bytes inside `inner` are not represented by any text node.
 */
const LEADING_NEWLINE_DROPPED: ReadonlySet<string> = new Set(['pre', 'listing', 'textarea'])

/**
 * The decoded character data of an element whose `inner` bytes are exactly its text-node children,
 * or `null` when they are not — the definition of `ElementSpan.textOnly` (see its docstring).
 *
 * Coverage is checked on **source spans**, not on the tree: the text nodes must tile `inner` from
 * its first byte to its last with no gap. A gap means bytes the tree does not attribute to this
 * element's character data — a start tag the adoption agency moved elsewhere, foster-parented text
 * that landed *outside* the element, a `<head>` whose location the parser reports inverted — and
 * splicing over those bytes is exactly the corruption this refuses.
 *
 * A text node's span may legitimately contain bytes that are not text: the parser *ignores* a stray
 * `</b>` or an out-of-place `<tr>` inside `<p>a</b>b</p>`, merges the character tokens around it into
 * one node and extends that node's span across the ignored tag. Those bytes produced no element, so
 * nothing addressable is lost by writing over them; the decoded value is still the whole truth of
 * what the element renders.
 */
function textOnlyContent(
  source: string,
  tagName: string,
  inner: Span,
  children: readonly ChildNode[],
): string | null {
  let cursor = inner.start
  if (LEADING_NEWLINE_DROPPED.has(tagName)) {
    if (source.startsWith('\r\n', cursor)) cursor += 2
    else if (source[cursor] === '\n') cursor += 1
  }

  let content = ''
  for (const child of children) {
    if (!isTextNode(child)) return null
    const location = child.sourceCodeLocation
    if (!location || location.startOffset !== cursor) return null
    cursor = location.endOffset
    content += child.value
  }
  return cursor === inner.end ? content : null
}

interface WalkState {
  readonly source: string
  readonly slideId: string
  readonly spans: ElementSpan[]
  readonly byId: Map<string, ElementSpan>
  /**
   * Start-tag start offset -> the one element that owns it. See `mapElement` on cloning.
   *
   * A given offset in the source is one physical start tag, so this is the identity of a *source*
   * element as opposed to a *tree* element — and the two are not one-to-one.
   */
  readonly ownerByStartTag: Map<number, ElementSpan>
}

/**
 * Map one element, or return `null` if it is not addressable.
 *
 * ## No source location
 *
 * parse5's signal for an element the tree builder invented: the implied `<html>`, `<head>` and
 * `<body>` that appear for any fragment-like slide. 40-design-mode.md §1.2 is explicit that those
 * get no `data-sl-id` and are not selectable — there is nothing in the source to point at, so
 * there is nothing to patch, and fabricating a span would hand the patcher an offset that means
 * nothing.
 *
 * A missing `startTag` is treated the same way. It should not occur for a located element, but if
 * it ever did we would have no tag name to insert an attribute after, and the conservative
 * failure is to leave the element unaddressable rather than to guess an offset.
 *
 * ## Adoption agency clones — one source element, several tree elements
 *
 * Mis-nested formatting is ordinary model output (`<p><b>x</p><p>y</b></p>`), and the HTML
 * parser's adoption agency algorithm resolves it by **cloning** the formatting element into the
 * second paragraph. parse5 copies the original's `sourceCodeLocation` onto the clone, so the tree
 * holds two `<b>` elements that both claim to start at offset 3 — and the clone's `outer` is
 * widened as it closes, to `[3,19)`, a range spanning `</p><p>` and so covering bytes belonging
 * to two paragraphs it does not own.
 *
 * Minting an id per *tree* element there is wrong three ways, all of them measured: `instrument`
 * emits two `data-sl-id` attributes into the one physical start tag, so the second id never
 * reaches the DOM and is silently unselectable; the fixpoint guarantee becomes false and each
 * round-trip grows the document; and a patch aimed at the clone's `outer` rewrites the original
 * element's source plus whatever else that range crosses.
 *
 * So identity here is the **source** element, not the tree element: an element is addressable
 * only if it is the first in tree order to claim its start-tag offset. Later claimants are
 * clones — unaddressable in exactly the way implied elements are, and transparent for
 * parent/child linking, so any genuinely new element the adoption agency moved inside a clone is
 * still mapped and simply attaches to the nearest mapped ancestor.
 *
 * First-in-tree-order is the right survivor, not an arbitrary tie-break: across every mis-nesting
 * shape probed (including three-deep `<b><i><u>`) it is the clone that carries the widened,
 * boundary-crossing `outer`, while the first claimant keeps the tight span that really is the
 * element's source extent.
 *
 * Nothing is lost in the DOM. Because both tree elements share one start tag, the single
 * `data-sl-id` injected there is copied onto the clone by the very same cloning step — so both
 * rendered nodes carry the surviving id, and a click on either resolves to the one source element
 * that produced them.
 *
 * `ElementSpan.minDomNodeCount` counts the clones we can see, and is a **lower bound**: when the
 * adoption agency's furthest block is a block element (`<b><p>x</b>y</p>`) parse5 gives the clone
 * no location at all, so it arrives at the guard above and is indistinguishable here from an
 * implied `<body>`. That costs nothing operationally — the id still reaches every rendered node,
 * so nothing is unselectable, and consumers are told to use `querySelectorAll` unconditionally —
 * but the field must not be read as exact. See its docstring for why counting those structurally
 * was tried and rejected.
 */
function mapElement(
  state: WalkState,
  node: Element,
  path: number[],
  parentSlId: string | null,
): ElementSpan | null {
  const location = node.sourceCodeLocation
  if (!location?.startTag) return null

  const owner = state.ownerByStartTag.get(location.startTag.startOffset)
  if (owner) {
    owner.minDomNodeCount += 1
    return null
  }

  const { source } = state
  const outer: Span = { start: location.startOffset, end: location.endOffset }
  const startTag: Span = { start: location.startTag.startOffset, end: location.startTag.endOffset }
  const ns = NAMESPACE_BY_URI[node.namespaceURI] ?? 'html'

  const attrs: Record<string, AttrSpan> = {}
  for (const [name, attrLocation] of Object.entries(location.attrs ?? {})) {
    attrs[name] = readAttrSpan(source, {
      start: attrLocation.startOffset,
      end: attrLocation.endOffset,
    })
  }

  const contentless = isContentless(source, node, ns, outer, startTag, attrs)
  const inner: Span | null = contentless
    ? null
    : { start: startTag.end, end: location.endTag ? location.endTag.startOffset : outer.end }

  const children = childrenOf(node)
  const slIdAttr = attrs[SL_ID_ATTR]
  const textContent = inner === null ? null : textOnlyContent(source, node.tagName, inner, children)

  const span: ElementSpan = {
    slId: `${state.slideId}:${String(state.spans.length)}`,
    tagName: node.tagName,
    outer,
    inner,
    attrs,
    attrInsert: tagNameEnd(source, startTag.start),
    parentSlId,
    childSlIds: [],
    path,
    textOnly: textContent !== null,
    textContent,
    ns,
    authoredSlId: slIdAttr?.value ? source.slice(slIdAttr.value.start, slIdAttr.value.end) : null,
    minDomNodeCount: 1,
  }
  state.ownerByStartTag.set(startTag.start, span)
  return span
}

/**
 * Depth-first walk in tree order, assigning ids and stitching the mapped-only parent/child links.
 *
 * `path` counts *every* element child including unmapped implied ones and adoption-agency clones,
 * while `parentSlId` and `childSlIds` skip them — an unmapped element is transparent, so a mapped
 * element's parent is its nearest mapped ancestor and its children are its nearest mapped
 * descendants. That is what lets the breadcrumb and keyboard traversal of §4.2 walk a clean tree
 * of addressable nodes while §1.5's path re-resolution still runs against the real, deterministic
 * parser output.
 */
function walk(
  state: WalkState,
  parent: ParentNode,
  path: number[],
  nearestMappedId: string | null,
): string[] {
  const mappedChildren: string[] = []
  let elementIndex = 0

  for (const child of childrenOf(parent)) {
    if (!isElement(child)) continue

    const childPath = [...path, elementIndex]
    elementIndex += 1

    const span = mapElement(state, child, childPath, nearestMappedId)
    if (span === null) {
      // Transparent: its mapped descendants attach to *our* nearest mapped ancestor.
      mappedChildren.push(...walk(state, child, childPath, nearestMappedId))
      continue
    }

    state.spans.push(span)
    state.byId.set(span.slId, span)
    mappedChildren.push(span.slId)
    span.childSlIds = walk(state, child, childPath, span.slId)
  }

  return mappedChildren
}

export interface BuildSlideMapOptions {
  /**
   * Override the source fingerprint — pass a real `sha256:…` when the value crosses a trust
   * boundary. See `sourceFingerprint` for why the default is not one.
   */
  sourceHash?: string
}

/**
 * Parse `source` and return every span Design Mode can address.
 *
 * ## How `slId` is assigned, and why it is stable
 *
 * `"<slideId>:<n>"`, where `n` is the element's zero-based index in **tree document order**,
 * counting only elements that carry a source location. This is 40-design-mode.md §1.1's scheme.
 * A counter, not a content hash: the plan asks for ids that are stable across reparses of
 * unchanged source and across edits that only change attribute values or text, and a positional
 * counter gives exactly that — parsing is deterministic, so the same bytes always produce the
 * same indices, and changing a value moves offsets without moving anyone's position. Structural
 * edits do invalidate ids, which the plan accepts and answers with `path` re-resolution (§1.5).
 * A content hash would buy stability across *moves* but lose it across every text edit, which is
 * the far more common case, and would need collision handling for the duplicated elements that
 * slides are full of (five identical `<rect class="bar">`).
 *
 * "Document order" here means **tree order**, which is not always source order: foster parenting
 * relocates a `<div>` written inside a `<table>` to *before* the table in the tree, so its `n` is
 * lower than the table's despite its higher source offset. Tree order is the right choice because
 * it is the order the iframe's DOM will exhibit, and the one `path` and `childSlIds` are
 * consistent with. Ids are opaque either way; what matters is that the choice is fixed.
 *
 * Elements the parser invented get no id at all — see `mapElement`.
 */
export function buildSlideMap(
  slideId: string,
  source: string,
  options: BuildSlideMapOptions = {},
): SlideMap {
  const document = parse(source, { sourceCodeLocationInfo: true })
  const state: WalkState = {
    source,
    slideId,
    spans: [],
    byId: new Map(),
    ownerByStartTag: new Map(),
  }

  walk(state, document, [], null)

  return {
    slideId,
    sourceHash: options.sourceHash ?? sourceFingerprint(source),
    source,
    byId: state.byId,
    order: state.spans.map((span) => span.slId),
  }
}
