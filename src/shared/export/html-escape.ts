/**
 * Escaping for the text the HTML export injects into its generated presenter shell (M4.4).
 *
 * ## Why this is not the PPTX sanitizer
 *
 * PPTX export's problem is that XML 1.0 has characters it simply *cannot represent* — C0 controls,
 * lone surrogates — so its sanitizer **strips** them: the byte has no encoding, so it must go.
 *
 * HTML's problem is the opposite one. Every character is representable; what varies is which of them
 * end a context. `<`, `&`, `"`, `'` are perfectly legal HTML text — they just have to be spelled as
 * references so the parser reads them as data instead of as the start of a tag, an entity, or the end
 * of an attribute value. So this module **escapes** and never strips: a deck titled `A & B <script>`
 * must survive into the shell's heading as those exact visible characters, not as `A  B`.
 *
 * Using the XML stripper here would silently mangle legitimate titles; using this escaper there would
 * emit a well-formed reference to a character XML cannot hold. Different failure, different fix — the
 * two are kept as separate functions on purpose rather than merged into one "sanitize".
 *
 * ## The threat
 *
 * The deck title is model- and user-authored text that lands in three different contexts in a file
 * the user opens *outside* our app, where our `slide://` CSP no longer covers anything. A title of
 * `" onload="alert(1)` or `</title><script>…` must be inert in all three. Each context gets the
 * function that closes it, and the tests assert the breakout attempt for each.
 */

/**
 * Anything `JSON.stringify` is guaranteed to turn into a string.
 *
 * Deliberately excludes `undefined`, functions and symbols — the three inputs for which
 * `JSON.stringify` returns `undefined` rather than a string — and `bigint`, for which it throws.
 * Declared here rather than imported so `html-escape.ts` stays a leaf module with no dependency on
 * the bundle types that happen to be its only caller today.
 */
export type JsonValue =
  string | number | boolean | null | readonly JsonValue[] | { readonly [key: string]: JsonValue }

/**
 * Escape for HTML **text** context (between tags).
 *
 * `&` first — always — or a later replacement's own `&` would be double-escaped into `&amp;lt;`.
 * `<` and `>` cover tag starts; `>` is not strictly required in text but escaping it costs nothing
 * and removes the need to reason about the parser's handling of a stray `>` after a bogus comment.
 *
 * Quotes are escaped here too, so a single function is safe if a caller ever moves a string from text
 * to attribute context. Over-escaping in text is invisible to the reader (the parser resolves the
 * reference back to the character); under-escaping in an attribute is an XSS. The asymmetry decides.
 */
export function escapeHtmlText(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/**
 * Escape for HTML **attribute value** context. Identical to text escaping — quotes included — which
 * is the point: the shell quotes every attribute it emits with `"`, and `&quot;` closes the only
 * breakout that matters. Kept as a distinct named export so call sites document which context they
 * are in, and so the two can diverge later without hunting for every caller.
 */
export function escapeHtmlAttribute(value: string): string {
  return escapeHtmlText(value)
}

/**
 * Serialize a value for embedding in `<script type="application/json">…</script>`.
 *
 * The manifest is inlined rather than fetched because `fetch('deck.json')` from `file://` is blocked
 * by the opaque-origin rule (60-export.md §5.2) — so this string is written straight into the
 * document, and the HTML parser, not the JSON parser, sees it first.
 *
 * That parser is scanning raw text for `</script`. Nothing else terminates the block: not `</title`,
 * not a quote, not a newline. So the one escape that is load-bearing is `<`, and encoding it as the
 * JSON escape `<` is exactly right — it is still valid JSON, `JSON.parse` yields the identical
 * string back, and no `</script` sequence can survive because its `<` is gone. `>` and `&` are
 * escaped alongside for the same cost, which also neutralizes the `<!--` / `-->` comment-state trick
 * that historically confused script-block scanners.
 *
 * U+2028 / U+2029 are escaped because they are literal line terminators in JavaScript source; JSON
 * itself tolerates them, but a downstream tool that hands this block to a JS parser would break on
 * them. Cheap insurance for a string that has already left our process.
 *
 * ## Why the parameter is `JsonValue` and not `unknown`
 *
 * `JSON.stringify` does not return a string for every input: `undefined`, a function, and a symbol
 * all serialize to `undefined`, so an `unknown` parameter let a caller reach `.replace()` on
 * `undefined` and get an opaque `TypeError` thrown from inside an escaper. Nothing in the codebase
 * does that \u2014 the only call site passes a `BundleManifest` \u2014 but a parameter typed `unknown` is an
 * open invitation to the call that breaks it, so the type now says what the function actually
 * accepts and the compiler refuses the rest.
 *
 * Narrowing cannot express *acyclicity*, so the one runtime failure left is a cyclic object. That is
 * a programmer error rather than bad user data (the manifest is built here, not received), so it
 * fails loudly with a message naming the cause instead of a `TypeError` from a regex call.
 */
export function encodeJsonForScriptBlock(value: JsonValue): string {
  let json: string
  try {
    json = JSON.stringify(value)
  } catch (error) {
    throw new Error(
      `cannot embed a non-serializable value in a script block: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error },
    )
  }
  return json
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')
}
