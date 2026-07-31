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
  AGENT_CLEAR_KEY_CHANNEL,
  AGENT_EVENT_CHANNEL,
  AGENT_INTERRUPT_CHANNEL,
  AGENT_KEY_STATUS_CHANNEL,
  AGENT_SEND_CHANNEL,
  AGENT_SET_KEY_CHANNEL,
} from '../shared/ipc-contract'
import { isAgentEvent, type AgentEvent, type ApiKeyStatus } from '../shared/agent/types'

export type AgentInvoke = (channel: string, payload: unknown) => Promise<unknown>
export type AgentSubscribe = (channel: string, handler: (payload: unknown) => void) => () => void

export type AgentBridge = {
  /** Store an API key. The plaintext travels main-ward only; resolves with the masked status. */
  setApiKey: (key: string) => Promise<ApiKeyStatus>
  clearApiKey: () => Promise<ApiKeyStatus>
  getApiKeyStatus: () => Promise<ApiKeyStatus>
  /** Enqueue a user turn. `accepted: false` means no key is configured. */
  sendMessage: (text: string) => Promise<boolean>
  /** Stop the in-flight turn. */
  interrupt: () => Promise<boolean>
  /** Subscribe to the streaming event feed. Returns an unsubscribe function. */
  onAgentEvent: (listener: (event: AgentEvent) => void) => () => void
}

function readStatus(response: unknown): ApiKeyStatus {
  const status = (response as { status?: unknown } | null)?.status
  const rec = status as { configured?: unknown; last4?: unknown } | null
  if (rec === null || typeof rec !== 'object' || typeof rec.configured !== 'boolean') {
    throw new TypeError('agent key channel returned a malformed status')
  }
  const last4 = typeof rec.last4 === 'string' ? rec.last4 : null
  return { configured: rec.configured, last4 }
}

export function createAgentBridge(invoke: AgentInvoke, subscribe: AgentSubscribe): AgentBridge {
  return {
    setApiKey: async (key) => {
      if (typeof key !== 'string' || key.trim().length === 0) {
        throw new TypeError('setApiKey requires a non-empty key')
      }
      return readStatus(await invoke(AGENT_SET_KEY_CHANNEL, { key }))
    },

    clearApiKey: async () => readStatus(await invoke(AGENT_CLEAR_KEY_CHANNEL, {})),

    getApiKeyStatus: async () => readStatus(await invoke(AGENT_KEY_STATUS_CHANNEL, {})),

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
  }
}
