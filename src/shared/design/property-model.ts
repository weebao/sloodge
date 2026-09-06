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
import { composeTransform, inspectTransform } from './transform'
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
 * drags write when it is there (§5.3), and it never touches the `transform` — which is why the
 * overlay keeps move available under a transform lock exactly when this holds.
 */
export function positionsByOffsets(source: string, element: ElementSpan): boolean {
  return (
    readStyleProp(source, element, 'left') !== null ||
    readStyleProp(source, element, 'top') !== null
  )
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

  let x: string | null
  let y: string | null
  if (svg) {
    x = readAttr(source, element, 'x')
    y = readAttr(source, element, 'y')
  } else {
    if (positionsByOffsets(source, element)) {
      x = readStyleProp(source, element, 'left')
      y = readStyleProp(source, element, 'top')
    } else {
      const transform = readStyleProp(source, element, 'transform')
      const translate = transform === null ? null : readTranslate(transform)
      x = translate ? translate.tx : null
      y = translate ? translate.ty : null
    }
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
 * An editable transform is re-emitted through `composeTransform`, the same writer M3.6's rotate,
 * flip and duplicate use, so a `translateX(120px)` becomes one `translate(40px, 0)` rather than a
 * second translate beside it — which would have made the element opaque, and its handles dead, on
 * the user's first drag. An opaque transform gets the in-place rewrite of `replaceTranslate`.
 */
function translateOps(
  source: string,
  element: ElementSpan,
  axis: 'x' | 'y',
  px: string,
): SourceOp[] {
  const transform = readStyleProp(source, element, 'transform')
  const { tx, ty } = readTranslate(transform)
  const args = `${axis === 'x' ? px : tx}, ${axis === 'y' ? px : ty}`
  const shape = inspectTransform(transform)
  const next = shape.editable
    ? composeTransform({ ...shape.parts, translate: args })
    : replaceTranslate(transform ?? '', args)
  return setStyleProp(source, element, 'transform', next)
}

/**
 * Rebuild an opaque transform string, replacing only its exact `translate()` with `translate(args)`.
 *
 * A translate that was absent is **prepended**, not appended. CSS applies a transform list right to
 * left, so the leading function is the one that acts in the parent's frame: `translate(10px, 0)
 * rotate(30deg)` shifts the element 10px right on screen, while `rotate(30deg) translate(10px, 0)`
 * shifts it 10px along its own tilted axis — an X edit (or an M3.5 drag) on an element M3.6 has
 * rotated would otherwise move it in the wrong direction. Prepending is also §5.3's canonical
 * `translate → rotate → scale` order. An existing translate is replaced where it stands.
 */
function replaceTranslate(transform: string, args: string): string {
  const fns = parseTransform(transform)
  let replaced = false
  const out = fns.map((fn) => {
    if (fn.name === 'translate') {
      replaced = true
      return `translate(${args})`
    }
    return `${fn.name}(${fn.args})`
  })
  if (!replaced) out.unshift(`translate(${args})`)
  return out.join(' ')
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
      const attr = field === 'x' ? 'x' : 'y'
      const axis = field === 'x' ? 'x' : 'y'
      if (svg) return setAttr(element, attr, attr, value)
      // HTML: prefer left/top if the source already positions with them, else transform:translate.
      if (positionsByOffsets(source, element)) {
        return setStyleProp(source, element, field === 'x' ? 'left' : 'top', asLength(value))
      }
      return translateOps(source, element, axis, asLength(value))
    }
  }
}
