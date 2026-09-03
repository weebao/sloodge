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
 * 1. **Target gating** (`isTextEditable`) — only a `textOnly` element with an `inner` span, whose tag
 *    parses its children as ordinary character data, and which is not `data-sl-lock`ed.
 * 2. **Escaping** (`escapeText`, reused from `patch.ts`) — `&` and `<` become entities, so the text
 *    cannot close the element or open a tag. This is what makes HTML/script injection *structurally*
 *    impossible rather than merely filtered: there is no `<` left to start a tag with.
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
 * token. The match is found whitespace-tolerantly (`f\s*e\s*t\s*c\s*h\s*\(`) precisely because the
 * scan packs whitespace out, so `fetch (x)` is caught too.
 *
 * Neutralization is a **UX** measure: it keeps honest prose editable. The **guarantee** is the
 * assertion in `buildTextEditPatch`, which recomputes `findForbiddenApiTokens` over the whole patched
 * source and refuses the edit if it gained a token the original did not have. That catches anything
 * neutralization missed, including a token formed across the boundary between the inserted text and
 * the surrounding source. Both use `slide-contract.ts`'s exported token list and pack function, so
 * there is exactly one definition of the rule in the codebase.
 */

import { findForbiddenApiTokens, FORBIDDEN_API_TOKENS } from '../document/slide-contract'
import { applyOps } from './patch'
import { resolveElement } from './property-model'
import type { ElementSpan, SlideMap } from './types'

/**
 * Tags whose children the HTML parser does **not** treat as ordinary character data, so writing
 * "escaped text" into them does not mean what it means everywhere else.
 *
 * `<script>`, `<style>`, `<xmp>`, `<plaintext>`, `<noscript>` and `<iframe>` are RAWTEXT-ish: an
 * `&lt;` written inside them stays the six literal characters and is never decoded, so *escaping
 * buys nothing there*. `<style>` is the sharpest case and does not even need a `<` to be dangerous —
 * a typed `}` closes the current rule and everything after it is a new one, so a "text edit" would be
 * arbitrary CSS injection into saved, exportable source. `<title>`/`<textarea>` are RCDATA (escaping
 * does work) but are not visible slide content and have no business being edited on canvas.
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
  'iframe',
  'title',
  'textarea',
  'template',
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
 */
export const MAX_TEXT_LENGTH = 65_536

/**
 * Whether an element can be edited in place — the definition of §3.2's undefined `editableText`.
 *
 * Narrower than `textOnly` in two ways that matter: the tag must parse its content as character data
 * (see `NON_EDITABLE_TAGS`), and the element must not be `data-sl-lock`ed.
 *
 * Mixed inline content (`<p>Revenue rose <b>18%</b></p>`) is **out of scope for M3.11** and returns
 * `false` here. §9.3 routes it through rich-text editing that returns `innerHTML`, which is exactly
 * the payload §2.2 forbids acting on authoritatively — reconciling the two needs its own milestone.
 * Refusing is the honest behaviour: replacing that element's content as plain text would silently
 * delete the `<b>`.
 */
export function isTextEditable(element: ElementSpan): boolean {
  if (!element.textOnly || element.inner === null) return false
  if (NON_EDITABLE_TAGS.has(element.tagName)) return false
  return element.attrs[LOCK_ATTR] === undefined
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
 * Normalize a raw string that arrived from the frame into the text we are willing to write.
 *
 * Line endings are normalized to `\n` (a Windows paste carries `\r\n`, and a stray `\r` in source is
 * a diff hazard), control characters are stripped, and the result is capped. Nothing else is
 * "cleaned": the user's spaces, punctuation and non-ASCII are theirs, and `escapeText` deliberately
 * leaves non-ASCII alone so "Café" stays "Café" in source.
 */
export function sanitizeEditedText(raw: string): string {
  return raw.replace(/\r\n?/g, '\n').replace(CONTROL_CHARS, '').slice(0, MAX_TEXT_LENGTH)
}

/** Escape the regex metacharacters in a literal token so it can be spliced into a pattern. */
function escapeRegex(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * A whitespace-tolerant, case-insensitive matcher for one forbidden token.
 *
 * `\s*` between every character mirrors `packForApiScan` removing all whitespace before the scan: to
 * the validator, `fetch (` and `f e t c h (` are `fetch(`, so the neutralizer has to see them the
 * same way. Built per token from `FORBIDDEN_API_TOKENS` — never from a hand-written list.
 */
function tokenPattern(token: string): RegExp {
  return new RegExp([...token].map((char) => escapeRegex(char)).join('\\s*'), 'gi')
}

const TOKEN_PATTERNS: readonly RegExp[] = FORBIDDEN_API_TOKENS.map(tokenPattern)

/**
 * The indices in `text` at which a forbidden-token match begins — the characters that must be
 * written as numeric references to break the token.
 *
 * Every token is ASCII, so a break index always lands on a single-code-unit character and never
 * splits a surrogate pair.
 */
function forbiddenBreakPoints(text: string): ReadonlySet<number> {
  const breaks = new Set<number>()
  for (const pattern of TOKEN_PATTERNS) {
    pattern.lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = pattern.exec(text)) !== null) {
      breaks.add(match.index)
      // Overlapping matches matter: `eval(` inside a longer run must still be found, so the scan
      // resumes one character past the start rather than past the whole match.
      pattern.lastIndex = match.index + 1
    }
  }
  return breaks
}

