/**
 * @vitest-environment happy-dom
 *
 * The deck hot-update seam end to end through the shell: a `deck:updated` push from the agent bridge
 * is adopted into the deck store, and the canvas + rail + status bar re-render from it — proving the
 * push flows into the same store the UI renders from (M2.3 scope point 2), without a live agent.
 */

import { act, cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AppShell } from '../../../src/renderer/src/app/AppShell'
import { useDesignStore } from '../../../src/renderer/src/features/design/designStore'
import {
  createStarterDeck,
  getSlideHtml,
  useDeckStore,
} from '../../../src/renderer/src/stores/deckStore'
import { useAuthStore } from '../../../src/renderer/src/stores/authStore'
import { addSlide, createEmptyDeck, createSlideEntry } from '../../../src/shared/document/deck'
import { createStarterSlideHtml } from '../../../src/shared/document/starter-slide'
import type { DeckUpdate } from '../../../src/shared/document/deck-update'
import type { AgentBridge } from '../../../src/preload/agentBridge'
import type { AuthStatus } from '../../../src/shared/agent/auth'
import { DEFAULT_ENDPOINT } from '../../../src/shared/agent/endpoint'

const NOW = 1_781_000_000_000

/** A configured, masked auth status — the shell's chat panel must not sit behind the gate here. */
const AUTHED: AuthStatus = {
  mode: 'api-key',
  apiKey: { configured: true, last4: 'aXY9' },
  subscription: { configured: false, last4: null },
  endpoint: DEFAULT_ENDPOINT,
}

let deckListener: ((u: DeckUpdate) => void) | null = null

function fakeAgentBridge(): AgentBridge {
  return {
    setApiKey: vi.fn(async () => ({ configured: true, last4: 'aXY9' })),
    clearApiKey: vi.fn(async () => ({ configured: false, last4: null })),
    getApiKeyStatus: vi.fn(async () => ({ configured: true, last4: 'aXY9' })),
    setSubscriptionToken: vi.fn(async () => AUTHED),
    clearSubscriptionToken: vi.fn(async () => AUTHED),
    getAuthStatus: vi.fn(async () => AUTHED),
    sendMessage: vi.fn(async () => ({ accepted: true, reason: null })),
    interrupt: vi.fn(async () => true),
    getBudgetCap: vi.fn(async () => 2),
    setBudgetCap: vi.fn(async (cap: number | null) => cap),
    onAgentEvent: () => () => undefined,
    onDeckUpdated: (listener) => {
      deckListener = listener
      return () => {
        deckListener = null
      }
    },
    onAgentEditRequest: () => () => undefined,
    sendAgentEditResult: () => undefined,
  }
}

/** A five-slide snapshot standing in for a deck the agent just generated. */
function fiveSlideSnapshot(): DeckUpdate {
  let deck = createEmptyDeck({ now: NOW, title: 'Agent Deck' })
  const slides: Record<string, string> = {}
  for (let i = 1; i <= 5; i += 1) {
    const entry = createSlideEntry({
      now: NOW,
      title: `Generated ${String(i)}`,
      kind: 'content',
      origin: { type: 'template' },
    })
    deck = addSlide(deck, entry)
    slides[entry.id] = createStarterSlideHtml({ id: entry.id, title: `Generated ${String(i)}` })
  }
  return { manifest: deck, slides, notes: {}, theme: null }
}

/** A snapshot of the *current* deck with one slide's bytes rewritten — the agent-edit shape. */
function rewrittenCurrentSlide(): DeckUpdate {
  const state = useDeckStore.getState()
  const slides: Record<string, string> = {}
  for (const id of state.deck.slideOrder) {
    slides[id] = getSlideHtml(state.slideHtml, id) ?? ''
  }
  const first = state.deck.slideOrder[0]!
  slides[first] = (slides[first] ?? '').replace('<h1', '<h2 data-x="1"><span>agent</span></h2><h1')
  return { manifest: state.deck, slides, notes: {}, theme: null }
}

beforeEach(() => {
  useDeckStore.setState(createStarterDeck(NOW))
  useDesignStore.setState({
    enabled: true,
    hover: null,
    selections: [],
    selection: null,
    editing: null,
  })
  // `useAuthStore` is a module-level singleton (M2.7), so a status left behind by a previous case
  // would leak into the next one and make these order-dependent.
  useAuthStore.getState().reset()
  deckListener = null
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('about:blank')
  vi.spyOn(URL, 'revokeObjectURL').mockReturnValue(undefined)
  window.sloodge = { onMenuAction: () => () => undefined, agent: fakeAgentBridge() }
})

afterEach(() => {
  cleanup()
  delete window.sloodge
  vi.restoreAllMocks()
})

describe('AppShell — agent deck hot-update', () => {
  it('subscribes to deck:updated and adopts the pushed snapshot into the UI', () => {
    render(<AppShell />)
    // Boot deck: 3 slides.
    expect(screen.getByRole('contentinfo', { name: 'Status bar' }).textContent).toContain(
      'Slide 1 of 3',
    )
    expect(deckListener).not.toBeNull()

    act(() => {
      deckListener?.(fiveSlideSnapshot())
    })

    // The status bar, rail and canvas all now reflect the agent's 5-slide deck.
    expect(screen.getByRole('contentinfo', { name: 'Status bar' }).textContent).toContain(
      'Slide 1 of 5',
    )
    const rail = screen.getByRole('navigation', { name: 'Slides' })
    // 5 slide thumbnails + the "New" button.
    expect(within(rail).getAllByRole('button')).toHaveLength(6)
    expect(useDeckStore.getState().deck.slideOrder).toHaveLength(5)
  })

  /**
   * Round-3 major 3. A `data-sl-id` is positional, so after the agent restructures a slide the id the
   * user had selected names a different element — or nothing — while the overlay keeps painting the
   * box at the old geometry and swallowing the clicks under it. The snapshot here keeps the same
   * slide ids on purpose: the selection must be dropped by the *remote replacement*, not as a side
   * effect of the current slide changing.
   */
  it('drops the design selection when a remote snapshot replaces the deck', () => {
    render(<AppShell />)
    const slideId = useDeckStore.getState().deck.slideOrder[0]!
    act(() => {
      useDesignStore.getState().setSelection({
        slId: `${slideId}:3`,
        tag: 'h1',
        id: null,
        classes: ['title'],
        rect: { x: 48, y: 48, width: 1184, height: 55 },
        ancestors: [],
      })
    })
    expect(useDesignStore.getState().selection).not.toBeNull()

    const snapshot = rewrittenCurrentSlide()
    act(() => {
      deckListener?.(snapshot)
    })

    expect(useDeckStore.getState().currentSlideId).toBe(slideId)
    expect(useDesignStore.getState().selection).toBeNull()
    expect(useDesignStore.getState().selections).toEqual([])
    expect(useDesignStore.getState().editing).toBeNull()
  })

  it('keeps the selection when a malformed push is rejected', () => {
    render(<AppShell />)
    const hit = {
      slId: 'x:1',
      tag: 'h1',
      id: null,
      classes: [],
      rect: { x: 0, y: 0, width: 10, height: 10 },
      ancestors: [],
    }
    act(() => {
      useDesignStore.getState().setSelection(hit)
    })

    act(() => {
      deckListener?.({ manifest: {}, slides: {}, notes: {}, theme: null } as unknown as DeckUpdate)
    })

    expect(useDesignStore.getState().selection?.slId).toBe('x:1')
  })
})
