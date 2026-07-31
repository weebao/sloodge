import { memo, useMemo, type JSX } from 'react'
import { SLIDE_SIZE } from './slideFit'
import { wrapSlideHtml } from './wrapSlideHtml'

/**
 * Layer 2 of the slide sandbox (§7 of 10-architecture.md): one slide document in an iframe that
 * is an **opaque origin**.
 *
 * `allow-same-origin` is deliberately absent and must stay absent — that omission *is* the security
 * boundary. Without it the frame cannot reach `window.parent`, cannot read the app's DOM, cannot
 * touch `localStorage`, and cannot see any IPC bridge, so model-generated JS is contained even
 * though it runs. Adding `allow-same-origin` alongside `allow-scripts` would let the frame reach up
 * and remove its own sandbox attribute — the two together are equivalent to no sandbox at all.
 * `allow-popups`, `allow-top-navigation`, `allow-forms` and `allow-modals` are omitted for the same
 * reason, which is also why the contract forbids `alert`/`confirm`/`prompt` (§3.2 SL-S05 of
 * 30-slide-format.md): they are silent no-ops here.
 *
 * The frame keeps its intrinsic 1280x720 size and is CSS-transform-scaled by the caller. Scaling
 * the *frame* rather than resizing it is what makes a thumbnail a faithful miniature of the canvas:
 * the slide's own layout — media queries, `overflow:hidden` at exactly 1280x720, absolutely
 * positioned motifs — resolves against the same viewport in both places. Sizing the iframe down
 * would re-run the slide's layout at rail width and show something the presenter will never see.
 */

/** The complete sandbox token list. Pinned by a test; never widen it. */
export const SLIDE_SANDBOX = 'allow-scripts'

export type SlideFrameProps = {
  /** The slide's HTML document, exactly as it sits in `slides/<id>.html`. */
  html: string
  /** Accessible name for the frame. Rail thumbnails and the canvas both need a distinct one. */
  title: string
  /** CSS scale factor; see `fitSlide`. A non-positive scale paints an empty box. */
  scale: number
  /**
   * Whether the slide receives pointer and keyboard input. The canvas says yes (interactive
   * slides are a first-class capability); rail thumbnails say no, so a click lands on the
   * selection button behind the frame rather than being swallowed by the slide's own handlers.
   */
  interactive?: boolean
  className?: string
}

function SlideFrameInner({
  html,
  title,
  scale,
  interactive = true,
  className,
}: SlideFrameProps): JSX.Element {
  // Recomputed only when the document text changes: CSP injection is a string concat, but the
  // result is the `srcdoc` attribute, and handing React a fresh string on a scale change would
  // reload the frame — losing animation phase and any interactive state on every window resize.
  const srcDoc = useMemo(() => wrapSlideHtml(html), [html])
  const painted = Math.max(scale, 0)

  // Memoized because a new style object every render is a new prop for the host elements; the
  // iframe's especially, since React diffing a fresh object against the old one is the only thing
  // standing between a resize and a re-application of every declaration on the frame.
  const boxStyle = useMemo(
    () => ({
      width: `${String(SLIDE_SIZE.width * painted)}px`,
      height: `${String(SLIDE_SIZE.height * painted)}px`,
      overflow: 'hidden' as const,
    }),
    [painted],
  )

  const frameStyle = useMemo(
    () => ({
      width: `${String(SLIDE_SIZE.width)}px`,
      height: `${String(SLIDE_SIZE.height)}px`,
      transform: `scale(${String(painted)})`,
      transformOrigin: 'top left',
      pointerEvents: interactive ? ('auto' as const) : ('none' as const),
    }),
    [painted, interactive],
  )

  return (
    <div className={className} style={boxStyle}>
      <iframe
        title={title}
        sandbox={SLIDE_SANDBOX}
        referrerPolicy="no-referrer"
        allow=""
        srcDoc={srcDoc}
        tabIndex={interactive ? undefined : -1}
        aria-hidden={interactive ? undefined : 'true'}
        className="block border-0"
        style={frameStyle}
      />
    </div>
  )
}

/**
 * Memoized on shallow prop equality, which is the whole re-render policy for the rail: props are
 * primitives, so a slide whose `html` did not change never re-renders and its iframe is never
 * touched. That matters more than usual here — writing `srcdoc` reloads the document, so an
 * unguarded re-render of a 60-slide rail would restart 60 documents on every keystroke. The
 * canvas gets the same guarantee for free while resizing: only `scale` changes, so React updates
 * one style property and leaves `srcdoc` alone.
 *
 * Naive-but-correct is the M1.3 target: every slide in the deck is a live frame. Virtualization
 * (mount only the visible window) is M8.3.
 */
export const SlideFrame = memo(SlideFrameInner)
