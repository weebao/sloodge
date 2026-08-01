import { describe, expect, it } from 'vitest'
import { unzipSync, strFromU8 } from 'fflate'
import { writeDeckPptx } from '../../../src/main/export/pptx-writer'
import type { DeckPptxPlan, SlidePlan } from '../../../src/shared/export/pptx/types'

/**
 * The pptxgenjs emission edge, tested against the *real* library (it is pure JS, no electron). This is
 * the OPC-validity proof: the produced `.pptx` is unzipped and asserted on — the mandatory
 * `[Content_Types].xml`, one `ppt/slides/slideN.xml` per slide, editable `<a:t>` text on structured
 * slides, and an embedded `ppt/media/*` picture on raster slides.
 */

const PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

const structuredSlide: SlidePlan = {
  tier: 'structured',
  background: { color: '112233' },
  shapes: [
    {
      kind: 'text',
      box: { x: 1, y: 1, w: 5, h: 1 },
      runs: [{ text: 'Editable Title', bold: true, color: 'FFFFFF', fontSize: 40 }],
      align: 'center',
      valign: 'top',
    },
    {
      kind: 'rect',
      box: { x: 0.5, y: 3, w: 3, h: 1.5 },
      fill: { color: '00AA00', transparency: 20 },
    },
    {
      kind: 'roundRect',
      box: { x: 5, y: 3, w: 3, h: 1.5 },
      fill: { color: 'FF0000' },
      rectRadius: 0.2,
    },
    { kind: 'ellipse', box: { x: 9, y: 3, w: 2, h: 2 }, line: { color: '000000', width: 2 } },
    {
      kind: 'line',
      box: { x: 0, y: 6, w: 6, h: 0 },
      line: { color: '000000', width: 1, dashType: 'dash' },
    },
  ],
  notes: '[Slide text]\nEditable Title',
  confidence: 100,
  reasons: [],
}

const rasterSlide: SlidePlan = {
  tier: 'raster',
  shapes: [],
  rasterDataUrl: PNG,
  notes: '[Slide text]\nA picture',
  confidence: 40,
  reasons: ['multi-primitive SVG(s)'],
}

async function build(plan: DeckPptxPlan): Promise<Record<string, Uint8Array>> {
  const bytes = await writeDeckPptx(plan)
  return unzipSync(bytes)
}

describe('writeDeckPptx (OPC validity)', () => {
  it('produces a valid OPC package with one slide part per plan slide', async () => {
    const files = await build({
      title: 'Deck',
      author: 'Sloodge',
      slides: [structuredSlide, rasterSlide, structuredSlide],
    })
    expect('[Content_Types].xml' in files).toBe(true)
    const slideParts = Object.keys(files).filter((p) => /^ppt\/slides\/slide\d+\.xml$/.test(p))
    expect(slideParts).toHaveLength(3)
  })

  it('emits editable <a:t> text for structured slides (really editable, not a picture)', async () => {
    const files = await build({ title: 'D', author: 'Sloodge', slides: [structuredSlide] })
    const xml = strFromU8(files['ppt/slides/slide1.xml']!)
    expect(xml).toContain('Editable Title')
    expect(xml).toContain('<a:t>')
  })

  it('embeds a media image for raster slides', async () => {
    const files = await build({ title: 'D', author: 'Sloodge', slides: [rasterSlide] })
    expect(Object.keys(files).some((p) => /^ppt\/media\/.+\.png$/.test(p))).toBe(true)
  })

  it('attaches speaker notes as a notesSlide part', async () => {
    const files = await build({ title: 'D', author: 'Sloodge', slides: [structuredSlide] })
    expect(Object.keys(files).some((p) => /^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(p))).toBe(
      true,
    )
  })
})
