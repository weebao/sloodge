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
 * Ops to upsert one inline-`style` declaration on `element`, preserving every other declaration.
 * Reads the current `style` value from source (via the map), upserts `prop`, and either replaces
 * the existing `style` value span or inserts a whole new `style` attribute when there is none.
 */
export function setStyleProp(
  source: string,
  element: ElementSpan,
  prop: string,
  value: string,
): SourceOp[] {
  const styleAttr = element.attrs['style']
  const styleValue = styleAttr?.value ?? null
  const current = styleValue === null ? '' : source.slice(styleValue.start, styleValue.end)
  const next = serializeDeclarations(upsertDeclaration(parseDeclarations(current), prop, value))
  return setAttr(element, 'style', 'style', next)
}

/** The current source value of one inline-`style` declaration, or `null` if unset. */
export function readStyleProp(source: string, element: ElementSpan, prop: string): string | null {
  const styleValue = element.attrs['style']?.value ?? null
  if (styleValue === null) return null
  const current = source.slice(styleValue.start, styleValue.end)
  return getDeclaration(parseDeclarations(current), prop)
}

/** The current raw source value of an attribute (quotes stripped, entities NOT decoded), or null. */
export function readAttr(source: string, element: ElementSpan, key: string): string | null {
  const value = element.attrs[key]?.value ?? null
  if (value === null) return null
  return source.slice(value.start, value.end)
}

/**
 * Op to replace an element's text content. Valid only when `element.textOnly` and it has an `inner`
 * span (guaranteed together — a void element is never `textOnly`). Returns `null` when the element
 * cannot hold plain text, so a caller can disable the field rather than corrupt mixed content.
 */
export function setTextContent(element: ElementSpan, text: string): SourceOp | null {
  if (!element.textOnly || element.inner === null) return null
  return { kind: 'replaceSpan', span: element.inner, text: escapeText(text) }
}
