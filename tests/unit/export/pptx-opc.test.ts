import { describe, expect, it } from 'vitest'
import { writeDeckPptx } from '../../../src/main/export/pptx-writer'
import { isValidPptx, pptxParts, pptxSlideCount } from '../../../src/main/export/pptx-opc'
import type { SlidePlan } from '../../../src/shared/export/pptx/types'

const slide: SlidePlan = {
  tier: 'structured',
  shapes: [
    {
      kind: 'text',
      box: { x: 1, y: 1, w: 4, h: 1 },
      runs: [{ text: 'Hi' }],
      align: 'left',
      valign: 'top',
    },
  ],
  notes: '',
  confidence: 100,
  reasons: [],
}

describe('pptx OPC inspection', () => {
  it('counts the slide parts of a produced package', async () => {
    const bytes = await writeDeckPptx({ title: 'D', author: 'Sloodge', slides: [slide, slide] })
    expect(pptxSlideCount(bytes)).toBe(2)
    expect(pptxParts(bytes)).toContain('[Content_Types].xml')
    expect(isValidPptx(bytes)).toBe(true)
  })

  it('reports invalid bytes as not a pptx rather than throwing', () => {
    expect(isValidPptx(new Uint8Array([1, 2, 3, 4]))).toBe(false)
  })
})
