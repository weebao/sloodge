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
 * ## References must follow the ids they point at
 *
 * Freshening a *definition* id is only half the job: an element inside the clone that **references**
 * a definition also inside the clone (`<use href="#grad">`, `fill="url(#grad)"`, `<label for="fld">`,
 * `aria-labelledby="hdr"`) must be repointed at the fresh id, or the clone silently cross-links back
 * into the original and breaks the moment the original is edited or deleted. So after freshening we
 * build a remap of every `id` we changed and rewrite, in a second pass, only the references that
 * resolve **within** the clone — a reference to an id defined *outside* the clone is left untouched,
 * because it legitimately still points outside. The rewrite is anchored to parse5 attribute-value
 * spans (never a blind text replace over the markup), so it keeps the same span-safety as the insert.
 * The reference carriers covered are the ones slide markup actually uses: SVG `href`/`xlink:href`,
 * `url(#…)` in `style` and in the presentation attributes (`fill`/`stroke`/`clip-path`/`mask`/
 * `filter`/`marker-*`/`cursor`), `for`, `list`, and the space-separated id lists
 * (`aria-labelledby`/`-describedby`/`-controls`/`-owns`, `headers`).
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
import { composeTransform, inspectTransform, withTranslateOffset } from './transform'
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
  /**
   * Whether the clone was actually moved by `offset`. `false` when it sits exactly over the original
   * — see `nudgeTransform` — so the caller can say so instead of reporting a shifted box it never got.
   */
  readonly nudged: boolean
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

/** Attributes whose whole value is a single `#id` fragment reference (SVG). */
const HASH_REF_ATTRS: ReadonlySet<string> = new Set(['href', 'xlink:href'])
/** Attributes whose whole value is a single bare id. */
const SINGLE_ID_ATTRS: ReadonlySet<string> = new Set(['for', 'list'])
/** Attributes whose value is a space-separated list of ids. */
const ID_LIST_ATTRS: ReadonlySet<string> = new Set([
  'aria-labelledby',
  'aria-describedby',
  'aria-controls',
  'aria-owns',
  'headers',
])
/** Attributes (and `style`) whose value may embed one or more `url(#id)` references. */
const URL_REF_ATTRS: ReadonlySet<string> = new Set([
  'style',
  'fill',
  'stroke',
  'clip-path',
  'mask',
  'filter',
  'marker',
  'marker-start',
  'marker-mid',
  'marker-end',
  'cursor',
])

/** Rewrite a `#id` fragment reference, or `null` if it does not resolve within the clone. */
function remapHashRef(value: string, remap: ReadonlyMap<string, string>): string | null {
  const trimmed = value.trim()
  if (!trimmed.startsWith('#')) return null
  const next = remap.get(trimmed.slice(1))
  return next === undefined ? null : `#${next}`
}

/** Rewrite a bare single-id reference (`for`, `list`), or `null` when it points outside the clone. */
function remapSingleId(value: string, remap: ReadonlyMap<string, string>): string | null {
  const next = remap.get(value.trim())
  return next === undefined ? null : next
}

/** Rewrite the in-clone ids of a space-separated id list, preserving spacing; `null` if none change. */
function remapIdList(value: string, remap: ReadonlyMap<string, string>): string | null {
  let changed = false
  const out = value.split(/(\s+)/).map((token) => {
    const next = remap.get(token)
    if (next === undefined) return token
    changed = true
    return next
  })
  return changed ? out.join('') : null
}

