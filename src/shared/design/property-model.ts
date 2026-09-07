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
  type SourceOp,
} from './patch'
import { parseTransform } from './style'
import { textContentOp, textEditBlock } from './text-edit'
import type { ElementSpan, SlideMap } from './types'

/**
 * The fields the panel edits — the wireframe's Text / Size / Weight / Color / Fill / X/Y/W/H, plus
 * M3.8's `stroke` (the third colour target, §5.1 APPEARANCE: Fill / Stroke / Text colour).
 */
export type PropertyField =
  'text' | 'fontSize' | 'fontWeight' | 'color' | 'fill' | 'stroke' | 'x' | 'y' | 'width' | 'height'

/**
 * Why the Content field is disabled for an element: its content is not plain text (`mixed-content`),
 * it is `data-sl-lock`ed, or its tag does not hold slide text at all (`not-text` — `<script>`,
 * `<style>`, `<title>`…, whose character data is text-only to the parser but never prose). The same
 * three reasons the caret refuses with (`textEditBlock`), so the panel and the canvas agree on what
 * may be edited; the caret's frame-input gates (the 64 KiB cap, the one-DOM-node rule) are
 * deliberately not applied here — the panel's input is typed in the parent, and M3.11 named the
 * panel as the way to edit an over-cap element.
 */
export type TextFieldBlock = 'mixed-content' | 'locked' | 'not-text'

/** Why `element`'s text is not editable from the panel, or `null` when it is. */
export function textFieldBlock(element: ElementSpan): TextFieldBlock | null {
  const block = textEditBlock(element)
  if (block === 'not-text' || block === 'locked') return block
  return element.textOnly ? null : 'mixed-content'
}

/** Current source values for every field, `null` where the source declares nothing. */
export interface PropertyValues {
  /**
   * Element text **as the DOM reads it** — entities decoded — or `null` when the field is disabled
   * (see `textBlock`). Decoded because the field is the read half of a round trip whose write half
   * (`textContentOp`) escapes: showing the source bytes `X &amp; Y` here made every commit add a
   * level of escaping (M3.12). An empty element reads as `''`, not `null`: an emptied heading is
   * still retypable.
   */
  readonly text: string | null
  /** Why `text` is `null` and the field disabled, or `null` when the text is editable. */
  readonly textBlock: TextFieldBlock | null
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

/** The x-translate and y-translate of a `transform` value in source, defaulting to `'0'` each. */
function readTranslate(transform: string | null): { tx: string; ty: string } {
  if (transform === null) return { tx: '0', ty: '0' }
  const fn = parseTransform(transform).find((f) => f.name === 'translate')
  if (fn === undefined) return { tx: '0', ty: '0' }
  const parts = fn.args.split(',').map((part) => part.trim())
  return { tx: parts[0] ?? '0', ty: parts[1] ?? '0' }
}

/** Read every field's current source value. Pure over `(map.source, element)`. */
export function readPropertyValues(source: string, element: ElementSpan): PropertyValues {
  const svg = isSvg(element)
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
    const left = readStyleProp(source, element, 'left')
    const top = readStyleProp(source, element, 'top')
    if (left !== null || top !== null) {
      x = left
      y = top
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

  const textBlock = textFieldBlock(element)
  return {
    text: textBlock === null ? element.textContent : null,
    textBlock,
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
 */
function translateOps(
  source: string,
  element: ElementSpan,
  axis: 'x' | 'y',
  px: string,
): SourceOp[] {
  const transform = readStyleProp(source, element, 'transform')
  const { tx, ty } = readTranslate(transform)
  const next = replaceTranslate(transform ?? '', axis === 'x' ? px : tx, axis === 'y' ? px : ty)
  return setStyleProp(source, element, 'transform', next)
}

/** Rebuild a transform string, replacing only its `translate` with `translate(x, y)`. */
function replaceTranslate(transform: string, x: string, y: string): string {
  const fns = parseTransform(transform)
  let replaced = false
  const out = fns.map((fn) => {
    if (fn.name === 'translate') {
      replaced = true
      return `translate(${x}, ${y})`
    }
    return `${fn.name}(${fn.args})`
  })
  if (!replaced) out.push(`translate(${x}, ${y})`)
  return out.join(' ')
}

/**
 * Turn one field edit into the source ops that apply it. Returns `[]` when the edit is a no-op the
 * panel should not commit: an empty value, a `text` edit on an element whose text the panel does
 * not edit (`textFieldBlock` — mixed content, a lock, a non-text tag; the gate is applied on the
 * write as well as the read, so a value cannot be forced into a disabled field), or a `text` value
 * that already reads as the element's text (see `textContentOp`).
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
      if (textFieldBlock(element) !== null) return []
      const op = textContentOp(element, rawValue)
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
      const positioned =
        readStyleProp(source, element, 'left') !== null ||
        readStyleProp(source, element, 'top') !== null
      if (positioned) {
        return setStyleProp(source, element, field === 'x' ? 'left' : 'top', asLength(value))
      }
      return translateOps(source, element, axis, asLength(value))
    }
  }
}
