import { describe, expect, it } from 'vitest'
import { PDFDocument } from 'pdf-lib'
import { isSlidePageSize, mergeSlidePdfs, pdfGeometry } from '../../../src/main/export/merge'
import { SLIDE_HEIGHT_PT, SLIDE_WIDTH_PT } from '../../../src/shared/export/types'

/** A real single-page PDF whose page height encodes an ordinal, so merge order is observable. */
async function pdfWithPages(sizes: readonly [number, number][]): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  for (const [width, height] of sizes) doc.addPage([width, height])
  return doc.save()
}

describe('pdfGeometry', () => {
  it('reads page count and per-page box sizes in order', async () => {
    const bytes = await pdfWithPages([
      [960, 540],
      [100, 200],
    ])
    const geometry = await pdfGeometry(bytes)
    expect(geometry.pageCount).toBe(2)
    expect(geometry.pageSizes[0]).toEqual({ width: 960, height: 540 })
    expect(geometry.pageSizes[1]).toEqual({ width: 100, height: 200 })
  })
})

describe('isSlidePageSize', () => {
  it('accepts the exact 960×540 slide box', () => {
    expect(isSlidePageSize({ width: SLIDE_WIDTH_PT, height: SLIDE_HEIGHT_PT })).toBe(true)
  })

  it('accepts Chromium rounding within tolerance', () => {
    expect(isSlidePageSize({ width: 959.5, height: 540.3 })).toBe(true)
  })

  it('rejects a genuinely mis-sized box (e.g. A4 portrait)', () => {
    expect(isSlidePageSize({ width: 595, height: 842 })).toBe(false)
  })
})

describe('mergeSlidePdfs', () => {
  it('merges N single-page PDFs into one, preserving page order', async () => {
    // Each input is a single page with a distinct height marking its position.
    const inputs = await Promise.all([
      pdfWithPages([[960, 511]]),
      pdfWithPages([[960, 522]]),
      pdfWithPages([[960, 533]]),
    ])
    const merged = await mergeSlidePdfs(inputs, { creationDate: new Date(0) })
    const geometry = await pdfGeometry(merged)
    expect(geometry.pageCount).toBe(3)
    expect(geometry.pageSizes.map((s) => s.height)).toEqual([511, 522, 533])
  })

  it('takes only the first page of a slide that overflowed to multiple pages', async () => {
    const overflowing = await pdfWithPages([
      [960, 540],
      [960, 999],
    ])
    const merged = await mergeSlidePdfs([overflowing])
    const geometry = await pdfGeometry(merged)
    expect(geometry.pageCount).toBe(1)
    expect(geometry.pageSizes[0]?.height).toBe(540)
  })

  it('writes the deck title into the merged document metadata', async () => {
    const merged = await mergeSlidePdfs([await pdfWithPages([[960, 540]])], { title: 'Q3 Review' })
    const reloaded = await PDFDocument.load(merged)
    expect(reloaded.getTitle()).toBe('Q3 Review')
  })

  it('rejects non-PDF bytes rather than writing garbage', async () => {
    await expect(mergeSlidePdfs([new Uint8Array([1, 2, 3])])).rejects.toBeInstanceOf(Error)
  })
})
