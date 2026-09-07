/**
 * `text-edit.ts` — the pure core of M3.11's direct text editing on canvas (§4.1, §9.3 of
 * `.claude/plans/init/40-design-mode.md`).
 *
 * Double-clicking a text element turns it into a `contenteditable` **inside the sandboxed frame**;
 * when the edit commits, the frame posts the element's `textContent` back over the bridge. This
 * module is everything that happens between "a string arrived from the frame" and "these are the new
 * slide bytes" — and it is deliberately pure, so the entire trust boundary is unit-testable with no
 * iframe, no React and no DOM.
 *
 * ## The one rule that shapes this whole file: the returned text is untrusted
 *
 * §2.2 is normative and the M3.2 review sharpened it: a frame → parent message is **not**
 * authenticated. The bridge script and the slide's own author JS share one realm and one
 * `event.source`, so a well-formed `SL_EDIT` response proves only "some code in the frame said this",
 * never "the user typed this". A paste can carry markup, styles and scripts, and author JS can post a
 * commit that never happened. Consequently this module treats the incoming string as **an arbitrary
 * attacker-chosen sequence of characters** and derives everything else from parent-held state: the
 * element comes from the parent's own `SlideMap` (never from the payload), and the only thing the
 * payload contributes is text that is escaped into a text-node position.
 *
 * ## Three layers of defence, in order
 *
 * 1. **Target gating** (`isTextEditable`) — only a `textOnly` element with an `inner` span that
 *    renders as exactly one DOM node, whose tag parses its children as ordinary character data, and
 *    which is not `data-sl-lock`ed.
 * 2. **Escaping** (`escapeAndNeutralizeText`, a superset of `patch.ts`'s `escapeText`) — `&` and `<`
 *    become entities, so the text cannot close the element or open a tag. This is what makes
 *    HTML/script injection *structurally* impossible rather than merely filtered: there is no `<`
 *    left to start a tag with.
 * 3. **Contract preservation** (`neutralizeForbiddenTokens` + the post-patch assertion) — escaping
 *    stops injection but not SL-S04, which is a substring scan that does not care whether the match
 *    is executable. Typing the prose "we call fetch(url) here" would otherwise make the slide fail
 *    its own contract. See the section below.
 *
 * ## Why SL-S04 needs *neutralization* and not just rejection
 *
 * SL-S04 scans the packed source (whitespace stripped, lowercased) for `fetch(`, `localStorage`, …
 * A user typing any of those as ordinary prose is doing nothing wrong, but a naive write would either
 * corrupt the slide's contract or force us to refuse a legitimate edit. So the text is *neutralized*:
 * the first character of each match is rewritten as a numeric character reference (`f` → `&#102;`).
 * That is invisible to the reader — the DOM decodes it back to exactly the same character, so the
 * rendered text is unchanged and the round-trip is stable — while the *bytes* no longer contain the
 * token. The match is found whitespace-tolerantly (`f\s*e\s*t\s*c\s*h\s*\(`) and over the same
 * case fold the validator applies, precisely because the scan packs whitespace out and lowercases
 * before looking: `fetch (x)` and `WebSocKet` (a Kelvin sign that lowercases to `k`) are both
 * caught, because the neutralizer sees what the validator will see.
 *
 * Neutralization is a **UX** measure: it keeps honest prose editable. The **guarantee** is the
 * assertion in `resolveTextEdit`, which recomputes `findForbiddenApiTokens` over the whole patched
 * source and refuses the edit if it gained a token the original did not have. That catches anything
 * neutralization missed, including a token formed across the boundary between the inserted text and
 * the surrounding source. Both the matcher (`forbiddenBreakPoints`) and the scan
 * (`findForbiddenApiTokens`) are `slide-contract.ts`'s, so there is exactly one definition of the
 * rule in the codebase — the same matcher the PPTX importer's `slideText` (M4.5) defuses with.
 */

import { findForbiddenApiTokens, forbiddenBreakPoints } from '../document/slide-contract'
import { applyOps } from './patch'
import { resolveElement } from './property-model'
import { LEADING_NEWLINE_DROPPED } from './slide-map'
import { parseFragment } from 'parse5'
import type { DefaultTreeAdapterTypes } from 'parse5'
import type { ElementSpan, SlideMap } from './types'

