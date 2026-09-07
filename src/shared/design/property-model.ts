/**
 * The pure model behind the local property panel (§5 of `.claude/plans/init/40-design-mode.md`,
 * the M3.3 milestone). It answers two questions and nothing else:
 *
 *   1. `readPropertyValues(map, slId)` — what are this element's current field values, read from
 *      the **source** (never from a bridge message)?
 *   2. `buildFieldOps(source, element, field, rawValue)` — what `SourceOp`s turn one field edit
 *      into a patch of the source?
 *
 * Both are pure functions of the parent-owned `SlideMap` and a `field`/`value`. That purity is the
 * whole testing strategy: the panel's behaviour is exercised here against the same hostile corpus
 * `buildSlideMap` is, with no React and no iframe.
 *
 * ## Value source: the source map, not computed styles — and why
 *
 * §5 imagines the panel binding to `SL_INSPECT`'s computed-style whitelist. That message does not
 * exist yet (the bridge is `SL_HITTEST`-only), and — more fundamentally — a zero-LLM *source*
 * editor must read and write the **same channel it edits**: the author's source. Reading a computed
 * value (`44px` resolved from a stylesheet) and writing it back as an inline style would silently
 * materialize the entire cascade into `style=""` on first touch. Reading the inline/attribute
 * source value means an untouched field stays untouched, and editing one property adds exactly one
 * declaration. When the source declares nothing for a field, the value is `null` and the panel
 * shows it empty; typing inserts it. Computed-style *display* (showing the resolved `44px` as a
 * placeholder) is a strict addition once `SL_INSPECT` lands — it does not change the write path.
 *
 * ## The re-derivation rule (§2.2, normative)
 *
 * `resolveElement(map, slId)` takes the sl-id the **parent** tracks (from `designStore.selection`)
 * and looks it up in the parent-owned map. There is deliberately no parameter for a message
 * payload's element data: this module *cannot* act on what a slide posted, only on what the parent
 * believes is selected. A forged `SL_HITTEST` response can at most move the parent's selection to a
 * neighbouring sl-id; the edit then targets *that* element's real spans, never attacker-supplied
 * offsets or HTML.
 */

import {
  readAttr,
  readStyleProp,
  setAttr,
  setStyleProp,
  setStyleProps,
  setTextContent,
  type SourceOp,
} from './patch'
import { parseTransform } from './style'
import { composeTransform, inspectTransform, type TransformParts } from './transform'
import { readTransformShape } from './transform-commit'
import type { ElementSpan, SlideMap } from './types'

/**
 * The fields the panel edits — the wireframe's Text / Size / Weight / Color / Fill / X/Y/W/H, plus
 * M3.8's `stroke` (the third colour target, §5.1 APPEARANCE: Fill / Stroke / Text colour).
 */
export type PropertyField =
  'text' | 'fontSize' | 'fontWeight' | 'color' | 'fill' | 'stroke' | 'x' | 'y' | 'width' | 'height'

/** Current source values for every field, `null` where the source declares nothing. */
export interface PropertyValues {
  /** Element text, only when it is `textOnly`; `null` for mixed/void content (field disabled). */
  readonly text: string | null
  readonly fontSize: string | null
  readonly fontWeight: string | null
  readonly color: string | null
  readonly fill: string | null
  readonly stroke: string | null
  readonly x: string | null
  readonly y: string | null
  readonly width: string | null
  readonly height: string | null
}

/** Look up the element the parent has selected. See the re-derivation note in the file header. */
export function resolveElement(map: SlideMap, slId: string): ElementSpan | null {
  return map.byId.get(slId) ?? null
}

/** SVG elements whose geometry is expressed as `width`/`height` attributes (§5.2). */
const SVG_SIZED_TAGS: ReadonlySet<string> = new Set(['rect', 'image', 'img'])

function isSvg(element: ElementSpan): boolean {
  return element.ns === 'svg'
}

/**
 * The translate arguments of a `transform` value as the handles read them: `inspectTransform`'s
 * folded translate for an editable value (so `translateX(120px)` reads as `120px, 0`), else the
 * exact `translate()` function if the opaque value has one. One definition shared with M3.6's
 * transform algebra, so the panel and the handles cannot disagree about what a translate is.
 */
