/**
 * Turn a **multi-element** geometry change — align, distribute, or a group move — into a single
 * patched slide source, so the whole thing lands as **one** undoable command (§7.1 of
 * `.claude/plans/init/40-design-mode.md`; roadmap M3.7 "one undoable command"). It is the multi-
 * element generalization of `drag-commit.ts`: that file chains per-*field* edits over one source
 * string, rebuilding the map between each so no two ops collide on the same `style` span; this chains
 * per-*element* edits the same way, reusing `buildDragPatch` verbatim for each element.
 *
 * Pure — `(slideId, source, edits) → patched source` — so "N moved rects → new bytes" is exhaustively
 * testable with no DOM, and the caller commits the result through a single `setSlideHtml`, which is
 * the one-command guarantee: the overlay never calls `setSlideHtml` per element (that would be N undo
 * steps). Returns `source` **unchanged** when nothing moved, so an align that was already satisfied
 * commits no empty command.
 */

import type { SlRect } from './bridge-protocol'
import { buildDragPatch } from './drag-commit'

/** One element's move: its id, the rect it started at, and the rect it should end at. */
export interface ElementMove {
  readonly slId: string
  readonly startRect: SlRect
  readonly nextRect: SlRect
}

/**
 * The patched source after applying every move in `edits`, chained over one string. Each element is
 * re-derived from a **freshly rebuilt** map (inside `buildDragPatch`) so spans never go stale across
 * the sequence, and each edit re-derives from the parent-owned map by its tracked `slId` — never a
 * bridge payload (§2.2). `source` must be the current slide bytes the caller read at commit time.
 */
/** The patched source, and which members' bytes actually changed. */
export interface MultiElementPatch {
  readonly source: string
  /**
   * The `slId`s whose edit produced bytes. A member `buildDragPatch` refused — its transform is
   * opaque and the move would go through it — or that no longer resolves is absent, so a caller
   * shifts only the stored geometry of what really moved rather than every member it asked about.
   */
  readonly moved: ReadonlySet<string>
}

export function buildMultiElementPatch(
  slideId: string,
  source: string,
  edits: readonly ElementMove[],
): MultiElementPatch {
  let current = source
  const moved = new Set<string>()
  for (const edit of edits) {
    const next = buildDragPatch(slideId, current, edit.slId, edit.startRect, edit.nextRect)
    if (next !== current) moved.add(edit.slId)
    current = next
  }
  return { source: current, moved }
}
