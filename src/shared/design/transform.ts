/**
 * The pure algebra of the `transform` function list Design Mode owns end-to-end — §5.3 of
 * `.claude/plans/init/40-design-mode.md`, the compose/parse half of M3.6's rotate + flip.
 *
 * The plan stores transform as a **canonical ordered string** — `translate(Xpx, Ypx) rotate(Rdeg)
 * scale(S)` — parsing the existing value, replacing only the function being edited, and re-emitting
 * in that order with any unrecognised function preserved and appended verbatim after ours. This
 * module is that rule, kept pure (a string in, a string out) so the merge math — the thing M3.6's
 * mutation tests guard against clobbering an existing `translate` — is exhaustively unit-testable
 * with no DOM, no source spans and no React.
 *
 * It shares one parser with `style.ts` (`parseTransform`), so a value this module rewrites and a
 * value the M3.3 property panel reads are the same grammar; nothing here re-implements tokenizing.
 *
 * ## Why rotate/flip live here and not in `style.ts::upsertTransform`
 *
 * `upsertTransform` is a positional append-if-absent helper the M3.3 panel used for `translate`.
 * Rotation and flip need two things it does not give: identity **removal** (a rotation back to 0°,
 * or a double flip, must leave *no* junk function behind so the source round-trips clean) and
 * canonical **reordering** (so `translate rotate scale` is always emitted in that order regardless
 * of the order the author or a prior edit left them in). Those are M3.6 concerns, so they live in
 * the M3.6 module rather than widening the M3.3 one.
 */

import { parseTransform, type TransformFunction } from './style'

/** The functions Sloodge owns, in the canonical emit order of §5.3. Unknowns sort after these. */
const CANONICAL_ORDER: readonly string[] = ['translate', 'rotate', 'scale']

/** Sort rank for a transform function: its canonical index, or past the end for unknowns. */
function rankOf(name: string): number {
  const index = CANONICAL_ORDER.indexOf(name)
  return index === -1 ? CANONICAL_ORDER.length : index
}

/** Re-emit a function list as a transform value: `name(args)` joined by a single space. */
function serialize(functions: readonly TransformFunction[]): string {
  return functions.map((fn) => `${fn.name}(${fn.args})`).join(' ')
}

/**
 * Stable-sort a function list into canonical order. Known functions lead in `translate, rotate,
 * scale` order; every unrecognised function keeps its original relative position after them (a
 * stable sort keyed on `(rank, originalIndex)`), which is §5.3's "preserved and appended verbatim".
 */
function canonicalize(functions: readonly TransformFunction[]): TransformFunction[] {
  return functions
    .map((fn, index) => ({ fn, index }))
    .toSorted((a, b) => rankOf(a.fn.name) - rankOf(b.fn.name) || a.index - b.index)
    .map((entry) => entry.fn)
}

/** Replace `name`'s args in place (or append it), then re-emit in canonical order. */
function upsert(transform: string | null, name: string, args: string): string {
  const functions = parseTransform(transform ?? '')
  let replaced = false
  const next = functions.map((fn) => {
    if (fn.name !== name) return fn
    replaced = true
    return { name, args }
  })
  if (!replaced) next.push({ name, args })
  return serialize(canonicalize(next))
}

/** Drop every occurrence of `name`, then re-emit the rest in canonical order. */
function remove(transform: string | null, name: string): string {
  const kept = parseTransform(transform ?? '').filter((fn) => fn.name !== name)
  return serialize(canonicalize(kept))
}

/** Parse a `<angle>` argument (`"45deg"`, `"45"`, `"-90deg"`) to a number of degrees; NaN → 0. */
function parseAngle(args: string): number {
  const value = Number.parseFloat(args)
  return Number.isFinite(value) ? value : 0
}

/**
 * The element's current rotation in degrees, read from `rotate(...)`; `0` when there is none.
 *
 * Only `deg` (and a bare number treated as degrees) is understood — the unit Sloodge itself writes.
 * A `turn`/`rad` an author hand-wrote would be misread, which is acceptable for the overlay's
 * orientation hint and is noted rather than silently trusted.
 */
