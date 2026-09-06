/**
 * Turn a completed rotate or flip into a single patched slide source, reusing the M3.3 byte-span
 * patch layer verbatim — the M3.6 sibling of `drag-commit.ts` (§5.3 + §1.4 of
 * `.claude/plans/init/40-design-mode.md`).
 *
 * Both builders are pure — `(slideId, source, slId) → patched source` — so "gesture → new bytes" is
 * exhaustively testable with no DOM, and the overlay/panel commit through `setSlideHtml` as **one**
 * undoable command each (§7.2: the whole rotation gesture is one commit; a flip is one click).
 *
 * ## The re-derivation rule (§2.2)
 *
 * The element is resolved from the **parent-owned** map keyed by the parent-tracked `slId`, never a
 * bridge payload. Both edits touch exactly one declaration (`transform`) via the M3.3 helpers, and
 * either write it (`setStyleProp`) or, when it resolves to identity, remove it (`removeStyleProp`) —
 * so a rotation back to 0° or a double flip leaves the source byte-clean rather than trailing an
 * empty declaration. A no-op returns `source` **unchanged**, which the caller reads as "commit
 * nothing", so no empty command reaches the undo stack.
 *
 * An element whose transform `inspectTransform` refuses is also a no-op here: the overlay has already
 * hidden its handles and said why (`readTransformShape`), so this is the last line, not the message.
 */

import { applyOps, readStyleProp, removeStyleProp, setStyleProp } from './patch'
import { buildSlideMap } from './slide-map'
import {
  composeTransform,
  inspectTransform,
  withFlip,
  withRotation,
  type FlipAxis,
  type TransformParts,
  type TransformShape,
} from './transform'
import type { ElementSpan } from './types'

/** The element's transform as the handles see it: its parts, or the reason they are off. */
export function readTransformShape(source: string, element: ElementSpan): TransformShape {
  return inspectTransform(readStyleProp(source, element, 'transform'))
}

/** Write the composed parts as the element's `transform`, or remove the declaration for identity. */
function commitTransform(
  slideId: string,
  source: string,
  slId: string,
  compute: (parts: TransformParts) => TransformParts,
): string {
  const map = buildSlideMap(slideId, source)
  const element = map.byId.get(slId)
  if (element === undefined) return source

  const current = readStyleProp(source, element, 'transform')
  const shape = inspectTransform(current)
  if (!shape.editable) return source
  const next = composeTransform(compute(shape.parts))
  if ((current ?? '') === next) return source

  const ops =
    next.length === 0
      ? removeStyleProp(source, element, 'transform')
      : setStyleProp(source, element, 'transform', next)
  if (ops.length === 0) return source
  return applyOps(source, ops)
}

/**
 * The patched source after rotating `slId` to `degrees` (absolute, already snapped by the gesture).
 * `0°` removes the `rotate` function. Returns `source` unchanged when the element does not resolve,
 * its transform is opaque, or the rotation is already what the source says.
 */
export function buildRotatePatch(
  slideId: string,
  source: string,
  slId: string,
  degrees: number,
): string {
  return commitTransform(slideId, source, slId, (parts) => withRotation(parts, degrees))
}

/**
 * The patched source after flipping `slId` on `axis`. Composes into `scale(...)` without touching
 * the translate or rotation; flipping the same axis twice restores the source.
 */
export function buildFlipPatch(
  slideId: string,
  source: string,
  slId: string,
  axis: FlipAxis,
): string {
  return commitTransform(slideId, source, slId, (parts) => withFlip(parts, axis))
}
