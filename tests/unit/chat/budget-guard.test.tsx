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

  it('a MAIN refusal leaves no phantom open turn — the two ledgers must not drift', async () => {
    // The renderer opens its turn optimistically so the bubble appears instantly, but main decides
    // whether it runs. When main says no it never opened a matching turn, so without a rollback the
    // renderer stays one ahead forever and a later stray result folds into a turn that never was —
    // the same class of drift the shared accumulator exists to prevent.
    const fake = makeFakeBridge(null, { accepted: false, reason: 'budget' })
    window.sloodge = { onMenuAction: () => () => undefined, agent: fake.bridge }
    render(<ChatPanel />)
    await waitFor(() => expect(composer().disabled).toBe(false))

    send('hello')
    await screen.findByText(/budget reached for this session/i)

    // A stray result now must not fold: no turn is open.
    fake.emit({ type: 'turn-end', costUsd: 5, subtype: 'success' })
    await waitFor(() => expect(useSessionMeterStore.getState().costUsd).toBe(0))
  })

  it('a MAIN refusal keeps the draft in the composer and takes the bubble back', async () => {
    // `send` is awaited, so the draft is cleared only for a turn genuinely on its way. Clearing
    // optimistically is how a main-refused message used to disappear with nothing sent.
    const fake = makeFakeBridge(null, { accepted: false, reason: 'budget' })
    window.sloodge = { onMenuAction: () => () => undefined, agent: fake.bridge }
    render(<ChatPanel />)
    await waitFor(() => expect(composer().disabled).toBe(false))

    send('a message worth keeping')
    await screen.findByText(/budget reached for this session/i)

    expect(composer().value).toBe('a message worth keeping')
    // And it is not *also* sitting in the transcript looking as though it was sent.
    expect(screen.queryByText('a message worth keeping', { selector: 'p' })).toBeNull()
  })

  it('keeps the draft when main refuses for a missing credential too', async () => {
    const fake = makeFakeBridge(null, { accepted: false, reason: 'no-credential' })
    window.sloodge = { onMenuAction: () => () => undefined, agent: fake.bridge }
    render(<ChatPanel />)
    await waitFor(() => expect(composer().disabled).toBe(false))

    send('still mine')
    await screen.findByText(/authentication failed/i)
    expect(composer().value).toBe('still mine')
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

  it('names the cap in the refusal so the number the user is arguing with is on screen', async () => {
    const fake = makeFakeBridge(0.1)
    window.sloodge = { onMenuAction: () => () => undefined, agent: fake.bridge }
    render(<ChatPanel />)
    await waitFor(() => expect(useBudgetStore.getState().loaded).toBe(true))

    send('first')
    await waitFor(() => expect(fake.sendMessage).toHaveBeenCalledTimes(1))
    fake.emit({ type: 'turn-end', costUsd: 0.15, subtype: 'success' })

    send('blocked')
    expect((await screen.findByText(/budget reached for this session/i)).textContent).toContain(
      '$0.10',
    )
  })

  it('leaves the composer usable when the SDK stops the turn on its own ceiling', async () => {
    // The other half of the budget stop: `error_max_budget_usd` maps to [turn-end, error], so the
    // turn settles instead of stranding the composer in `streaming` forever. And the SDK's error —
    // which knows only a subtype — must render as the calibrated sentence, never "Turn ended:
    // error_max_budget_usd".
    const fake = makeFakeBridge(2)
    window.sloodge = { onMenuAction: () => () => undefined, agent: fake.bridge }
    render(<ChatPanel />)
    await waitFor(() => expect(composer().disabled).toBe(false))

    send('expensive')
    await waitFor(() => expect(fake.sendMessage).toHaveBeenCalledTimes(1))
    fake.emit({ type: 'turn-end', costUsd: 2.4, subtype: 'error_max_budget_usd' })
    fake.emit({ type: 'error', kind: 'budget', message: '', recoverable: true })

    await screen.findByText(/budget reached for this session/i)
    expect(screen.queryByText(/Turn ended/i)).toBeNull()
    // Not wedged in `streaming`: the composer is editable again.
    await waitFor(() => expect(composer().disabled).toBe(false))
  })

  it('a REJECTED send invoke rolls the optimistic turn back and shows calibrated copy, not the IPC text', async () => {
    // Main opens its turn in `session.send`, the last statement of `AgentService.send` after every
    // await, so an invoke that rejected never opened one. Round 3 skipped the rollback on the false
    // premise that it might have — leaving the renderer a phantom turn ahead for the session's life.
    const fake = makeFakeBridge(2)
    fake.bridge.sendMessage = vi.fn(async () => {
      throw new Error("Error invoking remote method 'agent:send': Error: keychain unavailable")
    })
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {})
    window.sloodge = { onMenuAction: () => () => undefined, agent: fake.bridge }
    render(<ChatPanel />)
    await waitFor(() => expect(composer().disabled).toBe(false))

    send('hello there')
    await screen.findByText(/the agent turn failed/i)
    // The raw IPC string stays in the console.
    expect(screen.queryByText(/agent:send|keychain/i)).toBeNull()
    expect(quiet).toHaveBeenCalled()
    // The pair is gone, the draft is back, and no phantom turn is open: a stray result folds nothing.
    expect(screen.queryByText('hello there', { selector: 'p' })).toBeNull()
    expect(composer().value).toBe('hello there')
    fake.emit({ type: 'turn-end', costUsd: 5, subtype: 'success' })
    await waitFor(() => expect(useSessionMeterStore.getState().costUsd).toBe(0))
    expect(composer().disabled).toBe(false)
  })

  it('an accept landing after Stop does not wipe what the user typed in between', async () => {
    // Stop re-enables the composer while `sendMessage` is still in flight. The accept must clear
    // only the text it sent, or the next message vanishes as it is being written.
    const fake = makeFakeBridge(2)
    let resolveSend: ((result: SendResult) => void) | null = null
    fake.bridge.sendMessage = vi.fn(
      () =>
        new Promise<SendResult>((resolve) => {
          resolveSend = resolve
        }),
    )
    window.sloodge = { onMenuAction: () => () => undefined, agent: fake.bridge }
    render(<ChatPanel />)
    await waitFor(() => expect(composer().disabled).toBe(false))

    send('first message')
    await waitFor(() => expect(resolveSend).not.toBeNull())
    fireEvent.click(screen.getByRole('button', { name: /stop/i }))
    await waitFor(() => expect(composer().disabled).toBe(false))
    fireEvent.change(composer(), { target: { value: 'typed after stop' } })

    act(() => resolveSend?.({ accepted: true, reason: null }))
    await waitFor(() => expect(fake.bridge.sendMessage).toHaveBeenCalledTimes(1))
    expect(composer().value).toBe('typed after stop')
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
