/**
 * `patch.ts` — the write-back primitive for Design Mode's local property panel (§1.4 of
 * `.claude/plans/init/40-design-mode.md`). Every zero-LLM parametric edit funnels through here:
 * a field value becomes a set of span-anchored `SourceOp`s, and `applyOps` splices them into the
 * **original** source to produce the patched source that a `slide.setHtml` command then commits.
 *
 * ## Why this is pure, and why that matters
 *
 * Nothing here touches the DOM, the bridge, React or the store. The input is a string and a list
 * of ops anchored to spans *in that string*; the output is a new string. That is what lets the
 * whole "field value → source edit → new source" pipeline be exhaustively unit-tested against the
 * same hostile corpus `buildSlideMap` is tested on, with no browser in the loop.
 *
 * ## The one invariant `applyOps` enforces: non-overlap
 *
 * `ElementSpan` spans of *different elements* can partially overlap (see the long note on
 * `ElementSpan.outer` in `types.ts` — EOF-implied parents and mis-nested formatting both produce
 * it, on ordinary model slides). So a multi-op patch cannot assume tree containment makes its ops
 * disjoint; it must be checked. `applyOps` sorts descending by offset and throws `PatchOverlapError`
 * the moment two ops would rewrite the same byte, rather than silently corrupting the slide. This
 * assertion is load-bearing and must never be relaxed to "they're nested anyway".
 *
 * Applying descending-by-offset is what keeps every op's offsets valid without bookkeeping: a
 * splice at a high offset never shifts a lower one, so the map's spans keep describing the source
 * they were derived from right up until the whole patch lands.
 */

import type { AttrSpan, ElementSpan, Span } from './types'
import {
  getDeclaration,
  parseDeclarations,
  serializeDeclarations,
  upsertDeclaration,
} from './style'

/**
 * A span-anchored edit against the original source.
 *
 *  - `replaceSpan` — overwrite `[span.start, span.end)` with `text` (attribute value, text content).
 *  - `insertAt` — insert `text` at `at`, a zero-length edit (a new attribute).
 *  - `deleteSpan` — remove `[span.start, span.end)` (an attribute and its leading space).
 */
export type SourceOp =
  | { readonly kind: 'replaceSpan'; readonly span: Span; readonly text: string }
  | { readonly kind: 'insertAt'; readonly at: number; readonly text: string }
  | { readonly kind: 'deleteSpan'; readonly span: Span }

/** Thrown when two ops in one patch would rewrite the same byte. Carries the offending offsets. */
export class PatchOverlapError extends Error {
  readonly a: Span
  readonly b: Span
  constructor(a: Span, b: Span) {
    super(
      `Overlapping source ops: [${String(a.start)},${String(a.end)}) and ` +
        `[${String(b.start)},${String(b.end)})`,
    )
    this.name = 'PatchOverlapError'
    this.a = a
    this.b = b
  }
}

/** Normalize every op to a half-open `[start, end)` replace so applying is one code path. */
function normalize(op: SourceOp): { start: number; end: number; text: string } {
  switch (op.kind) {
    case 'replaceSpan':
      return { start: op.span.start, end: op.span.end, text: op.text }
    case 'insertAt':
      return { start: op.at, end: op.at, text: op.text }
    case 'deleteSpan':
      return { start: op.span.start, end: op.span.end, text: '' }
  }
}

/** Two half-open ranges overlap when each starts before the other ends. Touching is not overlap. */
function overlaps(a: { start: number; end: number }, b: { start: number; end: number }): boolean {
  return a.start < b.end && b.start < a.end
}

/**
 * Apply `ops` to `source` and return the patched string. Throws `PatchOverlapError` if any two ops
 * overlap. An empty op list returns the source unchanged (by value; strings are immutable).
 *
 * Ops are applied high-offset-first so earlier offsets stay valid throughout — the source is never
 * mutated in a way that invalidates a not-yet-applied op's span.
 */
export function applyOps(source: string, ops: readonly SourceOp[]): string {
  const normalized = ops.map(normalize)
  // Descending by start; for equal starts, the wider range first, so the overlap check below sees
  // a stable order and a zero-length insert at a boundary sorts predictably against a replace.
  const sorted = normalized.toSorted((a, b) => b.start - a.start || b.end - a.end)

  for (let index = 1; index < sorted.length; index += 1) {
    const previous = sorted[index - 1]!
    const current = sorted[index]!
    if (overlaps(previous, current)) {
      throw new PatchOverlapError(
        { start: current.start, end: current.end },
        { start: previous.start, end: previous.end },
      )
    }
  }

  let result = source
  for (const op of sorted) {
    result = result.slice(0, op.start) + op.text + result.slice(op.end)
  }
  return result
}

/* -------------------------------------------------------------------------------------------- *
 * escaping — write what the author would have written
 * -------------------------------------------------------------------------------------------- */

