/**
 * Turn a completed drag/resize gesture into a single patched slide source, reusing the M3.3
 * byte-span patch layer verbatim — §5.5 + §1.4 of `.claude/plans/init/40-design-mode.md`.
 *
 * This is the seam between the pure drag geometry (`drag.ts`, frame-space rectangles) and the pure
 * source editor (`property-model.ts` / `patch.ts`, byte spans). It is itself pure — `(slideId,
 * source, slId, startRect, nextRect) → patched source` — so the "gesture → new bytes" step is
 * exhaustively testable with no DOM, and the whole drag reduces to one `applyGeometryFields` call
 * the overlay commits through `setSlideHtml` as **one** undoable command (§7.2 coalescing: the
 * gesture is scoped to a single commit, so intermediate pointer frames never reach the stack).
 *
 * ## Why X/Y are delta-based but W/H are absolute
 *
 * `startRect`/`nextRect` are measured **bounding rects** in frame space. An element's on-screen x is
 * its natural flow position *plus* any `transform: translate(...)` — so writing `nextRect.x` as the
 * translate would jump an in-flow element by its natural offset. X/Y therefore add the gesture's
 * *delta* to whatever the source already declares (a `left`/`top` for a positioned block, a
 * `translate` for an in-flow one — `buildFieldOps` picks the channel, §5.3), which is correct for
 * both. Width/height are box-sizing:border-box in every contract-clean slide (starter-slide.ts), so
 * the border-box width equals the measured rect width, and writing the absolute `nextRect` size
 * reproduces the box exactly whether or not the source previously declared a size.
 *
 * ## The re-derivation rule (§2.2) and why fields are applied one at a time
 *
 * The element is resolved from the **parent-owned** map keyed by the parent-tracked `slId` — never a
 * bridge payload. Each field is applied against a *freshly rebuilt* map: two `setStyleProp` writes to
 * the same `style` attribute (a move touches `left` and `top`, a corner resize up to four props)
 * would otherwise emit two ops over the identical value span, which `applyOps` rejects as an overlap.
 * Rebuilding between fields keeps every op anchored to spans that are actually live, so the whole
 * gesture lands as a clean sequence of single-property upserts.
 */

import { applyOps } from './patch'
import { buildFieldOps, readPropertyValues, type PropertyField } from './property-model'
import { buildSlideMap } from './slide-map'
import { geometryDelta } from './drag'
import type { SlRect } from './bridge-protocol'

/** Parse the numeric part of a source length (`"120px"`, `"120"`, `"0"`), defaulting to 0. */
function parseLength(value: string | null): number {
  if (value === null) return 0
  const parsed = Number.parseFloat(value)
  return Number.isFinite(parsed) ? parsed : 0
}

/**
 * The patched slide source after a drag from `startRect` to `nextRect` (both frame-space bounding
 * rects) on the element `slId`. Returns `source` **unchanged** when the gesture moved nothing (a
 * zero-distance click) or the element no longer resolves — the caller treats an unchanged string as
 * "commit nothing", so no empty command reaches the undo stack.
 *
 * `source` must be the current slide bytes the caller read from the store at commit time; every span
 * is anchored to them.
 */
export function buildDragPatch(
  slideId: string,
  source: string,
  slId: string,
  startRect: SlRect,
  nextRect: SlRect,
): string {
  const delta = geometryDelta(startRect, nextRect)

  const map = buildSlideMap(slideId, source)
  const element = map.byId.get(slId)
  if (element === undefined) return source
  const values = readPropertyValues(source, element)

  // Ordered so a corner resize writes position before size; each entry is one field edit.
  const edits: (readonly [PropertyField, string])[] = []
  if (delta.dx !== 0) edits.push(['x', String(Math.round(parseLength(values.x) + delta.dx))])
  if (delta.dy !== 0) edits.push(['y', String(Math.round(parseLength(values.y) + delta.dy))])
  if (delta.dw !== 0) edits.push(['width', String(Math.round(nextRect.width))])
  if (delta.dh !== 0) edits.push(['height', String(Math.round(nextRect.height))])
  if (edits.length === 0) return source

  // Apply one field at a time, rebuilding the map each time so two writes to the same `style` value
  // span never collide in a single `applyOps` batch (see the header). Every write re-derives the
  // element from the parent-owned map — never a message payload.
  let current = source
  for (const [field, value] of edits) {
    const stepMap = buildSlideMap(slideId, current)
    const stepElement = stepMap.byId.get(slId)
    if (stepElement === undefined) break
    const ops = buildFieldOps(current, stepElement, field, value)
    if (ops.length === 0) continue
    current = applyOps(current, ops)
  }
  return current
}
