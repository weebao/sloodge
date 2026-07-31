import { describe, expect, it } from 'vitest'
import {
  addSlide,
  createEmptyDeck,
  createSlideEntry,
  DeckError,
  duplicateSlide,
  getSlide,
  hasSlide,
  indexOfSlide,
  moveSlide,
  newAssetId,
  newDeckId,
  newSlideId,
  removeSlide,
  reorderSlides,
  slideCount,
  slidesInOrder,
  touchDeck,
  updateSlide,
} from '../../../src/shared/document/deck'
import {
  ASSET_ID_PATTERN,
  DECK_ID_PATTERN,
  DEFAULT_THEME_PATH,
  parseManifest,
  SLIDE_ID_PATTERN,
  type DeckManifest,
  type SlideId,
} from '../../../src/shared/document/types'

const T0 = 1_770_000_000_000

function deckWith(count: number): { deck: DeckManifest; ids: string[] } {
  let deck = createEmptyDeck({ now: T0, title: 'Fixture' })
  const ids: string[] = []
  for (let index = 0; index < count; index += 1) {
    const entry = createSlideEntry({
      now: T0 + index,
      title: `Slide ${String(index + 1)}`,
      withNotes: true,
    })
    ids.push(entry.id)
    deck = addSlide(deck, entry)
  }
  return { deck, ids }
}

describe('createEmptyDeck', () => {
  it('produces a schema-valid, slideless deck', () => {
    const deck = createEmptyDeck({ now: T0 })
    expect(deck.slideOrder).toEqual([])
    expect(deck.slides).toEqual({})
    expect(deck.canvas).toEqual({ width: 1280, height: 720 })
    expect(deck.id).toMatch(/^d_[0-9A-HJKMNP-TV-Z]{26}$/)
    expect(parseManifest(deck).ok).toBe(true)
  })

  it('does not point at a theme file nobody writes', () => {
    const bare = createEmptyDeck({ now: T0 })
    expect('theme' in bare).toBe(false)
    expect(createEmptyDeck({ now: T0, theme: DEFAULT_THEME_PATH }).theme).toBe(DEFAULT_THEME_PATH)
  })

  it('carries optional metadata only when supplied', () => {
    const bare = createEmptyDeck({ now: T0 })
    expect('subtitle' in bare).toBe(false)
    expect('authors' in bare).toBe(false)

    const full = createEmptyDeck({
      now: T0,
      subtitle: 'sub',
      authors: ['a@example.com'],
      generator: { app: 'sloodge', version: '0.0.0' },
    })
    expect(full.subtitle).toBe('sub')
    expect(full.authors).toEqual(['a@example.com'])
    expect(parseManifest(full).ok).toBe(true)
  })
})

describe('addSlide', () => {
  it('appends by default and keeps the deck schema-valid', () => {
    const { deck, ids } = deckWith(3)
    expect(deck.slideOrder).toEqual(ids)
    expect(slideCount(deck)).toBe(3)
    expect(parseManifest(deck).ok).toBe(true)
  })

  it('inserts at an explicit index', () => {
    const { deck, ids } = deckWith(2)
    const entry = createSlideEntry({ now: T0 + 99, title: 'Inserted' })
    const next = addSlide(deck, entry, 1)
    expect(next.slideOrder).toEqual([ids[0], entry.id, ids[1]])
  })

  it('never mutates the input deck', () => {
    const { deck } = deckWith(2)
    const before = structuredClone(deck)
    const next = addSlide(deck, createSlideEntry({ now: T0 + 5 }))
    expect(next).not.toBe(deck)
    expect(next.slides).not.toBe(deck.slides)
    expect(next.slideOrder).not.toBe(deck.slideOrder)
    expect(deck).toEqual(before)
  })

  it('rejects a duplicate id and an out-of-range index', () => {
    const { deck, ids } = deckWith(1)
    const clash = createSlideEntry({ id: ids[0]! })
    expect(() => addSlide(deck, clash)).toThrow(DeckError)
    expect(() => addSlide(deck, createSlideEntry({ now: T0 }), 7)).toThrow(/insert at 7/)
  })
})

describe('removeSlide', () => {
  it('drops the entry from both slides and slideOrder', () => {
    const { deck, ids } = deckWith(3)
    const next = removeSlide(deck, ids[1]!)
    expect(next.slideOrder).toEqual([ids[0], ids[2]])
    expect(getSlide(next, ids[1]!)).toBeUndefined()
    expect(getSlide(deck, ids[1]!)).toBeDefined()
    expect(parseManifest(next).ok).toBe(true)
  })

  it('throws for an unknown slide', () => {
    const { deck } = deckWith(1)
    expect(() => removeSlide(deck, newSlideId(T0))).toThrow(DeckError)
  })
})

