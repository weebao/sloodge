/**
 * @vitest-environment happy-dom
 *
 * The renderer's HTML-export trigger (M4.4). Mirrors `use-export-pdf.test.tsx`, plus the two things
 * that are specific to this format: the slide `id` reaches the request (the bundle manifest needs
 * it), and the wrapped-HTML rule is asserted as a *security* property rather than a fidelity one —
 * these bytes leave the machine, and the injected CSP meta is the only policy that travels with them.
 */
import { renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  buildExportHtmlRequest,
  useExportHtml,
} from '../../../src/renderer/src/features/export/useExportHtml'
import type { SlideView } from '../../../src/renderer/src/stores/deckStore'
import type { SlideId } from '../../../src/shared/document/types'
import type { SloodgeBridge } from '../../../src/renderer/src/host/bridge'

function view(id: string, title: string, html: string): SlideView {
  return { id: id as SlideId, title, html }
}

const slides = [
  view('s_1', 'Intro', '<!doctype html><body>one'),
  view('s_2', 'Body', '<!doctype html><body>two'),
]

describe('buildExportHtmlRequest', () => {
  it('sends the WRAPPED slide HTML — the only CSP the exported bundle will ever have', () => {
    // Outside our app there is no `slide://` response header and no host CSP. If this regressed to
    // sending raw source, every exported slide would run unpoliced in the viewer's browser.
    const request = buildExportHtmlRequest(slides, 0, 'Deck', { kind: 'all' })
    for (const slide of request.slides) {
      expect(slide.html).toContain('<meta http-equiv="Content-Security-Policy"')
      expect(slide.html).toContain("connect-src 'none'")
    }
    expect(request.slides[0]?.html).not.toBe('<!doctype html><body>one')
  })

  it('carries each slide id so the manifest can match files back to slides', () => {
    const request = buildExportHtmlRequest(slides, 0, 'Deck', { kind: 'all' })
    expect(request.slides.map((slide) => slide.id)).toEqual(['s_1', 's_2'])
  })

  it('preserves order and titles', () => {
    const request = buildExportHtmlRequest(slides, 1, 'Deck', { kind: 'all' })
    expect(request.slides.map((slide) => slide.title)).toEqual(['Intro', 'Body'])
    expect(request.slides[0]?.html).toContain('one')
    expect(request.slides[1]?.html).toContain('two')
  })

  it('carries the current index, range, and deck title through', () => {
    const request = buildExportHtmlRequest(slides, 1, 'My Deck', { kind: 'range', from: 1, to: 2 })
    expect(request.currentIndex).toBe(1)
    expect(request.range).toEqual({ kind: 'range', from: 1, to: 2 })
    expect(request.deckTitle).toBe('My Deck')
  })
})

describe('useExportHtml', () => {
  afterEach(() => {
    delete window.sloodge
  })

  it('returns a stable callback identity across arg changes', () => {
    // `useMenuActions` lists this callback in an effect dependency array; a new identity per edit
    // would tear down and rebuild the `app:menu` subscription on every keystroke.
    const { result, rerender } = renderHook(
      (args: Parameters<typeof useExportHtml>[0]) => useExportHtml(args),
      { initialProps: { slides, currentIndex: 0, deckTitle: 'Deck' } },
    )
    const first = result.current
    rerender({
      slides: [...slides, view('s_3', 'More', '<!doctype html><body>3')],
      currentIndex: 1,
      deckTitle: 'Deck v2',
    })
    expect(result.current).toBe(first)
  })

  it('is inert (no throw) when there is no bridge', () => {
    const { result } = renderHook(() =>
      useExportHtml({ slides, currentIndex: 0, deckTitle: 'Deck' }),
    )
    expect(() => result.current()).not.toThrow()
  })

  it('invokes the HTML channel, not the PDF one, with the current deck', () => {
    const exportHtml = vi.fn().mockResolvedValue({ canceled: true })
    const exportPdf = vi.fn()
    window.sloodge = {
      onMenuAction: () => () => undefined,
      exportHtml,
      exportPdf,
    } as unknown as SloodgeBridge

    const { result } = renderHook(() =>
      useExportHtml({ slides, currentIndex: 1, deckTitle: 'My Deck' }),
    )
    result.current()

    expect(exportPdf).not.toHaveBeenCalled()
    expect(exportHtml).toHaveBeenCalledTimes(1)
    const request = exportHtml.mock.calls[0]![0]
    expect(request.deckTitle).toBe('My Deck')
    expect(request.currentIndex).toBe(1)
    expect(request.slides).toHaveLength(2)
  })

  it('does not export an empty deck', () => {
    const exportHtml = vi.fn()
    window.sloodge = {
      onMenuAction: () => () => undefined,
      exportHtml,
    } as unknown as SloodgeBridge

    const { result } = renderHook(() =>
      useExportHtml({ slides: [], currentIndex: 0, deckTitle: 'D' }),
    )
    result.current()
    expect(exportHtml).not.toHaveBeenCalled()
  })

  it('uses the latest deck at click time, not the deck at mount time', () => {
    const exportHtml = vi.fn().mockResolvedValue({ canceled: true })
    window.sloodge = {
      onMenuAction: () => () => undefined,
      exportHtml,
    } as unknown as SloodgeBridge

    const { result, rerender } = renderHook(
      (args: Parameters<typeof useExportHtml>[0]) => useExportHtml(args),
      { initialProps: { slides, currentIndex: 0, deckTitle: 'Deck' } },
    )
    rerender({
      slides: [...slides, view('s_3', 'More', '<!doctype html><body>3')],
      currentIndex: 2,
      deckTitle: 'Deck v2',
    })
    result.current()

    // The stable identity must not mean a stale closure — the ref is read at click time.
    const request = exportHtml.mock.calls[0]![0]
    expect(request.slides).toHaveLength(3)
    expect(request.deckTitle).toBe('Deck v2')
  })
})
