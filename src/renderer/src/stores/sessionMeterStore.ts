/**
 * The live session telemetry the **status bar** shows (M2.5): what this session has cost, and how it
 * loaded its slide-craft knowledge.
 *
 * Why a store rather than props. Both numbers are produced inside `useChatSession`, which is called
 * by `ChatPanel` — a *sibling* of `StatusBar`, not an ancestor. The choices were to hoist the whole
 * chat session into `AppShell` (which would re-render the canvas and the rail on every streamed
 * token) or to publish the two values the bar needs. Same argument `authStore` makes for auth
 * status, same shape.
 *
 * This is emphatically **not** a second cost accumulator. The transcript reducer owns the fold —
 * once per turn, by the shared rule in `shared/agent/cost.ts` that main uses too — and this store
 * only mirrors the resulting total. A second accumulator is exactly the drift M2.5 exists to
 * prevent: the guard and the meter must read the same number as main's ledger.
 */

import type { SkillsStatus } from '../../../shared/agent/types'
import { createStore } from './createStore'

/** `null` until a session has resolved its first `system:init`. See `SkillsStatus`. */
export type SessionSkills = SkillsStatus | null

export type SessionMeterState = {
  /** Mirror of `Transcript.cost.totalUsd`. A client-side estimate — displayed with "≈" (§10). */
  readonly costUsd: number
  readonly skills: SessionSkills
  readonly setCostUsd: (costUsd: number) => void
  readonly setSkills: (skills: SkillsStatus) => void
  readonly reset: () => void
}

export const useSessionMeterStore = createStore<SessionMeterState>((set) => ({
  costUsd: 0,
  skills: null,
  setCostUsd: (costUsd) => {
    set({ costUsd })
  },
  setSkills: (skills) => {
    set({ skills })
  },
  reset: () => {
    set({ costUsd: 0, skills: null })
  },
}))

/** Selectors kept module-level so their identity is stable across renders (`createStore`'s contract). */
export const selectSessionCostUsd = (state: SessionMeterState): number => state.costUsd
export const selectSessionSkills = (state: SessionMeterState): SessionSkills => state.skills
