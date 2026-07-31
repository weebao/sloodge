import {
  memo,
  useCallback,
  useMemo,
  useState,
  type DragEvent,
  type JSX,
  type KeyboardEvent,
  type MouseEvent,
} from 'react'
import { SlideFrame } from '../canvas/SlideFrame'
import { fitSlide, SLIDE_SIZE } from '../canvas/slideFit'
import type { SlideId } from '../../../../shared/document/types'
import type { SlideView } from '../../stores/deckStore'
import { SlideContextMenu, type SlideContextMenuItem } from './SlideContextMenu'

/**
 * Thumbnail width in CSS px, and with it the mini-frame's scale.
 *
 * A constant, not a measurement: the rail is a fixed 188px column (`w-[188px]`) minus its 12px
 * gutters, the 12px slide-number column and the 8px gap. Every card is therefore the same known
 * width, and hard-coding it avoids a `ResizeObserver` per thumbnail — the one place in this
 * milestone where per-slide cost multiplies by deck length.
 */
export const THUMBNAIL_WIDTH = 144

/** The card is exactly 16:9, so the fit is width-bound; going through `fitSlide` keeps the one
 *  scaling rule in one place rather than open-coding a division here. */
const THUMBNAIL_FIT = fitSlide({
  width: THUMBNAIL_WIDTH,
  height: (THUMBNAIL_WIDTH * SLIDE_SIZE.height) / SLIDE_SIZE.width,
})

/** Hoisted: the width is a constant, so the style object is one allocation for the whole rail. */
const THUMBNAIL_BOX_STYLE = { width: `${String(THUMBNAIL_WIDTH)}px` } as const

/** Which side of the hovered card the drop indicator is drawn on, or `null` for no indicator. */
type DropEdge = 'before' | 'after'

type ThumbnailCardProps = {
  /** Position in `slideOrder`; the drag/drop protocol below is index-based. */
  index: number
  /** 1-based, for the label only; identity is the slide id. */
  number: number
  slide: SlideView
  selected: boolean
  dragging: boolean
  dropEdge: DropEdge | null
  onSelect: (id: SlideId) => void
  onOpenMenu: (id: SlideId, x: number, y: number) => void
  onDragStartCard: (index: number) => void
  onDragOverCard: (index: number) => void
  onDropCard: (index: number) => void
  onDragEndCard: () => void
  onMoveCard: (fromIndex: number, toIndex: number) => void
}

/**
 * Memoized so a selection change re-renders two cards, not the whole deck — and so an edit to one
 * slide's HTML cannot reload every other slide's frame. Props are primitives plus the `SlideView`,
 * which is rebuilt on every deck change; that is fine, because the expensive child (`SlideFrame`)
 * is itself memoized on the *string* `html` and so is left alone unless the bytes really changed.
 */
