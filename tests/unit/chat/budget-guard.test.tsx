/**
 * @vitest-environment happy-dom
 *
 * The budget guard where the user meets it (M2.5, 50-agent-integration.md §10): the composer refuses
 * to start a new turn once the session has spent its cap.
 *
 * The state machine itself is proven in `agent/budget.test.ts`; this covers the wiring that makes it
 * bite — the cap is loaded from the bridge, the spend is the transcript's own accumulator, a blocked
 * send never reaches `sendMessage`, the user's words stay in the composer, and raising the cap
 * unblocks the very next send.
 */

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChatPanel } from '../../../src/renderer/src/features/chat/ChatPanel'
import { useAuthStore } from '../../../src/renderer/src/stores/authStore'
import { useBudgetStore } from '../../../src/renderer/src/stores/budgetStore'
import { useSessionMeterStore } from '../../../src/renderer/src/stores/sessionMeterStore'
import type { AgentBridge } from '../../../src/preload/agentBridge'
import type { AgentEvent, ApiKeyStatus } from '../../../src/shared/agent/types'
import type { AuthStatus } from '../../../src/shared/agent/auth'
import { DEFAULT_ENDPOINT } from '../../../src/shared/agent/endpoint'
import type { BudgetCap } from '../../../src/shared/agent/budget'

type Emit = (event: AgentEvent) => void

const KEY_SET: ApiKeyStatus = { configured: true, last4: 'aXY9' }
const KEY_UNSET: ApiKeyStatus = { configured: false, last4: null }
const CONFIGURED: AuthStatus = {
  mode: 'api-key',
  apiKey: KEY_SET,
  subscription: KEY_UNSET,
  endpoint: DEFAULT_ENDPOINT,
}

type SendResult = { accepted: boolean; reason: 'no-credential' | 'budget' | null }

function makeFakeBridge(
  cap: BudgetCap,
  sendResult: SendResult = { accepted: true, reason: null },
): {
  bridge: AgentBridge
  emit: Emit
  sendMessage: ReturnType<typeof vi.fn>
} {
  const listeners = new Set<(e: AgentEvent) => void>()
  const sendMessage = vi.fn(async () => sendResult)
  const bridge: AgentBridge = {
    setApiKey: vi.fn(async () => KEY_SET),
    clearApiKey: vi.fn(async () => KEY_UNSET),
    getApiKeyStatus: vi.fn(async () => KEY_SET),
    setSubscriptionToken: vi.fn(async () => CONFIGURED),
    clearSubscriptionToken: vi.fn(async () => CONFIGURED),
    getAuthStatus: vi.fn(async () => CONFIGURED),
    sendMessage,
    interrupt: vi.fn(async () => true),
    onAgentEvent: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    onDeckUpdated: () => () => undefined,
    onAgentEditRequest: () => () => undefined,
    sendAgentEditResult: () => undefined,
    getBudgetCap: vi.fn(async () => cap),
    setBudgetCap: vi.fn(async (next: BudgetCap) => next),
  }
  const emit: Emit = (event) => {
    act(() => {
      for (const listener of listeners) listener(event)
    })
  }
  return { bridge, emit, sendMessage }
}

const resetStores = (): void => {
  act(() => {
    useAuthStore.getState().reset()
    useBudgetStore.getState().reset()
    useSessionMeterStore.getState().reset()
  })
}

beforeEach(resetStores)

afterEach(() => {
  cleanup()
  resetStores()
  delete window.sloodge
  vi.restoreAllMocks()
})

const composer = (): HTMLTextAreaElement =>
  screen.getByPlaceholderText('Ask Claude…') as HTMLTextAreaElement

/** Type into the composer and press Send. */
function send(text: string): void {
  fireEvent.change(composer(), { target: { value: text } })
  fireEvent.click(screen.getByRole('button', { name: /send/i }))
}

