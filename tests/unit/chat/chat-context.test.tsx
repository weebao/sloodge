/**
 * @vitest-environment happy-dom
 *
 * The `[⊕ctx]` element-context chip in the composer (M3.4) — attach, display, remove, and "send
 * includes the context". The chip is fed by `chatContextStore` (which the property panel's "Ask
 * Claude about this element" writes); this test drives that store directly with a real bundle built
 * from a real `SlideMap`, then asserts the composer renders the chip, removing it clears the context,
 * and sending a turn passes the *composed* message (user text + serialized context) to the bridge
 * while the transcript shows the plain text.
 */

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChatPanel } from '../../../src/renderer/src/features/chat/ChatPanel'
import { useChatContextStore } from '../../../src/renderer/src/features/chat/chatContextStore'
import type { AgentBridge } from '../../../src/preload/agentBridge'
import type { ApiKeyStatus } from '../../../src/shared/agent/types'
import { buildSlideMap } from '../../../src/shared/design/slide-map'
import {
  buildElementContextBundle,
  type ElementContextBundle,
} from '../../../src/shared/design/element-context'

const CONFIGURED: ApiKeyStatus = { configured: true, last4: 'aXY9' }

function makeFakeBridge(): { bridge: AgentBridge; sendMessage: ReturnType<typeof vi.fn> } {
  const sendMessage = vi.fn(async () => true)
  const bridge: AgentBridge = {
    setApiKey: vi.fn(async () => CONFIGURED),
    clearApiKey: vi.fn(async () => ({ configured: false, last4: null })),
    getApiKeyStatus: vi.fn(async () => CONFIGURED),
    sendMessage,
    interrupt: vi.fn(async () => true),
    onAgentEvent: () => () => undefined,
    onDeckUpdated: () => () => undefined,
  }
  return { bridge, sendMessage }
}

const HTML =
  '<section class="slide"><div class="card"><h3 class="card-title">Q3 Revenue</h3></div></section>'

function h3Bundle(): ElementContextBundle {
  const map = buildSlideMap('s04', HTML)
  let slId = ''
  for (const [id, span] of map.byId) if (span.tagName === 'h3') slId = id
  const bundle = buildElementContextBundle({
    map,
    slId,
    slide: { index: 3, title: 'Q3 Revenue' },
    computedStyles: { color: '#0f172a', 'font-size': '44px' },
    rect: { x: 10, y: 20, width: 320, height: 84 },
  })
  if (bundle === null) throw new Error('bundle build failed')
  return bundle
}

const composer = (): HTMLTextAreaElement =>
  screen.getByPlaceholderText('Ask Claude…') as HTMLTextAreaElement

function attach(bundle: ElementContextBundle): void {
  act(() => useChatContextStore.getState().attach(bundle))
}

beforeEach(() => {
  act(() => useChatContextStore.getState().clear())
})

afterEach(() => {
  cleanup()
  act(() => useChatContextStore.getState().clear())
  delete window.sloodge
  vi.restoreAllMocks()
})

describe('ChatPanel — element-context chip', () => {
  let fake: ReturnType<typeof makeFakeBridge>

  beforeEach(async () => {
    fake = makeFakeBridge()
    window.sloodge = { onMenuAction: () => () => undefined, agent: fake.bridge }
    render(<ChatPanel />)
    await waitFor(() => expect(composer().disabled).toBe(false))
  })

  it('shows the inert "no context" pill until an element is attached', () => {
    expect(screen.getByTestId('chat-context-empty')).toBeTruthy()
    expect(screen.queryByTestId('chat-context-chip')).toBeNull()
  })

  it('renders the element label chip once a bundle is attached', () => {
    attach(h3Bundle())
    const chip = screen.getByTestId('chat-context-chip')
    expect(chip.textContent).toContain('◇ h3.card-title')
    expect(screen.queryByTestId('chat-context-empty')).toBeNull()
  })

  it('the chip is removable — the × button clears the context', () => {
    attach(h3Bundle())
    fireEvent.click(screen.getByTestId('chat-context-remove'))
    expect(screen.queryByTestId('chat-context-chip')).toBeNull()
    expect(screen.getByTestId('chat-context-empty')).toBeTruthy()
    expect(useChatContextStore.getState().attachment).toBeNull()
  })

  it('SEND INCLUDES CONTEXT: the bridge gets user text + serialized bundle; transcript shows text', async () => {
    attach(h3Bundle())
    fireEvent.change(composer(), { target: { value: 'make this pop' } })
    fireEvent.click(screen.getByRole('button', { name: /send/i }))

    await waitFor(() => expect(fake.sendMessage).toHaveBeenCalledTimes(1))
    const sent = fake.sendMessage.mock.calls[0]?.[0] as string
    // The agent-bound message carries the user's words AND the element context (HTML + styles + path).
    expect(sent.startsWith('make this pop')).toBe(true)
    expect(sent).toContain('<h3 class="card-title">Q3 Revenue</h3>')
    expect(sent).toContain('section.slide > div.card > h3.card-title')
    expect(sent).toContain('color: #0f172a')
    // The transcript bubble shows only the plain text, not the context blob.
    const bubble = screen.getByText('make this pop')
    expect(bubble.textContent).toBe('make this pop')
    // The chip is consumed after the send.
    expect(screen.queryByTestId('chat-context-chip')).toBeNull()
  })

  it('sends plain text (identity) when no context is attached', async () => {
    fireEvent.change(composer(), { target: { value: 'just text' } })
    fireEvent.click(screen.getByRole('button', { name: /send/i }))
    await waitFor(() => expect(fake.sendMessage).toHaveBeenCalledWith('just text'))
  })
})
