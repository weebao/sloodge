/**
 * The renderer's end of the agent IPC, as plain functions over an injected transport — same shape as
 * `slideBridge.ts`, and for the same reason: it lives outside `index.ts` (which imports `electron` at
 * module scope) so it is unit-testable, and the decisions — *what may cross, in either direction* —
 * are here.
 *
 * M2.1 ships this inert: no chat UI consumes it yet (M2.3). It exists so the wire is exercised and
 * typed end-to-end now. Outbound calls validate shape before crossing; inbound events are shape-gated
 * with `isAgentEvent` before reaching a listener, so the renderer never switches on an unknown `type`.
 */

import {
  AGENT_AUTH_STATUS_CHANNEL,
  AGENT_CLEAR_KEY_CHANNEL,
  AGENT_CLEAR_SUBSCRIPTION_TOKEN_CHANNEL,
  AGENT_SET_SUBSCRIPTION_TOKEN_CHANNEL,
  AGENT_EVENT_CHANNEL,
  AGENT_INTERRUPT_CHANNEL,
  AGENT_KEY_STATUS_CHANNEL,
  AGENT_SEND_CHANNEL,
  AGENT_SET_KEY_CHANNEL,
  DECK_AGENT_EDIT_CHANNEL,
  DECK_AGENT_EDIT_RESULT_CHANNEL,
  DECK_UPDATED_CHANNEL,
} from '../shared/ipc-contract'
import { isAgentEvent, type AgentEvent, type ApiKeyStatus } from '../shared/agent/types'
import { deriveAuthStatus, type AuthStatus } from '../shared/agent/auth'
import { DEFAULT_ENDPOINT, type EndpointInfo } from '../shared/agent/endpoint'
import { isDeckUpdate, type DeckUpdate } from '../shared/document/deck-update'
import {
  isAgentEditRequest,
  type AgentEditRequest,
  type AgentEditResponse,
} from '../shared/document/agent-edit'

export type AgentInvoke = (channel: string, payload: unknown) => Promise<unknown>
export type AgentSubscribe = (channel: string, handler: (payload: unknown) => void) => () => void
/** Fire-and-forget renderer → main send (for the agent-edit reply, which is not an `invoke`). */
export type AgentSend = (channel: string, payload: unknown) => void

export type AgentBridge = {
  /** Store an API key. The plaintext travels main-ward only; resolves with the masked status. */
  setApiKey: (key: string) => Promise<ApiKeyStatus>
  clearApiKey: () => Promise<ApiKeyStatus>
  getApiKeyStatus: () => Promise<ApiKeyStatus>
  /**
   * Store a `claude setup-token` subscription token (M2.7). Like the key, the plaintext travels
   * main-ward only and resolves with the combined masked auth status.
   */
  setSubscriptionToken: (token: string) => Promise<AuthStatus>
  clearSubscriptionToken: () => Promise<AuthStatus>
  /** Both vault slots plus the derived active mode — what the Settings Auth tab renders. */
  getAuthStatus: () => Promise<AuthStatus>
  /** Enqueue a user turn. `accepted: false` means no key is configured. */
  sendMessage: (text: string) => Promise<boolean>
  /** Stop the in-flight turn. */
  interrupt: () => Promise<boolean>
  /** Subscribe to the streaming event feed. Returns an unsubscribe function. */
  onAgentEvent: (listener: (event: AgentEvent) => void) => () => void
  /**
   * Subscribe to live deck snapshots pushed as the agent writes (§9). A separate feed from
   * `onAgentEvent` so the canvas never waits on the chat stream. Returns an unsubscribe function.
   */
  onDeckUpdated: (listener: (update: DeckUpdate) => void) => () => void
  /**
   * Subscribe to agent tool edits pushed for the renderer to apply through its authoritative history
   * (M2.6). The listener is expected to reply via `sendAgentEditResult`. Returns an unsubscribe fn.
   */
  onAgentEditRequest: (listener: (request: AgentEditRequest) => void) => () => void
  /** Reply to an `onAgentEditRequest`, correlated by `requestId`. Fire-and-forget. */
  sendAgentEditResult: (response: AgentEditResponse) => void
}