/**
 * Tags a caret must never open in, in three groups.
 *
 * **Not character data.** `<script>`, `<style>`, `<xmp>`, `<plaintext>`, `<noscript>`, `<noembed>`,
 * `<noframes>` and `<iframe>` are RAWTEXT-ish: an `&lt;` written inside them stays the six literal
 * characters and is never decoded, so *escaping buys nothing there*. `<style>` is the sharpest case
 * and does not even need a `<` to be dangerous — a typed `}` closes the current rule and everything
 * after it is a new one, so a "text edit" would be arbitrary CSS injection into saved, exportable
 * source. `<title>`/`<textarea>` are RCDATA (escaping does work) but are not visible slide content and
 * have no business being edited on canvas. `<template>` content is inert until cloned.
 *
 * **Text is foster-parented out.** Inside `<table>`, `<thead>`, `<tbody>`, `<tfoot>`, `<tr>` and
 * `<colgroup>` the tree builder moves non-whitespace text *before* the table, so the frame's caret
 * would type into a node that renders somewhere else and the parent would write bytes the element
 * never renders. Whitespace-only content is the only way one of these is text-only at all.
 *
 * **Text is not content.** `<ul>`, `<ol>`, `<dl>`, `<select>` and `<optgroup>` accept character
 * data in the parser but their text is not slide content the way an `<li>` or `<option>`'s is;
 * a whitespace-only list is "empty", not "a text box". `<html>` and `<head>` are document structure:
 * text written into an empty `<head>` is moved by the parser into an implied body, and an authored
 * `<body>` that follows then loses its location and its id — the id-stability corpus test found it.
 *
 * None of these is reachable through the UI today — the grabbable climb rejects zero-size elements,
 * so a `<script>` or `<style>` can never be double-clicked. This list is the second lock on that
 * door: the gate is enforced on the *source element the parent resolved*, so it holds even if a
 * forged `SL_EDIT` payload names an sl-id the user never clicked.
 */
export const NON_EDITABLE_TAGS: ReadonlySet<string> = new Set([
  'script',
  'style',
  'xmp',
  'plaintext',
  'noscript',
  'noembed',
  'noframes',
  'iframe',
  'title',
  'textarea',
  'template',
  'table',
  'thead',
  'tbody',
  'tfoot',
  'tr',
  'colgroup',
  'ul',
  'ol',
  'dl',
  'select',
  'optgroup',
  'html',
  'head',
])

/**
 * `data-sl-lock` (30-slide-format.md §3.4): "selectable but **not mutable** by Design Mode" —
 * template chrome the deck author wants visible to selection but immune to editing.
 */
export const LOCK_ATTR = 'data-sl-lock'

/**
 * The hard cap on a committed text value. A `contenteditable` accepts an unbounded paste, and the
 * slide source is re-parsed and re-instrumented on every commit, so an unbounded value is a cheap way
 * to wedge the editor. 64 KiB is far past any real slide's text and far short of a problem.
 *
 * The cap **refuses**, it never truncates. Truncating made the guard itself the data loss it was
 * meant to prevent: an element holding 70 000 characters, edited anywhere, had its whole text
 * replaced by the first 65 536 — 4 465 authored characters deleted with no warning (round-3 review,
 * measured). So an element whose text is already over the cap is not editable at all
 * (`isTextEditable`), and an over-cap value arriving from the frame is refused at the commit
 * (`resolveTextEdit`), leaving the source exactly as it was.
 */
export const MAX_TEXT_LENGTH = 65_536

/**
 * Why a caret will not open on an element: it is not a text-bearing tag, it is `data-sl-lock`ed, it
 * holds mixed inline content M3.11 cannot edit as plain text, its text is already past the cap, or
 * the id is not on this slide. Distinct from `TextEditRefusal`, which is about a value the user has
 * already typed rather than about whether they may start typing.
 */
export type TextEditBlock = 'not-text' | 'locked' | 'mixed-content' | 'too-long' | 'unknown-element'

/**
 * Whether an element can be edited in place — the definition of §3.2's undefined `editableText`.
 *
 * Narrower than `textOnly` in three ways that matter: the element must render as **one** DOM node,
 * the tag must parse its content as character data (see `NON_EDITABLE_TAGS`), and the element must
 * not be `data-sl-lock`ed.
 *
 * The one-node rule is about the adoption agency. `<p><b>x</p><p>y</b></p>` is one source `<b>`
 * rendered as two `<b>` nodes with different text, both carrying the same `data-sl-id`; the frame
 * can only put the caret in one of them and the map cannot say which one the user double-clicked, so
 * a session there edits text the user may not have been looking at. `minDomNodeCount` is a lower
 * bound, so this refuses the clones it can see; the ones it cannot (a clone the parser gave no
 * location) leave the source element with bytes its text nodes do not cover, which `textOnly`
 * already refuses.
 *
 * Mixed inline content (`<p>Revenue rose <b>18%</b></p>`) is **out of scope for M3.11** and returns
 * `false` here. §9.3 routes it through rich-text editing that returns `innerHTML`, which is exactly
 * the payload §2.2 forbids acting on authoritatively — reconciling the two needs its own milestone.
 * Refusing is the honest behaviour: replacing that element's content as plain text would silently
 * delete the `<b>`.
 */