describe('duplicateSlide', () => {
  it('mints a new id, rewrites paths and lands right after the original', () => {
    const { deck, ids } = deckWith(3)
    const copyId = newSlideId(T0 + 1000)
    const next = duplicateSlide(deck, ids[1]!, { newId: copyId, now: T0 + 1000 })

    expect(next.slideOrder).toEqual([ids[0], ids[1], copyId, ids[2]])
    const copy = getSlide(next, copyId)
    expect(copy?.file).toBe(`slides/${copyId}.html`)
    expect(copy?.notes).toBe(`notes/${copyId}.md`)
    expect(copy?.title).toBe(getSlide(deck, ids[1]!)?.title)
    expect(parseManifest(next).ok).toBe(true)
  })

  it('resets cached validation and drops the stale thumbnail', () => {
    const { deck, ids } = deckWith(1)
    const withThumb = updateSlide(deck, ids[0]!, {
      thumb: `thumbs/${ids[0]!}.webp`,
      validation: { status: 'pass', contentHash: `sha256:${'ab'.repeat(32)}` },
    })
    const copyId = newSlideId(T0 + 2000)
    const next = duplicateSlide(withThumb, ids[0]!, { newId: copyId })
    const copy = getSlide(next, copyId)
    expect(copy?.validation).toEqual({ status: 'unknown' })
    expect(copy?.thumb).toBeUndefined()
    expect(getSlide(withThumb, ids[0]!)?.thumb).toBeDefined()
  })

  it('deep-copies nested entry data so the copy is independent', () => {
    const { deck, ids } = deckWith(1)
    const seeded = updateSlide(deck, ids[0]!, {
      origin: { type: 'agent', skill: 'slide-deck', sessionId: 'as_1' },
    })
    const copyId = newSlideId(T0 + 3000)
    const next = duplicateSlide(seeded, ids[0]!, { newId: copyId })
    expect(getSlide(next, copyId)?.origin).not.toBe(getSlide(seeded, ids[0]!)?.origin)
    expect(getSlide(next, copyId)?.origin).toEqual(getSlide(seeded, ids[0]!)?.origin)
  })

  it('throws for an unknown source slide', () => {
    const { deck } = deckWith(1)
    expect(() => duplicateSlide(deck, newSlideId(T0))).toThrow(DeckError)
  })
})

describe('reordering', () => {
  it('moves a slide to an absolute index', () => {
    const { deck, ids } = deckWith(4)
    const next = moveSlide(deck, ids[0]!, 2)
    expect(next.slideOrder).toEqual([ids[1], ids[2], ids[0], ids[3]])
    expect(indexOfSlide(next, ids[0]!)).toBe(2)
    expect(deck.slideOrder).toEqual(ids)
  })

  it('is a no-op when the slide is already at the target index', () => {
    const { deck, ids } = deckWith(2)
    expect(moveSlide(deck, ids[0]!, 0)).toBe(deck)
  })

  it('rejects an out-of-range move target', () => {
    const { deck, ids } = deckWith(2)
    expect(() => moveSlide(deck, ids[0]!, 2)).toThrow(DeckError)
    expect(() => moveSlide(deck, ids[0]!, -1)).toThrow(DeckError)
  })

  it('replaces the whole order with a permutation', () => {
    const { deck, ids } = deckWith(3)
    const next = reorderSlides(deck, [ids[2]!, ids[0]!, ids[1]!])
    expect(next.slideOrder).toEqual([ids[2], ids[0], ids[1]])
    expect(slidesInOrder(next).map((slide) => slide.id)).toEqual([ids[2], ids[0], ids[1]])
    expect(parseManifest(next).ok).toBe(true)
  })

  it('rejects an order that is not a permutation', () => {
    const { deck, ids } = deckWith(3)
    expect(() => reorderSlides(deck, [ids[0]!, ids[1]!])).toThrow(DeckError)
    expect(() => reorderSlides(deck, [ids[0]!, ids[0]!, ids[1]!])).toThrow(/permutation/)
  })
})