/**
 * Escape text for an element's content, matching §1.4: escape `&` and `<` only, plus `>` when it
 * would close a `]]>` (which would otherwise terminate a CDATA-like run). Non-ASCII is left as-is
 * so "Café" stays "Café" in source.
 *
 * No production caller since M3.12 moved every user-text write onto `text-edit.ts`'s
 * `escapeAndNeutralizeText`. It stays as that function's **reference implementation**: the tests
 * assert the two agree exactly on text with no forbidden token, which is what keeps the neutralizer
 * from drifting in what it does to `&`, `<` and `]]>`.
 */
export function escapeText(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/]]>/g, ']]&gt;')
}

/**
 * Escape a value for an attribute value context. `setAttr` writes into an existing value span whose
 * quoting is **whatever the author used** — `setAttr` deliberately preserves single quotes (§1.4:
 * "never disturbs the quoting style") — or, for a new attribute, into a double-quoted one. So the
 * escaped value must be safe in *both* quotings: `&`, `"` **and** `'` are all escaped. Escaping the
 * single quote is what stops a value like `blue' onmouseover='alert(1)` from breaking out of a
 * single-quoted attribute and injecting a new one into the saved (and exportable, unsandboxed)
 * slide source. `<`/`>` are legal unescaped inside any attribute value and are left alone.
 *
 * ## Its inverse is `AttrSpan.text`, and every read/write pair must use both
 *
 * This is the *encode* half of an attribute-value boundary whose *decode* half is parse5's
 * tokenizer, surfaced as `AttrSpan.text`. Reading raw bytes and writing through here is not a
 * round trip — it adds a level of escaping per commit, which is precisely how the Content field
 * came to double-escape (M3.12) and how a `font-family: &quot;Georgia&quot;` was rewritten to
 * `font-family: &amp;quot` by an unrelated font-size tweak (M3.18). So a value that will be
 * written back through here is read from `AttrSpan.text`, never sliced out of the source.
 */