export function isTextEditable(element: ElementSpan): boolean {
  return textEditBlock(element) === null
}

/**
 * Why an element cannot take a caret, or `null` when it can — `isTextEditable` with its reason kept.
 *
 * The reason exists so the refusal can be *said*: a double-click that opens nothing and explains
 * nothing is the report M3.11 was written to answer (round-5 major), and these four cases want four
 * different sentences. `null` for the element means the id is not in the current map at all.
 *
 * Order is by what is most worth telling the user, not by cost: a `<script>` is never prose whatever
 * it contains, and a locked element stays locked whatever is inside it, so both are reported ahead of
 * the mixed-content rule that would otherwise absorb them.
 */
export function textEditBlock(element: ElementSpan | null): TextEditBlock | null {
  if (element === null) return 'unknown-element'
  if (NON_EDITABLE_TAGS.has(element.tagName)) return 'not-text'
  if (element.attrs[LOCK_ATTR] !== undefined) return 'locked'
  // No `inner` span at all is a void element (`<img>`): there is nothing between its tags to type
  // into, which is a different thing to say than "this has formatting in it".
  if (element.inner === null) return 'not-text'
  if (!element.textOnly || element.minDomNodeCount !== 1) return 'mixed-content'
  // Text already past the cap is read-only rather than lossy: no caret opens, the overlay says why,
  // and the property panel keeps its own (unbounded) text field. See `MAX_TEXT_LENGTH`.
  if ((element.textContent?.length ?? 0) > MAX_TEXT_LENGTH) return 'too-long'
  return null
}

/**
 * Characters stripped from a committed value: the C0 controls except tab and newline, `DEL`, the C1
 * controls, and the Unicode line/paragraph separators.
 *
 * These are invisible in the editor but meaningful to a parser or a diff, so they are exactly the
 * payload a forged commit would use to smuggle bytes past a reviewer reading the rendered slide.
 * Tab and newline survive because a paste can legitimately contain them and both are ordinary
 * whitespace in a text node.
 */
// oxlint-disable-next-line no-control-regex -- stripping control characters is the point.
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u2028\u2029]/g

/**
 * A high surrogate not followed by a low one, or a low surrogate not preceded by a high one. A lone
 * surrogate cannot be encoded as UTF-8, so the save would write U+FFFD in its place and edit → save →
 * reopen would not be identity. Replacing it here makes the bytes the same before and after the
 * save. Only reachable through a paste or author JS — a keyboard never produces one.
 */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g

/**
 * Normalize a raw string that arrived from the frame into the text we are willing to write.
 *
 * Line endings are normalized to `\n` (a Windows paste carries `\r\n`, and a stray `\r` in source is
 * a diff hazard), control characters are stripped, and lone surrogates become U+FFFD. Nothing else is
 * "cleaned": the user's spaces, punctuation and non-ASCII are theirs, and `escapeText` deliberately
 * leaves non-ASCII alone so "Café" stays "Café" in source.
 *
 * Length is **not** touched here. This function runs on both sides of the "did the text change?"
 * comparison, so a truncating sanitizer compared a cut value against a cut value and then wrote the
 * cut value into the source — see `MAX_TEXT_LENGTH`. The cap is a refusal in `resolveTextEdit`,
 * not a normalization.
 */
export function sanitizeEditedText(raw: string): string {
  return raw.replace(/\r\n?/g, '\n').replace(CONTROL_CHARS, '').replace(LONE_SURROGATE, '\uFFFD')
}

/**
 * Characters that render as nothing or as an ordinary space, written as references so a reader of
 * the source can tell them from a plain space or from nothing at all.
 *
 * The frame hands back decoded text, so an author's `&nbsp;` arrives as U+00A0 and would otherwise
 * be written back raw — an invisible byte in a file people diff and edit by hand. `&nbsp;` is the
 * spelling authors use; the rest have no common name and get numeric references.
 */
