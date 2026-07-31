import type { JSX } from 'react'

export type SlideCanvasProps = {
  currentSlide: number
}

/**
 * Center stage. The real canvas hosts a sandboxed 1280x720 iframe scaled to
 * fit; M0.4 draws the letterboxed 16:9 frame and an empty state in its place.
 */
export function SlideCanvas({ currentSlide }: SlideCanvasProps): JSX.Element {
  return (
    <main
      aria-label="Slide canvas"
      className="flex min-w-0 flex-1 items-center justify-center overflow-hidden bg-canvas-mat/25 p-6 dark:bg-black/40"
    >
      <div className="flex aspect-video w-full max-w-[1100px] items-center justify-center rounded-sm border border-chrome-line bg-white shadow-[0_1px_2px_rgba(0,0,0,0.12),0_8px_24px_rgba(0,0,0,0.10)] dark:border-ink-line dark:bg-ink-alt">
        <div className="select-none text-center">
          <p className="text-[15px] font-medium text-shell-fg dark:text-ink-fg">
            Slide {currentSlide}
          </p>
          <p className="mt-1.5 text-[12px] text-chrome-muted dark:text-ink-muted">
            Nothing here yet — ask Claude to draft this slide.
          </p>
        </div>
      </div>
    </main>
  )
}
