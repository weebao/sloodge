/**
 * The runtime APIs a slide may not contain (SL-S04), the normalisation they are matched under, the
 * scan that decides the rule and the whitespace-tolerant matcher the two writers of slide text
 * defuse with — kept in a leaf module of its own, importing nothing.
 *
 * ## Do not give this module a dependency
 *
 * Not a style preference; it is load-bearing, and it is the reason the module exists at all. This
 * file is reachable from the **preload** bundle, which Electron builds `sandbox: true`. A sandboxed
 * preload cannot `require` an external module, and the failure is silent: the preload does not throw
 * anywhere visible, `contextBridge.exposeInMainWorld` simply never runs, `window.sloodge` comes up
 * `undefined`, and the renderer takes its no-Electron fallback — no slide protocol, no agent, no
 * export, in the packaged app only, with the entire unit suite still green.
 *
 * That is not hypothetical: M3.10's font bridge first read this list from `slide-contract.ts`, which
 * imports `parse5` and the zod deck schema, and the built app came up with no bridge at all. So the
 * list lives here, with no imports, and both consumers reach *in*:
 *
 *   - `slide-contract.ts` (the validator), which may import whatever it likes;
 *   - `shared/fonts/family.ts` (a writer that refuses a value which would trip SL-S04 before
 *     committing it), which is on the preload's import graph and may not;
 *   - `shared/document/slide-text.ts` and `shared/design/text-edit.ts`, the two writers of slide
 *     text, which take the matcher from here rather than through parse5.
 *
 * If a later branch wants the tokens in `slide-contract.ts` instead — an `export const` there is the
 * obvious shape and two sibling milestones each proposed it — that re-creates the bug the moment any
 * preload-reachable module consumes it. Add to this file; do not move it back.
 * `tests/unit/preload/preload-bundle-deps.test.ts` is what notices if someone does.
 *
 * ## `slide-contract.ts` re-exports the rule; it does not declare it
 *
 * M3.11 landed first with its own `FORBIDDEN_API_TOKENS`, `packForApiScan` and
 * `findForbiddenApiTokens` in `slide-contract.ts`, and rebasing M3.10 onto it left both sets
 * standing — the duplicated predicate the note on `packForApiScan` below exists to forbid, put back
 * by a merge. Nothing noticed. Measured in that state: `pnpm typecheck` exits 0, 188 test files
 * pass, `PRELOAD_BUNDLE_REQUIRED=1` gives 20/20. So the invariant is checked, not kept by review:
 * the `SL-S04 scan` block in `tests/unit/preload/preload-bundle-deps.test.ts` fails if
 * `slide-contract.ts` declares any of the five names at module scope under any spelling, names one
 * anywhere else but its two remaining calls, takes one from anywhere but here, or `export *`s from
 * anywhere but here.
 *
 * M4.5 then landed the matcher — `tokenPattern`, `TOKEN_PATTERNS`, `foldForScan`,
 * `forbiddenBreakPoints` — in `slide-contract.ts` too, and it followed the list here on the rebase
 * for a mechanical reason rather than a stylistic one: `tokenPattern` calls `packForApiScan` and
 * `TOKEN_PATTERNS` maps `FORBIDDEN_API_TOKENS`, so leaving the matcher behind would mean importing
 * both names back into `slide-contract.ts` — the two the count pin holds at their single legitimate
 * call. `cssPacked` in the SL-G05 viewport-unit check is that call for `packForApiScan`; it is not
 * part of the matcher and stayed.
 *
 * The shape it holds `slide-contract.ts` to: import from `'./forbidden-apis'` every name it calls
 * itself — `export … from` binds nothing — and re-export all five, so importers written against it
 * keep compiling; `shared/design/text-edit.ts` and `shared/document/slide-text.ts` take what they
 * need from here directly rather than through a module that pulls in parse5. If a merge ever puts a
 * second copy back, `pnpm typecheck` (CI runs unit tests only) and
 * `pnpm vitest run tests/unit/preload/preload-bundle-deps.test.ts` are what say so.
 *
 * `tokenPattern`'s regex is built from a string, so `tests/unit/import/regex-linearity.test.ts`
 * cannot see it as a literal — this file is in that test's `ARCHIVE_INPUT_MODULES` all the same, so
 * the literals that came with the matcher stay under the linearity heuristic.
 */

