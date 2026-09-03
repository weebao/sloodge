import { useCallback, useEffect, useReducer, useRef, useState, type JSX } from 'react'
import type { SlideView } from '../../stores/deckStore'
import { getBridge } from '../../host/bridge'
import { SlideStage } from '../canvas/SlideStage'
import { fitSlide } from '../canvas/slideFit'
import { useElementSize } from '../canvas/useElementSize'
import { createControlsAutoHide } from './controlsAutoHide'
import { PresentControls } from './PresentControls'
import {
  clampSlideIndex,
  createPresentState,
  keyToPresentIntent,
  PRESENT_CONTROLS_HIDE_MS,
  reducePresent,
} from './presentMachine'

/**
 * Idle time before the controls fade, per the wireframe's "on mouse move" affordance. Shared with
 * the HTML export's presenter shell (M4.4) so both surfaces fade on the same beat.
 */
const CONTROLS_HIDE_MS = PRESENT_CONTROLS_HIDE_MS

export type PresentSurfaceProps = {
  /** The deck in presentation order — the same `SlideView[]` the rail and canvas use. */
  slides: readonly SlideView[]
  /** Where to open — the slide the presenter was on. Clamped into range. */
  startIndex: number
  /** Leave Present and restore the editor. The surface also drops OS fullscreen on the way out. */
  onExit: () => void
}

/**
 * The fullscreen presentation surface (M4.1) — the payoff of M2.0. The current slide is rendered
 * through the *same* `SlideStage` / `SlideFrame` / `slide://` delivery as the editor canvas (no
 * second, weaker render path: the sandbox and per-document CSP hold exactly as in edit view), scaled
 * to fill the screen letterboxed at 16:9. Because it is a real `slide://` document, the slide's own
 * animations and interactive JS run live — a chart stays clickable — while this shell only owns the
 * presentation-level keys, the auto-hiding controls, and the black-screen toggle. The stage keeps the
 * next and previous slides mounted behind the current one, so advancing never shows a blank frame
 * (M8.2).
 *
 * ## Its own state, on purpose
 *
 * Present state (`presentMachine.ts`) is seeded once from `startIndex` and then lives here,
 * independent of the editor's selection — advancing the talk must not scroll the rail behind it, and
 * a deck hot-update mid-talk must not yank the presenter to another slide. The index is re-clamped
 * at render against the live `slides` length so a shrinking deck can never index past the end.
 *
 * ## Fullscreen
 *
 * Real, borderless OS fullscreen is a main-process capability (`BrowserWindow.setFullScreen`),
 * reached through the one `setPresentFullscreen` bridge seam and toggled on mount / off on exit. A
 * plain-browser host (tests, the static preview used for the screen recording) has no such bridge,
 * so the surface degrades to a maximized black overlay — everything else (nav, controls, blank,
 * exit) is identical, which is why those are what the recording and the component tests exercise.
 */
