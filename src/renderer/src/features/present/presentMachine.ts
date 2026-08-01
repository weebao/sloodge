/**
 * Present mode's pure state machine — re-exported from `src/shared/present/machine.ts`.
 *
 * The logic moved to `shared/` in M4.4 because HTML export needs it too: the exported bundle's
 * presenter shell is a standalone version of this surface, and its key map is *generated* from
 * `keyToPresentIntent` at build time (see `PRESENT_KEYS`) rather than reimplemented. Main and the
 * bundle builder may not import renderer code, so the machine had to live somewhere both halves can
 * reach.
 *
 * This module stays as the renderer's import site so `PresentSurface.tsx` — and anything reading the
 * feature folder to understand Present mode — still finds the machine where it expects it.
 */

export {
  clampSlideIndex,
  createPresentState,
  keyToPresentIntent,
  PRESENT_CONTROLS_HIDE_MS,
  PRESENT_KEYS,
  reducePresent,
} from '../../../../shared/present/machine'
export type { PresentIntent, PresentState } from '../../../../shared/present/machine'