/** Rewrite every in-clone `url(#id)` in a value (style or presentation attr); `null` if none change. */
function remapUrlRefs(value: string, remap: ReadonlyMap<string, string>): string | null {
  let changed = false
  const out = value.replace(
    /url\(\s*(['"]?)#([^'")\s]+)\1\s*\)/g,
    (whole, quote: string, id: string) => {
      const next = remap.get(id)
      if (next === undefined) return whole
      changed = true
      return `url(${quote}#${next}${quote})`
    },
  )
  return changed ? out : null
}

/**
 * The rewritten value of one reference-carrying attribute, or `null` when it carries no in-clone
 * reference (leave it byte-identical). Dispatches on the attribute's role; anything not a reference
 * carrier — `id`, `data-sl-id`, ordinary attributes — returns `null` and is never touched here.
 */
function rewriteReference(
  key: string,
  value: string,
  remap: ReadonlyMap<string, string>,
): string | null {
  if (HASH_REF_ATTRS.has(key)) return remapHashRef(value, remap)
  if (SINGLE_ID_ATTRS.has(key)) return remapSingleId(value, remap)
  if (ID_LIST_ATTRS.has(key)) return remapIdList(value, remap)
  if (URL_REF_ATTRS.has(key)) return remapUrlRefs(value, remap)
  return null
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
function freshenClone(
  cloneText: string,
  taken: Set<string>,
  offset: DuplicateOffset,
): { text: string; nudged: boolean } {
  const idMap = buildSlideMap('dup', cloneText)
  const ops: SourceOp[] = []
  // Pass 1: freshen definition ids. Build the `id` remap (references target `id`, not `data-sl-id`)
  // so pass 2 can repoint intra-clone references at the fresh ids. Each op targets a distinct
  // attribute-value span, so none overlap.
  const remap = new Map<string, string>()
  for (const element of idMap.byId.values()) {
    const idAttr = element.attrs['id']
    if (idAttr !== undefined && idAttr.value !== null) {
      const current = cloneText.slice(idAttr.value.start, idAttr.value.end)
      const fresh = uniquify(current, taken)
      remap.set(current, fresh)
      ops.push({ kind: 'replaceSpan', span: idAttr.value, text: fresh })
    }
    const slAttr = element.attrs[SL_ID_ATTR]
    if (slAttr !== undefined && slAttr.value !== null) {
      const current = cloneText.slice(slAttr.value.start, slAttr.value.end)
      ops.push({ kind: 'replaceSpan', span: slAttr.value, text: uniquify(current, taken) })
    }
  }

  // Pass 2: repoint references that resolve WITHIN the clone at the fresh ids. A reference to an id
  // defined outside the clone is not in `remap`, so it is left untouched. Distinct attribute spans
  // from pass 1 (id/data-sl-id are never reference carriers), so the two op sets never overlap.
  if (remap.size > 0) {
    for (const element of idMap.byId.values()) {
      for (const [key, attr] of Object.entries(element.attrs)) {
        if (attr.value === null) continue
        const raw = cloneText.slice(attr.value.start, attr.value.end)
        const next = rewriteReference(key, raw, remap)
        if (next !== null) ops.push({ kind: 'replaceSpan', span: attr.value, text: next })
      }
    }
  }

  let text = ops.length > 0 ? applyOps(cloneText, ops) : cloneText

  // Pass 3: offset the root, rebuilt against the freshened text so its style span is live.
  const offsetMap = buildSlideMap('dup', text)
  const rootId = offsetMap.order[0]
  const root = rootId === undefined ? undefined : offsetMap.byId.get(rootId)
  if (root === undefined) return { text, nudged: false }
  const nudged = nudgeTransform(readStyleProp(text, root, 'transform'), offset)
  if (nudged === null) return { text, nudged: false }
  const offsetOps = setStyleProp(text, root, 'transform', nudged)
  return { text: offsetOps.length > 0 ? applyOps(text, offsetOps) : text, nudged: true }
}

/**
 * The clone root's transform with `offset` applied, or `null` to leave the clone exactly over the
 * original.
 *
 * Three cases, decided by `inspectTransform`. A transform the handles can decompose with a px (or
 * absent) translate folds the offset into it — the common case. An **opaque** transform (`matrix`,
 * a non-canonical order) gets a `translate(...)` **prepended**: the outermost function of a CSS
 * transform list is applied last, so a leading translate is a parent-space shift that is correct
 * whatever follows it, and the clone stays as opaque — and as loudly locked — as its original. An
 * editable transform whose translate is *not* px (`translate(-50%, -50%)`, the centring idiom) is
 * the one case with no safe nudge: adding px to a percentage needs a `calc()` the tokenizer refuses,
 * and prepending a second translate would make the clone opaque and lock the handles on a copy of an
 * element whose original had them. So the clone lands in place and the caller says so.
 */
function nudgeTransform(transform: string | null, offset: DuplicateOffset): string | null {
  const shape = inspectTransform(transform)
  const prefix = `translate(${String(offset.dx)}px, ${String(offset.dy)}px)`
  if (!shape.editable) return transform === null ? prefix : `${prefix} ${transform}`
  const parts = withTranslateOffset(shape.parts, offset.dx, offset.dy)
  return parts === null ? null : composeTransform(parts)
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
  const { text, nudged } = freshenClone(cloneText, taken, offset)

  const at = element.outer.end
  return { source: source.slice(0, at) + text + source.slice(at), cloneStart: at, nudged }
}
