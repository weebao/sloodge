/**
 * Duplicate an element's source subtree — M3.6's `Ctrl/⌘+D`, roadmap M3.6 "cloning the element
 * subtree with fresh `data-sl-id`s". Pure `(slideId, source, slId, offset) → patched source`, so the
 * subtle part — reassigning ids across the clone without colliding with anything already in the
 * slide, and keeping every other byte-span valid — is exhaustively testable against the same hostile
 * corpus `buildSlideMap` is (`tests/unit/design/duplicate.test.ts`).
 *
 * ## What "fresh ids" means in this architecture
 *
 * A `data-sl-id` is **never persisted** (§1.1 of `.claude/plans/init/40-design-mode.md`): the map's
 * `slId` is a positional counter minted at `buildSlideMap` time, so re-parsing the patched source
 * gives every element — the clone and its descendants included — a fresh, unique `slId` for free,
 * with no possibility of collision (the counter is monotonic). So the clone is "independently
 * addressable" the moment it is re-mapped; there is no id to hand-assign.
 *
 * What *can* collide is what the **author** wrote: an `id` attribute (illegal to duplicate in the
 * DOM, and what the breadcrumb shows as `tag#id`) or an authored `data-sl-id` (30-slide-format's
 * `e_<hex>`, whose whole point is uniqueness). Those are the ids this module freshens — every one in
 * the clone subtree is rewritten to a value not present anywhere in the slide — so the clone is a
 * genuinely distinct element rather than a second node claiming an existing identity.
 *
 * ## Why the insert keeps every other span valid
 *
 * The clone is a single insertion at the original's `outer.end` — a pure insertion, no deletion — so
 * every span the map holds for another element is either before the insertion point (unchanged) or
 * after it (shifted uniformly, and the caller rebuilds the map against the new source anyway). No
 * author byte is rewritten; the original subtree's source is reproduced verbatim in the clone apart
 * from the freshened ids and the offset nudge.
 */

import { applyOps, readStyleProp, setStyleProp, type SourceOp } from './patch'
import { buildSlideMap } from './slide-map'
import { SL_ID_ATTR } from './slide-map'
import { addTranslateOffset } from './transform'
import type { SlideMap } from './types'

/** A visible offset for the clone, in frame px — PowerPoint nudges a paste down-and-right. */
export interface DuplicateOffset {
  readonly dx: number
  readonly dy: number
}

/** The result of a duplicate: the patched source and where the clone's root start tag begins. */
export interface DuplicateResult {
  /** The slide source with the clone inserted after the original. */
  readonly source: string
  /**
   * The `outer.start` of the clone in `source` — equal to the original's `outer.end`, since the
   * clone is inserted there. The caller rebuilds the map and looks up the element at this offset to
   * find the clone's fresh `slId` (which cannot be known before re-parsing; see the header).
   */
  readonly cloneStart: number
}

/** Every author-written `id` and `data-sl-id` value anywhere in the slide — the collision set. */
function collectAuthorIds(map: SlideMap): Set<string> {
  const taken = new Set<string>()
  for (const element of map.byId.values()) {
    const idAttr = element.attrs['id']
    if (idAttr !== undefined && idAttr.value !== null) {
      taken.add(map.source.slice(idAttr.value.start, idAttr.value.end))
    }
    if (element.authoredSlId !== null) taken.add(element.authoredSlId)
  }
  return taken
}

/** A fresh id derived from `base` that is not in `taken`; the chosen value is added to `taken`. */
function uniquify(base: string, taken: Set<string>): string {
  let counter = 2
  let candidate = `${base}-${String(counter)}`
  while (taken.has(candidate)) {
    counter += 1
    candidate = `${base}-${String(counter)}`
  }
  taken.add(candidate)
  return candidate
}

/**
 * Rewrite every author `id`/`data-sl-id` in `cloneText` to a fresh value, then nudge the clone's
 * root by `offset`. Parses the clone as its own fragment so the rewrites are anchored to real
 * attribute-value spans (never a blind text replace that could hit element content).
 */
function freshenClone(cloneText: string, taken: Set<string>, offset: DuplicateOffset): string {
  // Pass 1: freshen ids. Each op targets a distinct attribute-value span, so they never overlap.
  const idMap = buildSlideMap('dup', cloneText)
  const ops: SourceOp[] = []
  for (const element of idMap.byId.values()) {
    for (const key of ['id', SL_ID_ATTR]) {
      const attr = element.attrs[key]
      if (attr === undefined || attr.value === null) continue
      const current = cloneText.slice(attr.value.start, attr.value.end)
      ops.push({ kind: 'replaceSpan', span: attr.value, text: uniquify(current, taken) })
    }
  }
  let text = ops.length > 0 ? applyOps(cloneText, ops) : cloneText

  // Pass 2: offset the root, rebuilt against the freshened text so its style span is live.
  const offsetMap = buildSlideMap('dup', text)
  const rootId = offsetMap.order[0]
  const root = rootId === undefined ? undefined : offsetMap.byId.get(rootId)
  if (root !== undefined) {
    const transform = readStyleProp(text, root, 'transform')
    const nudged = addTranslateOffset(transform, offset.dx, offset.dy)
    const offsetOps = setStyleProp(text, root, 'transform', nudged)
    if (offsetOps.length > 0) text = applyOps(text, offsetOps)
  }
  return text
}

/**
 * The patched source after duplicating `slId`, plus where the clone begins. Returns `null` when the
 * element does not resolve (the caller commits nothing). The clone is inserted immediately after the
 * original's `outer` with its author ids freshened and its root nudged by `offset`.
 */
export function buildDuplicatePatch(
  slideId: string,
  source: string,
  slId: string,
  offset: DuplicateOffset,
): DuplicateResult | null {
  const map = buildSlideMap(slideId, source)
  const element = map.byId.get(slId)
  if (element === undefined) return null

  const taken = collectAuthorIds(map)
  const cloneText = source.slice(element.outer.start, element.outer.end)
  const freshened = freshenClone(cloneText, taken, offset)

  const at = element.outer.end
  return { source: source.slice(0, at) + freshened + source.slice(at), cloneStart: at }
}
