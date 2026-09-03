import { useRef, type JSX } from 'react'
import { SLIDE_THUMBNAIL_HOST } from '../../../../shared/slide-protocol'
import type { SlideView } from '../../stores/deckStore'
import { SlideFrame } from '../canvas/SlideFrame'
import { fitSlide, SLIDE_SIZE } from '../canvas/slideFit'
import { defaultSlideUrls } from '../canvas/slideUrlFactory'
import { useVisibility, type VisibilityTracker } from './visibilityTracker'

/**
 * Thumbnail width in CSS px, and with it the mini-frame's scale.
 *
 * A constant, not a measurement: the rail is a fixed 188px column (`w-[188px]`) minus its 12px
 * gutters, the 12px slide-number column and the 8px gap. Every card is therefore the same known
 * width, and hard-coding it avoids a `ResizeObserver` per thumbnail.
 */
export const THUMBNAIL_WIDTH = 144

/** The card is exactly 16:9, so the fit is width-bound; going through `fitSlide` keeps the one
 *  scaling rule in one place rather than open-coding a division here. */
const THUMBNAIL_FIT = fitSlide({
  width: THUMBNAIL_WIDTH,
  height: (THUMBNAIL_WIDTH * SLIDE_SIZE.height) / SLIDE_SIZE.width,
})

/** The box is the same size live or not, so mounting a frame never shifts the rail's layout. */
const BOX_STYLE = {
  width: `${String(THUMBNAIL_FIT.width)}px`,
  height: `${String(THUMBNAIL_FIT.height)}px`,
} as const

/**
 * How far outside the rail's viewport a card counts as visible, in CSS px above and below. One
 * card's height either side, so the next thumbnail to scroll in is already live when it arrives
 * and a card that scrolls just past the edge does not thrash between frame and placeholder.
 */
export const THUMBNAIL_LIVE_MARGIN = '96px 0px'

export type ThumbnailPreviewProps = {
  slide: SlideView
  /** The rail's shared observer; `null` before the rail's scroller has mounted. */
  visibility: VisibilityTracker | null
}

/**
 * A slide's miniature: a live `SlideFrame` while its card is inside the rail's scroll window, a
 * placeholder otherwise (M8.2).
 *
 * This is the seam M8.3 slots into. Today the "not live" state is a titled blank, because the
 * renderer has no way to read pixels out of an opaque-origin frame; M8.3 replaces that branch with
 * the persisted PNG snapshot and adds the virtual list, and neither touches the live branch or the
 * visibility gate. What must not change is the shape: **a thumbnail costs a document only while it
 * is on screen.** A rail of a thousand slides holds a handful of live frames, wherever it is
 * scrolled.
 *
 * `interactive={false}`: the mini-render is a picture of the slide, so pointer events pass through
 * to the button and the frame stays out of the tab order — otherwise an interactive slide would eat
 * the click that is supposed to select it.
 *
 * Miniatures publish on the `thumbnails` host, which puts them in their own renderer process: a
 * rail of animating miniatures must never share a main thread with the slide on the canvas (see
 * `slideDocumentUrl`). Under Electron that is a different process; in a browser host both hosts
 * fall back to the same blob factory.
 */
export function ThumbnailPreview({ slide, visibility }: ThumbnailPreviewProps): JSX.Element {
  const boxRef = useRef<HTMLDivElement>(null)
  const live = useVisibility(visibility, boxRef)

  return (
    <div ref={boxRef} style={BOX_STYLE} data-thumbnail={live ? 'live' : 'placeholder'}>
      {live ? (
        <SlideFrame
          html={slide.html}
          title={slide.title}
          scale={THUMBNAIL_FIT.scale}
          interactive={false}
          slideUrls={defaultSlideUrls(SLIDE_THUMBNAIL_HOST)}
        />
      ) : (
        <span
          aria-hidden="true"
          className="flex h-full w-full items-center justify-center px-2 text-center text-[9px] leading-tight text-chrome-muted dark:text-ink-muted"
        >
          {slide.title}
        </span>
      )}
    </div>
  )
}