const ThumbnailCard = memo(function ThumbnailCard({
  index,
  number,
  slide,
  selected,
  dragging,
  dropEdge,
  onSelect,
  onOpenMenu,
  onDragStartCard,
  onDragOverCard,
  onDropCard,
  onDragEndCard,
  onMoveCard,
}: ThumbnailCardProps): JSX.Element {
  const handleClick = useCallback(() => {
    onSelect(slide.id)
  }, [slide.id, onSelect])

  const handleContextMenu = useCallback(
    (event: MouseEvent) => {
      event.preventDefault()
      // Right-clicking selects, as it does in PowerPoint: the menu's verbs read as "this slide",
      // and the canvas has to agree with them before the user picks one.
      onSelect(slide.id)
      onOpenMenu(slide.id, event.clientX, event.clientY)
    },
    [slide.id, onSelect, onOpenMenu],
  )

  const handleDragStart = useCallback(
    (event: DragEvent<HTMLLIElement>) => {
      event.dataTransfer.effectAllowed = 'move'
      // Firefox refuses to start a drag with an empty data transfer; the payload itself is unused
      // (the rail tracks the source index in state, which is what survives a re-render).
      event.dataTransfer.setData('text/plain', String(index))
      onDragStartCard(index)
    },
    [index, onDragStartCard],
  )

  const handleDragOver = useCallback(
    (event: DragEvent<HTMLLIElement>) => {
      // Without `preventDefault` on *dragover*, the browser never fires a drop.
      event.preventDefault()
      event.dataTransfer.dropEffect = 'move'
      onDragOverCard(index)
    },
    [index, onDragOverCard],
  )

  const handleDrop = useCallback(
    (event: DragEvent<HTMLLIElement>) => {
      event.preventDefault()
      onDropCard(index)
    },
    [index, onDropCard],
  )

  /**
   * Alt+Arrow moves the focused slide. Drag-and-drop is a mouse-only affordance, and reordering is
   * the one rail action with no other route to it — Duplicate and Delete are both in the context
   * menu, which the keyboard can open, but a keyboard-only user with no reorder has no way to
   * arrange a deck at all.
   */
  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLButtonElement>) => {
      if (!event.altKey) return
      if (event.key === 'ArrowUp') {
        event.preventDefault()
        onMoveCard(index, index - 1)
      } else if (event.key === 'ArrowDown') {
        event.preventDefault()
        onMoveCard(index, index + 1)
      }
    },
    [index, onMoveCard],
  )

  return (
    <li
      draggable
      onDragStart={handleDragStart}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
      onDragEnd={onDragEndCard}
      onContextMenu={handleContextMenu}
      data-slide-index={index}
      // The indicator is a border on the card's own box rather than a separate node, so it cannot
      // change the rail's layout mid-drag and make the drop target move under the pointer.
      className={`relative border-y-2 border-transparent ${dragging ? 'opacity-40' : ''} ${
        dropEdge === 'before' ? 'border-t-accent' : dropEdge === 'after' ? 'border-b-accent' : ''
      }`}
    >
      <button
        type="button"
        aria-current={selected ? 'true' : undefined}
        onClick={handleClick}
        onKeyDown={handleKeyDown}
        className={`flex w-full items-start gap-2 rounded text-left outline-none ${
          selected ? 'text-accent' : 'text-chrome-muted dark:text-ink-muted'
        }`}
      >
        <span className="w-3 pt-1 text-[11px] tabular-nums">{number}</span>
        <span
          className={`overflow-hidden rounded-sm border bg-white shadow-sm transition-colors dark:bg-ink-alt ${
            selected
              ? 'border-accent ring-1 ring-accent'
              : 'border-chrome-line hover:border-chrome-muted dark:border-ink-line'
          }`}
          style={THUMBNAIL_BOX_STYLE}
        >
          {/* `interactive={false}`: the mini-render is a picture of the slide, so pointer events
              pass through to the button and the frame stays out of the tab order — otherwise an
              interactive slide would eat the click that is supposed to select it. */}
          <SlideFrame
            html={slide.html}
            title={slide.title}
            scale={THUMBNAIL_FIT.scale}
            interactive={false}
          />
        </span>
        <span className="sr-only">
          Slide {number} thumbnail: {slide.title}
        </span>
      </button>
    </li>
  )
})

export type ThumbnailRailProps = {
  slides: readonly SlideView[]
  currentSlideId: SlideId | null
  onSelectSlide: (id: SlideId) => void
  onAddSlide: () => void
  onDuplicateSlide: (id: SlideId) => void
  onDeleteSlide: (id: SlideId) => void
  /** Absolute, post-move index — the same contract as `deckStore.moveSlide`. */
  onMoveSlide: (fromIndex: number, toIndex: number) => void
}

type MenuState = { slideId: SlideId; x: number; y: number }

/**
 * Left rail: one live mini-render per slide, current-slide highlight, click to select, `[+ New]`,
 * a right-click menu, and drag-to-reorder (20-ui-wireframes.md).
 *
 * **The drop target is a whole card, not the gap between two.** A drop on card *i* means "put the
 * dragged slide at index *i*", and the indicator is drawn on the edge the slide arrives from. The
 * usual alternative — hit-testing the pointer against each card's vertical midpoint — buys
 * half-a-card of precision at the cost of reading layout geometry on every `dragover`, and it
 * reaches no position this does not: dragging onto the last card lands at the end, onto the first
 * lands at the front. It is also the difference between a reorder that can be tested with a
 * synthetic drag event and one that needs a real layout engine to mean anything.
 *
 * Every slide in the deck is a mounted frame. That is the naive shape on purpose — correctness
 * first, and a 20-slide deck is 20 static documents. Virtualizing to the visible window (and
 * swapping settled frames for captured bitmaps) is M8.3, where there is a perf budget to measure
 * against.
 */