export function PresentSurface({ slides, startIndex, onExit }: PresentSurfaceProps): JSX.Element {
  const [state, dispatch] = useReducer(reducePresent, undefined, () =>
    createPresentState(startIndex, slides.length),
  )
  const [surfaceRef, size] = useElementSize<HTMLDivElement>()
  const [controlsVisible, setControlsVisible] = useState(true)

  // `onExit` may be a fresh closure each parent render; a ref keeps the key/effect listeners stable
  // so they are not torn down and re-added on every render, which would drop an in-flight keypress.
  const onExitRef = useRef(onExit)
  onExitRef.current = onExit

  // Set by the auto-hide effect below to the controller's `poke`. A ref (not a callback in a dep
  // array) so the key listener can reveal the controls without re-subscribing on every render.
  const pokeRef = useRef<() => void>(() => undefined)

  // Enter real OS fullscreen on mount, restore the editor on unmount. Best-effort: a host without
  // the bridge (browser/tests) simply presents in a maximized overlay. The cleanup runs on Esc/exit
  // because leaving Present unmounts this component.
  useEffect(() => {
    const bridge = getBridge()
    void bridge?.setPresentFullscreen?.(true).catch(() => undefined)
    return () => {
      void bridge?.setPresentFullscreen?.(false).catch(() => undefined)
    }
  }, [])

  // Presentation keys, captured at the window so they work regardless of which chrome element has
  // focus. Keys the surface owns are consumed (Space/PageUp/PageDown/arrows would otherwise scroll);
  // everything else falls through so the slide's own JS still receives it. Every owned key also pokes
  // the controls: when the slide fills the screen exactly (16:9 on a 16:9 display) the mouse sits over
  // the sandboxed frame, whose mousemove never reaches this surface — so a keypress is the reliable
  // way to bring the controls back, not only a move into a letterbox bar.
  useEffect(() => {
    const handler = (event: KeyboardEvent): void => {
      const intent = keyToPresentIntent(event.key)
      if (intent === null) return
      event.preventDefault()
      if (intent === 'exit') {
        onExitRef.current()
        return
      }
      pokeRef.current()
      dispatch(intent)
    }
    window.addEventListener('keydown', handler)
    return () => {
      window.removeEventListener('keydown', handler)
    }
  }, [])

  // Auto-hiding controls: the injected controller flips `controlsVisible`, a mouse move pokes it, and
  // it fades after `CONTROLS_HIDE_MS`. The controller is built once and disposed on unmount so a
  // pending fade cannot fire into an unmounted component.
  useEffect(() => {
    const controller = createControlsAutoHide({
      timeoutMs: CONTROLS_HIDE_MS,
      schedule: (fn, ms) => {
        const id = window.setTimeout(fn, ms)
        return () => {
          window.clearTimeout(id)
        }
      },
      onChange: setControlsVisible,
    })
    pokeRef.current = controller.poke
    // Show on entry, then arm the fade — the presenter sees the controls, learns they exist, and
    // they get out of the way.
    controller.poke()
    return () => {
      controller.dispose()
    }
  }, [])

  const index = clampSlideIndex(state.index, slides.length)
  const fit = fitSlide(size)

  // Stable across renders (`dispatch` and the refs never change identity) so the memoized children
  // and the mousemove handler are not handed a fresh function every frame — react-perf.
  const goPrev = useCallback((): void => {
    pokeRef.current()
    dispatch('prev')
  }, [])
  const goNext = useCallback((): void => {
    pokeRef.current()
    dispatch('next')
  }, [])
  const handleMouseMove = useCallback((): void => {
    pokeRef.current()
  }, [])

  return (
    <div
      ref={surfaceRef}
      role="dialog"
      aria-modal="true"
      aria-label="Presentation"
      className="fixed inset-0 z-50 flex items-center justify-center overflow-hidden bg-black"
      onMouseMove={handleMouseMove}
    >
      <SlideStage
        slides={slides}
        activeIndex={index}
        titlePrefix="Presenting"
        scale={fit.scale}
        interactive
      />

      {/* The black-screen toggle. The slide stays mounted underneath, so `B` twice returns to the
          exact animation/interaction state — nothing reloads.

          Deliberately painted above the controls (z-10 vs the controls' z-auto): a blanked screen is
          meant to be *truly black* — the presenter's cue to look away from the screen — so the
          on-screen chevrons are intentionally covered while blanked. Navigation is unaffected: the
          window key handler still drives B (un-blank), the arrows, and Esc, none of which depend on
          the controls being visible or clickable. */}
      {state.blank ? (
        <div aria-label="Blanked screen" className="absolute inset-0 z-10 bg-black" />
      ) : null}

      <PresentControls
        index={index}
        slideCount={slides.length}
        visible={controlsVisible}
        onPrev={goPrev}
        onNext={goNext}
        onExit={onExit}
      />
    </div>
  )
}
