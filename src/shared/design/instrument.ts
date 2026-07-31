/**
 * `instrument` — produce the copy of a slide that the editor iframe renders, with a `data-sl-id`
 * on every addressable element.
 *
 * §1.3 of `.claude/plans/init/40-design-mode.md`. The contract is the same one `wrapSlideHtml.ts`
 * holds for the CSP meta, and for the same reason: **insertion, never re-serialization**. Handing
 * the parse5 tree to a serializer would normalize quote styles, reorder attributes, re-encode
 * entities and drop comments — and every one of those rewrites a byte that a `Span` in the map
 * still points at, silently invalidating the whole patcher.
 *
 * So this assembles the output from slices of the original source and fixed strings inserted at
 * offsets the map already knows. The map's spans keep describing the **original** source, which
 * is what patches operate on; the instrumented string is a render artifact that is never saved
 * (§1.1: `data-sl-id` never reaches the `.sloodge` file on disk).
 */

import type { SlideMap } from './types'
import { SL_ID_ATTR } from './slide-map'

/**
 * Characters that would let a slide id escape the quoted attribute it is written into.
 *
 * Ids come from `createSlideId` and are Crockford base32, so this can never fire in practice —
 * which is exactly why it is checked rather than assumed. `instrument` is the one place in the
 * pipeline that *writes* markup, and the value it writes is the only thing there that is not a
 * constant. A caller that gets a slide id from somewhere unexpected should get an exception, not
 * an attribute injection.
 */
const UNSAFE_SLIDE_ID = /["'`<>&\s\\]/

/**
 * The instrumented document for `map`, byte-identical to `map.source` apart from the inserted
 * `data-sl-id` attributes.
 *
 * ## What is inserted, and where
 *
 * ` data-sl-id="<slId>"` at each element's `attrInsert` — immediately after the tag name, ahead
 * of the author's own attributes. Nothing else in the document changes: no author byte is
 * rewritten, reordered, re-quoted or removed.
 *
 * ## Elements that already carry a `data-sl-id`
 *
 * A slide may arrive with one already on it: the model was free to emit one, and
 * 30-slide-format.md §3.3 describes a world where Sloodge persists `e_<hex>` ids into saved
 * source. Two rules cover it, and together they make this function a **fixpoint**:
 *
 *  1. If the existing value is already exactly the id we would inject, insert nothing. This is
 *     what makes `instrument(reparse(instrument(x)))` byte-identical to `instrument(x)` — running
 *     the pipeline twice cannot double-inject or reshuffle anything.
 *  2. Otherwise insert ours anyway, in front. The result has two `data-sl-id` attributes on that
 *     element, which is a parse error the tokenizer resolves by **keeping the first and dropping
 *     the rest** — so the DOM the bridge queries sees ours, deterministically. The author's value
 *     is not touched, and it stays available on `ElementSpan.authoredSlId` for the 30-format
 *     `SL-D02` mapping-loss check.
 *
 * Rule 2 is the reason this stays a pure insertion. The alternative — overwriting the author's
 * value span — would be a rewrite of author bytes in a function whose entire guarantee is that it
 * does not rewrite author bytes, and it would put the map's own spans out of date with the string
 * they were derived from.
 *
 * ## Why the fixpoint depends on the map, not just on rule 1
 *
 * Rule 1 only holds if each start tag is offered at most one id. When `buildSlideMap` minted an
 * id per *tree* element, an adoption-agency clone (§ `mapElement`) gave one start tag two ids:
 * rule 1 saw the first and skipped it, rule 2 then added the second in front, and every
 * round-trip grew the document by another attribute — measured 111 to 221 characters over five
 * generations. The fixpoint is a property of the pair, which is why the map collapses clones to
 * one addressable element and why the loop below throws if two insertions ever land on one
 * offset.
 *
 * ## Not yet injected
 *
 * §1.3 also puts the in-frame agent script and the highlight stylesheet before `</body>`, both
 * tagged `data-sl-ignore`. Those belong to the bridge (§2.2), which does not exist yet; they hook
 * in here once it does. Keeping them out for now means this function's output is exactly "the
 * source plus ids", which is a property the tests can assert exactly.
 */
export function instrument(map: SlideMap): string {
  if (map.slideId.length === 0 || UNSAFE_SLIDE_ID.test(map.slideId)) {
    throw new TypeError(
      `Slide id is not safe to write into an attribute: ${JSON.stringify(map.slideId)}`,
    )
  }

  const insertions: { at: number; text: string }[] = []

  for (const span of map.byId.values()) {
    const existing = span.attrs[SL_ID_ATTR]
    const existingValue =
      existing?.value === null || existing?.value === undefined
        ? null
        : map.source.slice(existing.value.start, existing.value.end)
    if (existingValue === span.slId) continue

    insertions.push({ at: span.attrInsert, text: ` ${SL_ID_ATTR}="${span.slId}"` })
  }

  // Ascending, so the source can be consumed left to right in one pass.
  insertions.sort((left, right) => left.at - right.at)

  // Chunked assembly, not repeated splicing. Rebuilding the whole document once per insertion is
  // O(elements x length): measured at 20.4s for a 525KB / 30k-element slide, against the M8 goal
  // of a 500KB slide well under 100ms. Collecting slices and joining once is the same bytes in
  // single-digit milliseconds, and Design Mode enters on the UI thread.
  const parts: string[] = []
  let cursor = 0
  let previousAt = -1
  for (const { at, text } of insertions) {
    if (at === previousAt) {
      // Two ids in one start tag — the adoption-agency aliasing defect. `buildSlideMap` mints at
      // most one id per start-tag offset, so this is unreachable; it throws rather than quietly
      // emitting a duplicate attribute, because the shape that produces is an element the bridge
      // can never find (a duplicate attribute keeps the first and drops the rest).
      throw new Error(`Two data-sl-id insertions at offset ${String(at)}`)
    }
    parts.push(map.source.slice(cursor, at), text)
    cursor = at
    previousAt = at
  }
  parts.push(map.source.slice(cursor))
  return parts.join('')
}
