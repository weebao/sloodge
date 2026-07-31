import { memo, useCallback, type JSX } from 'react'

type ThumbnailCardProps = {
  number: number
  selected: boolean
  onSelect: (index: number) => void
}

const ThumbnailCard = memo(function ThumbnailCard({
  number,
  selected,
  onSelect,
}: ThumbnailCardProps): JSX.Element {
  const handleClick = useCallback(() => {
    onSelect(number)
  }, [number, onSelect])

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
          className={`aspect-video flex-1 rounded-sm border bg-white shadow-sm transition-colors dark:bg-ink-alt ${
            selected
              ? 'border-accent ring-1 ring-accent'
              : 'border-chrome-line hover:border-chrome-muted dark:border-ink-line'
          }`}
        >
          <span className="sr-only">Slide {number} thumbnail placeholder</span>
        </span>
      </button>
    </li>
  )
})

export type ThumbnailRailProps = {
  slideCount: number
  currentSlide: number
  onSelectSlide: (index: number) => void
}

/**
 * Left rail. M0.4 renders placeholder cards only — live mini-renders,
 * drag-to-reorder and the context menu land with the document milestones.
 */
export function ThumbnailRail({
  slideCount,
  currentSlide,
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
        {Array.from({ length: slideCount }, (_, index) => index + 1).map((number) => (
          <ThumbnailCard
            key={number}
            number={number}
            selected={number === currentSlide}
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
