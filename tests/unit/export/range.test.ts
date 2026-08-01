import { describe, expect, it } from 'vitest'
import { parseSlideRangeText, resolveRange } from '../../../src/shared/export/range'
import type { SlideRange } from '../../../src/shared/export/types'

describe('parseSlideRangeText', () => {
  it.each([
    ['all', { kind: 'all' }],
    ['All', { kind: 'all' }],
    ['  ALL  ', { kind: 'all' }],
    ['current', { kind: 'current' }],
    ['Current', { kind: 'current' }],
    ['3', { kind: 'range', from: 3, to: 3 }],
    ['1-4', { kind: 'range', from: 1, to: 4 }],
    ['1 - 4', { kind: 'range', from: 1, to: 4 }],
    ['4-1', { kind: 'range', from: 1, to: 4 }],
  ])('parses %j', (text, expected) => {
    expect(parseSlideRangeText(text)).toEqual(expected)
  })

  it.each(['', '   ', '0', '0-3', 'abc', '1-', '-4', '1.5', '1,4', '1-2-3'])(
    'rejects %j as null',
    (text) => {
      expect(parseSlideRangeText(text)).toBeNull()
    },
  )
})

describe('resolveRange', () => {
  const all: SlideRange = { kind: 'all' }
  const current: SlideRange = { kind: 'current' }

  it('all → every 0-based index in order', () => {
    expect(resolveRange(all, 4, 0)).toEqual([0, 1, 2, 3])
  })

  it('current → the current index when in range', () => {
    expect(resolveRange(current, 8, 5)).toEqual([5])
  })

  it('current → empty when the index is stale (deck shrank)', () => {
    expect(resolveRange(current, 3, 7)).toEqual([])
    expect(resolveRange(current, 3, -1)).toEqual([])
  })

  it('range → inclusive 1-based converted to 0-based', () => {
    expect(resolveRange({ kind: 'range', from: 2, to: 4 }, 8, 0)).toEqual([1, 2, 3])
  })

  it('range → a single slide', () => {
    expect(resolveRange({ kind: 'range', from: 3, to: 3 }, 8, 0)).toEqual([2])
  })

  it('range → clamps the upper bound to the deck size', () => {
    expect(resolveRange({ kind: 'range', from: 6, to: 100 }, 8, 0)).toEqual([5, 6, 7])
  })

  it('range → empty when the whole span is past the end (not clamped to the last slide)', () => {
    expect(resolveRange({ kind: 'range', from: 50, to: 60 }, 8, 0)).toEqual([])
  })

  it.each([0, -1, 2.5, Number.NaN])('empty for a non-positive/invalid total (%j)', (total) => {
    expect(resolveRange(all, total, 0)).toEqual([])
  })
})
