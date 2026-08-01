/**
 * The stateful wrapper around the pure transcript reducer (`transcript.ts`): it owns the reducer
 * state, subscribes to the agent bridge's streaming feed, and exposes the actions the composer and
 * Stop control call. Everything with a *decision* in it lives in the reducer; this hook is wiring —
 * bridge in, dispatch out — kept thin enough that the component test can drive it with a fake bridge
 * and no real IPC.
 *
 * The bridge is resolved once via `getAgentBridge()`. `undefined` (a browser host, or a preload
 * without the agent surface) is a first-class state: the composer stays a plain editable field so the
 * shell's focus-guard behaviour is unaffected, but there is nothing to send to, so Send is inert and
 * no key affordance is offered (you cannot store a key without a bridge).
 */

import { useCallback, useEffect, useMemo, useReducer } from 'react'
import { isAuthenticated, NOT_CONFIGURED, type AuthStatus } from '../../../../shared/agent/auth'
import type { AgentEvent } from '../../../../shared/agent/types'
import {
  budgetRefusalMessage,
  canStartTurn,
  evaluateBudget,
  type BudgetCap,
  type BudgetStatus,
} from '../../../../shared/agent/budget'
import { selectAuthLoaded, selectAuthStatus, useAuthStore } from '../../stores/authStore'
import { selectBudgetCap, selectBudgetLoaded, useBudgetStore } from '../../stores/budgetStore'
import { useSessionMeterStore } from '../../stores/sessionMeterStore'
import {
  composeAgentMessage,
  type ElementContextBundle,
} from '../../../../shared/design/element-context'
import { getAgentBridge } from './agentClient'
import { initialTranscript, reduceTranscript, type Transcript } from './transcript'

/**
 * The chat-visible refusal, raised locally so the composer explains itself without a round trip.
 *
 * Carries `budgetRefusalMessage(cap)` as its message so the bubble names the number the user is
 * arguing with — `errorCopy` prefers a non-empty message for `budget`. The SDK's own mid-turn
 * `error_max_budget_usd` arrives with an empty message and falls through to the generic sentence,
 * because it knows only a subtype.
 */
function budgetRefusalEvent(capUsd: BudgetCap): AgentEvent {
  return {
    type: 'error',
    kind: 'budget',
    message: budgetRefusalMessage(capUsd),
    // Recoverable: raising the cap in Settings makes the very next send work. A dead end would be
    // wrong copy for a state the user can clear in two clicks.
    recoverable: true,
  }
}

export type ChatSession = {
  readonly transcript: Transcript
  /**
   * The masked auth status from the shared store (M2.7). Read from a store rather than local state
   * because Settings writes the credential from a different subtree — per-hook state would leave the
   * composer gated after a successful save.
   */
  readonly authStatus: AuthStatus
  /** False until the first status probe resolves, so the gate never flashes at a configured user. */
  readonly authLoaded: boolean
  /** True once we know the user has no credential — the composer shows the Settings link. */
  readonly needsAuth: boolean
  /** False when this renderer has no agent bridge (browser host / older preload). */
  readonly hasBridge: boolean
  /**
   * The session against its spend cap (M2.5, §10). `level: 'blocked'` means `send` will refuse; the
   * composer renders the cap line from this rather than recomputing it.
   */
  readonly budget: BudgetStatus
  /**
   * Send the given text as a user turn. No-op while streaming, or for empty/whitespace text. When an
   * element context bundle is attached, the transcript still shows the user's plain words while the
   * message that crosses to the agent carries the serialized context (§6.1) — see `composeAgentMessage`.
   *
   * Resolves to whether the turn was **accepted by main**. `false` means nothing will run — no
   * bridge, a turn already streaming, empty text, the local budget guard refusing, or main refusing
   * (M2.5) — which the composer awaits so it clears the draft and the context chip only for a turn
   * genuinely on its way, rather than eating a message that was never sent.
   */
  readonly send: (text: string, attachment?: ElementContextBundle | null) => Promise<boolean>
  /** Stop the in-flight turn (the Stop button). */
  readonly interrupt: () => void
}