/**
 * Escape `text` for a text-node position **and** break any SL-S04 forbidden token, in one pass.
 *
 * One pass rather than "escape, then neutralize" for a specific correctness reason: a second scan
 * would run over text that already contains `&amp;`/`&lt;`, so a token match could in principle begin
 * *inside* an entity, and rewriting its first character would corrupt that entity — turning a `<` the
 * user typed into the literal text `&lt;`. Scanning the raw text and emitting the escaped form only
 * for characters that are not break points makes that unrepresentable.
 *
 * For text containing no forbidden token this is **exactly** `escapeText` — asserted over a corpus in
 * the unit tests, so the two can never drift into disagreeing about `&`, `<` or `]]>`.
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
    if (char === '&') out += '&amp;'
    else if (char === '<') out += '&lt;'
    // `>` only needs escaping where it would close a `]]>` run — matching `escapeText` exactly.
    else if (char === '>' && index >= 2 && text[index - 1] === ']' && text[index - 2] === ']') {
      out += '&gt;'
    } else out += char
  }
  return out
}

/**
 * Turn a committed text value into patched slide source, or `null` when the edit must not land.
 *
 * `null` is returned — and the caller commits nothing, leaving the document and the undo stack
 * untouched — when the sl-id is unknown to the map, the element is not editable, the text is
 * unchanged (a no-op edit must never consume a Ctrl+Z), or the patched source would gain an SL-S04
 * forbidden token the original did not have.
 *
 * `slId` is the **parent-tracked** selection id and `source` is the parent's current bytes: per §2.2
 * neither may come from a bridge payload. The only payload-derived input is `rawText`.
 */
export function buildTextEditPatch(map: SlideMap, slId: string, rawText: string): string | null {
  const element = resolveElement(map, slId)
  if (element === null || element.inner === null) return null
  if (!isTextEditable(element)) return null

  const source = map.source
  const text = sanitizeEditedText(rawText)
  const written = escapeAndNeutralizeText(text)
  // Compare against the bytes actually in the span: an edit that retypes the same text — including
  // one that re-normalizes to what is already there — is a no-op, not an undo entry.
  if (written === source.slice(element.inner.start, element.inner.end)) return null

  const patched = applyOps(source, [{ kind: 'replaceSpan', span: element.inner, text: written }])

  // The guarantee (see the file header). Neutralization is best-effort UX; this is the invariant.
  // A *subset* check, not "is empty": a slide that already violated SL-S04 elsewhere is still
  // editable, it just may not get worse.
  //
  // ## Deliberately unpinned, and why
  //
  // No test reds when this branch is deleted, and that is honest rather than an oversight: with the
  // neutralizer in place the branch is **unreachable by construction**. The bytes immediately around
  // an `inner` span are `>` and `<` (the element's own tags), no forbidden token contains either
  // character, and `escapeAndNeutralizeText` breaks every token *within* the inserted text — so
  // there is no way for a patch to introduce a token the original lacked. Removing the neutralizer
  // instead (mutation M2) makes this branch fire and reds the SL-S04 corpus, which is what pins the
  // pair as a whole.
  //
  // It stays because it is the only thing standing between a *future* change and a contract
  // violation in saved, exportable source: a new token containing `<`, a weakened neutralizer, or an
  // `inner` span that stops being a text-node context would each make it reachable, and the failure
  // it prevents (a slide that no longer passes its own validator) is silent at the point of edit.
  const before = new Set(findForbiddenApiTokens(source))
  if (findForbiddenApiTokens(patched).some((token) => !before.has(token))) return null

  return patched
}