export function ThumbnailRail({
  slides,
  currentSlideId,
  onSelectSlide,
  onAddSlide,
  onDuplicateSlide,
  onDeleteSlide,
  onMoveSlide,
}: ThumbnailRailProps): JSX.Element {
  const [menu, setMenu] = useState<MenuState | null>(null)
  const [dragIndex, setDragIndex] = useState<number | null>(null)
  const [overIndex, setOverIndex] = useState<number | null>(null)

  const closeMenu = useCallback(() => {
    setMenu(null)
  }, [])

  const openMenu = useCallback((slideId: SlideId, x: number, y: number) => {
    setMenu({ slideId, x, y })
  }, [])

  const handleDragStartCard = useCallback((index: number) => {
    setDragIndex(index)
    setOverIndex(index)
  }, [])

  const handleDragOverCard = useCallback((index: number) => {
    setOverIndex(index)
  }, [])

  const endDrag = useCallback(() => {
    setDragIndex(null)
    setOverIndex(null)
  }, [])

  const handleDropCard = useCallback(
    (index: number) => {
      // `dragIndex` is read from state rather than the data transfer so that a drag started
      // outside the rail (a file, a text selection) cannot be mistaken for a slide.
      if (dragIndex !== null && dragIndex !== index) onMoveSlide(dragIndex, index)
      endDrag()
    },
    [dragIndex, onMoveSlide, endDrag],
  )

  const handleAdd = useCallback(() => {
    closeMenu()
    onAddSlide()
  }, [closeMenu, onAddSlide])

  const menuItems = useMemo<SlideContextMenuItem[]>(() => {
    if (menu === null) return []
    const { slideId } = menu
    return [
      {
        id: 'duplicate',
        label: 'Duplicate',
        onSelect: () => {
          onDuplicateSlide(slideId)
        },
      },
      {
        id: 'delete',
        label: 'Delete',
        // A deck keeps at least one slide (`canDeleteSlide` in the store). Disabled rather than
        // hidden, so the verb stays where the user expects it and the reason is discoverable.
        disabled: slides.length <= 1,
        onSelect: () => {
          onDeleteSlide(slideId)
        },
      },
    ]
  }, [menu, slides.length, onDuplicateSlide, onDeleteSlide])

  return (
    <nav
      aria-label="Slides"
      className="flex w-[188px] shrink-0 flex-col border-r border-chrome-line bg-chrome dark:border-ink-line dark:bg-ink"
    >
      <h2 className="px-3 py-2 text-[11px] font-semibold uppercase tracking-wider text-chrome-muted dark:text-ink-muted">
        Slides
      </h2>

      <ol className="flex-1 space-y-1 overflow-y-auto px-3 pb-2">
        {slides.map((slide, index) => (
          <ThumbnailCard
            key={slide.id}
            index={index}
            number={index + 1}
            slide={slide}
            selected={slide.id === currentSlideId}
            dragging={dragIndex === index}
            dropEdge={
              dragIndex === null || overIndex !== index || dragIndex === index
                ? null
                : dragIndex < index
                  ? 'after'
                  : 'before'
            }
            onSelect={onSelectSlide}
            onOpenMenu={openMenu}
            onDragStartCard={handleDragStartCard}
            onDragOverCard={handleDragOverCard}
            onDropCard={handleDropCard}
            onDragEndCard={endDrag}
            onMoveCard={onMoveSlide}
          />
        ))}
      </ol>

      <div className="border-t border-chrome-line p-2 dark:border-ink-line">
        <button
          type="button"
          onClick={handleAdd}
          title="New slide"
          className="w-full rounded border border-dashed border-chrome-line py-1.5 text-[12px] text-chrome-muted transition-colors hover:border-accent hover:text-accent dark:border-ink-line dark:text-ink-muted"
        >
          + New
        </button>
      </div>

      {menu !== null && (
        <SlideContextMenu
          x={menu.x}
          y={menu.y}
          label="Slide actions"
          items={menuItems}
          onClose={closeMenu}
        />
      )}
    </nav>
  )
}
