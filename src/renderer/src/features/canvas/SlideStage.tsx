import { useCallback, useEffect, useMemo, useState, type JSX, type RefObject } from 'react'
import type { SlideId } from '../../../../shared/document/types'
import type { SlideView } from '../../stores/deckStore'
import { liveSlideWindow, type LiveSlideRole } from './liveWindow'
import { SlideFrame } from './SlideFrame'

/**
 * The live slide window as DOM (M8.2): the active slide's frame, visible, plus its ±1 neighbours
 * mounted but hidden — `visibility: hidden`, `inert`, `aria-hidden` — so that a step to either is a
 * style toggle rather than a navigation. Both the editor canvas and Present render through this, so
 * the two surfaces share one mounting policy and one pre-warm order.
 *
 * ## Deck-ordered, keyed by id
 *
 * Frames are rendered in deck order and keyed by slide id (`liveSlideWindow`). Moving to a
 * neighbour therefore appends one frame at one end and drops one at the other; the frame that was
 * active stays exactly where it is in the DOM and merely becomes hidden. That is what makes the
 * switch instant and preserves the outgoing slide's animation phase and interactive state. Any
 * scheme that reordered children would move an `<iframe>` element, and a moved iframe reloads.
 *
 * ## Neighbours warm *after* the active slide has loaded
 *
 * A cold jump mounts the target first and its *cold* neighbours only once the target's frame has
 * fired `load`. Mounting all three at once would have the neighbours' publish round-trips, parses
 * and script contend with the slide the user is actually waiting for — measurably so when the three
 * share a renderer process. A neighbour that is already loaded (it was in the previous window)
 * stays mounted throughout; unmounting it to re-mount it a moment later would be the reload the
 * window exists to avoid. The bookkeeping is a set of loaded slide ids, added on `load` and dropped
 * on unmount, so an id that leaves the window and later returns is cold again rather than being
 * treated as loaded because it once was.
 *
 * ## What is *not* here
 *
 * Thumbnails: the rail decides on its own which of its miniatures are live (`ThumbnailPreview`),
 * because that is a question of scroll visibility, not selection.
 */

export type SlideStageProps = {
  /** The deck in presentation order. */
  slides: readonly SlideView[]
  /** Index of the active slide; out of range renders nothing. */
  activeIndex: number
  /**
   * The document the active frame shows *instead of* its stored html — Design Mode's instrumented
   * copy. Neighbours always show their stored source; instrumenting a slide nobody can select
   * elements on would be parse work for nothing.
   */
  activeHtml?: string | undefined
  /** CSS scale for every frame; see `fitSlide`. */
  scale: number
  /** The active frame's accessible name is `${titlePrefix}: ${slide.title}`. */
  titlePrefix: string
  /** Whether the *active* frame takes input. Hidden neighbours never do. */
  interactive: boolean
  /** Handle to the active frame's iframe, re-pointed as the selection moves. */
  frameRef?: RefObject<HTMLIFrameElement | null>
  /** Classes for the active frame's box (the canvas paints its outline and shadow there). */
  frameClassName?: string
}

export function SlideStage({
  slides,
  activeIndex,
  activeHtml,
  scale,
  titlePrefix,
  interactive,
  frameRef,
  frameClassName,
}: SlideStageProps): JSX.Element {
  const frames = useMemo(() => liveSlideWindow(slides, activeIndex), [slides, activeIndex])
  const [loaded, setLoaded] = useState<ReadonlySet<SlideId>>(() => new Set())

  const markLoaded = useCallback((id: SlideId) => {
    setLoaded((previous) => (previous.has(id) ? previous : new Set(previous).add(id)))
  }, [])
  const markGone = useCallback((id: SlideId) => {
    setLoaded((previous) => {
      if (!previous.has(id)) return previous
      const next = new Set(previous)
      next.delete(id)
      return next
    })
  }, [])

  const active = frames.find((frame) => frame.role === 'active')
  const warmReady = active !== undefined && loaded.has(active.slide.id)

  return (
    <div className="relative">
      {frames.map(({ slide, role }) =>
        role === 'active' || warmReady || loaded.has(slide.id) ? (
          <StageFrame
            key={slide.id}
            slide={slide}
            html={role === 'active' && activeHtml !== undefined ? activeHtml : slide.html}
            role={role}
            scale={scale}
            titlePrefix={titlePrefix}
            interactive={interactive}
            frameRef={frameRef}
            frameClassName={frameClassName}
            onLoaded={markLoaded}
            onGone={markGone}
          />
        ) : null,
      )}
    </div>
  )
}

type StageFrameProps = {
  slide: SlideView
  html: string
  role: LiveSlideRole
  scale: number
  titlePrefix: string
  interactive: boolean
  frameRef: RefObject<HTMLIFrameElement | null> | undefined
  frameClassName: string | undefined
  onLoaded: (id: SlideId) => void
  onGone: (id: SlideId) => void
}

/**
 * One frame of the window. The active frame sits in flow and gives the stage its size; a warm
 * neighbour is stacked over the same box, invisible and inert, so promoting it is a class swap on
 * this wrapper and nothing touches the iframe itself.
 */
function StageFrame({
  slide,
  html,
  role,
  scale,
  titlePrefix,
  interactive,
  frameRef,
  frameClassName,
  onLoaded,
  onGone,
}: StageFrameProps): JSX.Element {
  const isActive = role === 'active'

  useEffect(() => () => onGone(slide.id), [slide.id, onGone])
  const handleLoad = useCallback(() => onLoaded(slide.id), [slide.id, onLoaded])

  return (
    <div
      data-slide-role={role}
      className={isActive ? 'relative' : 'invisible absolute inset-0'}
      inert={!isActive}
      aria-hidden={isActive ? undefined : 'true'}
    >
      <SlideFrame
        html={html}
        title={isActive ? `${titlePrefix}: ${slide.title}` : `Preloading: ${slide.title}`}
        scale={scale}
        interactive={isActive && interactive}
        frameRef={isActive ? frameRef : undefined}
        className={isActive ? frameClassName : undefined}
        onLoad={handleLoad}
      />
    </div>
  )
}
