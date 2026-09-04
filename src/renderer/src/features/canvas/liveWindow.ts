/**
 * Which slides are *live* — mounted as real documents — for a given selection (M8.2).
 *
 * Memory is O(mounted documents), not O(deck): every live frame is a published `slide://` document,
 * a parsed DOM, a running script, and (per host) a renderer process. So the set of live slides is
 * the active one plus a fixed radius of neighbours, and nothing else. The neighbours exist for one
 * reason — a step to the next or previous slide must be a visibility toggle, not a navigation, so
 * switching stays instant and Present never shows a blank frame on advance. Everything outside the
 * window is held only as its serialized source in the deck store.
 *
 * Pure so the edge cases (first slide, last slide, a one-slide deck, no selection) are pinned in a
 * unit test rather than discovered in the stage component.
 */

export type LiveSlideRole = 'active' | 'warm'

export type LiveSlide<T> = {
  readonly slide: T
  readonly role: LiveSlideRole
}

/** How many slides either side of the active one stay mounted. The roadmap's "±1". */
export const LIVE_WINDOW_RADIUS = 1

/**
 * The live window around `activeIndex`, **ordered by slide id**, not by deck position.
 *
 * The order is load-bearing. The stage keys frames by slide id, and React moves a keyed child in the
 * DOM whenever the children's relative order changes; a moved `<iframe>` reloads its document, which
 * is exactly the flash the window exists to prevent. Deck order is *not* stable under the operations
 * the window has to survive: moving the selected slide one slot turns `[B, C, D]` into `[D, C, E]`,
 * and the active frame C would be moved. Id order is a total order that no reorder, step or jump can
 * change for two surviving frames, so every transition is inserts and removes only. Nothing depends
 * on DOM order — the warm frames are absolutely positioned over the active one.
 *
 * Out-of-range `activeIndex` (no selection, empty deck) yields an empty window.
 */
export function liveSlideWindow<T extends { readonly id: string }>(
  slides: readonly T[],
  activeIndex: number,
): LiveSlide<T>[] {
  if (activeIndex < 0 || activeIndex >= slides.length) return []
  const from = Math.max(0, activeIndex - LIVE_WINDOW_RADIUS)
  const to = Math.min(slides.length - 1, activeIndex + LIVE_WINDOW_RADIUS)
  return slides
    .slice(from, to + 1)
    .map((slide, offset): LiveSlide<T> => ({
      slide,
      role: from + offset === activeIndex ? 'active' : 'warm',
    }))
    .toSorted((a, b) => (a.slide.id < b.slide.id ? -1 : a.slide.id > b.slide.id ? 1 : 0))
}
