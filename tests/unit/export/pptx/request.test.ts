import { describe, expect, it } from 'vitest'
import { parseExportPptxRequest } from '../../../../src/shared/export/pptx/request'

const valid = {
  slides: [{ title: 'One', html: '<!doctype html><body>a' }],
  currentIndex: 0,
  range: { kind: 'all' },
  deckTitle: 'Deck',
  fidelity: 'auto',
}

describe('parseExportPptxRequest', () => {
  it('accepts a well-formed request', () => {
    expect(parseExportPptxRequest(valid)).toEqual(valid)
  })

  it('accepts each fidelity and a numeric range', () => {
    expect(parseExportPptxRequest({ ...valid, fidelity: 'raster' })?.fidelity).toBe('raster')
    expect(parseExportPptxRequest({ ...valid, fidelity: 'editable' })?.fidelity).toBe('editable')
    const ranged = parseExportPptxRequest({ ...valid, range: { kind: 'range', from: 2, to: 4 } })
    expect(ranged?.range).toEqual({ kind: 'range', from: 2, to: 4 })
  })

  it('rejects a missing/invalid fidelity and malformed shapes', () => {
    expect(parseExportPptxRequest({ ...valid, fidelity: 'nope' })).toBeNull()
    expect(parseExportPptxRequest({ ...valid, fidelity: undefined })).toBeNull()
    expect(parseExportPptxRequest({ ...valid, slides: 'x' })).toBeNull()
    expect(parseExportPptxRequest({ ...valid, slides: [{ title: 1, html: 'a' }] })).toBeNull()
    expect(parseExportPptxRequest({ ...valid, currentIndex: 1.5 })).toBeNull()
    expect(parseExportPptxRequest({ ...valid, range: { kind: 'weird' } })).toBeNull()
    expect(parseExportPptxRequest(null)).toBeNull()
  })
})
