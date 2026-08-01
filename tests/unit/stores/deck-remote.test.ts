import { beforeEach, describe, expect, it } from 'vitest'
import type { DeckUpdate } from '../../../src/shared/document/deck-update'
import {
  createStarterDeck,
  getSlideHtml,
  useDeckStore,
} from '../../../src/renderer/src/stores/deckStore'

const NOW = 1_780_000_000_000

beforeEach(() => {
  useDeckStore.setState(createStarterDeck(NOW))
})

/** A serializable snapshot built from a freshly-created deck (a stand-in for an agent push). */
function snapshotOf(now: number): DeckUpdate {
  const doc = createStarterDeck(now).history.doc
  return { manifest: doc.manifest, slides: doc.slides, notes: doc.notes, theme: doc.theme }
}

describe('deckStore.applyRemoteDeck', () => {
  it('adopts a pushed deck snapshot into the canvas/rail state', () => {
    const incoming = snapshotOf(NOW + 1)
    expect(useDeckStore.getState().applyRemoteDeck(incoming)).toBe(true)

    const state = useDeckStore.getState()
    expect(state.deck.slideOrder).toEqual(incoming.manifest.slideOrder)
    // The store now renders the pushed bytes.
    const firstId = incoming.manifest.slideOrder[0]!
    expect(getSlideHtml(state.slideHtml, firstId)).toBe(incoming.slides[firstId])
  })

  it('selects the first slide of the adopted deck when the prior selection is gone', () => {
    const incoming = snapshotOf(NOW + 2)
    useDeckStore.getState().applyRemoteDeck(incoming)
    expect(useDeckStore.getState().currentSlideId).toBe(incoming.manifest.slideOrder[0])
  })

  it('adopting a snapshot clears the undo/redo history (a doc-open, not a command)', () => {
    // Make a local edit so there is something on the undo stack first.
    const id = useDeckStore.getState().currentSlideId!
    useDeckStore.getState().setSlideHtml(id, '<div class="slide">edited</div>', id, 'edit')
    expect(useDeckStore.getState().canUndo).toBe(true)

    useDeckStore.getState().applyRemoteDeck(snapshotOf(NOW + 3))
    expect(useDeckStore.getState().canUndo).toBe(false)
    expect(useDeckStore.getState().canRedo).toBe(false)
  })

  it('is a no-op that returns false for a malformed manifest, leaving the deck intact', () => {
    const before = useDeckStore.getState().deck
    const bad = {
      manifest: { id: '' },
      slides: {},
      notes: {},
      theme: null,
    } as unknown as DeckUpdate
    expect(useDeckStore.getState().applyRemoteDeck(bad)).toBe(false)
    expect(useDeckStore.getState().deck).toBe(before)
  })

  it('keeps a surviving selection when the adopted deck still contains it', () => {
    // Adopt the *current* deck's own snapshot (same ids), with the selection on slide 2.
    const current = useDeckStore.getState()
    current.selectSlideAt(1)
    const selected = useDeckStore.getState().currentSlideId
    const doc = current.history.doc
    const same: DeckUpdate = {
      manifest: doc.manifest,
      slides: doc.slides,
      notes: doc.notes,
      theme: doc.theme,
    }
    useDeckStore.getState().applyRemoteDeck(same)
    expect(useDeckStore.getState().currentSlideId).toBe(selected)
  })
})
