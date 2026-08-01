/**
 * The pure geometry of drag-to-move and resize — §5.5 of `.claude/plans/init/40-design-mode.md`,
 * the M3.5 milestone. Nothing here touches the DOM, React, the store, or the source: it is
 * arithmetic on rectangles in the slide's own 1280×720 **frame space**, which is the whole reason it
 * can be exhaustively unit-tested with no browser and no layout engine.
 *
 * Two spaces meet at the caller, not here. A pointer moves in client pixels; the overlay divides
 * that delta by the fit-to-pane scale `z` (`clientDeltaToFrame` in `overlay-geometry.ts`) to get the
 * **frame-space** delta this module consumes. So every function below is scale-independent: feed it a
 * frame delta and it returns a frame rect, and the scale-correctness of the whole gesture reduces to
 * that one division, tested where it lives.
 *
 * ## What each handle anchors
 *
 * The eight resize handles each drag one or two edges of the box; the *opposite* edge stays put (its
 * anchor), so dragging the NW handle keeps the SE corner fixed and vice-versa. `move` translates the
 * whole box. `Alt` resizes about the box centre instead (both opposite edges move symmetrically);
 * `Shift` locks a move to its dominant axis and locks a corner resize to the box's start aspect
 * ratio. These are the modifiers §5.5 and §4.2 name; anything else is left for a later milestone.
 *
 * ## Floors, not walls
 *
 * A resize is floored at `MIN_SIZE` frame px so a box can never invert or collapse to nothing — the
 * dragged edge is pulled back to the floor rather than crossing its anchor. Movement is deliberately
 * **not** clamped to the frame: the plan specifies *snapping* to edges and guides (a later
 * milestone), never a hard wall, and a slide element legitimately bleeds off-frame (a full-bleed
 * image, a decorative shape). Off-frame is allowed and left to the user.
 */

import type { SlRect } from './bridge-protocol'
import type { Point } from './overlay-geometry'

/** The eight resize grips: corners and edge midpoints. */
export type ResizeHandle = 'n' | 's' | 'e' | 'w' | 'nw' | 'ne' | 'sw' | 'se'

/** Every draggable affordance: the eight grips plus the selection body (move). */
export type DragHandle = 'move' | ResizeHandle

/** The keyboard modifiers that alter a drag, read live from the pointer event. */
export interface DragModifiers {
  /** Move → lock to dominant axis; corner resize → lock to start aspect ratio (§5.5). */
  readonly shift: boolean
  /** Resize about the box centre instead of the opposite edge (§5.5). Ignored for move. */
  readonly alt: boolean
}

/** The smallest a resize may make either dimension, in frame px. A box can never invert. */
export const MIN_SIZE = 8

/** Which horizontal edge a handle drags — `null` for the pure-vertical edge handles. */
const H_EDGE: Readonly<Record<ResizeHandle, 'left' | 'right' | null>> = {
  n: null,
  s: null,
  e: 'right',
  w: 'left',
  nw: 'left',
  ne: 'right',
  sw: 'left',
  se: 'right',
}

/** Which vertical edge a handle drags — `null` for the pure-horizontal edge handles. */
const V_EDGE: Readonly<Record<ResizeHandle, 'top' | 'bottom' | null>> = {
  n: 'top',
  s: 'bottom',
  e: null,
  w: null,
  nw: 'top',
  ne: 'top',
  sw: 'bottom',
  se: 'bottom',
}

interface Edges {
  left: number
  top: number
  right: number
  bottom: number
}

function toEdges(rect: SlRect): Edges {
  return { left: rect.x, top: rect.y, right: rect.x + rect.width, bottom: rect.y + rect.height }
}

function toRect(edges: Edges): SlRect {
  return {
    x: edges.left,
    y: edges.top,
    width: edges.right - edges.left,
    height: edges.bottom - edges.top,
  }
}

/** Type guard so the resize path can index `H_EDGE`/`V_EDGE` without a cast. */
function isResizeHandle(handle: DragHandle): handle is ResizeHandle {
  return handle !== 'move'
}

/**
 * A move, with `Shift` optionally locking to the dominant axis. Off-frame is allowed (see header),
 * so this is just a translate — no clamp.
 */
function applyMove(start: SlRect, delta: Point, mods: DragModifiers): SlRect {
  let { x: dx, y: dy } = delta
  if (mods.shift) {
    // Lock to whichever axis the pointer has travelled further along; ties keep horizontal, which
    // is the axis a reader's hand favours and the one a tie is most likely meant for.
    if (Math.abs(dx) >= Math.abs(dy)) dy = 0
    else dx = 0
  }
  return { x: start.x + dx, y: start.y + dy, width: start.width, height: start.height }
}

/**
 * Rewrite a corner-resize delta so the box keeps its start aspect ratio (`Shift`, §5.5). The axis
 * the pointer drives further (relative to the box's own proportions) wins; the other dimension is
 * derived from it. Only meaningful for corners — an edge handle has a single free axis, so the
 * caller passes `mods.shift` through unchanged for those.
 */
