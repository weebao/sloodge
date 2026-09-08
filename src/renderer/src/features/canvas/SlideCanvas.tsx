import { useMemo, useRef, type JSX } from 'react'
import { buildSlideMap } from '../../../../shared/design/slide-map'
import { instrument } from '../../../../shared/design/instrument'
import type { SlideId } from '../../../../shared/document/types'
import type { SlideView } from '../../stores/deckStore'
import { useDesignStore } from '../design/designStore'
import { ArrangeBar } from '../design/ArrangeBar'
import { DesignNotice } from '../design/DesignNotice'
import { injectDesignBridge } from '../design/frameScript'
import { PropertyPanel } from '../design/PropertyPanel'
import { SelectionOverlay } from '../design/SelectionOverlay'
import { useElementInspect } from '../design/useElementInspect'
import { SlideStage } from './SlideStage'
import { fitSlide } from './slideFit'
import { useElementSize } from './useElementSize'

export type SlideCanvasProps = {
  /** The deck in presentation order. */
  slides: readonly SlideView[]
  /** The selected slide's index, or `-1` for a deck with no selection. */
  currentIndex: number
}

/**
 * Design Mode's document for one slide: the source parsed and addressed (`instrument`), then given
 * the in-frame agent bridge.
 *
 * At module scope so its identity is fixed for the process rather than merely memoized. The stage
 * keys its per-frame memo and its pre-warm gate on `(documentFor, id, html)`, and the canvas
 * re-renders on every `ResizeObserver` tick — so an instrumenter built in the render body re-parses
 * all three mounted documents per animation frame while the panel splitter is dragged, with nothing
 * visibly wrong. A constant cannot drift back into that; a memo can, by being deleted.
 */
const instrumentDocument = (id: SlideId, html: string): string =>
  injectDesignBridge(instrument(buildSlideMap(id, html)))

/**
 * Center stage: the current slide, live, in a sandboxed 1280x720 frame scaled to fit its mat.
 *
 * Capped at 1:1 (`maxScale: 1`). Beyond that the slide is not sharper, only bigger — the document
 * is a 1280px layout, so upscaling it interpolates text that a presenter will read at native size
 * anyway, and it would make the editing canvas disagree with the exported pixels.
 *
 * The frame itself is one of the `SlideStage`'s: the selected slide visible, its ±1 neighbours
 * mounted but hidden so a step either way is instant, with Design Mode on or off (M8.2). The
 * overlay, the bridge and the property panel all bind to the *active* frame through `frameRef`,
 * which the stage re-points as the selection moves.
 *
 * ## Design Mode delivery
 *
 * With Design Mode on, every mounted frame receives the **instrumented** document — the same source
 * with a `data-sl-id` on every addressable element (`instrument`) plus the in-frame agent script
 * (`injectDesignBridge`) — instead of the raw slide. Both are render artifacts that never reach disk
 * (§1.1). The selection overlay is laid over the active frame and swallows pointer events so the
 * slide's own handlers stay frozen while selecting (§2.1). Turning Design Mode off swaps the raw
 * documents back and unmounts the overlay, restoring full slide interactivity.
 *
 * Neighbours get the instrumented document too, so that a step swaps no documents and reloads no
 * frame (see `SlideStage`). Their bridge scripts are dormant: the overlay talks only to the frame
 * behind `frameRef` and drops any message whose `event.source` is another window, and a hidden,
 * `inert` frame receives no input to hit-test. The instrumentation is memoized per frame on the
 * slide's html inside the stage, so zooming never re-parses and a new URL only mints when the bytes
 * actually change (see `useSlideUrl`).
 */
