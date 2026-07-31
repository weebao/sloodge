import { beforeEach, describe, expect, it } from 'vitest'
import {
  createStarterDeck,
  getSlideHtml,
  selectCurrentIndex,
  selectSlideViews,
  useDeckStore,
  type SlideHtmlMap,
} from '../../../src/renderer/src/state/deckStore'
import { moveSlide, removeSlide } from '../../../src/shared/document/deck'
import { parseManifest, type SlideId } from '../../../src/shared/document/types'

const NOW = 1_770_000_000_000
const UNKNOWN_ID = 's_01H8XQZ4P7K2M9NB3VYRTC6FDA' as SlideId

beforeEach(() => {
  // The store is a module singleton, so every test starts from a freshly built boot deck.
  useDeckStore.setState(createStarterDeck(NOW))
})

describe('createStarterDeck', () => {
  it('produces a manifest that would survive a round-trip through the schema', () => {
    const { deck } = createStarterDeck(NOW)
    const parsed = parseManifest(JSON.parse(JSON.stringify(deck)))
    expect(parsed.ok ? [] : parsed.issues).toEqual([])
  })

  it('boots with three slides and the first one selected', () => {
    const { deck, currentSlideId } = createStarterDeck(NOW)
    expect(deck.slideOrder).toHaveLength(3)
    expect(currentSlideId).toBe(deck.slideOrder[0])
  })

  it('gives every slide contract-compliant HTML stamped with its own id', () => {
    const { deck, slideHtml } = createStarterDeck(NOW)
    for (const id of deck.slideOrder) {
      const html = getSlideHtml(slideHtml, id)
      expect(html).toContain(`data-sl-slide="${id}"`)
      expect(html).toContain('data-sl-contract="1"')
      expect(html).toContain('width: 1280px')
      expect(html).toContain('height: 720px')
    }
  })

  it('mints distinct ids even from a fixed clock', () => {
    const first = createStarterDeck(NOW)
    const second = createStarterDeck(NOW)
    const ids = new Set([...first.deck.slideOrder, ...second.deck.slideOrder])
    expect(ids.size).toBe(6)
  })
})

describe('getSlideHtml', () => {
  it('reads own keys only — a prototype member is not a slide', () => {
    const { slideHtml, deck } = createStarterDeck(NOW)
    expect(getSlideHtml(slideHtml, deck.slideOrder[0]!)).toContain('<!doctype html>')
    expect(getSlideHtml(slideHtml, 'constructor' as SlideId)).toBeUndefined()
    expect(getSlideHtml(slideHtml, 'toString' as SlideId)).toBeUndefined()
    expect(getSlideHtml(slideHtml, '__proto__' as SlideId)).toBeUndefined()
  })
})

describe('selectSlideViews', () => {
  it('follows slideOrder, not insertion order', () => {
    const { deck, slideHtml } = createStarterDeck(NOW)
    const moved = moveSlide(deck, deck.slideOrder[2]!, 0)

    expect(selectSlideViews(moved, slideHtml).map((view) => view.id)).toEqual(moved.slideOrder)
    expect(selectSlideViews(moved, slideHtml)[0]?.id).toBe(deck.slideOrder[2])
  })

  it('carries the manifest title and the matching html', () => {
    const { deck, slideHtml } = createStarterDeck(NOW)
    const views = selectSlideViews(deck, slideHtml)

    expect(views.map((view) => view.title)).toEqual([
      'Untitled deck',
      'Second slide',
      'Third slide',
    ])
    expect(views[1]?.html).toBe(getSlideHtml(slideHtml, deck.slideOrder[1]!))
  })

  it('keeps a slide whose bytes are missing, as an empty document', () => {
    const { deck } = createStarterDeck(NOW)
    const views = selectSlideViews(deck, Object.create(null) as SlideHtmlMap)

    expect(views).toHaveLength(3)
    expect(views.every((view) => view.html === '')).toBe(true)
  })

  it('is empty for a deck with no slides', () => {
    const { deck, slideHtml } = createStarterDeck(NOW)
    const emptied = deck.slideOrder.reduce(removeSlide, deck)
    expect(selectSlideViews(emptied, slideHtml)).toEqual([])
  })
})

describe('selectCurrentIndex', () => {
  it('is the 0-based position in slideOrder', () => {
    const { deck } = createStarterDeck(NOW)
    expect(selectCurrentIndex(deck, deck.slideOrder[1]!)).toBe(1)
  })

  it('is -1 when nothing is selected or the selection is not in the deck', () => {
    const { deck } = createStarterDeck(NOW)
    expect(selectCurrentIndex(deck, null)).toBe(-1)
    expect(selectCurrentIndex(deck, UNKNOWN_ID)).toBe(-1)
  })
})

describe('useDeckStore selection', () => {
  it('boots on the first slide', () => {
    const state = useDeckStore.getState()
    expect(state.currentSlideId).toBe(state.deck.slideOrder[0])
  })

  it('selects by id', () => {
    const target = useDeckStore.getState().deck.slideOrder[2]!
    useDeckStore.getState().selectSlide(target)
    expect(useDeckStore.getState().currentSlideId).toBe(target)
  })

  // A rail click that races a delete must not blank the canvas.
  it('ignores an id the deck does not contain', () => {
    const before = useDeckStore.getState().currentSlideId
    useDeckStore.getState().selectSlide(UNKNOWN_ID)
    expect(useDeckStore.getState().currentSlideId).toBe(before)
  })

  it('selects by position', () => {
    useDeckStore.getState().selectSlideAt(1)
    expect(useDeckStore.getState().currentSlideId).toBe(useDeckStore.getState().deck.slideOrder[1])
  })

  it('ignores an out-of-range position', () => {
    const before = useDeckStore.getState().currentSlideId
    useDeckStore.getState().selectSlideAt(99)
    useDeckStore.getState().selectSlideAt(-1)
    expect(useDeckStore.getState().currentSlideId).toBe(before)
  })

  it('leaves the deck itself alone — M1.3 selects, it does not mutate', () => {
    const deck = useDeckStore.getState().deck
    useDeckStore.getState().selectSlideAt(2)
    expect(useDeckStore.getState().deck).toBe(deck)
  })
})
