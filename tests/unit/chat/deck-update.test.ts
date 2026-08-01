import { describe, expect, it } from 'vitest'
import { isDeckUpdate } from '../../../src/shared/document/deck-update'

describe('isDeckUpdate', () => {
  it('accepts a payload with the structural fields present', () => {
    expect(isDeckUpdate({ manifest: { id: 'd' }, slides: {}, notes: {}, theme: null })).toBe(true)
  })

  it.each([
    ['null', null],
    ['a string', 'deck'],
    ['a null manifest', { manifest: null, slides: {}, notes: {} }],
    ['a missing manifest', { slides: {}, notes: {} }],
    ['a non-object slides', { manifest: {}, slides: 'x', notes: {} }],
    ['a missing notes', { manifest: {}, slides: {} }],
  ])('rejects %s', (_label, value) => {
    expect(isDeckUpdate(value)).toBe(false)
  })
})
