import { useMemo, useRef, type JSX } from 'react'
import { buildSlideMap } from '../../../../shared/design/slide-map'
import { instrument } from '../../../../shared/design/instrument'
import type { SlideView } from '../../stores/deckStore'
import { useDesignStore } from '../design/designStore'
import { injectDesignBridge } from '../design/frameScript'
import { PropertyPanel } from '../design/PropertyPanel'
import { SelectionOverlay } from '../design/SelectionOverlay'
import { useElementInspect } from '../design/useElementInspect'
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
 *
 * ## Design Mode delivery
 *
 * With Design Mode on, the frame receives the **instrumented** document — the same source with a
 * `data-sl-id` on every addressable element (`instrument`) plus the in-frame agent script
 * (`injectDesignBridge`) — instead of the raw slide. Both are render artifacts that never reach disk
 * (§1.1). The selection overlay is laid over the frame and swallows pointer events so the slide's own
 * handlers stay frozen while selecting (§2.1). Turning Design Mode off swaps the raw document back
 * and unmounts the overlay, restoring full slide interactivity.
 *
 * The instrumented HTML is memoized on `(id, html)` so toggling zoom never re-parses; a new URL only
 * mints when the bytes actually change (see `useSlideUrl`).
 */
export function SlideCanvas({ slide }: SlideCanvasProps): JSX.Element {
  const [matRef, mat] = useElementSize<HTMLDivElement>()
  const fit = useMemo(() => fitSlide(mat, { maxScale: 1 }), [mat])
  const designEnabled = useDesignStore((state) => state.enabled)
  const frameRef = useRef<HTMLIFrameElement>(null)

  const designModeActive = designEnabled && slide !== null

  // The computed-styles bridge client, shared with the property panel's "Ask Claude about this
  // element" affordance. Armed only in Design Mode; the frameRef and slide id are the ones the
  // instrumented frame is showing.
  const { inspect } = useElementInspect({
    frameRef,
    slideId: slide?.id ?? '',
    enabled: designModeActive,
  })

  // Only pay for the parse + instrument + inject while Design Mode is on for this slide.
  const html = useMemo(() => {
    if (slide === null) return ''
    if (!designEnabled) return slide.html
    const map = buildSlideMap(slide.id, slide.html)
    return injectDesignBridge(instrument(map))
  }, [slide, designEnabled])

  // Memoized so the relative wrapper's style is not a fresh object on every render (react-perf).
  const stageStyle = useMemo(
    () => ({ width: fit.width, height: fit.height }),
    [fit.width, fit.height],
  )

  return (
    <main
      aria-label="Slide canvas"
      className="flex min-w-0 flex-1 flex-col overflow-hidden bg-canvas-mat/25 dark:bg-black/40"
    >
      <div
        ref={matRef}
        className="flex min-h-0 flex-1 items-center justify-center overflow-hidden p-6"
      >
        {slide ? (
          <div className="relative" style={stageStyle}>
            <SlideFrame
              html={html}
              frameRef={frameRef}
              title={`Slide: ${slide.title}`}
              scale={fit.scale}
              // The slide must not receive pointer events while Design Mode's overlay is capturing
              // them — otherwise a click would reach both the overlay and the slide's own handlers.
              interactive={!designModeActive}
              // `outline` rather than `border`: an outline is painted outside the box without
              // joining the layout, so the framed slide stays exactly the scaled 16:9 rectangle
              // `fitSlide` computed instead of being two pixels wider than it.
              className="bg-white outline outline-1 outline-chrome-line shadow-[0_1px_2px_rgba(0,0,0,0.12),0_8px_24px_rgba(0,0,0,0.10)] dark:bg-ink-alt dark:outline-ink-line"
            />
            {designModeActive ? (
              <SelectionOverlay frameRef={frameRef} slideId={slide.id} scale={fit.scale} />
            ) : null}
          </div>
        ) : (
          <div className="select-none text-center">
            <p className="text-[15px] font-medium text-shell-fg dark:text-ink-fg">No slides</p>
            <p className="mt-1.5 text-[12px] text-chrome-muted dark:text-ink-muted">
              Nothing here yet — ask Claude to draft this slide.
            </p>
          </div>
        )}
      </div>
      {/* Docked bottom-of-canvas (wireframe §20): the local property panel, only in Design Mode
          and only when an element is selected (the panel returns null otherwise). */}
      {designModeActive && slide ? <PropertyPanel slide={slide} inspect={inspect} /> : null}
    </main>
  )
}
