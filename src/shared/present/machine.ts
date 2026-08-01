/**
 * The pure heart of Present mode (M4.1): where in the deck the presenter is, whether the screen is
 * blanked, and what a keystroke means. No React, no DOM, no timers — so every rule here is testable
 * as a plain function, and the component in `PresentSurface.tsx` is left holding only the wiring.
 *
 * ## Why a reducer and not ad-hoc handlers
 *
 * The navigation rules are small but they are *rules*, not conveniences: advancing past the last
 * slide is a no-op (a talk must not wrap to the title slide because the presenter pressed → once too
 * often), and the same clamp guards the start. Expressing them as one `(state, intent) => state`
 * function is what lets a test assert "next at the last slide changes nothing" against the exact code
 * that ships, and what makes the clamp a single line a mutation (`+ 1` with no clamp) reddens.
 *
 * `exit` is an intent the reducer *recognises but does not act on* — leaving the surface is a
 * lifecycle event the container owns (it restores the editor and drops fullscreen), not a field on
 * this state. Keeping it in the union means the key map has one exhaustive target and the container
 * switches on a typed value rather than re-parsing the key.
 */

/** The presentation position. `slideCount` travels in state so the clamp is self-contained. */
export type PresentState = {
  /** 0-based index into the deck's presentation order. Always in `[0, slideCount - 1]`, or 0. */
  readonly index: number
  /** How many slides the deck has. The clamp's upper bound. */
  readonly slideCount: number
  /** Whether the screen is blanked to black (the `B` toggle). The slide stays mounted underneath. */
  readonly blank: boolean
}

/**
 * A presentation-level command. `next`/`prev` step one slide (clamped); `first`/`last` jump to the
 * ends; `toggle-blank` flips the black screen; `exit` leaves Present (handled by the container, a
 * no-op here). Deliberately *not* a raw key — the key map is the only place a keyboard string turns
 * into one of these, so the reducer is testable without inventing key events.
 */
export type PresentIntent = 'next' | 'prev' | 'first' | 'last' | 'toggle-blank' | 'exit'

/**
 * Clamp an index into a deck of `slideCount` slides. An empty deck collapses to 0 rather than -1, so
 * a caller never indexes `slides[-1]`; a single-slide deck pins to 0, which is what makes `next` a
 * no-op there.
 */
export function clampSlideIndex(index: number, slideCount: number): number {
  if (slideCount <= 0) return 0
  if (index < 0) return 0
  if (index > slideCount - 1) return slideCount - 1
  return index
}

/** The state Present opens in: at `startIndex` (clamped), screen not blanked. */
export function createPresentState(startIndex: number, slideCount: number): PresentState {
  return { index: clampSlideIndex(startIndex, slideCount), slideCount, blank: false }
}

function withIndex(state: PresentState, next: number): PresentState {
  const clamped = clampSlideIndex(next, state.slideCount)
  // Referential stability: a `next` at the last slide returns the *same* object, so React's reducer
  // dispatch bails out of a re-render rather than re-mounting the frame and restarting its animation.
  return clamped === state.index ? state : { ...state, index: clamped }
}

/**
 * Apply an intent. `next`/`prev`/`first`/`last` move the clamped index; `toggle-blank` flips blank;
 * `exit` is recognised but leaves the state untouched (the container tears the surface down).
 */
export function reducePresent(state: PresentState, intent: PresentIntent): PresentState {
  switch (intent) {
    case 'next':
      return withIndex(state, state.index + 1)
    case 'prev':
      return withIndex(state, state.index - 1)
    case 'first':
      return withIndex(state, 0)
    case 'last':
      return withIndex(state, state.slideCount - 1)
    case 'toggle-blank':
      return { ...state, blank: !state.blank }
    case 'exit':
      return state
  }
}

/**
 * The one place a keyboard key becomes a Present intent, per the wireframe (20-ui-wireframes.md §
 * Present mode): →/Space/PageDown advance, ←/PageUp go back, Esc exits, `B` blanks. `Home`/`End`
 * jump to the ends (10-architecture.md §8). Anything else returns `null` so the slide's own JS keeps
 * the keystroke — an interactive chart's arrow-key handling is not stolen by the presenter shell for
 * keys it does not own.
 *
 * `' '` is the modern `KeyboardEvent.key` for Space; `'Spacebar'` is the legacy spelling some hosts
 * still emit. Both map to advance so neither scrolls the (fixed) surface instead.
 */
export function keyToPresentIntent(key: string): PresentIntent | null {
  switch (key) {
    case 'ArrowRight':
    case ' ':
    case 'Spacebar':
    case 'PageDown':
      return 'next'
    case 'ArrowLeft':
    case 'PageUp':
      return 'prev'
    case 'Home':
      return 'first'
    case 'End':
      return 'last'
    case 'Escape':
      return 'exit'
    case 'b':
    case 'B':
      return 'toggle-blank'
    default:
      return null
  }
}

/**
 * Idle time before the presenter controls fade, per the wireframe's "on mouse move" affordance
 * (20-ui-wireframes.md § Present mode). Shared rather than local to `PresentSurface.tsx` because the
 * exported bundle's presenter shell (M4.4) must feel like the same surface, and two copies of a
 * tuning number drift the moment one is adjusted.
 */
export const PRESENT_CONTROLS_HIDE_MS = 2500

/**
 * Every key `keyToPresentIntent` claims, as data.
 *
 * The HTML export's presenter shell (M4.4) is *emitted* JavaScript — it runs from `file://` in a
 * browser that never loads our bundle — so it cannot import `keyToPresentIntent`. Instead the bundle
 * builder walks this list, calls `keyToPresentIntent` on each entry, and emits the resulting
 * key→intent object literal. The shell's key semantics are therefore *generated by* the same
 * function the editor uses rather than retyped beside it, and the only thing that could drift is
 * this list's membership — which a test pins by asserting that every key here maps to a non-`null`
 * intent and that the emitted table round-trips against `keyToPresentIntent` for all of them.
 *
 * Keys absent from the list are not "unmapped" by omission: the emitted lookup misses them and the
 * shell leaves the keystroke to the slide, which is exactly `keyToPresentIntent`'s `default: null`.
 */
export const PRESENT_KEYS = [
  'ArrowRight',
  ' ',
  'Spacebar',
  'PageDown',
  'ArrowLeft',
  'PageUp',
  'Home',
  'End',
  'Escape',
  'b',
  'B',
] as const
