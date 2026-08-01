/**
 * @vitest-environment happy-dom
 */
import { renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import {
  buildExportPdfRequest,
  useExportPdf,
} from '../../../src/renderer/src/features/export/useExportPdf'
import type { SlideView } from '../../../src/renderer/src/stores/deckStore'
import type { SlideId } from '../../../src/shared/document/types'

function view(id: string, title: string, html: string): SlideView {
  return { id: id as SlideId, title, html }
}

const slides = [
  view('s_1', 'Intro', '<!doctype html><body>one'),
  view('s_2', 'Body', '<!doctype html><body>two'),
]

describe('buildExportPdfRequest', () => {
  it('sends the WRAPPED slide HTML — the same CSP-injected bytes the canvas publishes', () => {
    const request = buildExportPdfRequest(slides, 0, 'Deck', { kind: 'all' })
    for (const slide of request.slides) {
      expect(slide.html).toContain('<meta http-equiv="Content-Security-Policy"')
    }
    // The raw source is not sent verbatim.
    expect(request.slides[0]?.html).not.toBe('<!doctype html><body>one')
  })

  it('preserves order and titles', () => {
    const request = buildExportPdfRequest(slides, 1, 'Deck', { kind: 'all' })
    expect(request.slides.map((s) => s.title)).toEqual(['Intro', 'Body'])
    expect(request.slides[0]?.html).toContain('one')
    expect(request.slides[1]?.html).toContain('two')
  })

  it('carries the current index, range, and deck title through', () => {
    const request = buildExportPdfRequest(slides, 1, 'My Deck', { kind: 'range', from: 1, to: 2 })
    expect(request.currentIndex).toBe(1)
    expect(request.range).toEqual({ kind: 'range', from: 1, to: 2 })
    expect(request.deckTitle).toBe('My Deck')
  })
})

describe('useExportPdf', () => {
  afterEach(() => {
    delete window.sloodge
  })

  it('returns a stable callback identity across arg changes (no menu re-subscription per edit)', () => {
    const { result, rerender } = renderHook(
      (args: Parameters<typeof useExportPdf>[0]) => useExportPdf(args),
      {
        initialProps: { slides, currentIndex: 0, deckTitle: 'Deck' },
      },
    )
    const first = result.current
    // Simulate a deck edit: a fresh slides array and a new title, as AppShell would pass.
    rerender({
      slides: [...slides, view('s_3', 'More', '<!doctype html><body>3')],
      currentIndex: 1,
      deckTitle: 'Deck v2',
    })
    expect(result.current).toBe(first)
  })

  it('is inert (no throw) when there is no bridge', () => {
    const { result } = renderHook(() =>
      useExportPdf({ slides, currentIndex: 0, deckTitle: 'Deck' }),
    )
    expect(() => result.current()).not.toThrow()
  })
})
