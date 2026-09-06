/**
 * The pure algebra of the `transform` function list Design Mode owns end-to-end — §5.3 of
 * `.claude/plans/init/40-design-mode.md`, the compose/parse half of M3.6's rotate + flip.
 *
 * The plan stores transform as a **canonical ordered string** — `translate(Xpx, Ypx) rotate(Rdeg)
 * scale(S)`. This module reads a value into its three parts (`inspectTransform`), lets an edit
 * replace exactly one part (`withRotation`, `withFlip`, `withTranslateOffset`), and re-emits the
 * canonical string (`composeTransform`). Pure — a string in, a string out — so the merge math is
 * exhaustively unit-testable with no DOM, no source spans and no React.
 *
 * It shares one tokenizer with `style.ts` (`parseTransform`), so a value this module rewrites and a
 * value the M3.3 property panel reads are the same grammar.
 *
 * ## Loud, not lossy: a transform the handles cannot decompose is refused, never reordered
 *
 * Transform functions do not commute. `rotate(90deg) translate(100px, 0)` and
 * `translate(100px, 0) rotate(90deg)` put the element in different places, and `matrix(...)`,
 * `skew(...)`, a repeated `translate`, or a `rotate(0.5turn)` are shapes whose rotation and scale the
 * handles cannot read at all. The first M3.6 cut normalized any author order to canonical order on the
 * first edit and appended unknown functions after ours — which kept every byte but silently *moved*
 * the element, the exact failure a source-preserving editor exists to avoid.
 *
 * So `inspectTransform` is the single gate: it returns `editable` with the decomposed parts only
 * when the value is a subset of `translate rotate scale` (single-axis aliases included), each family
 * at most once, in canonical relative order; anything else is `opaque` with a human-readable reason.
 * The edit functions take `TransformParts`, so the type system makes it impossible to rotate or flip
 * a value that was never decomposed. The overlay hides the handles and shows the reason; the panel,
 * keyboard and AI paths remain, so nothing is lost — it is just not done blind.
 *
 * `translate` is carried **verbatim** (its raw arguments), not parsed: rotation and flip never touch
 * it, and a percentage translate (`translate(-50%, -50%)`, the centring idiom) is perfectly rotatable.
 * Only `withTranslateOffset` needs numbers, and it returns `null` rather than guessing when the
 * arguments are not px.
 */

import { parseTransform } from './style'

/** A 2-axis scale, `1` where absent — the shape flip math operates on. */
export interface Scale {
  readonly sx: number
  readonly sy: number
}

/** The three functions Sloodge owns, decomposed. `composeTransform` is the inverse. */
export interface TransformParts {
  /** The `translate(...)` arguments verbatim (`"10px, 20px"`, `"-50%, -50%"`); `null` when absent. */
  readonly translate: string | null
  /** Rotation in degrees; `0` when absent. */
  readonly rotate: number
  /** Scale per axis; `{1, 1}` when absent. */
  readonly scale: Scale
}

/** What `inspectTransform` decided: the parts, or why the handles must stay off. */
export type TransformShape =
  | { readonly editable: true; readonly parts: TransformParts }
  | { readonly editable: false; readonly reason: string }

const IDENTITY_SCALE: Scale = { sx: 1, sy: 1 }
const IDENTITY: TransformParts = { translate: null, rotate: 0, scale: IDENTITY_SCALE }

type Family = 'translate' | 'rotate' | 'scale'

/** Function name (lowercased) → the family it belongs to. Anything absent here is opaque. */
const FAMILY_OF: Readonly<Record<string, Family>> = {
  translate: 'translate',
  translatex: 'translate',
  translatey: 'translate',
  rotate: 'rotate',
  rotatez: 'rotate',
  scale: 'scale',
  scalex: 'scale',
  scaley: 'scale',
}

/** Canonical emit order of §5.3; an author value in any other relative order is opaque. */
const RANK: Readonly<Record<Family, number>> = { translate: 0, rotate: 1, scale: 2 }

/**
 * A whole value made of `name(args)` terms with no nested parentheses. `parseTransform` is a lenient
 * tokenizer that skips what it cannot read, so it would quietly reduce `translate(calc(50% - 8px), 0)`
 * to garbage; this full-match check is what turns that into a refusal instead.
 */
const FUNCTION_LIST = /^\s*(?:[a-zA-Z][\w-]*\s*\([^()]*\)\s*)+$/

const NUMBER = /^-?(?:\d+\.?\d*|\.\d+)$/

function opaque(reason: string): TransformShape {
  return { editable: false, reason }
}

/** Degrees from a `<angle>`: `45deg`, or a bare number read as degrees. Other units → `null`. */
function parseDegrees(args: string): number | null {
  const match = /^(-?(?:\d+\.?\d*|\.\d+))(deg)?$/.exec(args.trim())
  return match === null ? null : Number(match[1])
}

/** One or two comma-separated `<number>`s; anything else → `null`. */
function parseNumbers(args: string): number[] | null {
  const parts = args.split(',').map((part) => part.trim())
  if (parts.length === 0 || parts.length > 2 || !parts.every((part) => NUMBER.test(part))) {
    return null
  }
  return parts.map(Number)
}

/**
 * Decompose a `transform` value. See the header for the rule: `editable` iff every function is a
 * translate/rotate/scale (or one of their single-axis aliases), each family appears at most once, and
 * they are in canonical relative order. Aliases fold into the canonical form (`scaleX(-1)` reads as
 * `scale(-1, 1)`, `translateY(8px)` as `translate(0, 8px)`); a later `composeTransform` emits the
 * folded form, a one-time rewrite of a function we own rather than a reorder.
 */