export function escapeAttrValue(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

/* -------------------------------------------------------------------------------------------- *
 * span-anchored helpers — build the ops for one element (§1.4 helper table)
 * -------------------------------------------------------------------------------------------- */

/**
 * Ops to set attribute `name` (lowercased key) to `value` on `element`:
 *  - present with a value → replace the value span (quotes untouched);
 *  - present but valueless (`hidden`) → replace the whole attribute with `name="value"`;
 *  - absent → insert ` name="value"` at `attrInsert` (after the tag name).
 *
 * `name` is written verbatim, so callers pass the casing they want in source (`viewBox`, not the
 * lowercased map key). `attrs` is keyed by lowercased name, so pass a lowercased `key` to find it.
 */
export function setAttr(
  element: ElementSpan,
  key: string,
  name: string,
  value: string,
): SourceOp[] {
  const attr: AttrSpan | undefined = element.attrs[key]
  const escaped = escapeAttrValue(value)
  if (attr === undefined) {
    return [{ kind: 'insertAt', at: element.attrInsert, text: ` ${name}="${escaped}"` }]
  }
  if (attr.value === null) {
    return [{ kind: 'replaceSpan', span: attr.whole, text: `${attr.sourceName}="${escaped}"` }]
  }
  return [{ kind: 'replaceSpan', span: attr.value, text: escaped }]
}

/**
 * `;`, `{` and `}` are the characters that end a declaration (or open/close a block) in CSS. A
 * single-property write must never contain one in its *value*: `color` = `red;background:url(x)`
 * would serialize to `color: red;background:url(x)`, which reparses as **two** declarations —
 * silently injecting a sibling property the user did not choose. `isSafeStyleValue` is the guard
 * that keeps a single-property write to a single property.
 */
export function isSafeStyleValue(value: string): boolean {
  return !/[;{}]/.test(value)
}

/**
 * Ops to upsert one inline-`style` declaration on `element`, preserving every other declaration.
 * Reads the element's current *decoded* `style` value (`AttrSpan.text`), upserts `prop`, and
 * either replaces the existing `style` value span or inserts a whole new `style` attribute when
 * there is none.
 *
 * A `value` that could terminate the declaration (contains `;`, `{` or `}`) is **rejected** — the
 * function returns `[]` (a no-op the caller does not commit) rather than let the write inject a
 * second declaration. That is the only way this helper can be misused to change a property the
 * caller did not name, so it is closed here at the one chokepoint every style write funnels through.
 */
export function setStyleProp(
  source: string,
  element: ElementSpan,
  prop: string,
  value: string,
): SourceOp[] {
  return setStyleProps(source, element, [[prop, value]])
}

/**
 * Upsert several inline-`style` declarations in **one** span rewrite. A field whose edit touches more
 * than one property — HTML "stroke", which is `border-color` plus a `border-style` so the border
 * actually renders — cannot call `setStyleProp` twice: each call rewrites the whole `style` value span,
 * so two would produce overlapping ops and `applyOps` would (correctly) throw. This folds every upsert
 * into a single declaration list and emits one op, preserving order and every untouched declaration.
 *
 * The whole batch is rejected (`[]`) if *any* value could terminate a declaration (`;`, `{`, `}`),
 * same guard as `setStyleProp` — a single unsafe value must not sneak in beside safe ones.
 *
 * `entries` are **decoded** values, the same alphabet `readStyleProp` returns: the escaping into
 * attribute-value bytes happens once, in `setAttr`. Re-parsing the raw bytes here and handing them
 * back to that escaper is what rewrote `font-family: &quot;Georgia&quot;, serif` as
 * `font-family: &amp;quot` on the next unrelated edit (M3.18); every untouched declaration now goes
 * out through the same decode → re-emit → escape path, so it comes back saying what it said.
 *
 * `source` is unused for the same reason as in `readStyleProp` — the decoded value lives on
 * `AttrSpan.text` — and is kept so all the `…StyleProp` helpers share one signature.
 */
export function setStyleProps(
  _source: string,
  element: ElementSpan,
  entries: readonly (readonly [prop: string, value: string])[],
): SourceOp[] {
  if (entries.some(([, value]) => !isSafeStyleValue(value))) return []
  let declarations = parseDeclarations(element.attrs['style']?.text ?? '')
  for (const [prop, value] of entries) declarations = upsertDeclaration(declarations, prop, value)
  return setAttr(element, 'style', 'style', serializeDeclarations(declarations))
}

/**
 * Ops to remove one inline-`style` declaration from `element`, preserving every other declaration.
 * Returns `[]` (a no-op) when the element has no `style` attribute or does not declare `prop`.
 *
 * When `prop` was the element's *only* declaration, the whole `style` attribute is deleted —
 * including the single whitespace character before it, so the start tag round-trips to exactly what
 * it was before the attribute ever existed rather than leaving a `style=""` husk. When other
 * declarations remain, the value span is rewritten to just those. This is the counterpart
 * `setStyleProp` needs so that a transform edit which resolves to identity (a rotation back to 0°, a
 * double flip) removes the `transform` cleanly instead of writing an empty declaration.
 */
export function removeStyleProp(source: string, element: ElementSpan, prop: string): SourceOp[] {
  const styleAttr = element.attrs['style']
  // `text === null` is the same condition as `value === null` — `readAttrSpan` sets them together
  // for a valueless attribute, pinned by slide-map.test.ts — so this narrows rather than defaults.
  // A `?? ''` here would read as doubt about an invariant this file's own tests state.
  if (styleAttr === undefined || styleAttr.text === null) return []
  const key = prop.toLowerCase()
  const declarations = parseDeclarations(styleAttr.text)
  const kept = declarations.filter((declaration) => declaration.prop !== key)
  if (kept.length === declarations.length) return []
  // Through `setAttr`, not a bare `replaceSpan`, because `kept` holds **decoded** values: writing
  // them straight into the value span would put a raw `"` inside a double-quoted attribute and
  // end it early — `style="font-family: "Georgia", serif"` truncates to `font-family: `. The
  // escape belongs on this path for the same reason it belongs on `setStyleProps`'.
  if (kept.length > 0) return setAttr(element, 'style', 'style', serializeDeclarations(kept))
  // Nothing left — delete the attribute and its single leading space so the tag is as it was.
  const hasLeadingSpace = styleAttr.whole.start > 0 && /\s/.test(source[styleAttr.whole.start - 1]!)
  const start = hasLeadingSpace ? styleAttr.whole.start - 1 : styleAttr.whole.start
  return [{ kind: 'deleteSpan', span: { start, end: styleAttr.whole.end } }]
}

/**
 * The current value of one inline-`style` declaration, **decoded**, or `null` if unset.
 *
 * Decoded because the `style` attribute holds CSS, and the CSS it holds is what the character
 * references *stand for*, not how they are spelled: the browser sees
 * `font-family: "Georgia", serif` where the bytes say `font-family: &quot;Georgia&quot;, serif`.
 * Parsing the bytes made `;` inside an entity end a declaration, so that attribute read back as
 * `font-family: &quot` with `Georgia&quot;, serif` dropped for having no `:` (M3.18).
 *
 * The value is therefore in the same alphabet as the one `setStyleProp` takes, and the two are
 * inverse: read a declaration, write it back unchanged, and the bytes do not move.
 *
 * `source` is unused — `AttrSpan.text` already carries the decoded value for the map that was
 * built from it — but stays in the signature, which is the one every `…StyleProp` helper shares
 * and which ~15 call sites pass positionally.
 */
export function readStyleProp(_source: string, element: ElementSpan, prop: string): string | null {
  const style = element.attrs['style']
  if (style === undefined || style.text === null) return null
  return getDeclaration(parseDeclarations(style.text), prop)
}

/** The current raw source value of an attribute (quotes stripped, entities NOT decoded), or null. */
export function readAttr(source: string, element: ElementSpan, key: string): string | null {
  const value = element.attrs[key]?.value ?? null
  if (value === null) return null
  return source.slice(value.start, value.end)
}