function translateArgs(transform: string | null): string | null {
  const shape = inspectTransform(transform)
  if (shape.editable) return shape.parts.translate
  return parseTransform(transform ?? '').find((f) => f.name === 'translate')?.args ?? null
}

/** The x-translate and y-translate of a `transform` value in source, defaulting to `'0'` each. */
function readTranslate(transform: string | null): { tx: string; ty: string } {
  const args = translateArgs(transform)
  if (args === null) return { tx: '0', ty: '0' }
  const parts = args.split(',').map((part) => part.trim())
  return { tx: parts[0] ?? '0', ty: parts[1] ?? '0' }
}

/**
 * Whether the source positions the element with `left`/`top`. That is the channel X/Y edits and
 * drags write when it is there (§5.3), and it never touches the `transform` — which is why move
 * stays available under a transform lock exactly when this holds. Private: `moveChannel` is the
 * only thing that should ever ask, so no consumer can rebuild a paraphrase of the rule out of it.
 */
function positionsByOffsets(source: string, element: ElementSpan): boolean {
  return (
    readStyleProp(source, element, 'left') !== null ||
    readStyleProp(source, element, 'top') !== null
  )
}

/**
 * Which channel an X/Y edit on this element uses — and, when that channel is `transform`, whether
 * the edit may be written at all. **One function answers it for the reader, the writer and the
 * message**, so they cannot drift apart; four review rounds of this milestone were spent on sites
 * that each re-derived a paraphrase of it.
 *
 * The question every arm answers is the same one: **does adding the pointer's screen-space delta to
 * this field actually move the element by that delta?**
 *
 * - `offsets` — the source declares `left`/`top`. Layout offsets are resolved *before* the
 *   `transform` is painted, so they are parent-space whatever the transform says; `translateZ(0)`,
 *   the compositing idiom, must not make an element unmovable.
 * - `attr` — an SVG element's `x`/`y` presentation attributes. **Only when the transform leaves the
 *   element's axes parent-aligned** (absent, or decomposable with `rotate === 0` and scale `1, 1`).
 *   SVG is *not* the free pass an earlier version of this comment claimed: `x`/`y` are geometry
 *   inside the element's own user space and the `transform` is what maps that space to the parent's,
 *   so under `rotate(30deg)` a +40 write to `x` moves the rect ~34.6px right and ~20px **down**, and
 *   under `scale(2)` it moves 80px. That is the same wrong-axis write `refused` exists to prevent —
 *   HTML escapes it only because `left`/`top` are pre-transform and because a new `translate()` is
 *   composed outermost.
 * - `translate` — the element moves by rewriting its `translate()`, which `composeTransform` writes
 *   **first** in the list and CSS therefore applies **last**, in the parent's frame. Reached by an
 *   in-flow HTML element, and by an SVG element whose transform rotates or scales: there the
 *   attribute channel is unsafe but the parent-space translate is exactly right, so the element
 *   follows the pointer instead of being frozen by M3.6's own rotation handle.
 * - `refused` — the transform is one `inspectTransform` cannot decompose (a `matrix()`, a `rotate()`
 *   written before its `translate()`), so neither safe channel is available: the exact `translate()`
 *   would be rewritten where it stands and send the delta along the element's tilted axis (a +40 X
 *   edit under `rotate(90deg)` moves it 40px *down*, a +40 Y edit 40px *left*), and an SVG `x`/`y`
 *   write cannot be shown parent-aligned because the matrix was never decomposed. The value is still
 *   readable — the panel shows it greyed with `reason` as the tooltip — but no write goes out.
 *   **This is the transform lock, and this arm is the whole of it.**
 *
 * Known gap, milestone-wide and not this function's to close: the whole M3.6 transform stack reads
 * and writes the **style** `transform` only (`readTransformShape`, `buildRotatePatch`, `duplicate`),
 * so an SVG element carrying the legacy `transform="rotate(30)"` *attribute* looks untransformed to
 * every one of them, this included. See the M3.6 roadmap row.
 */
export type MoveChannel =
  | { readonly kind: 'attr' }
  | { readonly kind: 'offsets' }
  | { readonly kind: 'translate'; readonly parts: TransformParts }
  | { readonly kind: 'refused'; readonly reason: string }

