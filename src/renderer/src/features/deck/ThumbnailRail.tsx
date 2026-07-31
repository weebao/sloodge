import { memo, useCallback, type JSX } from 'react'
import { SlideFrame } from '../canvas/SlideFrame'
import { fitSlide, SLIDE_SIZE } from '../canvas/slideFit'
import type { SlideId } from '../../../../shared/document/types'
import type { SlideView } from '../../state/deckStore'

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

type ThumbnailCardProps = {
  /** 1-based, for the label only; identity is the slide id. */
  number: number
  slide: SlideView
  selected: boolean
  onSelect: (id: SlideId) => void
}

/**
 * Memoized so a selection change re-renders two cards, not the whole deck — and so an edit to one
 * slide's HTML cannot reload every other slide's frame. Props are primitives plus the `SlideView`,
 * which is rebuilt on every deck change; that is fine, because the expensive child (`SlideFrame`)
 * is itself memoized on the *string* `html` and so is left alone unless the bytes really changed.
 */
const ThumbnailCard = memo(function ThumbnailCard({
  number,
  slide,
  selected,
  onSelect,
}: ThumbnailCardProps): JSX.Element {
  const handleClick = useCallback(() => {
    onSelect(slide.id)
  }, [slide.id, onSelect])

  return (
    <li>
      <button
        type="button"
        aria-current={selected ? 'true' : undefined}
        onClick={handleClick}
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
}

/**
 * Left rail: one live mini-render per slide, current-slide highlight, click to select.
 *
 * Every slide in the deck is a mounted frame. That is the naive shape on purpose — correctness
 * first, and a 20-slide deck is 20 static documents. Virtualizing to the visible window (and
 * swapping settled frames for captured bitmaps) is M8.3, where there is a perf budget to measure
 * against; drag-to-reorder and the context menu arrive with M1.4's command layer.
 */
export function ThumbnailRail({
  slides,
  currentSlideId,
  onSelectSlide,
}: ThumbnailRailProps): JSX.Element {
  return (
    <nav
      aria-label="Slides"
      className="flex w-[188px] shrink-0 flex-col border-r border-chrome-line bg-chrome dark:border-ink-line dark:bg-ink"
    >
      <h2 className="px-3 py-2 text-[11px] font-semibold uppercase tracking-wider text-chrome-muted dark:text-ink-muted">
        Slides
      </h2>

      <ol className="flex-1 space-y-2 overflow-y-auto px-3 pb-2">
        {slides.map((slide, index) => (
          <ThumbnailCard
            key={slide.id}
            number={index + 1}
            slide={slide}
            selected={slide.id === currentSlideId}
            onSelect={onSelectSlide}
          />
        ))}
      </ol>

      <div className="border-t border-chrome-line p-2 dark:border-ink-line">
        <button
          type="button"
          aria-disabled="true"
          title="New slide (not wired up yet)"
          className="w-full rounded border border-dashed border-chrome-line py-1.5 text-[12px] text-chrome-muted transition-colors hover:border-accent hover:text-accent dark:border-ink-line dark:text-ink-muted"
        >
          + New
        </button>
      </div>
    </nav>
  )
}
