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
 */

import { FORBIDDEN_API_TOKENS, packForApiScan } from './slide-contract'

export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

/**
 * One matcher per forbidden token, derived from `slide-contract.ts`'s **own** list and **own**
 * normalisation rather than a copy of either.
 *
 * The first version of this restated both, and got the normalisation wrong in exactly one place:
 * it split each token on characters and joined with `\s*`, so the literal space inside
 * `new Function(` became a *required* space. SL-S04 strips all whitespace before comparing, so it
 * matched `newFunction(` while the defuser did not — and a slide whose prose read
 * `Avoid newFunction( in modern JavaScript` failed conversion, failed the text-only fallback for
 * the same reason, and took the entire deck import down as `unconvertible`. One innocuous word,
 * one unopenable presentation.
 *
 * So the token is packed with `packForApiScan` first (which is what removes that space), and *then*
 * `\s*` is inserted between every remaining character — because the validator's normalisation means
 * arbitrary whitespace may sit anywhere inside a match. `i` covers the case fold. The list itself is
 * imported, so a token added to the rule later is defused without anyone remembering to mirror it.
 */
const FORBIDDEN_TOKEN_MATCHERS: readonly RegExp[] = FORBIDDEN_API_TOKENS.map(
  (token) =>
    new RegExp(
      packForApiScan(token)
        .split('')
        .map((char) => char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        .join('\\s*'),
      'gi',
    ),
)

/**
 * Defuse SL-S04 token matches in *text content*, without changing what the text says.
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
 * Matching mirrors the validator's own normalisation: whitespace between characters is optional
 * (the scan strips it, so "local storage" packs to "localstorage" and would match) and the compare
 * is case-insensitive. Applied only to text nodes and only after HTML escaping, so it can never
 * introduce markup.
 */
export function defuseForbiddenTokens(escaped: string): string {
  let out = escaped
  for (const matcher of FORBIDDEN_TOKEN_MATCHERS) {
    // `lastIndex` is per-RegExp state and these are module-level `g` objects, so it must be reset
    // before each use or a second call would resume mid-string and miss an early match.
    matcher.lastIndex = 0
    out = out.replace(matcher, (match) => {
      const first = match.codePointAt(0)
      if (first === undefined) return match
      return `&#${String(first)};${match.slice(String.fromCodePoint(first).length)}`
    })
  }
  return out
}

/** HTML-escape a text node or attribute value, then make it unmatchable by SL-S04's scan. */
export function slideText(value: string): string {
  return defuseForbiddenTokens(escapeHtml(value))
}
