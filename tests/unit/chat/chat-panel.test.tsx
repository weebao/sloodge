/**
 * @vitest-environment happy-dom
 *
 * The live chat panel driven by a fake agent bridge — no real IPC, no API call. The pure transcript
 * logic is proven in `transcript.test.ts`; this covers the component wiring: compose+send calls the
 * bridge, Enter vs Shift+Enter, Stop interrupts, chips + errors render, the unauthenticated gate, and
 * the disabled-while-streaming composer.
 */

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChatPanel } from '../../../src/renderer/src/features/chat/ChatPanel'
import { useAuthStore } from '../../../src/renderer/src/stores/authStore'
import type { AgentBridge } from '../../../src/preload/agentBridge'
import type { AgentEvent, ApiKeyStatus } from '../../../src/shared/agent/types'
import type { AuthStatus } from '../../../src/shared/agent/auth'
import { DEFAULT_ENDPOINT } from '../../../src/shared/agent/endpoint'

type Emit = (event: AgentEvent) => void

const KEY_SET: ApiKeyStatus = { configured: true, last4: 'aXY9' }
const KEY_UNSET: ApiKeyStatus = { configured: false, last4: null }

/** Configured through the API-key slot — the composer is open. */
const CONFIGURED: AuthStatus = {
  mode: 'api-key',
  apiKey: KEY_SET,
  subscription: KEY_UNSET,
  endpoint: DEFAULT_ENDPOINT,
}
/** Neither vault slot filled — the composer is gated behind the Settings link. */
const NO_AUTH: AuthStatus = {
  mode: 'not-configured',
  apiKey: KEY_UNSET,
  subscription: KEY_UNSET,
  endpoint: DEFAULT_ENDPOINT,
}

function makeFakeBridge(status: AuthStatus): {
  bridge: AgentBridge
  emit: Emit
  sendMessage: ReturnType<typeof vi.fn>
  interrupt: ReturnType<typeof vi.fn>
  getAuthStatus: ReturnType<typeof vi.fn>
} {
  const listeners = new Set<(e: AgentEvent) => void>()
  const sendMessage = vi.fn(async () => ({ accepted: true, reason: null }))
  const interrupt = vi.fn(async () => true)
  const getAuthStatus = vi.fn(async () => status)
  const bridge: AgentBridge = {
    setApiKey: vi.fn(async () => KEY_SET),
    clearApiKey: vi.fn(async () => KEY_UNSET),
    getApiKeyStatus: vi.fn(async () => status.apiKey),
    setSubscriptionToken: vi.fn(async () => status),
    clearSubscriptionToken: vi.fn(async () => status),
    getAuthStatus,
    sendMessage,
    interrupt,
    onAgentEvent: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    onDeckUpdated: () => () => undefined,
    onAgentEditRequest: () => () => undefined,
    sendAgentEditResult: () => undefined,
    getBudgetCap: vi.fn(async () => 2),
    setBudgetCap: vi.fn(async (cap: number | null) => cap),
  }
  const emit: Emit = (event) => {
    act(() => {
      for (const listener of listeners) listener(event)
    })
  }
  return { bridge, emit, sendMessage, interrupt, getAuthStatus }
}

beforeEach(() => {
  // `useAuthStore` is a module-level singleton (M2.7): without this, a case that ends up configured
  // leaves the next one's composer ungated and the gate tests pass or fail by file order.
  act(() => useAuthStore.getState().reset())
})

afterEach(() => {
  cleanup()
  act(() => useAuthStore.getState().reset())
  delete window.sloodge
  vi.restoreAllMocks()
})

const composer = (): HTMLTextAreaElement =>
  screen.getByPlaceholderText('Ask Claude…') as HTMLTextAreaElement