export function inspectTransform(transform: string | null): TransformShape {
  if (transform === null) return { editable: true, parts: IDENTITY }
  const value = transform.trim()
  if (value.length === 0 || value === 'none') return { editable: true, parts: IDENTITY }
  if (!FUNCTION_LIST.test(value)) return opaque(`the transform value could not be parsed`)

  let translate: string | null = null
  let rotate = 0
  let scale: Scale = IDENTITY_SCALE
  let lastFamily: Family | null = null
  const seen = new Set<Family>()

  for (const fn of parseTransform(value)) {
    const name = fn.name.toLowerCase()
    const written = `${fn.name}(${fn.args})`
    const family = FAMILY_OF[name]
    if (family === undefined) return opaque(`${written} is not a transform the handles can edit`)
    if (seen.has(family)) return opaque(`${family}() appears more than once`)
    if (lastFamily !== null && RANK[family] < RANK[lastFamily]) {
      return opaque(
        `${fn.name}() comes after ${lastFamily}(); reordering them would move the element`,
      )
    }
    seen.add(family)
    lastFamily = family

    if (family === 'translate') {
      const parts = fn.args.split(',').map((part) => part.trim())
      if (parts.length > 2 || parts.some((part) => part.length === 0)) {
        return opaque(`${written} is not a one- or two-length translate`)
      }
      if (name === 'translatex') translate = `${parts[0]!}, 0`
      else if (name === 'translatey') translate = `0, ${parts[0]!}`
      else translate = parts.join(', ')
    } else if (family === 'rotate') {
      const degrees = parseDegrees(fn.args)
      if (degrees === null) return opaque(`${written} is not in degrees`)
      rotate = degrees
    } else {
      const numbers = parseNumbers(fn.args)
      if (numbers === null) return opaque(`${written} is not a plain numeric scale`)
      const [first, second] = numbers
      if (name === 'scalex') scale = { sx: first!, sy: 1 }
      else if (name === 'scaley') scale = { sx: 1, sy: first! }
      else scale = { sx: first!, sy: second ?? first! }
    }
  }
  return { editable: true, parts: { translate, rotate, scale } }
}

/**
 * Format a scale pair as the shortest exact `scale(...)` arguments — `''` for identity (so the
 * function is dropped), `S` when both axes match, `sx, sy` otherwise. Emitting the uniform short form
 * when the axes are equal is what lets a flip-and-flip-back on `scale(2)` round-trip to `scale(2)`.
 */
function formatScale(scale: Scale): string {
  if (scale.sx === 1 && scale.sy === 1) return ''
  if (scale.sx === scale.sy) return String(scale.sx)
  return `${String(scale.sx)}, ${String(scale.sy)}`
}

/**
 * Re-emit parts as the canonical `translate(...) rotate(...deg) scale(...)` string, omitting every
 * identity part — so a rotation back to 0° or a double flip leaves no junk function behind, and an
 * all-identity value is `''` (the caller removes the declaration).
 */
export function composeTransform(parts: TransformParts): string {
  const out: string[] = []
  if (parts.translate !== null) out.push(`translate(${parts.translate})`)
  if (parts.rotate !== 0) out.push(`rotate(${String(parts.rotate)}deg)`)
  const scale = formatScale(parts.scale)
  if (scale.length > 0) out.push(`scale(${scale})`)
  return out.join(' ')
}

/** The parts with `degrees` as the rotation; translate and scale untouched. */
export function withRotation(parts: TransformParts, degrees: number): TransformParts {
  return { ...parts, rotate: degrees }
}

/** The two flip axes: `x` mirrors left↔right (negates `scaleX`), `y` top↔bottom (`scaleY`). */
export type FlipAxis = 'x' | 'y'

/**
 * Toggle a flip on one axis by negating that axis of the scale; translate and rotation untouched.
 * Applying the same flip twice returns the parts to their exact starting value.
 *
 * Because the canonical order applies `scale` innermost, the flip mirrors the element **within its
 * own rotated frame**: a box at 30° stays at 30° with its content mirrored, so the selection box and
 * handles do not jump. This is DrawingML's model too (`flipH` is applied inside `rot`), so a flipped
 * element exports to PPTX as a flipped element rather than as a negated rotation.
 */
export function withFlip(parts: TransformParts, axis: FlipAxis): TransformParts {
  const { sx, sy } = parts.scale
  return { ...parts, scale: axis === 'x' ? { sx: -sx, sy } : { sx, sy: -sy } }
}

/** A px or unitless length (`"16px"`, `"0"`, `"-4.5px"`) as a number; anything else → `null`. */
function parsePx(part: string): number | null {
  const match = /^(-?(?:\d+\.?\d*|\.\d+))(px)?$/.exec(part.trim())
  return match === null ? null : Number(match[1])
}

/**
 * Add `dx`/`dy` frame px to the translate, or `null` when the existing translate is not in px (a
 * `-50%` cannot have 16px added to it without a `calc()` the tokenizer would then refuse). Used by
 * duplicate to nudge a clone off its original; the caller decides what to do with `null`.
 */
export function withTranslateOffset(
  parts: TransformParts,
  dx: number,
  dy: number,
): TransformParts | null {
  let tx = 0
  let ty = 0
  if (parts.translate !== null) {
    const [first, second] = parts.translate.split(',')
    const x = parsePx(first ?? '')
    const y = second === undefined ? 0 : parsePx(second)
    if (x === null || y === null) return null
    tx = x
    ty = y
  }
  return { ...parts, translate: `${String(tx + dx)}px, ${String(ty + dy)}px` }
}
