/**
 * @vitest-environment happy-dom
 */
import { renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  buildExportPptxRequest,
  useExportPptx,
} from '../../../src/renderer/src/features/export/useExportPptx'
import type { SlideView } from '../../../src/renderer/src/stores/deckStore'
import type { SlideId } from '../../../src/shared/document/types'
import type { ExportPptxResponse } from '../../../src/shared/export/pptx/types'

function view(id: string, title: string, html: string): SlideView {
  return { id: id as SlideId, title, html }
}

const slides = [
  view('s_1', 'Intro', '<!doctype html><body>one'),
  view('s_2', 'Body', '<!doctype html><body>two'),
]

describe('buildExportPptxRequest', () => {
  it('sends WRAPPED slide HTML plus the fidelity choice', () => {
    const request = buildExportPptxRequest(slides, 0, 'Deck', { kind: 'all' }, 'raster')
    for (const slide of request.slides) {
      expect(slide.html).toContain('<meta http-equiv="Content-Security-Policy"')
    }
    expect(request.fidelity).toBe('raster')
    expect(request.slides.map((s) => s.title)).toEqual(['Intro', 'Body'])
  })
})

describe('useExportPptx', () => {
  afterEach(() => {
    delete window.sloodge
  })

  it('invokes the bridge with the chosen fidelity', () => {
    const exportPptx = vi.fn((_request: unknown): Promise<ExportPptxResponse> =>
      Promise.resolve({ canceled: true }),
    )
    window.sloodge = { onMenuAction: () => () => undefined, exportPptx }
    const { result } = renderHook(() =>
      useExportPptx({ slides, currentIndex: 0, deckTitle: 'Deck' }),
    )
    result.current('editable')
    expect(exportPptx).toHaveBeenCalledTimes(1)
    expect(exportPptx.mock.calls[0]![0]).toMatchObject({ fidelity: 'editable', deckTitle: 'Deck' })
  })

  it('is inert (no throw) with no bridge and returns a stable callback identity', () => {
    const { result, rerender } = renderHook(
      (args: Parameters<typeof useExportPptx>[0]) => useExportPptx(args),
      { initialProps: { slides, currentIndex: 0, deckTitle: 'Deck' } },
    )
    const first = result.current
    expect(() => result.current('auto')).not.toThrow()
    rerender({ slides: [...slides], currentIndex: 1, deckTitle: 'Deck v2' })
    expect(result.current).toBe(first)
  })
})
