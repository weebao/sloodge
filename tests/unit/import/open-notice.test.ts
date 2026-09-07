import { describe, expect, it } from 'vitest'
import { noticeForOpen, type OpenDeckPayload } from '../../../src/shared/document/open'

/**
 * The status-bar summary of a lossy open (M4.5, review r3). Pure, so the wording — counts, plurals,
 * and above all *silence for a clean open* — is pinned without a DOM.
 */

const deck = { manifest: {} as never, slides: {}, notes: {}, theme: null }

function pptx(
  summary: Partial<NonNullable<OpenDeckPayload['import']>>,
  warnings: string[] = [],
): OpenDeckPayload {
  return {
    path: '/tmp/a.pptx',
    fileName: 'a.pptx',
    source: 'pptx',
    deck,
    warnings,
    import: {
      slideCount: 12,
      convertedCount: 12,
      fallbackCount: 0,
      sourceSha256: '',
      retainedBytes: 0,
      partCount: 0,
      conversionNotes: [],
      ...summary,
    },
  }
}

describe('noticeForOpen', () => {
  it('is silent for an import that lost nothing', () => {
    expect(noticeForOpen(pptx({}))).toBeNull()
  })

  it('counts every kind of loss and keeps the items for the tooltip', () => {
    const notice = noticeForOpen(
      pptx({ convertedCount: 9, fallbackCount: 3, conversionNotes: ['note a', 'note b'] }, [
        'warning a',
      ]),
    )
    expect(notice?.summary).toBe(
      'Imported 12 slides · 3 as text-only · 1 warning · 2 conversion notes',
    )
    expect(notice?.details).toEqual(['warning a', 'note a', 'note b'])
  })

  it('reports a fallback even when nothing else was noted', () => {
    expect(
      noticeForOpen(pptx({ slideCount: 1, convertedCount: 0, fallbackCount: 1 }))?.summary,
    ).toBe('Imported 1 slide · 1 as text-only')
  })

  it('reports a .sloodge that opened with repairs, and nothing for a clean one', () => {
    const clean: OpenDeckPayload = {
      path: '/tmp/a.sloodge',
      fileName: 'a.sloodge',
      source: 'sloodge',
      deck,
      warnings: [],
    }
    expect(noticeForOpen(clean)).toBeNull()
    const repaired = { ...clean, warnings: ['slide s_1 repaired', 'slide s_2 repaired'] }
    expect(noticeForOpen(repaired)).toEqual({
      summary: 'Opened with 2 warnings',
      details: ['slide s_1 repaired', 'slide s_2 repaired'],
    })
  })
})
