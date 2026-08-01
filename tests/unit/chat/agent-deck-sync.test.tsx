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
import { createStarterDeck, useDeckStore } from '../../../src/renderer/src/stores/deckStore'
import { addSlide, createEmptyDeck, createSlideEntry } from '../../../src/shared/document/deck'
import { createStarterSlideHtml } from '../../../src/shared/document/starter-slide'
import type { DeckUpdate } from '../../../src/shared/document/deck-update'
import type { AgentBridge } from '../../../src/preload/agentBridge'

const NOW = 1_781_000_000_000

let deckListener: ((u: DeckUpdate) => void) | null = null

function fakeAgentBridge(): AgentBridge {
  return {
    setApiKey: vi.fn(async () => ({ configured: true, last4: 'aXY9' })),
    clearApiKey: vi.fn(async () => ({ configured: false, last4: null })),
    getApiKeyStatus: vi.fn(async () => ({ configured: true, last4: 'aXY9' })),
    sendMessage: vi.fn(async () => true),
    interrupt: vi.fn(async () => true),
    onAgentEvent: () => () => undefined,
    onDeckUpdated: (listener) => {
      deckListener = listener
      return () => {
        deckListener = null
      }
    },
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

beforeEach(() => {
  useDeckStore.setState(createStarterDeck(NOW))
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
})
