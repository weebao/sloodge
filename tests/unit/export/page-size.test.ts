import { describe, expect, it } from 'vitest'
import { pxToPoints, slidePrintToPdfOptions } from '../../../src/shared/export/page-size'
import {
  SLIDE_HEIGHT_INCHES,
  SLIDE_HEIGHT_PT,
  SLIDE_WIDTH_INCHES,
  SLIDE_WIDTH_PT,
} from '../../../src/shared/export/types'

describe('pxToPoints', () => {
  it('converts 1280×720 CSS px to the exact 960×540 pt slide box', () => {
    expect(pxToPoints(1280)).toBe(960)
    expect(pxToPoints(720)).toBe(540)
    expect(SLIDE_WIDTH_PT).toBe(960)
    expect(SLIDE_HEIGHT_PT).toBe(540)
  })

  it('is the exact px/96*72 identity', () => {
    expect(pxToPoints(96)).toBe(72)
    expect(pxToPoints(0)).toBe(0)
  })
})

describe('slidePrintToPdfOptions', () => {
  it('locks printBackground on — the single most common "PDF looks wrong" cause', () => {
    expect(slidePrintToPdfOptions().printBackground).toBe(true)
  })

  it('locks all four margins to zero — the slide is the page', () => {
    expect(slidePrintToPdfOptions().margins).toEqual({ top: 0, bottom: 0, left: 0, right: 0 })
  })

  it('sets the 16:9 slide page size in inches and prefers the slide @page', () => {
    const options = slidePrintToPdfOptions()
    expect(options.pageSize).toEqual({ width: SLIDE_WIDTH_INCHES, height: SLIDE_HEIGHT_INCHES })
    expect(options.pageSize.width).toBeCloseTo(13.333, 3)
    expect(options.pageSize.height).toBe(7.5)
    expect(options.preferCSSPageSize).toBe(true)
  })

  it('keeps scale 1, tags for accessibility, and builds no per-file outline', () => {
    const options = slidePrintToPdfOptions()
    expect(options.scale).toBe(1)
    expect(options.generateTaggedPDF).toBe(true)
    expect(options.generateDocumentOutline).toBe(false)
  })

  it('returns a fresh object each call so a caller cannot mutate a shared constant', () => {
    const a = slidePrintToPdfOptions()
    const b = slidePrintToPdfOptions()
    expect(a).not.toBe(b)
    expect(a.margins).not.toBe(b.margins)
  })
})
