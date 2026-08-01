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

import { useCallback, useEffect, useMemo, useReducer, useState } from 'react'
import type { ApiKeyStatus } from '../../../../shared/agent/types'
import {
  composeAgentMessage,
  type ElementContextBundle,
} from '../../../../shared/design/element-context'
import { getAgentBridge } from './agentClient'
import { initialTranscript, reduceTranscript, type Transcript } from './transcript'

export type ChatSession = {
  readonly transcript: Transcript
  /** `null` while the initial key-status probe is in flight; the masked status afterwards. */
  readonly keyStatus: ApiKeyStatus | null
  /** False when this renderer has no agent bridge (browser host / older preload). */
  readonly hasBridge: boolean
  /**
   * Send the given text as a user turn. No-op while streaming, or for empty/whitespace text. When an
   * element context bundle is attached, the transcript still shows the user's plain words while the
   * message that crosses to the agent carries the serialized context (§6.1) — see `composeAgentMessage`.
   */
  readonly send: (text: string, attachment?: ElementContextBundle | null) => void
  /** Stop the in-flight turn (the Stop button). */
  readonly interrupt: () => void
  /** Store an API key and refresh the key status (the first-run affordance). */
  readonly submitKey: (key: string) => Promise<void>
}

export function useChatSession(): ChatSession {
  const bridge = useMemo(() => getAgentBridge(), [])
  const [transcript, dispatch] = useReducer(reduceTranscript, initialTranscript)
  const [keyStatus, setKeyStatus] = useState<ApiKeyStatus | null>(null)

  // Probe the key status once and stream every agent event into the reducer. The subscription and
  // the probe share one effect because both live and die with the bridge.
  useEffect(() => {
    if (bridge === undefined) return undefined
    let live = true
    void bridge
      .getApiKeyStatus()
      .then((status) => {
        if (live) setKeyStatus(status)
      })
      .catch(() => {
        // A failed probe is treated as "no key configured": the worst case is offering the
        // add-key affordance to a user who already has one, which their first send corrects.
        if (live) setKeyStatus({ configured: false, last4: null })
      })
    const unsubscribe = bridge.onAgentEvent((event) => {
      dispatch({ type: 'agent-event', event })
    })
    return () => {
      live = false
      unsubscribe()
    }
  }, [bridge])

  const send = useCallback(
    (text: string, attachment?: ElementContextBundle | null) => {
      const trimmed = text.trim()
      if (trimmed.length === 0) return
      if (transcript.turnState === 'streaming') return
      if (bridge === undefined) return
      // The transcript shows the user's own words; the agent-bound message additionally carries the
      // serialized element context (as inert, fenced data — never executed; see `composeAgentMessage`).
      dispatch({ type: 'user-send', text: trimmed })
      const outbound = composeAgentMessage(trimmed, attachment ?? null)
      void bridge
        .sendMessage(outbound)
        .then((accepted) => {
          // The key was removed between the status probe and this send: surface it as a
          // chat-visible auth error rather than a silently swallowed turn.
          if (!accepted) {
            dispatch({
              type: 'agent-event',
              event: {
                type: 'error',
                kind: 'auth',
                message: 'No Claude API key is configured.',
                recoverable: false,
              },
            })
            setKeyStatus({ configured: false, last4: null })
          }
        })
        .catch((error: unknown) => {
          // `agent:send` can reject *before* the stream starts — the keychain read in `loadApiKey`,
          // or a synchronous `query()` spawn fault. `session.consume()` only catches *streaming*
          // errors, so without this the promise rejects unhandled and the turn is wedged in
          // `streaming` forever with no bubble — the exact opposite of the "errors as chat bubbles"
          // contract. Route it through the same error path a streaming failure takes.
          const message = error instanceof Error ? error.message : String(error)
          dispatch({
            type: 'agent-event',
            event: { type: 'error', kind: 'unknown', message, recoverable: true },
          })
        })
    },
    [bridge, transcript.turnState],
  )

  const interrupt = useCallback(() => {
    dispatch({ type: 'interrupt-requested' })
    if (bridge !== undefined) void bridge.interrupt()
  }, [bridge])

  const submitKey = useCallback(
    async (key: string) => {
      if (bridge === undefined) return
      const status = await bridge.setApiKey(key)
      setKeyStatus(status)
    },
    [bridge],
  )

  return { transcript, keyStatus, hasBridge: bridge !== undefined, send, interrupt, submitKey }
}
