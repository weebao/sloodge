import { describe, expect, it, vi } from 'vitest'
import { PDFDocument } from 'pdf-lib'
import { buildSlidesPdf, type SlidePdfRenderer } from '../../../src/main/export/pdf-export'
import { pdfGeometry } from '../../../src/main/export/merge'
import type { SlideExportInput, SlideRange } from '../../../src/shared/export/types'

/** A real single-page PDF whose height marks which slide produced it, so page order is observable. */
async function slidePdf(height: number, pages = 1): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  for (let i = 0; i < pages; i += 1) doc.addPage([960, height])
  return doc.save()
}

/** Renderer that maps a slide's html to a canned PDF, or throws for slides named in `failFor`. */
function fakeRenderer(
  byHtml: Map<string, Uint8Array>,
  failFor: Set<string> = new Set(),
): SlidePdfRenderer {
  return {
    renderToPdf: vi.fn(async (html: string) => {
      if (failFor.has(html)) throw new Error(`boom: ${html}`)
      const bytes = byHtml.get(html)
      if (bytes === undefined) throw new Error(`no canned pdf for ${html}`)
      return bytes
    }),
  }
}

function slides(...htmls: string[]): SlideExportInput[] {
  return htmls.map((html, index) => ({ title: `Slide ${String(index + 1)}`, html }))
}

const ALL: SlideRange = { kind: 'all' }
const base = {
  outPath: '/out/deck.pdf',
  deckTitle: 'Deck',
  currentIndex: 0,
  creationDate: new Date(0),
}

describe('buildSlidesPdf', () => {
  it('renders the range in order — page k is slide k', async () => {
    const input = slides('a', 'b', 'c')
    const canned = new Map([
      ['a', await slidePdf(511)],
      ['b', await slidePdf(522)],
      ['c', await slidePdf(533)],
    ])
    const result = await buildSlidesPdf({
      ...base,
      slides: input,
      range: ALL,
      renderer: fakeRenderer(canned),
    })
    expect(result.pdfBytes).not.toBeNull()
    const geometry = await pdfGeometry(result.pdfBytes!)
    expect(geometry.pageSizes.map((s) => s.height)).toEqual([511, 522, 533])
    expect(result.report.pageCount).toBe(3)
    expect(result.report.slides.map((s) => s.status)).toEqual(['ok', 'ok', 'ok'])
  })

  it('does not abort when one slide fails — the rest still export and it is reported', async () => {
    const input = slides('a', 'bad', 'c')
    const canned = new Map([
      ['a', await slidePdf(511)],
      ['c', await slidePdf(533)],
    ])
    const result = await buildSlidesPdf({
      ...base,
      slides: input,
      range: ALL,
      renderer: fakeRenderer(canned, new Set(['bad'])),
    })
    // Two slides survive, in order; the failed one is absent from the PDF but present in the report.
    const geometry = await pdfGeometry(result.pdfBytes!)
    expect(geometry.pageSizes.map((s) => s.height)).toEqual([511, 533])
    expect(result.report.pageCount).toBe(2)
    expect(result.report.slides.map((s) => s.status)).toEqual(['ok', 'failed', 'ok'])
    expect(result.report.slides[1]?.error).toContain('boom')
    expect(result.report.warnings.some((w) => w.includes('Slide 2'))).toBe(true)
  })

  it('respects a sub-range and only renders those slides', async () => {
    const input = slides('a', 'b', 'c', 'd')
    const canned = new Map([
      ['b', await slidePdf(522)],
      ['c', await slidePdf(533)],
    ])
    const renderer = fakeRenderer(canned)
    const result = await buildSlidesPdf({
      ...base,
      slides: input,
      range: { kind: 'range', from: 2, to: 3 },
      renderer,
    })
    expect(renderer.renderToPdf).toHaveBeenCalledTimes(2)
    expect((renderer.renderToPdf as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0])).toEqual([
      'b',
      'c',
    ])
    const geometry = await pdfGeometry(result.pdfBytes!)
    expect(geometry.pageSizes.map((s) => s.height)).toEqual([522, 533])
    expect(result.report.slideCount).toBe(2)
  })

  it('returns no bytes and warns when the range is empty', async () => {
    const result = await buildSlidesPdf({
      ...base,
      slides: slides('a'),
      range: { kind: 'current' },
      currentIndex: 9,
      renderer: fakeRenderer(new Map()),
    })
    expect(result.pdfBytes).toBeNull()
    expect(result.report.pageCount).toBe(0)
    expect(result.report.warnings.join(' ')).toContain('no slides')
  })

  it('returns no bytes when every slide fails', async () => {
    const result = await buildSlidesPdf({
      ...base,
      slides: slides('x', 'y'),
      range: ALL,
      renderer: fakeRenderer(new Map(), new Set(['x', 'y'])),
    })
    expect(result.pdfBytes).toBeNull()
    expect(result.report.slides.every((s) => s.status === 'failed')).toBe(true)
    expect(result.report.warnings.join(' ')).toContain('No slides could be exported')
  })

  it('flags a slide that overflowed past one page (clipped in the merge)', async () => {
    const canned = new Map([['a', await slidePdf(540, 2)]])
    const result = await buildSlidesPdf({
      ...base,
      slides: slides('a'),
      range: ALL,
      renderer: fakeRenderer(canned),
    })
    expect(result.report.warnings.some((w) => w.includes('extends past'))).toBe(true)
    // Clipped: the merged PDF is one page despite the two-page input.
    expect(result.report.pageCount).toBe(1)
  })

  it('emits rendering then assembling progress', async () => {
    const canned = new Map([['a', await slidePdf(540)]])
    const onProgress = vi.fn()
    await buildSlidesPdf({
      ...base,
      slides: slides('a'),
      range: ALL,
      renderer: fakeRenderer(canned),
      onProgress,
    })
    const phases = onProgress.mock.calls.map((c) => c[0].phase)
    expect(phases).toContain('rendering')
    expect(phases).toContain('assembling')
  })
})
