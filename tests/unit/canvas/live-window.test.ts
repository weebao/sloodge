import { describe, expect, it } from 'vitest'
import {
  LIVE_WINDOW_RADIUS,
  liveSlideWindow,
} from '../../../src/renderer/src/features/canvas/liveWindow'

const deck = ['a', 'b', 'c', 'd', 'e'] as const

describe('liveSlideWindow', () => {
  it('is the roadmap’s ±1: the active slide and one neighbour each side', () => {
    expect(LIVE_WINDOW_RADIUS).toBe(1)
    expect(liveSlideWindow(deck, 2)).toEqual([
      { slide: 'b', role: 'warm' },
      { slide: 'c', role: 'active' },
      { slide: 'd', role: 'warm' },
    ])
  })

  it('clips at the ends of the deck instead of wrapping', () => {
    expect(liveSlideWindow(deck, 0)).toEqual([
      { slide: 'a', role: 'active' },
      { slide: 'b', role: 'warm' },
    ])
    expect(liveSlideWindow(deck, 4)).toEqual([
      { slide: 'd', role: 'warm' },
      { slide: 'e', role: 'active' },
    ])
  })

  it('is just the active slide in a one-slide deck', () => {
    expect(liveSlideWindow(['only'], 0)).toEqual([{ slide: 'only', role: 'active' }])
  })

  it.each([
    ['no selection', -1],
    ['past the end', 5],
    ['an empty deck', 0],
  ])('is empty for %s', (_label, index) => {
    const slides = index === 0 ? [] : deck
    expect(liveSlideWindow(slides, index)).toEqual([])
  })

  // The stage keys frames by id in this order; a step to a neighbour must be an append/remove at
  // the ends, never a reorder, because a moved iframe reloads its document.
  it('keeps deck order so a step to a neighbour preserves the surviving frames’ order', () => {
    const before = liveSlideWindow(deck, 2).map((f) => f.slide)
    const after = liveSlideWindow(deck, 3).map((f) => f.slide)
    const survivors = before.filter((id) => after.includes(id))
    expect(survivors).toEqual(after.filter((id) => before.includes(id)))
    expect(survivors).toEqual(['c', 'd'])
  })
})