const INVISIBLE_AS_REFERENCE: ReadonlyMap<string, string> = new Map([
  ['\u00A0', '&nbsp;'],
  ['\u00AD', '&#173;'],
  ['\u200B', '&#8203;'],
  ['\u200C', '&#8204;'],
  ['\u200D', '&#8205;'],
  ['\u2060', '&#8288;'],
  ['\uFEFF', '&#65279;'],
])

/**
 * Escape `text` for a text-node position **and** break any SL-S04 forbidden token, in one pass.
 *
 * One pass rather than "escape, then neutralize" for a specific correctness reason: a second scan
 * would run over text that already contains `&amp;`/`&lt;`, so a token match could in principle begin
 * *inside* an entity, and rewriting its first character would corrupt that entity — turning a `<` the
 * user typed into the literal text `&lt;`. Scanning the raw text and emitting the escaped form only
 * for characters that are not break points makes that unrepresentable.
 *
 * For text containing no forbidden token and none of `INVISIBLE_AS_REFERENCE` this is **exactly**
 * `escapeText` — asserted over a corpus in the unit tests, so the two can never drift into
 * disagreeing about `&`, `<` or `]]>`.
 */
export function escapeAndNeutralizeText(text: string): string {
  const breaks = forbiddenBreakPoints(text)
  let out = ''
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!
    if (breaks.has(index)) {
      // A numeric reference decodes back to exactly this character, so the rendered text is
      // unchanged; the bytes no longer spell the token.
      out += `&#${String(char.codePointAt(0) ?? 0)};`
      continue
    }
    const invisible = INVISIBLE_AS_REFERENCE.get(char)
    if (invisible !== undefined) out += invisible
    else if (char === '&') out += '&amp;'
    else if (char === '<') out += '&lt;'
    // `>` only needs escaping where it would close a `]]>` run — matching `escapeText` exactly.
    else if (char === '>' && index >= 2 && text[index - 1] === ']' && text[index - 2] === ']') {
      out += '&gt;'
    } else out += char
  }
  return out
}

/**
 * Why an edit did not become bytes. Only the `refused` reasons are worth telling the user about;
 * `unchanged` is the overwhelmingly common outcome (double-click, look, leave) and saying anything
 * about it would be noise.
 */
export type TextEditRefusal = 'too-long' | 'not-editable' | 'unknown-element' | 'forbidden-token'

/** What `resolveTextEdit` decided: bytes to write, nothing to do, or a refusal with its reason. */
export type TextEditOutcome =
  | { readonly kind: 'patched'; readonly source: string }
  | { readonly kind: 'unchanged' }
  | { readonly kind: 'refused'; readonly reason: TextEditRefusal }

/**
 * Turn a committed text value into patched slide source, saying *why* when it does not.
 *
 * Nothing is written — the document and the undo stack are untouched — when the sl-id is unknown to
 * the map, the element is not editable, the value is over `MAX_TEXT_LENGTH`, the text is unchanged
 * (a no-op edit must never consume a Ctrl+Z), the patch would change no bytes, or the patched source
 * would gain an SL-S04 forbidden token the original did not have.
 *
 * The reason exists because a refusal used to be indistinguishable from "nothing to do" at the call
 * site, so the caller silently dropped the edit while the frame went on displaying the text it had
 * rejected — a 70 000-character paste read as accepted right up until an unrelated slide switch
 * reverted it (round-4 major). A caller that knows it refused can put the frame back and say so.
 *
 * `slId` is the **parent-tracked** selection id and `source` is the parent's current bytes: per §2.2
 * neither may come from a bridge payload. The only payload-derived input is `rawText`.
 */