export function readRotation(transform: string | null): number {
  if (transform === null) return 0
  const fn = parseTransform(transform).find((f) => f.name === 'rotate')
  return fn === undefined ? 0 : parseAngle(fn.args)
}

/**
 * A 2-axis scale, `1` where absent — the shape flip math operates on.
 */
export interface Scale {
  readonly sx: number
  readonly sy: number
}

/**
 * The element's current `scale(...)`, defaulting each axis to `1`. A one-argument `scale(S)` is
 * uniform (both axes `S`); a two-argument `scale(sx, sy)` sets them independently.
 */
export function readScale(transform: string | null): Scale {
  if (transform === null) return { sx: 1, sy: 1 }
  const fn = parseTransform(transform).find((f) => f.name === 'scale')
  if (fn === undefined) return { sx: 1, sy: 1 }
  const parts = fn.args.split(',').map((part) => Number.parseFloat(part.trim()))
  const sx = Number.isFinite(parts[0]) ? parts[0]! : 1
  const sy = parts.length > 1 && Number.isFinite(parts[1]) ? parts[1]! : sx
  return { sx, sy }
}

/**
 * Format a scale pair as the shortest exact `scale(...)` — `''` for identity (so the caller drops
 * the function), `scale(S)` when both axes match, `scale(sx, sy)` otherwise. Emitting the uniform
 * short form when the axes are equal is what lets a flip-and-flip-back on `scale(2)` round-trip to
 * `scale(2)` rather than to `scale(2, 2)`.
 */
function formatScale(scale: Scale): string {
  if (scale.sx === 1 && scale.sy === 1) return ''
  if (scale.sx === scale.sy) return String(scale.sx)
  return `${String(scale.sx)}, ${String(scale.sy)}`
}

/**
 * Write `degrees` as the element's rotation, composing with (never clobbering) any existing
 * `translate`/`scale`/unknown function. A `degrees` of `0` **removes** the `rotate` function so a
 * rotation back to upright leaves the transform exactly as it would have been without one. Result is
 * canonically ordered.
 */
export function setRotation(transform: string | null, degrees: number): string {
  if (degrees === 0) return remove(transform, 'rotate')
  return upsert(transform, 'rotate', `${String(degrees)}deg`)
}

/**
 * Add `dx`/`dy` frame px to the element's `translate(...)`, composing with any existing translate
 * and every other transform function. Used by duplicate to nudge a clone off its original so it is
 * visible. Reads the existing translate numerically (px), so a non-px author translate is treated as
 * its bare number — acceptable for a cosmetic nudge and noted rather than silently trusted; every
 * translate Sloodge itself writes is px.
 */
export function addTranslateOffset(transform: string | null, dx: number, dy: number): string {
  const existing = parseTransform(transform ?? '').find((fn) => fn.name === 'translate')
  let tx = 0
  let ty = 0
  if (existing !== undefined) {
    const parts = existing.args.split(',').map((part) => Number.parseFloat(part.trim()))
    tx = Number.isFinite(parts[0]) ? parts[0]! : 0
    ty = parts.length > 1 && Number.isFinite(parts[1]) ? parts[1]! : 0
  }
  return upsert(transform, 'translate', `${String(tx + dx)}px, ${String(ty + dy)}px`)
}

/** The two flip axes: `x` mirrors left↔right (negates `scaleX`), `y` top↔bottom (`scaleY`). */
export type FlipAxis = 'x' | 'y'

/**
 * Toggle a flip on one axis by negating that axis of `scale(...)`, composing with every other
 * transform function. Applying the same flip twice returns the transform to its exact starting
 * value (`scaleX` goes `1 → -1 → 1`, and an identity scale is removed), which is the property M3.6's
 * "flip then flip returns to original" test pins. Result is canonically ordered.
 */
export function toggleFlip(transform: string | null, axis: FlipAxis): string {
  const current = readScale(transform)
  const flipped: Scale =
    axis === 'x' ? { sx: -current.sx, sy: current.sy } : { sx: current.sx, sy: -current.sy }
  const args = formatScale(flipped)
  return args.length === 0 ? remove(transform, 'scale') : upsert(transform, 'scale', args)
}
