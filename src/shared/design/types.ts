/**
 * Design Mode's source map: the types that connect a `data-sl-id` to the exact stretch of
 * *author* source it came from.
 *
 * This is §1.1-1.2 of `.claude/plans/init/40-design-mode.md`. The whole point is stated in that
 * doc's goal #2: every edit lands as a patch to the slide's original source, never a
 * re-serialization of a DOM. Formatting, comments, attribute order and the model's hand-written
 * whitespace all survive because we never rewrite anything we did not explicitly target.
 *
 * ## Offset semantics — read this before doing arithmetic on a `Span`
 *
 * The plan calls these "byte spans". They are **not** byte offsets. `parse5` tokenizes a
 * JavaScript string, and every offset it reports is a **zero-based UTF-16 code-unit index into
 * that string** — its own `Location` docstring says "zero-based first *character* index". So:
 *
 *  - `source.slice(span.start, span.end)` is always exact, for any input.
 *  - `Café` costs 4 code units, not 5 bytes. `😀` costs **2** code units (a surrogate pair), not
 *    1 and not 4 bytes.
 *  - A `Span` is meaningless against a `Buffer`/`Uint8Array`. Converting to true UTF-8 byte
 *    offsets is a separate transform nobody in the pipeline needs: slides are decoded to a string
 *    once on load (§1.1 of 30-slide-format.md: everything is UTF-8) and every patch is computed
 *    and applied in string space, then encoded back on save.
 *
 * We pin this deliberately rather than inheriting it, because the failure mode is silent: byte
 * math on a slide that happens to be pure ASCII passes every test until the first `—` or emoji.
 *
 * **Line endings are not normalized.** `parse5` reports offsets into the string as given, CRLF
 * included — a `\r\n` is two code units and both are inside the span that contains them. We do
 * not normalize newlines anywhere, so a CRLF slide round-trips byte-identically.
 *
 * **Entities are not decoded.** Every span covers *raw source text*. The value span of
 * `title="a&amp;b"` is `a&amp;b`, seven characters, not the decoded `a&b`. That is the right
 * behaviour for a patcher — it edits what the author wrote — but it means a consumer that wants
 * the semantic value must decode, and a consumer that writes a value must escape.
 */

/** A half-open `[start, end)` range of UTF-16 code units into the original slide source. */
export interface Span {
  start: number
  end: number
}

/** The three namespaces the HTML parser can produce. Tracked per element, not per document. */
export type SlideNamespace = 'html' | 'svg' | 'mathml'

/**
 * One attribute's location, split into the parts a patcher needs.
 *
 * `whole` covers the attribute as written — name, `=`, quotes and all — so removing an attribute
 * is a delete of `whole` (plus its leading whitespace, which the patcher handles). `value`
 * excludes the quotes, so replacing a value never disturbs the quoting style the author chose.
 */
export interface AttrSpan {
  /**
   * The attribute name **as written in the source**, e.g. `viewBox`, `CLASS`.
   *
   * This exists because the map is keyed by the *lowercased* name (see `ElementSpan.attrs`), and
   * a patcher rewriting a whole attribute must be able to put the author's casing back.
   */
  sourceName: string
  /** Span of just the name. Excludes any whitespace before `=`. */
  name: Span
  /** Span of the value with quotes stripped, or `null` for a valueless attribute (`hidden`). */
  value: Span | null
  /** Span of the entire attribute, from the first character of the name to the closing quote. */
  whole: Span
}