describe('budget guard — the composer refuses a turn past the cap', () => {
  it('sends normally while under the cap', async () => {
    const fake = makeFakeBridge(2)
    window.sloodge = { onMenuAction: () => () => undefined, agent: fake.bridge }
    render(<ChatPanel />)
    await waitFor(() => expect(composer().disabled).toBe(false))

    send('make a title slide')
    await waitFor(() => expect(fake.sendMessage).toHaveBeenCalledWith('make a title slide'))
  })

  it('refuses the next turn once the session spend reaches the cap', async () => {
    const fake = makeFakeBridge(0.1)
    window.sloodge = { onMenuAction: () => () => undefined, agent: fake.bridge }
    render(<ChatPanel />)
    await waitFor(() => expect(useBudgetStore.getState().loaded).toBe(true))

    send('first')
    await waitFor(() => expect(fake.sendMessage).toHaveBeenCalledTimes(1))
    // The turn ends having spent past the cap. It is not interrupted — it already ran.
    fake.emit({ type: 'turn-end', costUsd: 0.15, subtype: 'success' })

    send('second')
    await screen.findByText(/budget reached for this session/i)
    // The refusal is *before* the turn opens: main is never asked.
    expect(fake.sendMessage).toHaveBeenCalledTimes(1)
  })

  it('keeps the refused words in the composer so the user can retry, not in the transcript', async () => {
    const fake = makeFakeBridge(0.1)
    window.sloodge = { onMenuAction: () => () => undefined, agent: fake.bridge }
    render(<ChatPanel />)
    await waitFor(() => expect(useBudgetStore.getState().loaded).toBe(true))

    send('first')
    await waitFor(() => expect(fake.sendMessage).toHaveBeenCalledTimes(1))
    fake.emit({ type: 'turn-end', costUsd: 0.2, subtype: 'success' })

    fireEvent.change(composer(), { target: { value: 'a message worth keeping' } })
    fireEvent.click(screen.getByRole('button', { name: /send/i }))

    await screen.findByText(/budget reached for this session/i)
    expect(composer().value).toBe('a message worth keeping')
  })

  it('unblocks the very next send when the cap is raised', async () => {
    const fake = makeFakeBridge(0.1)
    window.sloodge = { onMenuAction: () => () => undefined, agent: fake.bridge }
    render(<ChatPanel />)
    await waitFor(() => expect(useBudgetStore.getState().loaded).toBe(true))

    send('first')
    await waitFor(() => expect(fake.sendMessage).toHaveBeenCalledTimes(1))
    fake.emit({ type: 'turn-end', costUsd: 0.15, subtype: 'success' })

    send('blocked')
    await screen.findByText(/budget reached for this session/i)
    expect(fake.sendMessage).toHaveBeenCalledTimes(1)

    // Settings ▸ Budget raises the limit; the store is the renderer's mirror of main's value.
    act(() => useBudgetStore.getState().setCap(5))

    send('now allowed')
    await waitFor(() => expect(fake.sendMessage).toHaveBeenCalledWith('now allowed'))
  })

  it('never blocks when no cap is configured', async () => {
    const fake = makeFakeBridge(null)
    window.sloodge = { onMenuAction: () => () => undefined, agent: fake.bridge }
    render(<ChatPanel />)
    await waitFor(() => expect(useBudgetStore.getState().loaded).toBe(true))

    send('first')
    await waitFor(() => expect(fake.sendMessage).toHaveBeenCalledTimes(1))
    fake.emit({ type: 'turn-end', costUsd: 99, subtype: 'success' })

    send('second')
    await waitFor(() => expect(fake.sendMessage).toHaveBeenCalledTimes(2))
  })

  it('surfaces the budget refusal when MAIN blocks a turn the local guard allowed', async () => {
    // Main is authoritative — a stale local cap must not let a turn through, and its refusal must
    // not render as the auth gate (which is what a bare `accepted: false` used to do).
    const fake = makeFakeBridge(null, { accepted: false, reason: 'budget' })
    window.sloodge = { onMenuAction: () => () => undefined, agent: fake.bridge }
    render(<ChatPanel />)
    await waitFor(() => expect(composer().disabled).toBe(false))

    send('hello')
    await screen.findByText(/budget reached for this session/i)
    expect(screen.queryByText(/authentication failed/i)).toBeNull()
  })

  it('still renders the auth gate for a no-credential refusal', async () => {
    const fake = makeFakeBridge(null, { accepted: false, reason: 'no-credential' })
    window.sloodge = { onMenuAction: () => () => undefined, agent: fake.bridge }
    render(<ChatPanel />)
    await waitFor(() => expect(composer().disabled).toBe(false))

    send('hello')
    await screen.findByText(/authentication failed/i)
    expect(screen.queryByText(/budget reached/i)).toBeNull()
  })

  it('publishes the session cost to the status-bar store — one accumulator, two readers', async () => {
    const fake = makeFakeBridge(2)
    window.sloodge = { onMenuAction: () => () => undefined, agent: fake.bridge }
    render(<ChatPanel />)
    await waitFor(() => expect(composer().disabled).toBe(false))

    send('first')
    await waitFor(() => expect(fake.sendMessage).toHaveBeenCalledTimes(1))
    fake.emit({ type: 'turn-end', costUsd: 0.42, subtype: 'success' })

    await waitFor(() => expect(useSessionMeterStore.getState().costUsd).toBeCloseTo(0.42))
  })

  it('publishes the §8 skills status to the status-bar store', async () => {
    const fake = makeFakeBridge(2)
    window.sloodge = { onMenuAction: () => () => undefined, agent: fake.bridge }
    render(<ChatPanel />)
    await waitFor(() => expect(composer().disabled).toBe(false))

    fake.emit({ type: 'skills-status', status: 'fallback' })
    await waitFor(() => expect(useSessionMeterStore.getState().skills).toBe('fallback'))
    // A repaired session says nothing in chat — the status line is the whole notification.
    expect(screen.queryByText(/slide skills unavailable/i)).toBeNull()
  })
})
