/**
 * The one path by which text enters slide HTML: escape it, then make it unmatchable by SL-S04.
 *
 * Every module that emits a slide document — the starter slide, the DrawingML converter and the
 * importer's text-only fallback — puts text through `slideText`. Nothing else may spell the pair,
 * and `escapeHtml` on its own is reserved for values that are provably not text (a generated slide
 * id, a `data:` URI whose MIME type was allow-listed). That rule is enforced by
 * `tests/unit/import/slide-text-boundary.test.ts`, which derives its rows from the source.
 *
 * ## Why one module and not a convention
 *
 * M4.5 review rounds 1, 2 and 3 each found the same defect — text that was escaped but not defused
 * — at a different emission site: a text run, then the typeface attribute, then the template's
 * `dc:title` reaching the starter slide through `createStarterSlideHtml`, which `escapeHtml`'d it
 * because the defuser lived in the import package and the starter slide could not reach it without
 * an import cycle. A convention maintained by review re-discovers the same hole each round; a
 * module the emitters all import from, sitting beside the contract it satisfies, does not.
 *
 * ## Why the matcher is not defined here either
 *
 * Round 5 found the defect one layer down: this module *did* import the rule's list and
 * normalisation, but built its own matcher on top of them with the RegExp `i` flag — whose case
 * fold disagrees with the validator's `toLowerCase()` on U+212A KELVIN SIGN — so `WebSocKet`
 * was flagged by the validator and missed by the defuser, and one word made a deck unopenable. The
 * matcher now lives in `forbidden-apis.ts` as `forbiddenBreakPoints`, beside the list and the
 * normalisation, and is the same function Design Mode's text editor uses.
 */

import { forbiddenBreakPoints } from './forbidden-apis'

export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

/**
 * HTML-escape a text node or attribute value, then make it unmatchable by SL-S04's scan — without
 * changing what the text says.
 *
 * SL-S04 forbids `fetch(`, `localStorage`, `eval(` and friends by scanning the whole slide source
 * with whitespace stripped and case folded. For an authored slide that is exactly right. For text
 * that merely *mentions* them it produces a false positive on ordinary prose: a deck about
 * JavaScript whose title reads "Use fetch() instead of XMLHttpRequest" is perfectly inert — the
 * words sit in a text node, there is no `<script>` in the document at all (`capabilities:
 * ['static']`, and SL-H01/I02 enforce that separately) — but the scan cannot see context and
 * rejects it. Before this, such a deck failed conversion, failed the text-only fallback for the same
 * reason, and failed the import outright with `unconvertible`. That is a real deck a real user has.
 *
 * The fix is to make the *bytes* unmatchable while leaving the *rendering* identical: the first
 * character of each occurrence becomes a numeric character reference. `fetch(` is emitted as
 * `&#102;etch(`, which a browser renders as "fetch(" and a substring scan does not match. Nothing
 * is removed, nothing is altered on screen, and no rule is weakened — a document that genuinely
 * contained script would still carry `<script>`, which SL-H01 rejects independently.
 *
 * The break points are found on the *raw* text and the escaping is applied in the same pass, so a
 * match can never begin inside an entity the escaping produced and rewrite one of its characters.
 */
export function slideText(value: string): string {
  const breaks = forbiddenBreakPoints(value)
  if (breaks.size === 0) return escapeHtml(value)
  let out = ''
  for (let index = 0; index < value.length; index += 1) {
    out += breaks.has(index)
      ? `&#${String(value.charCodeAt(index))};`
      : escapeHtml(value.charAt(index))
  }
  return out
}