function readStatus(response: unknown): ApiKeyStatus {
  const status = (response as { status?: unknown } | null)?.status
  const rec = status as { configured?: unknown; last4?: unknown } | null
  if (rec === null || typeof rec !== 'object' || typeof rec.configured !== 'boolean') {
    throw new TypeError('agent key channel returned a malformed status')
  }
  // Truncated HERE, not merely trusted from main. `authStore`'s docstring promises the renderer
  // never holds plaintext; that guarantee should be structural at the masking boundary rather than
  // contingent on main's `keyStatus()` happening to slice — the same argument `readAuthStatus` makes
  // for `mode`.
  const last4 = typeof rec.last4 === 'string' ? rec.last4.slice(-4) : null
  return { configured: rec.configured, last4 }
}

/**
 * Re-narrow the combined auth status. Both slots go through the same `readStatus` gate, and the mode
 * is *re-derived* here rather than trusted from the wire — so a main-process bug (or a malicious
 * message on this channel) cannot make the UI claim "using your Claude subscription" while no
 * subscription token is actually stored.
 */
function readAuthStatus(response: unknown): AuthStatus {
  const status = (response as { status?: unknown } | null)?.status
  const rec = status as { apiKey?: unknown; subscription?: unknown; endpoint?: unknown } | null
  if (rec === null || typeof rec !== 'object') {
    throw new TypeError('agent auth channel returned a malformed status')
  }
  return deriveAuthStatus(
    readStatus({ status: rec.apiKey }),
    readStatus({ status: rec.subscription }),
    readEndpoint(rec.endpoint),
  )
}

/**
 * Narrow the endpoint report. Falls back to "default" only when the field is absent or malformed —
 * never inventing a host, and never letting a non-string `host` through to be rendered.
 */
function readEndpoint(value: unknown): EndpointInfo {
  const rec = value as { custom?: unknown; host?: unknown } | null
  if (rec === null || typeof rec !== 'object' || typeof rec.custom !== 'boolean') {
    return DEFAULT_ENDPOINT
  }
  return { custom: rec.custom, host: typeof rec.host === 'string' ? rec.host : null }
}

export function createAgentBridge(
  invoke: AgentInvoke,
  subscribe: AgentSubscribe,
  send: AgentSend,
): AgentBridge {
  return {
    setApiKey: async (key) => {
      if (typeof key !== 'string' || key.trim().length === 0) {
        throw new TypeError('setApiKey requires a non-empty key')
      }
      return readStatus(await invoke(AGENT_SET_KEY_CHANNEL, { key }))
    },

    clearApiKey: async () => readStatus(await invoke(AGENT_CLEAR_KEY_CHANNEL, {})),

    getApiKeyStatus: async () => readStatus(await invoke(AGENT_KEY_STATUS_CHANNEL, {})),

    setSubscriptionToken: async (token) => {
      if (typeof token !== 'string' || token.trim().length === 0) {
        throw new TypeError('setSubscriptionToken requires a non-empty token')
      }
      return readAuthStatus(await invoke(AGENT_SET_SUBSCRIPTION_TOKEN_CHANNEL, { key: token }))
    },

    clearSubscriptionToken: async () =>
      readAuthStatus(await invoke(AGENT_CLEAR_SUBSCRIPTION_TOKEN_CHANNEL, {})),

    getAuthStatus: async () => readAuthStatus(await invoke(AGENT_AUTH_STATUS_CHANNEL, {})),

    sendMessage: async (text) => {
      if (typeof text !== 'string' || text.length === 0) {
        throw new TypeError('sendMessage requires a non-empty text')
      }
      const response = await invoke(AGENT_SEND_CHANNEL, { text })
      return (response as { accepted?: unknown } | null)?.accepted === true
    },

    interrupt: async () => {
      const response = await invoke(AGENT_INTERRUPT_CHANNEL, {})
      return (response as { interrupted?: unknown } | null)?.interrupted === true
    },

    onAgentEvent: (listener) =>
      subscribe(AGENT_EVENT_CHANNEL, (payload) => {
        if (isAgentEvent(payload)) listener(payload)
      }),

    onDeckUpdated: (listener) =>
      subscribe(DECK_UPDATED_CHANNEL, (payload) => {
        if (isDeckUpdate(payload)) listener(payload)
      }),

    onAgentEditRequest: (listener) =>
      subscribe(DECK_AGENT_EDIT_CHANNEL, (payload) => {
        if (isAgentEditRequest(payload)) listener(payload)
      }),

    sendAgentEditResult: (response) => {
      send(DECK_AGENT_EDIT_RESULT_CHANNEL, response)
    },
  }
}
