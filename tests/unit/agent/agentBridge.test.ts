import { describe, expect, it, vi } from 'vitest'
import { createAgentBridge } from '../../../src/preload/agentBridge'
import {
  AGENT_CLEAR_KEY_CHANNEL,
  AGENT_EVENT_CHANNEL,
  AGENT_INTERRUPT_CHANNEL,
  AGENT_AUTH_STATUS_CHANNEL,
  AGENT_CLEAR_SUBSCRIPTION_TOKEN_CHANNEL,
  AGENT_KEY_STATUS_CHANNEL,
  AGENT_SET_SUBSCRIPTION_TOKEN_CHANNEL,
  AGENT_SEND_CHANNEL,
  AGENT_SET_KEY_CHANNEL,
  DECK_UPDATED_CHANNEL,
} from '../../../src/shared/ipc-contract'
import type { AgentEvent } from '../../../src/shared/agent/types'
import type { DeckUpdate } from '../../../src/shared/document/deck-update'

function makeBridge(invokeImpl: (channel: string, payload: unknown) => Promise<unknown>) {
  const invoke = vi.fn(invokeImpl)
  const handlers = new Map<string, (payload: unknown) => void>()
  const subscribe = vi.fn((channel: string, handler: (payload: unknown) => void) => {
    handlers.set(channel, handler)
    return () => handlers.delete(channel)
  })
  const send = vi.fn()
  return { bridge: createAgentBridge(invoke, subscribe, send), invoke, subscribe, send, handlers }
}

const STATUS_OK = { status: { configured: true, last4: 'W3z9' } }

describe('createAgentBridge — key channels', () => {
  it('setApiKey sends the plaintext main-ward and returns the masked status', async () => {
    const { bridge, invoke } = makeBridge(async () => STATUS_OK)
    expect(await bridge.setApiKey('sk-ant-live')).toEqual({ configured: true, last4: 'W3z9' })
    expect(invoke).toHaveBeenCalledWith(AGENT_SET_KEY_CHANNEL, { key: 'sk-ant-live' })
  })

  it('setApiKey rejects an empty key before it crosses', async () => {
    const { bridge, invoke } = makeBridge(async () => STATUS_OK)
    await expect(bridge.setApiKey('   ')).rejects.toThrow()
    expect(invoke).not.toHaveBeenCalled()
  })

  it('clearApiKey and getApiKeyStatus hit their channels', async () => {
    const { bridge, invoke } = makeBridge(async () => ({
      status: { configured: false, last4: null },
    }))
    await bridge.clearApiKey()
    await bridge.getApiKeyStatus()
    expect(invoke).toHaveBeenCalledWith(AGENT_CLEAR_KEY_CHANNEL, {})
    expect(invoke).toHaveBeenCalledWith(AGENT_KEY_STATUS_CHANNEL, {})
  })

  it('throws on a malformed status rather than passing garbage up', async () => {
    const { bridge } = makeBridge(async () => ({ status: { last4: 'x' } }))
    await expect(bridge.getApiKeyStatus()).rejects.toThrow(/malformed status/)
  })
})

describe('createAgentBridge — turns', () => {
  it('sendMessage reports an accepted turn with no refusal reason', async () => {
    const { bridge, invoke } = makeBridge(async () => ({ accepted: true }))
    expect(await bridge.sendMessage('hi')).toEqual({ accepted: true, reason: null })
    expect(invoke).toHaveBeenCalledWith(AGENT_SEND_CHANNEL, { text: 'hi' })
  })

  it('sendMessage carries the budget refusal reason through (M2.5)', async () => {
    const { bridge } = makeBridge(async () => ({ accepted: false, reason: 'budget' }))
    expect(await bridge.sendMessage('hi')).toEqual({ accepted: false, reason: 'budget' })
  })

  it('re-narrows an unrecognised refusal reason to the conservative no-credential', async () => {
    // A reason the renderer cannot switch on must not reach it; `no-credential` is the answer that
    // still offers the user a way forward.
    const { bridge } = makeBridge(async () => ({ accepted: false, reason: 'wat' }))
    expect(await bridge.sendMessage('hi')).toEqual({ accepted: false, reason: 'no-credential' })
  })

  it('sendMessage rejects an empty text', async () => {
    const { bridge } = makeBridge(async () => ({ accepted: true }))
    await expect(bridge.sendMessage('')).rejects.toThrow()
  })

  it('interrupt reports the boolean', async () => {
    const { bridge, invoke } = makeBridge(async () => ({ interrupted: true }))
    expect(await bridge.interrupt()).toBe(true)
    expect(invoke).toHaveBeenCalledWith(AGENT_INTERRUPT_CHANNEL, {})
  })
})