describe('ChatPanel — no bridge (browser host)', () => {
  it('renders an editable composer with an inert Send and no auth gate', () => {
    render(<ChatPanel />)
    expect(composer().disabled).toBe(false)
    expect(screen.getByRole('button', { name: /send/i }).getAttribute('aria-disabled')).toBe('true')
    expect(screen.queryByText(/set up authentication/i)).toBeNull()
    // The reason is on screen, not only in the button's tooltip — Enter is inert here too.
    expect(screen.getByText(/chat is unavailable in this window/i)).toBeTruthy()
    fireEvent.change(composer(), { target: { value: 'hello' } })
    fireEvent.keyDown(composer(), { key: 'Enter' })
    expect(composer().value).toBe('hello')
  })
})

describe('ChatPanel — no credential configured', () => {
  beforeEach(() => {
    window.sloodge = { onMenuAction: () => () => undefined, agent: makeFakeBridge(NO_AUTH).bridge }
  })

  it('shows the Set up authentication affordance and disables the composer', async () => {
    render(<ChatPanel />)
    expect(await screen.findByText(/set up authentication/i)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Open Settings' })).toBeTruthy()
    expect(composer().disabled).toBe(true)
  })

  it('the gate hands off to Settings instead of taking a credential inline', async () => {
    // M2.7 moved credential entry into Settings ▸ Auth so there is exactly one place a secret is
    // typed. The gate must therefore *only* be a link — no field, no save, no second masking rule.
    const onOpenAuthSettings = vi.fn()
    render(<ChatPanel onOpenAuthSettings={onOpenAuthSettings} />)

    fireEvent.click(await screen.findByRole('button', { name: 'Open Settings' }))

    expect(onOpenAuthSettings).toHaveBeenCalledTimes(1)
    expect(screen.queryByLabelText(/api key/i)).toBeNull()
  })

  it('a credential stored from Settings clears the gate and enables the composer', async () => {
    window.sloodge = { onMenuAction: () => () => undefined, agent: makeFakeBridge(NO_AUTH).bridge }
    render(<ChatPanel />)
    await screen.findByText(/set up authentication/i)
    expect(composer().disabled).toBe(true)

    // The Settings dialog lives in a different subtree and publishes through the shared store; the
    // composer has to follow it, which is the whole reason the status left local component state.
    act(() => {
      useAuthStore.setState({ status: CONFIGURED, loaded: true })
    })

    await waitFor(() => expect(composer().disabled).toBe(false))
    expect(screen.queryByText(/set up authentication/i)).toBeNull()
  })
})

describe('ChatPanel — sending', () => {
  let fake: ReturnType<typeof makeFakeBridge>

  beforeEach(async () => {
    fake = makeFakeBridge(CONFIGURED)
    window.sloodge = { onMenuAction: () => () => undefined, agent: fake.bridge }
    render(<ChatPanel />)
    await waitFor(() => expect(composer().disabled).toBe(false))
  })

  it('sends the composed text and shows a user bubble', async () => {
    fireEvent.change(composer(), { target: { value: 'make a title slide' } })
    fireEvent.click(screen.getByRole('button', { name: /send/i }))

    await waitFor(() => expect(fake.sendMessage).toHaveBeenCalledWith('make a title slide'))
    expect(screen.getByText('make a title slide')).toBeTruthy()
    // Composer clears and disables while the turn streams.
    expect(composer().value).toBe('')
    expect(composer().disabled).toBe(true)
  })

  it('Enter sends, Shift+Enter does not', () => {
    fireEvent.change(composer(), { target: { value: 'first' } })
    fireEvent.keyDown(composer(), { key: 'Enter', shiftKey: true })
    expect(fake.sendMessage).not.toHaveBeenCalled()

    fireEvent.keyDown(composer(), { key: 'Enter' })
    expect(fake.sendMessage).toHaveBeenCalledWith('first')
  })

  it('does not send empty/whitespace text', () => {
    fireEvent.change(composer(), { target: { value: '   ' } })
    fireEvent.keyDown(composer(), { key: 'Enter' })
    expect(fake.sendMessage).not.toHaveBeenCalled()
  })
})

describe('ChatPanel — streaming transcript', () => {
  let fake: ReturnType<typeof makeFakeBridge>

  beforeEach(async () => {
    fake = makeFakeBridge(CONFIGURED)
    window.sloodge = { onMenuAction: () => () => undefined, agent: fake.bridge }
    render(<ChatPanel />)
    await waitFor(() => expect(composer().disabled).toBe(false))
    fireEvent.change(composer(), { target: { value: 'build it' } })
    fireEvent.click(screen.getByRole('button', { name: /send/i }))
  })

  it('shows Stop while streaming and interrupts on click', () => {
    const stop = screen.getByRole('button', { name: /stop/i })
    fireEvent.click(stop)
    expect(fake.interrupt).toHaveBeenCalled()
    // Send returns once the turn is no longer streaming.
    expect(screen.getByRole('button', { name: /send/i })).toBeTruthy()
  })

  it('streams assistant deltas and renders tool-call chips inline', () => {
    fake.emit({ type: 'assistant-delta', text: 'Creating the title slide' })
    fake.emit({ type: 'tool-use', toolUseId: 't1', label: 'create slide' })

    const log = screen.getByRole('log', { name: 'Conversation' })
    expect(within(log).getByText('Creating the title slide')).toBeTruthy()
    expect(within(log).getByText(/New slide/)).toBeTruthy()
  })

  it('surfaces a typed error as a chat bubble', () => {
    fake.emit({ type: 'error', kind: 'auth', message: '401', recoverable: false })
    expect(screen.getByRole('alert').textContent).toMatch(/authentication failed/i)
  })

  it('shows a visible, non-alarming notice when the bundled skills did not load', () => {
    fake.emit({ type: 'skills-degraded', missing: ['svg-animation', 'interactive-graph'] })

    const notice = screen.getByRole('status')
    expect(notice.textContent).toMatch(/svg-animation/)
    expect(notice.textContent).toMatch(/interactive-graph/)
    // Degraded, not failed: it must not render as an error, and the turn keeps streaming.
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByRole('button', { name: /stop/i })).toBeTruthy()
  })

  it('renders "(no response)" for a turn that produced no text or tools', () => {
    fake.emit({ type: 'turn-end', snapshotUsd: 0, generation: 0, subtype: 'success' })
    const log = screen.getByRole('log', { name: 'Conversation' })
    expect(within(log).getByText('(no response)')).toBeTruthy()
  })
})

