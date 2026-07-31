/**
 * The coordinate arithmetic that keeps the selection overlay glued to the element it outlines at any
 * zoom — §3.4 of `.claude/plans/init/40-design-mode.md`.
 *
 * Two coordinate spaces are in play and this is the whole of the conversion between them:
 *
 *  - **Frame space** — the slide's own 1280×720 box. The iframe keeps its intrinsic size and is
 *    never scaled internally (see `SlideFrame.tsx`), so `document.elementFromPoint` and
 *    `getBoundingClientRect` inside it both speak this space directly.
 *  - **Client/overlay space** — CSS pixels on the host page. The stage applies
 *    `transform: scale(z)` to the frame, where `z` is `fitSlide`'s scale factor, so a frame that is
 *    1280 wide paints `1280·z` wide.
 *
 * The overlay is a non-scaled layer laid exactly over that painted box. A pointer event arrives in
 * client space and must be divided by `z` (after subtracting the box origin) to become the frame
 * coordinate the hit-test request carries; a rect comes back in frame space and must be multiplied
 * by `z` to land on the overlay. Kept pure and DOM-free — happy-dom reports every box as 0×0, so the
 * geometry can only be trusted if it is testable without a layout engine, exactly as `slideFit.ts`
 * is.
 */

import type { SlRect } from './bridge-protocol'

/** A point in either space; the space is whatever the caller's inputs are in. */
export interface Point {
  readonly x: number
  readonly y: number
}

/** The minimum of a `DOMRect` this module reads — the on-screen box of the scaled frame. */
export interface ScreenBox {
  readonly left: number
  readonly top: number
}

function isUsableScale(scale: number): boolean {
  return Number.isFinite(scale) && scale > 0
}

/**
 * Convert a client-space pointer position to frame (1280×720) coordinates.
 *
 * `box` is the on-screen bounding rect of the scaled frame (its `left`/`top`); `scale` is the same
 * `z` `fitSlide` produced and `SlideFrame` applied. A non-positive or non-finite scale — the first
 * paint, a collapsed container, a happy-dom test — yields `{0, 0}` rather than `NaN`/`Infinity`, so
 * a hit-test is simply aimed at the frame origin instead of at an invalid coordinate that would
 * throw or resolve nothing.
 */
export function clientPointToFrame(client: Point, box: ScreenBox, scale: number): Point {
  if (!isUsableScale(scale)) return { x: 0, y: 0 }
  return { x: (client.x - box.left) / scale, y: (client.y - box.top) / scale }
}

/**
 * Convert a frame-space rect (as the bridge reports it) to overlay pixels.
 *
 * The overlay is not itself scaled, so a frame rect is multiplied by `z` to place it. A non-usable
 * scale collapses the rect to a zero box at the origin, which paints nothing — the honest rendering
 * of "no valid geometry yet", matching `fitSlide`'s `scale: 0` contract.
 */
export function frameRectToOverlay(rect: SlRect, scale: number): SlRect {
  if (!isUsableScale(scale)) return { x: 0, y: 0, width: 0, height: 0 }
  return {
    x: rect.x * scale,
    y: rect.y * scale,
    width: rect.width * scale,
    height: rect.height * scale,
  }
}

/**
 * The smallest rect containing all of `rects`, or `null` for an empty list.
 *
 * A single source element can render as several DOM nodes — the adoption-agency clones documented on
 * `ElementSpan.minDomNodeCount` — so a consumer resolving a `data-sl-id` back to geometry measures
 * **every** matching node (`querySelectorAll`, never `querySelector`) and unions their boxes.
 * Measuring only the first would outline half of what the user can see. This is that union, pulled
 * out as a pure function so the rule is tested once here and merely applied in the frame script.
 */
export function unionRects(rects: readonly SlRect[]): SlRect | null {
  if (rects.length === 0) return null
  let left = Infinity
  let top = Infinity
  let right = -Infinity
  let bottom = -Infinity
  for (const rect of rects) {
    left = Math.min(left, rect.x)
    top = Math.min(top, rect.y)
    right = Math.max(right, rect.x + rect.width)
    bottom = Math.max(bottom, rect.y + rect.height)
  }
  return { x: left, y: top, width: right - left, height: bottom - top }
}