describe('createAgentBridge — event stream', () => {
  it('subscribes to the event channel and gates malformed payloads', () => {
    const received: AgentEvent[] = []
    const { bridge, subscribe, handlers } = makeBridge(async () => ({}))
    const unsubscribe = bridge.onAgentEvent((e) => received.push(e))
    expect(subscribe).toHaveBeenCalledWith(AGENT_EVENT_CHANNEL, expect.any(Function))

    const deliver = handlers.get(AGENT_EVENT_CHANNEL)
    deliver?.({ type: 'ready', sessionId: 's', model: 'claude-opus-5', skills: [] })
    deliver?.({ type: 'not-a-real-event' })
    deliver?.(null)

    expect(received).toEqual([
      { type: 'ready', sessionId: 's', model: 'claude-opus-5', skills: [] },
    ])
    unsubscribe()
    expect(handlers.has(AGENT_EVENT_CHANNEL)).toBe(false)
  })
})

describe('createAgentBridge — deck hot-update stream', () => {
  it('subscribes to the deck channel and gates malformed payloads', () => {
    const received: DeckUpdate[] = []
    const { bridge, subscribe, handlers } = makeBridge(async () => ({}))
    const unsubscribe = bridge.onDeckUpdated((u) => received.push(u))
    expect(subscribe).toHaveBeenCalledWith(DECK_UPDATED_CHANNEL, expect.any(Function))

    const deliver = handlers.get(DECK_UPDATED_CHANNEL)
    const update = { manifest: { id: 'd' }, slides: {}, notes: {}, theme: null }
    deliver?.(update)
    // Missing the structural fields the gate requires — must not reach the listener.
    deliver?.({ manifest: null, slides: {}, notes: {} })
    deliver?.({ slides: {}, notes: {} })
    deliver?.(null)

    expect(received).toEqual([update])
    unsubscribe()
    expect(handlers.has(DECK_UPDATED_CHANNEL)).toBe(false)
  })
})

/**
 * The preload is the declared masking boundary (M2.7). Two guarantees live here and BOTH were
 * unpinned in round 1 — a mutant that trusted `mode` off the wire survived the entire suite.
 */
