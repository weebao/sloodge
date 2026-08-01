import type { JSX } from 'react'

export type PresentControlsProps = {
  /** 0-based current slide index; rendered as `index + 1`. */
  index: number
  /** Total slides in the deck. */
  slideCount: number
  /** Whether the controls are currently shown (they fade, they do not unmount — see the surface). */
  visible: boolean
  onPrev: () => void
  onNext: () => void
  onExit: () => void
}

/**
 * The auto-hiding control cluster, bottom-center, per the wireframe (20-ui-wireframes.md § Present
 * mode): `◀ ▶   N / total   ⏹ Esc`.
 *
 * Presentational only — visibility and the fade timing are the surface's job (`controlsAutoHide.ts`),
 * so this renders the same DOM whether shown or hidden and merely animates opacity. It stays mounted
 * while hidden so a mouse move can bring it back without a remount, and `pointer-events` is dropped
 * while hidden so an invisible bar never eats a click meant for the slide underneath.
 *
 * Buttons rather than key-only affordances because the wireframe draws clickable chevrons and a stop
 * button; the keyboard path lives in the surface and shares the same handlers.
 */
export function PresentControls({
  index,
  slideCount,
  visible,
  onPrev,
  onNext,
  onExit,
}: PresentControlsProps): JSX.Element {
  const atStart = index <= 0
  const atEnd = index >= slideCount - 1

  return (
    <div
      aria-label="Presentation controls"
      aria-hidden={visible ? undefined : 'true'}
      className={`pointer-events-none absolute inset-x-0 bottom-6 flex justify-center transition-opacity duration-300 ${
        visible ? 'opacity-100' : 'opacity-0'
      }`}
    >
      <div
        className={`flex items-center gap-1 rounded-full bg-black/70 px-2 py-1.5 text-white shadow-lg backdrop-blur ${
          visible ? 'pointer-events-auto' : ''
        }`}
      >
        <button
          type="button"
          aria-label="Previous slide"
          disabled={atStart}
          onClick={onPrev}
          className="inline-flex h-8 w-8 items-center justify-center rounded-full text-lg leading-none transition-colors hover:bg-white/15 disabled:cursor-default disabled:opacity-30 disabled:hover:bg-transparent"
        >
          <span aria-hidden="true">◀</span>
        </button>
        <button
          type="button"
          aria-label="Next slide"
          disabled={atEnd}
          onClick={onNext}
          className="inline-flex h-8 w-8 items-center justify-center rounded-full text-lg leading-none transition-colors hover:bg-white/15 disabled:cursor-default disabled:opacity-30 disabled:hover:bg-transparent"
        >
          <span aria-hidden="true">▶</span>
        </button>
        <span className="px-3 text-[13px] tabular-nums text-white/90">
          {index + 1} / {slideCount}
        </span>
        <button
          type="button"
          aria-label="Exit presentation (Esc)"
          title="Exit (Esc)"
          onClick={onExit}
          className="inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-[12px] font-medium transition-colors hover:bg-white/15"
        >
          <span aria-hidden="true">⏹</span>
          Esc
        </button>
      </div>
    </div>
  )
}
