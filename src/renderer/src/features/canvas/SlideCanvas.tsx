import { useMemo, type JSX } from 'react'
import type { SlideView } from '../../state/deckStore'
import { SlideFrame } from './SlideFrame'
import { fitSlide } from './slideFit'
import { useElementSize } from './useElementSize'

export type SlideCanvasProps = {
  /** The selected slide, or `null` for a deck with no slides. */
  slide: SlideView | null
}

/**
 * Center stage: the current slide, live, in a sandboxed 1280x720 frame scaled to fit its mat.
 *
 * Capped at 1:1 (`maxScale: 1`). Beyond that the slide is not sharper, only bigger — the document
 * is a 1280px layout, so upscaling it interpolates text that a presenter will read at native size
 * anyway, and it would make the editing canvas disagree with the exported pixels.
 */
export function SlideCanvas({ slide }: SlideCanvasProps): JSX.Element {
  const [matRef, mat] = useElementSize<HTMLDivElement>()
  const fit = useMemo(() => fitSlide(mat, { maxScale: 1 }), [mat])

  return (
    <main
      aria-label="Slide canvas"
      className="flex min-w-0 flex-1 items-center justify-center overflow-hidden bg-canvas-mat/25 p-6 dark:bg-black/40"
    >
      <div ref={matRef} className="flex h-full w-full items-center justify-center">
        {slide ? (
          <SlideFrame
            html={slide.html}
            title={`Slide: ${slide.title}`}
            scale={fit.scale}
            // `outline` rather than `border`: an outline is painted outside the box without
            // joining the layout, so the framed slide stays exactly the scaled 16:9 rectangle
            // `fitSlide` computed instead of being two pixels wider than it.
            className="bg-white outline outline-1 outline-chrome-line shadow-[0_1px_2px_rgba(0,0,0,0.12),0_8px_24px_rgba(0,0,0,0.10)] dark:bg-ink-alt dark:outline-ink-line"
          />
        ) : (
          <div className="select-none text-center">
            <p className="text-[15px] font-medium text-shell-fg dark:text-ink-fg">No slides</p>
            <p className="mt-1.5 text-[12px] text-chrome-muted dark:text-ink-muted">
              Nothing here yet — ask Claude to draft this slide.
            </p>
          </div>
        )}
      </div>
    </main>
  )
}