describe('createAgentBridge — auth channels', () => {
  const UNSET = { configured: false, last4: null }

  it('getAuthStatus invokes the auth channel', async () => {
    const { bridge, invoke } = makeBridge(async () => ({
      status: { mode: 'not-configured', apiKey: UNSET, subscription: UNSET },
    }))
    await bridge.getAuthStatus()
    expect(invoke).toHaveBeenCalledWith(AGENT_AUTH_STATUS_CHANNEL, {})
  })

  it('setSubscriptionToken sends the token main-ward under the contract key', async () => {
    const { bridge, invoke } = makeBridge(async () => ({
      status: {
        mode: 'subscription',
        apiKey: UNSET,
        subscription: { configured: true, last4: 'abcd' },
      },
    }))
    const status = await bridge.setSubscriptionToken('sk-ant-oat01-abcd')
    expect(invoke).toHaveBeenCalledWith(AGENT_SET_SUBSCRIPTION_TOKEN_CHANNEL, {
      key: 'sk-ant-oat01-abcd',
    })
    expect(status.mode).toBe('subscription')
  })

  it('setSubscriptionToken rejects an empty token before it crosses', async () => {
    const { bridge, invoke } = makeBridge(async () => ({ status: {} }))
    await expect(bridge.setSubscriptionToken('   ')).rejects.toThrow(TypeError)
    expect(invoke).not.toHaveBeenCalled()
  })

  it('clearSubscriptionToken invokes the clear channel', async () => {
    const { bridge, invoke } = makeBridge(async () => ({
      status: { mode: 'not-configured', apiKey: UNSET, subscription: UNSET },
    }))
    await bridge.clearSubscriptionToken()
    expect(invoke).toHaveBeenCalledWith(AGENT_CLEAR_SUBSCRIPTION_TOKEN_CHANNEL, {})
  })

  /**
   * THE headline defence: `mode` is re-derived from the two masked slots, never trusted from the
   * wire, so a main-process bug cannot make the UI claim a subscription is active.
   *
   * Mutation check: return `rec.mode` instead of calling `deriveAuthStatus` and this fails.
   */
  it('re-derives mode: a payload claiming subscription with EMPTY slots is not believed', async () => {
    const { bridge } = makeBridge(async () => ({
      status: { mode: 'subscription', apiKey: UNSET, subscription: UNSET },
    }))
    expect((await bridge.getAuthStatus()).mode).toBe('not-configured')
  })

  it('re-derives mode: a lying "subscription" with only a key stored reads as api-key', async () => {
    const { bridge } = makeBridge(async () => ({
      status: {
        mode: 'subscription',
        apiKey: { configured: true, last4: 'aXY9' },
        subscription: UNSET,
      },
    }))
    expect((await bridge.getAuthStatus()).mode).toBe('api-key')
  })

  it('re-derives mode: a lying "not-configured" with a token stored still reads as subscription', async () => {
    const { bridge } = makeBridge(async () => ({
      status: {
        mode: 'not-configured',
        apiKey: UNSET,
        subscription: { configured: true, last4: '7f2b' },
      },
    }))
    expect((await bridge.getAuthStatus()).mode).toBe('subscription')
  })

  /**
   * The masking guarantee `authStore` advertises ("no plaintext ever reaches the renderer") is
   * enforced HERE rather than assumed of main.
   *
   * Mutation check: drop the `.slice(-4)` in `readStatus` and this fails.
   */
  it('truncates last4 at the boundary, so an over-long value cannot reach the renderer', async () => {
    const secret = 'sk-ant-oat01-full-secret-value'
    const { bridge } = makeBridge(async () => ({
      status: {
        mode: 'subscription',
        apiKey: UNSET,
        subscription: { configured: true, last4: secret },
      },
    }))
    const status = await bridge.getAuthStatus()
    expect(status.subscription.last4).toBe('alue')
    expect(JSON.stringify(status)).not.toContain(secret)
  })

  /**
   * Fails CLOSED, unlike the slot narrowing: a missing or malformed endpoint warns rather than
   * silently claiming the default. For a field whose whole purpose is to warn, silence is the
   * dangerous default.
   */
  it('warns when main sends no endpoint at all', async () => {
    const { bridge } = makeBridge(async () => ({
      status: { mode: 'not-configured', apiKey: UNSET, subscription: UNSET },
    }))
    expect((await bridge.getAuthStatus()).endpoint).toEqual({
      custom: true,
      host: null,
      transport: 'network',
    })
  })

  it('carries the socket transport through so the UI can name it', async () => {
    const { bridge } = makeBridge(async () => ({
      status: {
        mode: 'not-configured',
        apiKey: UNSET,
        subscription: UNSET,
        endpoint: { custom: true, host: null, transport: 'unix-socket' },
      },
    }))
    expect((await bridge.getAuthStatus()).endpoint.transport).toBe('unix-socket')
  })

  it('carries a custom endpoint through, and never a non-string host', async () => {
    const { bridge } = makeBridge(async () => ({
      status: {
        mode: 'not-configured',
        apiKey: UNSET,
        subscription: UNSET,
        endpoint: { custom: true, host: { evil: true } },
      },
    }))
    expect((await bridge.getAuthStatus()).endpoint).toEqual({
      custom: true,
      host: null,
      transport: 'network',
    })
  })
})