export function moveChannel(source: string, element: ElementSpan): MoveChannel {
  // `left`/`top` first: they are pre-transform, so they are safe before anything else is asked.
  if (!isSvg(element) && positionsByOffsets(source, element)) return { kind: 'offsets' }
  const shape = readTransformShape(source, element)
  if (!shape.editable) return { kind: 'refused', reason: shape.reason }
  // The attribute channel is SVG-only and conditional; the translate channel serves everyone else,
  // HTML in-flow and rotated/scaled SVG alike, because a leading translate is parent-space for both.
  const { rotate, scale } = shape.parts
  if (isSvg(element) && rotate === 0 && scale.sx === 1 && scale.sy === 1) return { kind: 'attr' }
  return { kind: 'translate', parts: shape.parts }
}

/**
 * Why an X/Y edit on this element must be refused, or `null` when it may be written — the `refused`
 * arm of `moveChannel`, for the consumers that only need the message: the overlay's badge and group
 * cursor, and the panel's disabled X/Y inputs. They call this rather than restating the rule, so a
 * badge cannot accuse a move that would have succeeded (an earlier paraphrase, `!positionsByOffsets`,
 * did exactly that to every SVG child).
 */
export function moveRefusal(source: string, element: ElementSpan): string | null {
  const channel = moveChannel(source, element)
  return channel.kind === 'refused' ? channel.reason : null
}

/** Read every field's current source value. Pure over `(map.source, element)`. */
export function readPropertyValues(source: string, element: ElementSpan): PropertyValues {
  const svg = isSvg(element)
  const text =
    element.textOnly && element.inner !== null
      ? source.slice(element.inner.start, element.inner.end)
      : null

  const fill = svg
    ? (readAttr(source, element, 'fill') ?? readStyleProp(source, element, 'fill'))
    : readStyleProp(source, element, 'background-color')

  // Stroke (§5.2): the SVG paint (`stroke` attribute preferred, else the style) or, for HTML, the
  // box's `border-color` — the closest "outline" channel a block element has.
  const stroke = svg
    ? (readAttr(source, element, 'stroke') ?? readStyleProp(source, element, 'stroke'))
    : readStyleProp(source, element, 'border-color')

  // The same `moveChannel` the writer switches on, so the field the panel shows is by construction
  // the field an edit would write. A `refused` element still *reads* its translate: the value is
  // shown, greyed, with the reason as the tooltip — hiding it would say less, not more.
  let x: string | null
  let y: string | null
  const channel = moveChannel(source, element)
  if (channel.kind === 'attr') {
    x = readAttr(source, element, 'x')
    y = readAttr(source, element, 'y')
  } else if (channel.kind === 'offsets') {
    x = readStyleProp(source, element, 'left')
    y = readStyleProp(source, element, 'top')
  } else {
    const transform = readStyleProp(source, element, 'transform')
    const translate = transform === null ? null : readTranslate(transform)
    x = translate ? translate.tx : null
    y = translate ? translate.ty : null
  }

  const width =
    svg && SVG_SIZED_TAGS.has(element.tagName)
      ? readAttr(source, element, 'width')
      : readStyleProp(source, element, 'width')
  const height =
    svg && SVG_SIZED_TAGS.has(element.tagName)
      ? readAttr(source, element, 'height')
      : readStyleProp(source, element, 'height')

  return {
    text,
    fontSize: readStyleProp(source, element, 'font-size'),
    fontWeight: readStyleProp(source, element, 'font-weight'),
    color: readStyleProp(source, element, 'color'),
    fill,
    stroke,
    x,
    y,
    width,
    height,
  }
}

/**
 * A bare number (optionally signed/decimal) gets `px`; anything with a unit or function is written
 * verbatim. So typing `320` writes `320px`, while `50%` or `calc(100% - 8px)` is preserved.
 */
function asLength(value: string): string {
  return /^-?\d+(\.\d+)?$/.test(value.trim()) ? `${value.trim()}px` : value.trim()
}

