import { describe, expect, it } from 'vitest'
import { parseExportPdfRequest } from '../../../src/shared/export/request'

const valid = {
  slides: [
    { title: 'One', html: '<!doctype html><body>1' },
    { title: 'Two', html: '<!doctype html><body>2' },
  ],
  currentIndex: 1,
  range: { kind: 'all' },
  deckTitle: 'My Deck',
}

describe('parseExportPdfRequest', () => {
  it('accepts a well-formed request', () => {
    expect(parseExportPdfRequest(valid)).toEqual(valid)
  })

  it.each([{ kind: 'all' }, { kind: 'current' }, { kind: 'range', from: 1, to: 4 }])(
    'accepts range %j',
    (range) => {
      const parsed = parseExportPdfRequest({ ...valid, range })
      expect(parsed?.range).toEqual(range)
    },
  )

  it.each([
    ['null payload', null],
    ['non-object', 'nope'],
    ['slides not an array', { ...valid, slides: {} }],
    ['a slide missing html', { ...valid, slides: [{ title: 'x' }] }],
    ['a slide with non-string title', { ...valid, slides: [{ title: 1, html: 'x' }] }],
    ['currentIndex not an integer', { ...valid, currentIndex: 1.5 }],
    ['currentIndex a string', { ...valid, currentIndex: '1' }],
    ['range missing', { ...valid, range: undefined }],
    ['range unknown kind', { ...valid, range: { kind: 'nope' } }],
    ['range kind=range without bounds', { ...valid, range: { kind: 'range' } }],
    ['range with non-finite bound', { ...valid, range: { kind: 'range', from: 1, to: Infinity } }],
    ['deckTitle not a string', { ...valid, deckTitle: 42 }],
  ])('rejects %s', (_label, payload) => {
    expect(parseExportPdfRequest(payload)).toBeNull()
  })
})