export function resolveTextEdit(map: SlideMap, slId: string, rawText: string): TextEditOutcome {
  const element = resolveElement(map, slId)
  // Two different answers, because the user is told which. An id the map has never had means the
  // slide moved under the edit; an element that *is* there but has no text-node span of its own —
  // mixed inline content, a void tag — was simply never editable.
  if (element === null) return { kind: 'refused', reason: 'unknown-element' }
  if (element.inner === null || element.textContent === null || !isTextEditable(element)) {
    return { kind: 'refused', reason: 'not-editable' }
  }
  // Refuse an over-cap value rather than trimming it to fit — see `MAX_TEXT_LENGTH`. Measured on the
  // raw string, before sanitizing, so the guard cannot be walked past with control characters that
  // the sanitizer would strip back under the cap.
  if (rawText.length > MAX_TEXT_LENGTH) return { kind: 'refused', reason: 'too-long' }

  const text = sanitizeEditedText(rawText)
  // "Unchanged" is judged on what the user saw, never on bytes: the frame returns decoded text, so
  // against the raw span `a&nbsp;b` would always look edited, and double-click + Esc on any element
  // holding an entity would push a phantom undo entry, dirty the document and rewrite the author's
  // entities. The same sanitizer runs on both sides so a stray control character in the source
  // cannot make an untouched edit look like a change either.
  if (text === sanitizeEditedText(element.textContent)) return { kind: 'unchanged' }

  const source = map.source
  // `<pre>` and `<listing>` lose a leading newline when parsed, so `element.textContent` — and the
  // value the frame hands back for the same element — is already one `\n` short of what `inner`
  // spells. Writing the committed string raw makes the read and the write non-inverse: source
  // `<pre>\n\nHello</pre>` reads as "\nHello", and committing "\nHello!" wrote `<pre>\nHello!</pre>`,
  // which reads back as "Hello!" — the blank first line silently deleted by an unrelated edit
  // (round-3 review, verified by execution). One extra literal newline compensates the drop.
  //
  // It has to be a *literal* newline. The parser drops `&#10;` at the same position, but
  // `slide-map.ts`'s cursor does not advance over a character reference, so the text nodes would
  // stop tiling `inner` and the element would come back `textOnly: false` — this edit would make its
  // own target uneditable.
  const compensateDroppedNewline =
    LEADING_NEWLINE_DROPPED.has(element.tagName) && text.startsWith('\n')
  const written = (compensateDroppedNewline ? '\n' : '') + escapeAndNeutralizeText(text)
  const patched = applyOps(source, [{ kind: 'replaceSpan', span: element.inner, text: written }])

  // A patch that changes no byte is not an edit. `useTextEditing` only checks for `null`, so
  // returning identical bytes would push an undo entry that undoes nothing, dirty the document, bump
  // the revision and reload the frame — the exact opposite of the "a no-op edit must never consume a
  // Ctrl+Z" contract above. Reachable when the decoded-text comparison says "changed" but the written
  // bytes land identical, which is what the uncompensated `<pre>` newline used to do.
  if (patched === source) return { kind: 'unchanged' }

  // The guarantee (see the file header). Neutralization is best-effort UX; this is the invariant.
  // A *subset* check, not "is empty": a slide that already violated SL-S04 elsewhere is still
  // editable, it just may not get worse.
  //
  // With the neutralizer folding case the way the validator does, no text reaches this branch
  // through a real map: the bytes around a text-only `inner` are `>` and `<`, no token contains
  // either, and every token *within* the text is broken. What pins it is a map whose `inner` is not
  // a text-node context (the unit test hands it one) — the shape a future change to `slide-map.ts`
  // could produce, and the failure it prevents (a slide that no longer passes its own validator)
  // is silent at the point of edit.
  const before = new Set(findForbiddenApiTokens(source))
  if (findForbiddenApiTokens(patched).some((token) => !before.has(token))) {
    return { kind: 'refused', reason: 'forbidden-token' }
  }

  return { kind: 'patched', source: patched }
}

/** Elements whose character data is never rendered as text: nothing in them is "visible text". */
const INVISIBLE_TEXT_TAGS: ReadonlySet<string> = new Set([
  'style',
  'script',
  'template',
  'noscript',
])

/**
 * Whether the element's subtree holds any visible text — decided over the **parsed** text nodes of
 * its inner bytes, not a regex over the markup, so a `<style>` rule or a `>` inside a quoted
 * attribute is not mistaken for prose (round-1 minor). Used by M3.6's flip to know when the mirrored
 * glyphs deserve a notice; a fragment parse is enough here because text nodes survive it even where
 * a context-dependent element (`<td>` outside a table) does not.
 */
export function hasVisibleText(source: string, element: ElementSpan): boolean {
  if (element.inner === null) return false
  const fragment = parseFragment(source.slice(element.inner.start, element.inner.end))
  const stack: DefaultTreeAdapterTypes.ChildNode[] = [...fragment.childNodes]
  for (let node = stack.pop(); node !== undefined; node = stack.pop()) {
    if ('value' in node) {
      if (/\S/.test(node.value)) return true
    } else if ('childNodes' in node && !INVISIBLE_TEXT_TAGS.has(node.nodeName)) {
      stack.push(...node.childNodes)
    }
  }
  return false
}