describe('updateSlide and touchDeck', () => {
  it('shallow-merges a patch but refuses to change id or file', () => {
    const { deck, ids } = deckWith(1)
    const next = updateSlide(deck, ids[0]!, {
      title: 'Renamed',
      hidden: true,
      id: 's_01H8XR0M5S8T1WQZ9C4XKB7GEH',
      file: 'slides/s_01H8XR0M5S8T1WQZ9C4XKB7GEH.html',
    })
    const slide = getSlide(next, ids[0]!)
    expect(slide?.title).toBe('Renamed')
    expect(slide?.hidden).toBe(true)
    expect(slide?.id).toBe(ids[0])
    expect(slide?.file).toBe(`slides/${ids[0]!}.html`)
    expect(getSlide(deck, ids[0]!)?.title).toBe('Slide 1')
  })

  it('stamps updatedAt without touching anything else', () => {
    const { deck } = deckWith(1)
    const next = touchDeck(deck, T0 + 60_000)
    expect(next.updatedAt).toBe(new Date(T0 + 60_000).toISOString())
    expect(next.slideOrder).toEqual(deck.slideOrder)
    expect(deck.updatedAt).toBe(new Date(T0).toISOString())
  })
})

describe('prototype-named slide ids (M1)', () => {
  const PROTO_IDS = ['constructor', 'toString', 'valueOf', 'hasOwnProperty'] as SlideId[]

  it.each(PROTO_IDS)('getSlide(%s) is undefined and agrees with hasSlide', (id) => {
    const { deck } = deckWith(2)
    expect(getSlide(deck, id)).toBeUndefined()
    expect(hasSlide(deck, id)).toBe(false)
  })

  it('slidesInOrder ignores an order entry that only exists on Object.prototype', () => {
    const { deck } = deckWith(1)
    const forged: DeckManifest = { ...deck, slideOrder: ['toString'] as SlideId[] }
    expect(slidesInOrder(forged)).toEqual([])
  })

  it('updateSlide on a prototype key throws instead of fabricating a slide', () => {
    const { deck } = deckWith(1)
    for (const id of PROTO_IDS) {
      expect(() => updateSlide(deck, id, { title: 'x' })).toThrow(DeckError)
      expect(() => removeSlide(deck, id)).toThrow(DeckError)
      expect(() => duplicateSlide(deck, id)).toThrow(DeckError)
      expect(() => moveSlide(deck, id, 0)).toThrow(DeckError)
    }
    expect(Object.keys(deck.slides)).toHaveLength(1)
  })

  it('keeps the slides map free of Object.prototype, created and parsed alike', () => {
    const { deck } = deckWith(2)
    expect(Object.getPrototypeOf(deck.slides)).toBeNull()
    expect(Object.getPrototypeOf(createEmptyDeck({ now: T0 }).slides)).toBeNull()

    // zod returns plain objects, so the parse boundary has to re-key the map.
    const parsed = parseManifest(JSON.parse(JSON.stringify(deck)))
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(Object.getPrototypeOf(parsed.manifest.slides)).toBeNull()
    expect(getSlide(parsed.manifest, 'constructor' as SlideId)).toBeUndefined()
  })
})

describe('slideOrder invariant guards', () => {
  it('refuses to move or duplicate a slide that is missing from slideOrder', () => {
    // Invariant 1 makes this unreachable through the schema; the guard exists because the failure
    // mode is silent — splice(-1, 1) would drop the *last* slide and insert the copy at the front.
    const { deck, ids } = deckWith(3)
    const broken: DeckManifest = {
      ...deck,
      slideOrder: deck.slideOrder.filter((id) => id !== ids[1]),
    }
    expect(() => moveSlide(broken, ids[1]!, 0)).toThrow(DeckError)
    expect(() => duplicateSlide(broken, ids[1]!)).toThrow(/not in the order/)
  })
})

describe('id minting', () => {
  it('newDeckId matches DECK_ID_PATTERN and is unique per call', () => {
    const a = newDeckId(T0)
    const b = newDeckId(T0)
    expect(a).toMatch(DECK_ID_PATTERN)
    expect(b).toMatch(DECK_ID_PATTERN)
    expect(a).not.toBe(b)
    expect(a.slice(0, 12)).toBe(b.slice(0, 12)) // same ms → same time prefix, ULID-sortable
  })

  it('newAssetId matches ASSET_ID_PATTERN and is unique per call', () => {
    const a = newAssetId(T0)
    const b = newAssetId(T0)
    expect(a).toMatch(ASSET_ID_PATTERN)
    expect(b).toMatch(ASSET_ID_PATTERN)
    expect(a).not.toBe(b)
  })

  it('newSlideId matches SLIDE_ID_PATTERN and never collides across id kinds', () => {
    const slide = newSlideId(T0)
    expect(slide).toMatch(SLIDE_ID_PATTERN)
    expect(slide).not.toMatch(DECK_ID_PATTERN)
    expect(slide).not.toMatch(ASSET_ID_PATTERN)
  })

  it('mints ids that sort by creation time', () => {
    const early = newDeckId(T0)
    const late = newDeckId(T0 + 60_000)
    expect(early < late).toBe(true)
  })
})
