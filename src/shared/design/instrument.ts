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
 * So this splices fixed strings into a copy of the original source at offsets the map already
 * knows, right-to-left so that each insertion leaves every earlier offset untouched. The map's
 * spans keep describing the **original** source, which is what patches operate on; the
 * instrumented string is a render artifact that is never saved (§1.1: `data-sl-id` never reaches
 * the `.sloodge` file on disk).
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

  // Right-to-left: each splice only moves offsets after it, and we have already passed those.
  insertions.sort((left, right) => right.at - left.at)

  let out = map.source
  for (const { at, text } of insertions) {
    out = `${out.slice(0, at)}${text}${out.slice(at)}`
  }
  return out
}
