import { describe, expect, it } from 'vitest'
import { unzipSync, strFromU8 } from 'fflate'
import { writeDeckPptx } from '../../../src/main/export/pptx-writer'
import { hasXmlIllegalChars } from '../../../src/shared/export/pptx/sanitize'
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

  it('emits rot on rotated text boxes and shapes, in 60000ths of a degree (M4.8a)', async () => {
    const rotated: SlidePlan = {
      tier: 'structured',
      shapes: [
        {
          kind: 'text',
          box: { x: 1, y: 1, w: 3, h: 1 },
          runs: [{ text: 'CONFIDENTIAL' }],
          align: 'left',
          valign: 'top',
          rotate: 346,
        },
        { kind: 'rect', box: { x: 1, y: 3, w: 2, h: 1 }, fill: { color: '00FF00' }, rotate: 3 },
      ],
      notes: '',
      confidence: 95,
      reasons: [],
    }
    const files = await build({ title: 'D', author: 'Sloodge', slides: [rotated] })
    const xml = strFromU8(files['ppt/slides/slide1.xml']!)
    expect(xml).toContain(`rot="${String(346 * 60000)}"`)
    expect(xml).toContain(`rot="${String(3 * 60000)}"`)
  })

  it('gives a text box with a radius roundRect geometry and forwards its border as a line', async () => {
    const pill: SlidePlan = {
      tier: 'structured',
      shapes: [
        {
          kind: 'text',
          box: { x: 1, y: 1, w: 2, h: 0.5 },
          runs: [{ text: 'Shipped' }],
          align: 'center',
          valign: 'top',
          fill: { color: 'FDE68A' },
          line: { color: 'B91C1C', width: 4.5 },
          rectRadius: 0.5,
        },
      ],
      notes: '',
      confidence: 100,
      reasons: [],
    }
    const files = await build({ title: 'D', author: 'Sloodge', slides: [pill] })
    const xml = strFromU8(files['ppt/slides/slide1.xml']!)
    expect(xml).toContain('prst="roundRect"')
    expect(xml).toContain('B91C1C')
  })

  it('writes a data-URL background as a picture background (<p:bg> with a blip) and embeds the media', async () => {
    const gradient: SlidePlan = { ...structuredSlide, background: { dataUrl: PNG } }
    const files = await build({ title: 'D', author: 'Sloodge', slides: [gradient] })
    const xml = strFromU8(files['ppt/slides/slide1.xml']!)
    expect(xml).toMatch(/<p:bg>[\s\S]*<a:blip\b[\s\S]*<\/p:bg>/)
    expect(Object.keys(files).some((p) => /^ppt\/media\/.+\.png$/.test(p))).toBe(true)
  })

  it('refuses a picture that is not a PNG/JPEG data URL — a pipeline defect, not something to embed', async () => {
    const bad: SlidePlan = {
      ...structuredSlide,
      background: { dataUrl: 'data:text/html,<b>x</b>' },
    }
    await expect(build({ title: 'D', author: 'Sloodge', slides: [bad] })).rejects.toThrow(
      /data URL/,
    )
    const badRaster: SlidePlan = { ...rasterSlide, rasterDataUrl: 'https://example.test/x.png' }
    await expect(build({ title: 'D', author: 'Sloodge', slides: [badRaster] })).rejects.toThrow(
      /data URL/,
    )
  })

  it('sanitizes ALL XML-1.0-illegal characters out of EVERY part (no corrupt .pptx)', async () => {
    const bell = String.fromCharCode(0x07) // C0
    const soh = String.fromCharCode(0x01) // C0
    const nonChar = String.fromCharCode(0xfffe) // non-character — NOT a C0 control
    const nonChar2 = String.fromCharCode(0xffff) // non-character
    const loneSurrogate = String.fromCharCode(0xd83d) // high surrogate with no low
    // The full illegal set is seeded, not just C0: round 3 showed a C0-only oracle reads a U+FFFE
    // part as clean, which is exactly how the `fontFace` hole stayed invisible. Every agent-settable
    // text field the writer can reach is dirtied — deck title and author (→ docProps/core.xml), body
    // text, a bulleted run, a hyperlink's text AND url, the FONT FAMILY (→ <a:latin typeface>), and
    // the speaker notes.
    const dirt = `${bell}${soh}${nonChar}${nonChar2}${loneSurrogate}`
    const dirty: SlidePlan = {
      tier: 'structured',
      shapes: [
        {
          kind: 'text',
          box: { x: 1, y: 1, w: 6, h: 1 },
          runs: [
            { text: `Heading${dirt} one`, fontFace: `Inter${dirt}` },
            { text: `Bullet${dirt} two`, bullet: true, fontFace: `Georgia${nonChar}` },
            {
              text: `Link${dirt} three`,
              hyperlink: `https://x.test/a${dirt}b`,
              fontFace: `Arial${loneSurrogate}`,
            },
          ],
          align: 'left',
          valign: 'top',
        },
      ],
      notes: `Notes${dirt} body 日本語 📊`,
      confidence: 100,
      reasons: [],
    }
    const files = await build({
      title: `Deck${dirt} Q3`,
      author: `Sloodge${dirt}`,
      slides: [dirty],
    })

    // The oracle, asserted FIRST so it is the primary mutation signal, and using the SAME predicate
    // the sanitizer is defined by (`hasXmlIllegalChars`) rather than a restatement — a narrower
    // duplicate here is what hid the `fontFace` hole for a round. No xml/rels part of the package may
    // contain any illegal character.
    const scanned: string[] = []
    const offenders: string[] = []
    for (const [name, data] of Object.entries(files)) {
      if (!/\.(xml|rels)$/.test(name)) continue
      scanned.push(name)
      if (hasXmlIllegalChars(strFromU8(data))) offenders.push(name)
    }
    expect(offenders).toEqual([])

    // Guard the guard: the scan must actually have covered the parts that carry our text.
    expect(scanned).toContain('ppt/slides/slide1.xml')
    expect(scanned).toContain('ppt/notesSlides/notesSlide1.xml')
    expect(scanned).toContain('docProps/core.xml')
    expect(scanned).toContain('ppt/slides/_rels/slide1.xml.rels')
    expect(scanned.length).toBeGreaterThan(10)

    // And the legal text survives — including the font family, which must still reach <a:latin>.
    const slideXml = strFromU8(files['ppt/slides/slide1.xml']!)
    expect(slideXml).toContain('Heading one')
    expect(slideXml).toContain('Bullet two')
    expect(slideXml).toContain('Inter')
    expect(slideXml).toContain('Georgia')
    expect(strFromU8(files['ppt/notesSlides/notesSlide1.xml']!)).toContain('Notes body')
    expect(strFromU8(files['ppt/notesSlides/notesSlide1.xml']!)).toContain('日本語')
    expect(strFromU8(files['docProps/core.xml']!)).toContain('Deck Q3')
  })
})
