import { describe, expect, it } from 'vitest'
import { parseExportHtmlRequest, parseExportPdfRequest } from '../../../src/shared/export/request'

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

describe('parseExportPdfRequest — the optional slide id (M4.4)', () => {
  it('keeps a string id, which the HTML bundle manifest records', () => {
    const parsed = parseExportPdfRequest({
      ...valid,
      slides: [{ id: 's_01', title: 'One', html: 'x' }],
    })
    expect(parsed?.slides[0]).toEqual({ id: 's_01', title: 'One', html: 'x' })
  })

  it('omits the id entirely when absent, rather than inventing an empty one', () => {
    const parsed = parseExportPdfRequest(valid)
    expect(parsed?.slides[0]).not.toHaveProperty('id')
  })

  it.each([
    ['a number', 42],
    ['an object', { toString: 'evil' }],
    ['null', null],
  ])('drops a non-string id (%s) rather than coercing it into the manifest', (_label, id) => {
    const parsed = parseExportPdfRequest({ ...valid, slides: [{ id, title: 'One', html: 'x' }] })
    // The request is still valid — `id` is optional — but the bad value never reaches the bundle.
    expect(parsed).not.toBeNull()
    expect(parsed?.slides[0]).not.toHaveProperty('id')
  })
})

describe('parseExportHtmlRequest', () => {
  it('accepts the same well-formed request the PDF channel does', () => {
    expect(parseExportHtmlRequest(valid)).toEqual(valid)
  })

  it('rejects a malformed payload, so main never zips garbage', () => {
    expect(parseExportHtmlRequest({ nope: true })).toBeNull()
    expect(parseExportHtmlRequest(null)).toBeNull()
  })
})