function lockAspect(
  start: SlRect,
  hEdge: 'left' | 'right',
  vEdge: 'top' | 'bottom',
  delta: Point,
): Point {
  if (start.width <= 0 || start.height <= 0) return delta
  const widthChange = hEdge === 'right' ? delta.x : -delta.x
  const heightChange = vEdge === 'bottom' ? delta.y : -delta.y
  const ratio = start.width / start.height
  // Compare the two proposed size changes in the *same* units by scaling one axis into the other.
  // Width drives when its change dominates the box's aspect; otherwise height drives.
  const widthDrives = Math.abs(widthChange) * start.height >= Math.abs(heightChange) * start.width
  let nextWidthChange: number
  let nextHeightChange: number
  if (widthDrives) {
    nextWidthChange = widthChange
    nextHeightChange = widthChange / ratio
  } else {
    nextHeightChange = heightChange
    nextWidthChange = heightChange * ratio
  }
  return {
    x: hEdge === 'right' ? nextWidthChange : -nextWidthChange,
    y: vEdge === 'bottom' ? nextHeightChange : -nextHeightChange,
  }
}

/** Pull a horizontal pair back to `MIN_SIZE` if the drag collapsed it, honouring the anchor. */
function floorHorizontal(edges: Edges, hEdge: 'left' | 'right', alt: boolean): void {
  if (edges.right - edges.left >= MIN_SIZE) return
  if (alt) {
    const cx = (edges.left + edges.right) / 2
    edges.left = cx - MIN_SIZE / 2
    edges.right = cx + MIN_SIZE / 2
  } else if (hEdge === 'left') {
    edges.left = edges.right - MIN_SIZE
  } else {
    edges.right = edges.left + MIN_SIZE
  }
}

/** Pull a vertical pair back to `MIN_SIZE` if the drag collapsed it, honouring the anchor. */
function floorVertical(edges: Edges, vEdge: 'top' | 'bottom', alt: boolean): void {
  if (edges.bottom - edges.top >= MIN_SIZE) return
  if (alt) {
    const cy = (edges.top + edges.bottom) / 2
    edges.top = cy - MIN_SIZE / 2
    edges.bottom = cy + MIN_SIZE / 2
  } else if (vEdge === 'top') {
    edges.top = edges.bottom - MIN_SIZE
  } else {
    edges.bottom = edges.top + MIN_SIZE
  }
}

/**
 * The new frame rect after dragging `handle` by `delta` (frame px), with modifiers applied.
 *
 * Move translates the box; a resize drags this handle's edge(s) while the opposite edge stays put
 * (or, with `Alt`, moves symmetrically so the centre stays put). `Shift` locks a move to its
 * dominant axis and a corner resize to the start aspect ratio. The result is floored at `MIN_SIZE`
 * per axis so the box can never invert. Pure — no clamp to the frame (off-frame is allowed).
 */
export function applyDrag(
  start: SlRect,
  handle: DragHandle,
  delta: Point,
  mods: DragModifiers,
): SlRect {
  if (!isResizeHandle(handle)) return applyMove(start, delta, mods)

  const hEdge = H_EDGE[handle]
  const vEdge = V_EDGE[handle]

  let effective = delta
  if (mods.shift && hEdge !== null && vEdge !== null) {
    effective = lockAspect(start, hEdge, vEdge, delta)
  }

  const edges = toEdges(start)
  if (hEdge === 'left') {
    edges.left += effective.x
    if (mods.alt) edges.right -= effective.x
  } else if (hEdge === 'right') {
    edges.right += effective.x
    if (mods.alt) edges.left -= effective.x
  }
  if (vEdge === 'top') {
    edges.top += effective.y
    if (mods.alt) edges.bottom -= effective.y
  } else if (vEdge === 'bottom') {
    edges.bottom += effective.y
    if (mods.alt) edges.top -= effective.y
  }

  if (hEdge !== null) floorHorizontal(edges, hEdge, mods.alt)
  if (vEdge !== null) floorVertical(edges, vEdge, mods.alt)
  return toRect(edges)
}

/** The per-component change from `start` to `next`, each rounded to whole frame px. */
export interface GeometryDelta {
  readonly dx: number
  readonly dy: number
  readonly dw: number
  readonly dh: number
}

/**
 * The whole-pixel change between two frame rects. Rounding here is what makes a zero-distance drag
 * (or a sub-pixel jitter) produce an all-zero delta — which the commit layer reads as "nothing to
 * do", so a click that does not move commits no command (§7.2).
 */
export function geometryDelta(start: SlRect, next: SlRect): GeometryDelta {
  return {
    dx: Math.round(next.x) - Math.round(start.x),
    dy: Math.round(next.y) - Math.round(start.y),
    dw: Math.round(next.width) - Math.round(start.width),
    dh: Math.round(next.height) - Math.round(start.height),
  }
}

/** Whether a delta changes any geometry at all — the commit-nothing guard for a zero-move gesture. */
export function isZeroDelta(delta: GeometryDelta): boolean {
  return delta.dx === 0 && delta.dy === 0 && delta.dw === 0 && delta.dh === 0
}