/**
 * The normalisation SL-S04 matches under: **all whitespace stripped**, lowercased. So a value
 * containing `Local Storage` counts as `localStorage`, and spaces do not separate tokens.
 *
 * Shared rather than re-implemented by each caller, because the guard in `family.ts` is only correct
 * while its packing is *identical* to the validator's — a duplicated predicate drifts narrower than
 * the rule it mirrors, and the drift shows up as a slide the app happily writes and then rejects.
 */
export function packForApiScan(value: string): string {
  return value.replace(/\s+/g, '').toLowerCase()
}

export const FORBIDDEN_API_TOKENS: readonly string[] = [
  'fetch(',
  'XMLHttpRequest',
  'WebSocket',
  'EventSource',
  'sendBeacon',
  'localStorage',
  'indexedDB',
  'document.cookie',
  'alert(',
  'confirm(',
  'prompt(',
  'eval(',
  'new Function(',
]

/**
 * The forbidden tokens `value` contains, under SL-S04's own packing. Asked by the validator deciding
 * SL-S04 and by the writers that refuse to produce a slide it would then reject — see the note on
 * `packForApiScan` for why they share one scan instead of each carrying their own.
 */
export function findForbiddenApiTokens(value: string): string[] {
  const packed = packForApiScan(value)
  return FORBIDDEN_API_TOKENS.filter((token) => packed.includes(packForApiScan(token)))
}

/**
 * A whitespace-tolerant matcher for one forbidden token, built from the token's **packed** form.
 *
 * The validator scans `packForApiScan(source)` for `packForApiScan(token)`, so anything that
 * rewrites text to *avoid* that scan must match exactly the spellings that reach the packed form:
 * every character of the *packed* token, in order, with any whitespace between any two of them.
 * Packing the token first is load-bearing for `new Function(` — spelling the pattern from the raw
 * token would make its space a *required* literal, so `newFunction(` would slip past (M4.5 review
 * round 1). Case is handled by folding the *text* (`foldForScan`), not by the `i` flag: the flag's
 * fold and `toLowerCase()`'s differ outside ASCII — `/k/i` does not match U+212A KELVIN SIGN,
 * `'\u212A'.toLowerCase()` is `k` — and it is `toLowerCase()` the validator applies (M4.5 review
 * round 5: a `.pptx` whose prose read `WebSoc\u212Aet` was defused by neither the importer nor the
 * fallback and refused the whole deck).
 */
function tokenPattern(token: string): RegExp {
  return new RegExp(
    [...packForApiScan(token)]
      .map((char) => char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('\\s*'),
    'g',
  )
}

const TOKEN_PATTERNS: readonly RegExp[] = FORBIDDEN_API_TOKENS.map(tokenPattern)

/**
 * `text` lowercased the way `packForApiScan` lowercases it, but **code unit for code unit**, so an
 * index into the folded string is an index into the original.
 *
 * `toLowerCase()` on the whole string would not give that: `İ` (U+0130) lowercases to two code
 * units, shifting every later index. A character whose lowercase is not exactly one code unit is
 * kept as-is — it cannot be a letter of an ASCII token anyway, and the validator's fold of it puts a
 * combining mark between the letters, so the validator does not see a token there either.
 */
export function foldForScan(text: string): string {
  let out = ''
  for (const char of text) {
    const lower = char.toLowerCase()
    out += lower.length === 1 ? lower : char
  }
  return out
}

/**
 * The indices in `text` at which a forbidden-token match begins — the characters that must be
 * written as numeric references to break the token.
 *
 * This is the one matcher for SL-S04's rule. Both writers of slide text consume it — the importer's
 * `slideText` (prose from a `.pptx`) and Design Mode's text editor (prose the user typed) — so the
 * rule has one list, one normalisation and one matcher, and a spelling the validator flags is a
 * spelling both writers defuse.
 *
 * Every token is ASCII, so a break index always lands on a single-code-unit character and never
 * splits a surrogate pair — a match can only start at a character that folds to an ASCII letter.
 */
export function forbiddenBreakPoints(text: string): ReadonlySet<number> {
  const folded = foldForScan(text)
  const breaks = new Set<number>()
  for (const pattern of TOKEN_PATTERNS) {
    pattern.lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = pattern.exec(folded)) !== null) {
      breaks.add(match.index)
      // Overlapping matches matter: `eval(` inside a longer run must still be found, so the scan
      // resumes one character past the start rather than past the whole match.
      pattern.lastIndex = match.index + 1
    }
  }
  return breaks
}