export function SlideCanvas({ slides, currentIndex }: SlideCanvasProps): JSX.Element {
  const [matRef, mat] = useElementSize<HTMLDivElement>()
  const fit = useMemo(() => fitSlide(mat, { maxScale: 1 }), [mat])
  const designEnabled = useDesignStore((state) => state.enabled)
  const editing = useDesignStore((state) => state.editing)
  const finishing = useDesignStore((state) => state.finishing)
  const frameRef = useRef<HTMLIFrameElement>(null)

  const slide = slides[currentIndex] ?? null
  const designModeActive = designEnabled && slide !== null

  // The computed-styles bridge client, shared with the property panel's "Ask Claude about this
  // element" affordance. Armed only in Design Mode; the frameRef and slide id are the ones the
  // instrumented frame is showing.
  const { inspect } = useElementInspect({
    frameRef,
    slideId: slide?.id ?? '',
    enabled: designModeActive,
  })

  // Only pay for the parse + instrument + inject while Design Mode is on — or while any text session
  // still holds the frame on the way out (M3.13). Swapping the document is a navigation, and a
  // session's answer can only come from the document its caret is in: swapping at the toggle put a
  // slide whose JS stalled across it past `finish`'s timeout, and the typed text was lost. The hold
  // is per session (`designStore.finishing` counts them), so the frame waits for the last of them.
  // Keeping the instrumented document costs nothing visible — it is the same slide plus
  // `data-sl-id`s and a dormant bridge — though it is stage-wide: a slide selected inside the window
  // loads instrumented and is re-navigated once the hold clears (§9.4 of 40-design-mode.md).
  const documentFor = designEnabled || finishing > 0 ? instrumentDocument : undefined

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
            <SlideStage
              slides={slides}
              activeIndex={currentIndex}
              documentFor={documentFor}
              frameRef={frameRef}
              titlePrefix="Slide"
              scale={fit.scale}
              // The slide must not receive pointer events while Design Mode's overlay is capturing
              // them — otherwise a click would reach both the overlay and the slide's own handlers.
              //
              // An open text edit is the one exception: the caret lives in the frame, so the frame
              // has to take pointer events for the user to place it. The overlay gives up its
              // capture for exactly the same interval (see SelectionOverlay's root `style`), so the
              // two are never both live, and the frame script suppresses the slide's own handlers
              // outside the element being edited so the "frozen frame" property survives.
              interactive={!designModeActive || editing !== null}
              // `outline` rather than `border`: an outline is painted outside the box without
              // joining the layout, so the framed slide stays exactly the scaled 16:9 rectangle
              // `fitSlide` computed instead of being two pixels wider than it.
              frameClassName="bg-white outline outline-1 outline-chrome-line shadow-[0_1px_2px_rgba(0,0,0,0.12),0_8px_24px_rgba(0,0,0,0.10)] dark:bg-ink-alt dark:outline-ink-line"
            />
            {designModeActive ? (
              <>
                <SelectionOverlay frameRef={frameRef} slideId={slide.id} scale={fit.scale} />
                <ArrangeBar slideId={slide.id} />
              </>
            ) : (
              // Design Mode off is a real, useful state — it is how you interact with a slide's live
              // JS — but with the overlay gone there is nothing on screen that says so, and a user
              // who lands here by accident just sees an editor where clicking does nothing. Naming
              // the state on the canvas is what makes it a mode rather than a malfunction.
              <div
                data-testid="canvas-live-hint"
                className="pointer-events-none absolute bottom-2 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-full bg-black/70 px-3 py-1 text-[11px] leading-4 text-white"
              >
                Live slide — Design Mode is off. Press Ctrl/⌘+D to select and edit.
              </div>
            )}
            {/* A permanently mounted polite live region, the same shape the chat transcript uses:
                a region inserted in the same commit as its first text is commonly not announced at
                all, so the host has to be on the page before the notice is. Outside the Design Mode
                branch on purpose — a refusal decided on the way *out* of Design Mode has to land
                somewhere the overlay no longer is (see `DesignNotice`). */}
            <div
              aria-live="polite"
              data-testid="design-notice-region"
              className="pointer-events-none absolute bottom-9 left-1/2 flex max-w-[80%] -translate-x-1/2 justify-center"
            >
              <DesignNotice slideId={slide.id} />
            </div>
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
      {/* Docked bottom-of-canvas (wireframe §20): the local property panel, mounted for as long as
          Design Mode is on — with nothing selected it shows an empty state. It must be there *before*
          the first selection: mounting it on select shrank the mat, `useElementSize` re-fit the
          slide ~116px higher, and the second click of a double-click landed on a different element
          (round-2 review). The panel's height is fixed for the same reason. */}
      {designModeActive && slide ? <PropertyPanel slide={slide} inspect={inspect} /> : null}
    </main>
  )
}