describe('ChatPanel — a pre-stream send rejection', () => {
  it('surfaces an error bubble and leaves the turn settled, not stuck streaming', async () => {
    const fake = makeFakeBridge(CONFIGURED)
    // agent:send rejects before any stream begins (e.g. a keychain read fault) — session.consume()
    // never sees it, so the hook's own catch is the only thing that can settle the turn.
    const rejecting = vi.fn(async () => {
      throw new Error("Error invoking remote method 'agent:send': keychain is locked")
    })
    fake.bridge.sendMessage = rejecting
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {})
    window.sloodge = { onMenuAction: () => () => undefined, agent: fake.bridge }
    render(<ChatPanel />)
    await waitFor(() => expect(composer().disabled).toBe(false))

    fireEvent.change(composer(), { target: { value: 'build it' } })
    fireEvent.click(screen.getByRole('button', { name: /send/i }))

    // The reject is mapped to a visible bubble with calibrated copy — the raw IPC text (channel
    // names, main-process stack) goes to the console, not the chat…
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toMatch(/the agent turn failed/i)
    expect(alert.textContent).not.toMatch(/agent:send|keychain/i)
    expect(quiet).toHaveBeenCalled()
    // …and the composer is usable again (not wedged behind a Stop button).
    await waitFor(() => expect(composer().disabled).toBe(false))
    expect(screen.getByRole('button', { name: /send/i })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /stop/i })).toBeNull()
  })
})