/** Everything Design Mode knows about one addressable element, all of it anchored to the source. */
export interface ElementSpan {
  /** `"<slideId>:<n>"` — see `buildSlideMap` for how `n` is assigned. */
  slId: string
  /** Tag name as parse5 reports it: lowercased for HTML, adjusted for SVG (`foreignObject`). */
  tagName: string
  /** The whole element including both tags. */
  outer: Span
  /**
   * The span between `>` and `</tag`, i.e. the element's content.
   *
   * `null` exactly when the element cannot have content: an HTML void element (`<br>`, `<img>`)
   * or a self-closed foreign element (`<rect/>`). An empty *non-void* element yields an empty
   * span, not `null` — `<div></div>` is a legitimate target for setting text content, `<br>` is
   * not, and collapsing the two would let a patcher inject children into a void element.
   */
  inner: Span | null
  /**
   * Attribute spans keyed by the **lowercased** attribute name.
   *
   * Lowercased, not source-cased, because that is the only key that supports correct lookup: the
   * HTML tokenizer lowercases every attribute name it reads, in foreign content too. Reading
   * `attrs['viewbox']` finds an attribute the author wrote as `viewBox`; the original casing is
   * on `AttrSpan.sourceName`.
   *
   * (40-design-mode.md §1.2 specifies keying by the source-cased name and matching
   * case-insensitively only in the HTML namespace, on the premise that parse5 "preserves SVG
   * camelCase". That premise holds for the *tree* — `node.attrs` carries the adjusted `viewBox` —
   * but **not** for `sourceCodeLocation.attrs`, whose keys are lowercased in every namespace.
   * Keying by the lowercased name is therefore both simpler and the only thing that actually
   * works; the source casing is preserved on the side rather than lost.)
   *
   * A duplicate attribute in the source appears once, as its **first** occurrence — which is the
   * one the HTML parser keeps and the DOM exposes. Later duplicates are dropped by the tokenizer
   * and are not addressable.
   */
  attrs: Record<string, AttrSpan>
  /**
   * Where a *new* attribute goes: immediately after the tag name in the start tag.
   *
   * Insert `' name="value"'` (leading space included) at this offset. Chosen over "before `>`"
   * because the end of a start tag has too many shapes to get right — `>`, `/>`, whitespace
   * before either, an unquoted final value that a `/` would attach itself to.
   */
  attrInsert: number
  /** Nearest *mapped* ancestor. `null` for a top-level mapped element (see `SlideMap.byId`). */
  parentSlId: string | null
  /** Nearest *mapped* descendants, in document order. Unmapped elements are transparent. */
  childSlIds: string[]
  /**
   * Child-element index chain from the document root, counting **all** element nodes including
   * the parser-implied `<html>`/`<head>`/`<body>`.
   *
   * This is the re-resolution key of §1.5: after a structural edit the `n` in an `slId` shifts,
   * but the path of an element that did not move does not. Implied elements are counted because
   * they are deterministic — the parser inserts the same ones for the same input — and skipping
   * them would make a path depend on whether the author happened to write `<body>`.
   */
  path: number[]
  /**
   * True when the element can hold text and every child it has is a text node.
   *
   * Vacuously true for an empty non-void element. False for a void element, and false for
   * `<p>a<b>c</b></p>` — replacing that element's content as plain text would destroy the `<b>`,
   * which is why §9.3 routes mixed content through in-frame rich-text editing instead.
   */
  textOnly: boolean
  ns: SlideNamespace
  /**
   * A `data-sl-id` **already present in the author's source**, if any.
   *
   * 40-design-mode.md treats `data-sl-id` as injection-only (§1.1: never in the `.sloodge` file),
   * while 30-slide-format.md §3.3 has Sloodge stamping persistent `e_<hex>` ids into the saved
   * source. The two plans disagree, and 40 is the authority here, so the map's own `slId` is
   * always ours. This field records what the source said so the 30-format story — the `SL-D01`
   * uniqueness lint and the `SL-D02` "a mapping was lost" check — can be built on the same parse
   * instead of a second one. `null` when the author wrote no `data-sl-id`.
   */
  authoredSlId: string | null
}

/** The parse result: the original source plus every span derived from it. */
export interface SlideMap {
  slideId: string
  /**
   * A fingerprint of `source`, used as the staleness guard of §1.4: a patch computed against one
   * revision is rejected if the slide has moved on. See `buildSlideMap` for what computes it and
   * why the default is explicitly **not** a cryptographic hash.
   */
  sourceHash: string
  /** The original source, untouched. Every `Span` in this map indexes into exactly this string. */
  source: string
  byId: ReadonlyMap<string, ElementSpan>
  /** Every `slId` in document order. `order[n]` is the element whose id ends in `:n`. */
  order: string[]
}