export function useChatSession(): ChatSession {
  const bridge = useMemo(() => getAgentBridge(), [])
  const [transcript, dispatch] = useReducer(reduceTranscript, initialTranscript)
  const authStatus = useAuthStore(selectAuthStatus)
  const authLoaded = useAuthStore(selectAuthLoaded)
  const setAuthStatus = useAuthStore((state) => state.setStatus)
  const capUsd = useBudgetStore(selectBudgetCap)
  const budgetLoaded = useBudgetStore(selectBudgetLoaded)
  const setCap = useBudgetStore((state) => state.setCap)
  const setCostUsd = useSessionMeterStore((state) => state.setCostUsd)
  const setSkills = useSessionMeterStore((state) => state.setSkills)

  // Probe the key status and the budget cap once, and stream every agent event into the reducer. The
  // subscription and the probes share one effect because all three live and die with the bridge.
  useEffect(() => {
    if (bridge === undefined) return undefined
    let live = true
    void bridge
      .getAuthStatus()
      .then((status) => {
        if (live) setAuthStatus(status)
      })
      .catch(() => {
        // A failed probe is treated as "nothing configured": the worst case is offering the
        // Settings link to a user who is already set up, which their first send corrects.
        if (live) setAuthStatus(NOT_CONFIGURED)
      })
    void bridge
      .getBudgetCap()
      .then((cap) => {
        if (live) setCap(cap)
      })
      .catch(() => {
        // Leave the store unloaded rather than committing to a guessed cap: main is authoritative
        // and enforces the real one on every send, so the local guard staying open is safe.
      })
    const unsubscribe = bridge.onAgentEvent((event) => {
      dispatch({ type: 'agent-event', event })
      // Status-bar telemetry rides the same feed; the transcript treats it as a no-op.
      if (event.type === 'skills-status') setSkills(event.status)
    })
    return () => {
      live = false
      unsubscribe()
    }
  }, [bridge, setAuthStatus, setCap, setSkills])

  // Publish the transcript's own total to the status bar. A mirror, never a second accumulator —
  // the reducer folds once per turn by the shared rule main uses (shared/agent/cost.ts).
  const costUsd = transcript.cost.totalUsd
  useEffect(() => {
    setCostUsd(costUsd)
  }, [costUsd, setCostUsd])

  const budget = useMemo(
    // An unresolved probe reads as uncapped: see `budgetStore`'s docstring for why the local guard
    // fails open here rather than enforcing a cap the user may not have set.
    () => evaluateBudget(costUsd, budgetLoaded ? capUsd : null),
    [costUsd, capUsd, budgetLoaded],
  )

  const send = useCallback(
    async (text: string, attachment?: ElementContextBundle | null): Promise<boolean> => {
      const trimmed = text.trim()
      if (trimmed.length === 0) return false
      if (transcript.turnState === 'streaming') return false
      if (bridge === undefined) return false
      // The budget guard, checked *before* the turn is opened (M2.5, §10). Refusing here rather than
      // after `user-send` keeps a blocked send out of the transcript entirely: the user's words stay
      // in the composer to retry once they raise the cap, instead of becoming a message that was
      // never sent. A turn already in flight is never interrupted — see `shared/agent/budget.ts` for
      // why stop-before-the-next-turn is the honest half of this and `maxBudgetUsd` is the other.
      if (!canStartTurn(budget)) {
        dispatch({ type: 'agent-event', event: budgetRefusalEvent(budget.capUsd) })
        return false
      }
      // The transcript shows the user's own words; the agent-bound message additionally carries the
      // serialized element context (as inert, fenced data — never executed; see `composeAgentMessage`).
      // Opened optimistically so the assistant bubble appears the instant Send is pressed; if main
      // refuses, `turn-refused` takes all of it back (bubbles, open turn, and the text itself).
      dispatch({ type: 'user-send', text: trimmed })
      const outbound = composeAgentMessage(trimmed, attachment ?? null)
      try {
        const result = await bridge.sendMessage(outbound)
        if (result.accepted) return true
        // Main is authoritative and it said no, so roll the optimistic turn back before reporting.
        // Without this the renderer keeps an open turn main never opened, and the two counts the
        // budget guard compares drift apart permanently.
        dispatch({ type: 'turn-refused' })
        if (result.reason === 'budget') {
          // Main's ledger blocked the turn even though ours did not — a stale local cap, or spend
          // main counted that we have not folded yet.
          dispatch({ type: 'agent-event', event: budgetRefusalEvent(budget.capUsd) })
          return false
        }
        // The credential was removed between the status probe and this send: surface it as a
        // chat-visible auth error rather than a silently swallowed turn, and re-gate the composer.
        dispatch({
          type: 'agent-event',
          event: {
            type: 'error',
            kind: 'auth',
            message: 'No Claude credential is configured.',
            recoverable: false,
          },
        })
        setAuthStatus(NOT_CONFIGURED)
        return false
      } catch (error: unknown) {
        // `agent:send` can reject *before* the stream starts — the keychain read in `loadApiKey`,
        // or a synchronous `query()` spawn fault. `session.consume()` only catches *streaming*
        // errors, so without this the promise rejects unhandled and the turn is wedged in
        // `streaming` forever with no bubble — the exact opposite of the "errors as chat bubbles"
        // contract. Route it through the same error path a streaming failure takes.
        //
        // The turn is NOT rolled back here: unlike a refusal, a rejected invoke may well have
        // reached main, so the safe reading is that the turn exists and failed.
        const message = error instanceof Error ? error.message : String(error)
        dispatch({
          type: 'agent-event',
          event: { type: 'error', kind: 'unknown', message, recoverable: true },
        })
        return false
      }
    },
    [bridge, transcript.turnState, setAuthStatus, budget],
  )

  const interrupt = useCallback(() => {
    dispatch({ type: 'interrupt-requested' })
    if (bridge !== undefined) void bridge.interrupt()
  }, [bridge])

  return {
    transcript,
    authStatus,
    authLoaded,
    // Only a *known* unconfigured state gates the composer; an unresolved probe must not.
    needsAuth: authLoaded && !isAuthenticated(authStatus),
    hasBridge: bridge !== undefined,
    budget,
    send,
    interrupt,
  }
}
