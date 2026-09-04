import { describe, expect, it } from 'vitest'
import {
  LIVE_WINDOW_RADIUS,
  liveSlideWindow,
} from '../../../src/renderer/src/features/canvas/liveWindow'

const deck = ['a', 'b', 'c', 'd', 'e'].map((id) => ({ id }))
const ids = (slides: readonly { id: string }[], index: number): string[] =>
  liveSlideWindow(slides, index).map((f) => f.slide.id)

describe('liveSlideWindow', () => {
  it('is the roadmap’s ±1: the active slide and one neighbour each side', () => {
    expect(LIVE_WINDOW_RADIUS).toBe(1)
    expect(liveSlideWindow(deck, 2)).toEqual([
      { slide: { id: 'b' }, role: 'warm' },
      { slide: { id: 'c' }, role: 'active' },
      { slide: { id: 'd' }, role: 'warm' },
    ])
  })

  it('clips at the ends of the deck instead of wrapping', () => {
    expect(liveSlideWindow(deck, 0)).toEqual([
      { slide: { id: 'a' }, role: 'active' },
      { slide: { id: 'b' }, role: 'warm' },
    ])
    expect(liveSlideWindow(deck, 4)).toEqual([
      { slide: { id: 'd' }, role: 'warm' },
      { slide: { id: 'e' }, role: 'active' },
    ])
  })

  it('is just the active slide in a one-slide deck', () => {
    expect(liveSlideWindow([{ id: 'only' }], 0)).toEqual([
      { slide: { id: 'only' }, role: 'active' },
    ])
  })

  it.each([
    ['no selection', -1],
    ['past the end', 5],
    ['an empty deck', 0],
  ])('is empty for %s', (_label, index) => {
    const slides = index === 0 ? [] : deck
    expect(liveSlideWindow(slides, index)).toEqual([])
  })

  /**
   * The stage keys frames by id in this order, and React moves a keyed child whenever the children's
   * relative order changes; a moved iframe reloads its document. So the order has to be one that no
   * transition can change for two surviving frames — which deck order is not: moving the selected
   * slide one slot turns [b, c, d] into [d, c, e] and would move the active frame c.
   */
  it('orders by id, not deck position', () => {
    const shuffled = ['c', 'a', 'e', 'b', 'd'].map((id) => ({ id }))
    expect(ids(shuffled, 2)).toEqual(['a', 'b', 'e'])
  })

  it('keeps surviving frames in the same relative order across a step', () => {
    const before = ids(deck, 2)
    const after = ids(deck, 3)
    expect(before.filter((id) => after.includes(id))).toEqual(
      after.filter((id) => before.includes(id)),
    )
  })

  it('keeps surviving frames in the same relative order when the active slide is moved', () => {
    const before = ids(deck, 2)
    // Move c one slot later: a b d c e, still selected.
    const moved = ['a', 'b', 'd', 'c', 'e'].map((id) => ({ id }))
    const after = ids(moved, 3)
    expect(after).toContain('c')
    expect(before.filter((id) => after.includes(id))).toEqual(
      after.filter((id) => before.includes(id)),
    )
  })
})
