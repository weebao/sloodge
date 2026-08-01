import { describe, expect, it, vi } from 'vitest'
import { createAgentBridge } from '../../../src/preload/agentBridge'
import {
  AGENT_CLEAR_KEY_CHANNEL,
  AGENT_EVENT_CHANNEL,
  AGENT_INTERRUPT_CHANNEL,
  AGENT_KEY_STATUS_CHANNEL,
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
  it('sendMessage returns the accepted flag', async () => {
    const { bridge, invoke } = makeBridge(async () => ({ accepted: false }))
    expect(await bridge.sendMessage('hi')).toBe(false)
    expect(invoke).toHaveBeenCalledWith(AGENT_SEND_CHANNEL, { text: 'hi' })
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
