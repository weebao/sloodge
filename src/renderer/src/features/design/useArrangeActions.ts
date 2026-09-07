/**
 * The M3.7 **align / distribute** actions — the multi-select analogue of `useElementActions`. Each
 * action reads the current ordered selection (`designStore.selections`), computes each element's
 * target rect with the pure `arrange.ts` geometry, patches every element into **one** slide source
 * via `buildMultiElementPatch`, and commits it with a single `setSlideHtml` — so a whole align of
 * five elements is exactly one undoable command (§7.1; roadmap M3.7). The hook is only wiring; the
 * geometry and the byte-span math are pure and tested on their own.
 *
 * ## The re-derivation rule (§2.2, normative)
 *
 * Every element is re-derived from the **store's current bytes** and the parent-tracked `slId`
 * (`selection.slId`) at call time, never a bridge payload. The selection *rects* used for the
 * geometry come from the last hit-test the parent stored — an untrusted hint that only decides *how
 * far* to move — while the actual source edit resolves spans from the parent-owned map, so a forged
 * rect can at most move a real element to a slightly wrong place a subsequent undo reverses.
 */

import { useCallback, useMemo } from 'react'
import type { SlRect } from '../../../../shared/design/bridge-protocol'
import {
  alignRects,
  distributeRects,
  MIN_ALIGN,
  MIN_DISTRIBUTE,
  type AlignEdge,
  type DistributeAxis,
} from '../../../../shared/design/arrange'
import { boxOf, shiftHit } from '../../../../shared/design/hit-geometry'
import { buildMultiElementPatch, type ElementMove } from '../../../../shared/design/multi-commit'
import { getSlideHtml, useDeckStore } from '../../stores/deckStore'
import { useDesignStore } from './designStore'

const ALIGN_LABEL: Readonly<Record<AlignEdge, string>> = {
  left: 'Align left',
  hcenter: 'Align center',
  right: 'Align right',
  top: 'Align top',
  vcenter: 'Align middle',
  bottom: 'Align bottom',
}

export interface ArrangeActions {
  /** Align every selected element to `edge` of the selection bounds, one undoable command. */
  readonly align: (edge: AlignEdge) => void
  /** Evenly space the selected elements' centres along `axis`, one undoable command. */
  readonly distribute: (axis: DistributeAxis) => void
  /** True when at least two elements are selected — align is a no-op otherwise. */
  readonly canAlign: boolean
  /** True when at least three elements are selected — distribute is a no-op otherwise. */
  readonly canDistribute: boolean
}

export function useArrangeActions(slideId: string): ArrangeActions {
  const selections = useDesignStore((state) => state.selections)
  const setSelections = useDesignStore((state) => state.setSelections)
  const setSlideHtml = useDeckStore((state) => state.setSlideHtml)

  // Commit a set of per-element target rects as one command: build one patched source over all of
  // them, push a single `setSlideHtml`, and shift the stored selection geometry to match.
  const commit = useCallback(
    (targets: readonly SlRect[], label: string): void => {
      const anchor = selections.at(-1)
      if (anchor === undefined) return
      const current = getSlideHtml(useDeckStore.getState().slideHtml, slideId)
      if (current === undefined) return

      const edits: ElementMove[] = selections.map((hit, index) => ({
        slId: hit.slId,
        startRect: boxOf(hit),
        nextRect: targets[index] ?? boxOf(hit),
      }))
      const { source: patched, moved } = buildMultiElementPatch(slideId, current, edits)
      if (patched === current) return
      if (!setSlideHtml(slideId, patched, anchor.slId, label)) return

      // A member the pure layer refused (its move would have gone through an opaque transform)
      // kept its bytes, so its stored box stays where it is too.
      setSelections(
        selections.map((hit, index) => {
          const target = targets[index]
          if (target === undefined || !moved.has(hit.slId)) return hit
          const start = boxOf(hit)
          return shiftHit(hit, target.x - start.x, target.y - start.y)
        }),
      )
    },
    [selections, slideId, setSlideHtml, setSelections],
  )

  const align = useCallback(
    (edge: AlignEdge): void => {
      if (selections.length < MIN_ALIGN) return
      commit(alignRects(selections.map(boxOf), edge), ALIGN_LABEL[edge])
    },
    [selections, commit],
  )

  const distribute = useCallback(
    (axis: DistributeAxis): void => {
      if (selections.length < MIN_DISTRIBUTE) return
      commit(
        distributeRects(selections.map(boxOf), axis),
        axis === 'horizontal' ? 'Distribute horizontally' : 'Distribute vertically',
      )
    },
    [selections, commit],
  )

  return useMemo(
    () => ({
      align,
      distribute,
      canAlign: selections.length >= MIN_ALIGN,
      canDistribute: selections.length >= MIN_DISTRIBUTE,
    }),
    [align, distribute, selections.length],
  )
}
