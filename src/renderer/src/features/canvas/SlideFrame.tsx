import { memo, useMemo, type JSX, type RefObject } from 'react'
import { SLIDE_SIZE } from './slideFit'
import { useSlideUrl, type SlideUrlFactory } from './useSlideUrl'

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
 * Content arrives over a **URL**, never `srcdoc` — `slide://` under Electron, a blob URL in a plain
 * browser. See `slideUrlFactory` for that choice and `useSlideUrl` for the lifecycle that keeps
 * neither transport leaking. The difference between them is the whole of M2.0: `blob:` is a *local*
 * scheme and inherits the embedder's CSP exactly as `srcdoc` does, so a slide's inline `<script>`
 * is blocked by the host page's `script-src 'self'`; `slide://` is not local, does not inherit, and
 * is governed only by the policy main sends and `wrapSlideHtml` injects — so its script runs.
 *
 * That makes the sandbox attribute below the *only* thing standing between model-authored JS and
 * the app. It was always meant to be; until M2.0 there was an inherited host CSP behind it that
 * happened to be blocking the script anyway.
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
  /**
   * Delivery seam, defaulted to whichever transport this host supports. Injected only by tests,
   * which is what makes "the previous URL was released before the next one was used" an assertion
   * rather than a hope — happy-dom has neither a real blob store nor a main process to observe.
   *
   * Named `slideUrls` rather than M1.3's `objectUrls` because a `slide://` URL is not an object
   * URL, and a seam whose name asserts the implementation is a seam nobody swaps.
   */
  slideUrls?: SlideUrlFactory
  /**
   * Handle to the underlying iframe, so Design Mode's overlay can reach `contentWindow` for the
   * postMessage bridge and validate message source identity against it. Only the canvas passes one;
   * rail thumbnails do not participate in the bridge.
   */
  frameRef?: RefObject<HTMLIFrameElement | null>
}

function SlideFrameInner({
  html,
  title,
  scale,
  interactive = true,
  className,
  slideUrls,
  frameRef,
}: SlideFrameProps): JSX.Element {
  // Keyed on the document text alone, so a scale change never mints a new URL and never reloads
  // the frame — a reload loses animation phase and any interactive state, on every window resize.
  const src = useSlideUrl(html, slideUrls)

  // `Math.max(NaN, 0)` is NaN, which yields `width: "NaNpx"` and `transform: scale(NaN)` — both
  // invalid declarations that CSS drops, leaving a full-size 1280px frame bursting out of its
  // container. `scale` is a public prop, so it is guarded here rather than trusted from callers.
  const painted = Number.isFinite(scale) ? Math.max(scale, 0) : 0

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
        ref={frameRef}
        title={title}
        sandbox={SLIDE_SANDBOX}
        referrerPolicy="no-referrer"
        allow=""
        // `undefined` for the one render before the effect mints the URL: an iframe with no src
        // shows about:blank, which is the right empty state.
        src={src ?? undefined}
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
 * touched. That matters more than usual here — a new `src` reloads the document and publishes
 * another copy of it, so an unguarded re-render of a 60-slide rail would restart 60 documents on
 * every keystroke, and on the `slide://` path would churn 60 entries through main's registry.
 * The canvas gets the same guarantee for free while resizing: only `scale` changes, so React
 * updates one style property and `useSlideUrl`'s effect never re-runs.
 *
 * Naive-but-correct is the M1.3 target: every slide in the deck is a live frame. Virtualization
 * (mount only the visible window) is M8.3.
 */
export const SlideFrame = memo(SlideFrameInner)
