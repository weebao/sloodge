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
 * ## Keyed by id, ordered by id
 *
 * Frames are keyed by slide id and rendered in id order (`liveSlideWindow`), never in deck order.
 * Any transition — a step, a jump, a reorder of the deck around or of the selected slide — is then
 * inserts and removes only: the frame that was active stays exactly where it is in the DOM and merely
 * becomes hidden. That is what makes the switch instant and preserves the outgoing slide's animation
 * phase and interactive state. Any scheme that moved a child would move an `<iframe>` element, and
 * a moved iframe reloads.
 *
 * ## Every frame shows the same *kind* of document
 *
 * `documentFor` (Design Mode's instrumented copy) is applied to every frame in the window, not just
 * the active one. The alternative — instrument only the active frame, keep neighbours on their stored
 * source — was tried first and costs more than it saves: a step then changes the document of *both*
 * the incoming frame (raw → instrumented) and the outgoing one (instrumented → raw), which is two
 * reloads and three publishes per step where a step with Design Mode off is none, and the incoming
 * frame's reload is invisible to the pre-warm gate. Instrumenting a neighbour is one parse in the
 * app renderer when it enters the window; it is memoized per frame, so a step costs one parse — the
 * new neighbour's — and zero reloads, exactly as with Design Mode off. Toggling Design Mode swaps
 * all mounted documents at once, which is the one moment three frames reload together.
 *
 * ## Neighbours warm *after* the active slide has loaded
 *
 * A cold jump mounts the target first and its *cold* neighbours only once the target's frame has
 * fired `load` **for the document it is currently showing**. Mounting all three at once would have
 * the neighbours' publish round-trips and parses contend with the slide the user is actually waiting
 * for — in main's registry and the app renderer even now that each stage document has its own
 * process. A neighbour that is already loaded (it was in the previous window) stays mounted
 * throughout; unmounting it to re-mount it a moment later would be the reload the window exists to
 * avoid. The bookkeeping is a map from slide id to the html its frame last fired `load` for, added
 * on `load` and dropped on unmount, so an id that leaves the window and later returns is cold again
 * rather than being treated as loaded because it once was — and a frame whose document changed
 * under it (an edit, or Design Mode toggling) is not treated as loaded on the strength of the old
 * document's `load`.
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
   * The document a frame shows *instead of* the slide's stored html — Design Mode's instrumented
   * copy. Applied to every mounted frame (see above); memoized per frame on the slide's html, so
   * give it a stable identity.
   */
  documentFor?: ((id: SlideId, html: string) => string) | undefined
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
  documentFor,
  scale,
  titlePrefix,
  interactive,
  frameRef,
  frameClassName,
}: SlideStageProps): JSX.Element {
  const frames = useMemo(() => liveSlideWindow(slides, activeIndex), [slides, activeIndex])
  const [loaded, setLoaded] = useState<ReadonlyMap<SlideId, string>>(() => new Map())

  const markLoaded = useCallback((id: SlideId, html: string) => {
    setLoaded((previous) =>
      previous.get(id) === html ? previous : new Map(previous).set(id, html),
    )
  }, [])
  const markGone = useCallback((id: SlideId) => {
    setLoaded((previous) => {
      if (!previous.has(id)) return previous
      const next = new Map(previous)
      next.delete(id)
      return next
    })
  }, [])

  const documentOf = (slide: SlideView): string =>
    documentFor === undefined ? slide.html : documentFor(slide.id, slide.html)

  const active = frames.find((frame) => frame.role === 'active')
  const warmReady = active !== undefined && loaded.get(active.slide.id) === documentOf(active.slide)

  return (
    <div className="relative">
      {frames.map(({ slide, role }) =>
        role === 'active' || warmReady || loaded.has(slide.id) ? (
          <StageFrame
            key={slide.id}
            slide={slide}
            documentFor={documentFor}
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
  documentFor: ((id: SlideId, html: string) => string) | undefined
  role: LiveSlideRole
  scale: number
  titlePrefix: string
  interactive: boolean
  frameRef: RefObject<HTMLIFrameElement | null> | undefined
  frameClassName: string | undefined
  onLoaded: (id: SlideId, html: string) => void
  onGone: (id: SlideId) => void
}

/**
 * One frame of the window. The active frame sits in flow and gives the stage its size; a warm
 * neighbour is stacked over the same box, invisible and inert, so promoting it is a class swap on
 * this wrapper and nothing touches the iframe itself.
 */
function StageFrame({
  slide,
  documentFor,
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

  // Per frame, on the slide's own html: a step re-instruments only the frame that just entered the
  // window, and a deck update that rebuilds the `SlideView` objects re-instruments nothing.
  const html = useMemo(
    () => (documentFor === undefined ? slide.html : documentFor(slide.id, slide.html)),
    [documentFor, slide.id, slide.html],
  )

  useEffect(() => () => onGone(slide.id), [slide.id, onGone])
  const handleLoad = useCallback(
    (loadedHtml: string) => onLoaded(slide.id, loadedHtml),
    [slide.id, onLoaded],
  )

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