/**
 * Set one axis of the element's `transform: translate(...)`, preserving the other axis and every
 * other transform function (rotate, scale). Writes the whole `transform` declaration via
 * `setStyleProp`, so all the other inline-style declarations are untouched.
 *
 * The transform is re-emitted through `composeTransform`, the same writer M3.6's rotate, flip and
 * duplicate use, so a `translateX(120px)` becomes one `translate(40px, 0)` rather than a second
 * translate beside it — which would have made the element opaque, and its handles dead, on the
 * user's first drag.
 *
 * Takes the already-decomposed `parts` from `moveChannel`'s `translate` arm rather than
 * re-inspecting, so this function has no opinion about whether the write is allowed — it cannot,
 * because it is only ever reached down the arm where it is. Round 2 fixed *how* an opaque transform
 * was written through (a new translate had to lead, or the shift ran along the element's own tilted
 * axis); round 4 decided such a write must not happen at all, which subsumes that fix, so its
 * in-place rewrite is gone rather than left behind as a path production can no longer take.
 */
function translateOps(
  source: string,
  element: ElementSpan,
  parts: TransformParts,
  axis: 'x' | 'y',
  px: string,
): SourceOp[] {
  const { tx, ty } = readTranslate(readStyleProp(source, element, 'transform'))
  const args = `${axis === 'x' ? px : tx}, ${axis === 'y' ? px : ty}`
  return setStyleProp(source, element, 'transform', composeTransform({ ...parts, translate: args }))
}

/**
 * Turn one field edit into the source ops that apply it. Returns `[]` when the edit is a no-op the
 * panel should not commit: an empty value, or a `text` edit on an element that is not `textOnly`.
 *
 * `element` must come from `resolveElement(map, parentSlId)` — see the file header. `source` is the
 * map's own source (`map.source`); passing a different string would misplace every span.
 */
export function buildFieldOps(
  source: string,
  element: ElementSpan,
  field: PropertyField,
  rawValue: string,
): SourceOp[] {
  const value = rawValue.trim()
  const svg = isSvg(element)

  switch (field) {
    case 'text': {
      const op = setTextContent(element, rawValue)
      return op === null ? [] : [op]
    }

    case 'fontSize':
      if (value.length === 0) return []
      return setStyleProp(source, element, 'font-size', asLength(value))

    case 'fontWeight':
      if (value.length === 0) return []
      return setStyleProp(source, element, 'font-weight', value)

    case 'color':
      if (value.length === 0) return []
      return setStyleProp(source, element, 'color', value)

    case 'fill':
      if (value.length === 0) return []
      if (svg) {
        // Prefer the channel the source already uses: a `fill` attribute if present, else style.
        return element.attrs['fill'] !== undefined
          ? setAttr(element, 'fill', 'fill', value)
          : setStyleProp(source, element, 'fill', value)
      }
      return setStyleProp(source, element, 'background-color', value)

    case 'stroke': {
      if (value.length === 0) return []
      if (svg) {
        // Prefer the channel the source already uses: a `stroke` attribute if present, else style.
        return element.attrs['stroke'] !== undefined
          ? setAttr(element, 'stroke', 'stroke', value)
          : setStyleProp(source, element, 'stroke', value)
      }
      // HTML: `border-color`, plus a `border-style` so the border actually renders — but only when the
      // source has not already set one, so an author's `dashed`/`dotted` border keeps its style.
      const entries: [string, string][] = [['border-color', value]]
      if (readStyleProp(source, element, 'border-style') === null) {
        entries.push(['border-style', 'solid'])
      }
      return setStyleProps(source, element, entries)
    }

    case 'width':
    case 'height': {
      if (value.length === 0) return []
      if (svg && SVG_SIZED_TAGS.has(element.tagName)) {
        return setAttr(element, field, field, value)
      }
      return setStyleProp(source, element, field, asLength(value))
    }

    case 'x':
    case 'y': {
      if (value.length === 0) return []
      const axis = field === 'x' ? 'x' : 'y'
      const channel = moveChannel(source, element)
      switch (channel.kind) {
        case 'attr':
          return setAttr(element, axis, axis, value)
        case 'offsets':
          return setStyleProp(source, element, axis === 'x' ? 'left' : 'top', asLength(value))
        case 'translate':
          return translateOps(source, element, channel.parts, axis, asLength(value))
        case 'refused':
          // The transform lock, and the only place it is applied. `buildDragPatch` and every one of
          // its callers — single drag, group drag, align/distribute, a drag whose element turned
          // opaque mid-gesture — and the panel's X/Y inputs all arrive here, so none of them needs
          // a gate of its own and none of them can forget one.
          return []
      }
    }
  }
}
