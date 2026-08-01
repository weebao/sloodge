import { afterEach, describe, expect, it, vi } from 'vitest'

/**
 * BEHAVIORAL proof that `SafePptxDeck` sanitizes on every forwarding path (M4.3, review round 4).
 *
 * Round 3 enforced the boundary with a *textual* check — the adapter file contains the string
 * `deepSanitizeXmlStrings`, plus a grep for method names. Round 4 showed that is not enforcement: the
 * sanitize call could be deleted from `addImage`, `setBackground`, `addShape`'s options and
 * `addText`'s options and the whole suite stayed green, because real pptxgenjs happens to normalize
 * those particular fields (hex-validated colours, MIME-normalized data URLs, closed-union aligns).
 * "Inert by accident of the library's behaviour" is the same gap shape that cost three rounds.
 *
 * So the adapter is driven against a **fake pptxgenjs that records exactly what it received**, with an
 * illegal character (a C0 *and* U+FFFE) seeded into every string-bearing position each method accepts
 * — nested option objects, array elements, and object KEYS — and each test asserts the fake was handed
 * the *sanitized* value. Deleting any single sanitize call now reds its own test by construction,
 * whatever the real library would have masked.
 */

const BELL = String.fromCharCode(0x07)
const NON_CHAR = String.fromCharCode(0xfffe)
/** Seeded into every string position; both halves must be gone downstream. */
const DIRT = `${BELL}${NON_CHAR}`

type Recorded = { method: string; args: unknown[] }

const mocks = vi.hoisted(() => {
  const calls: { method: string; args: unknown[] }[] = []
  const props: Record<string, unknown> = {}

  class FakeSlide {
    private bg: unknown
    addText(...args: unknown[]): void {
      calls.push({ method: 'addText', args })
    }
    addShape(...args: unknown[]): void {
      calls.push({ method: 'addShape', args })
    }
    addImage(...args: unknown[]): void {
      calls.push({ method: 'addImage', args })
    }
    addNotes(...args: unknown[]): void {
      calls.push({ method: 'addNotes', args })
    }
    set background(value: unknown) {
      this.bg = value
      calls.push({ method: 'background', args: [value] })
    }
    get background(): unknown {
      return this.bg
    }
  }

  class FakePptx {
    defineLayout(...args: unknown[]): void {
      calls.push({ method: 'defineLayout', args })
    }
    set layout(v: unknown) {
      props['layout'] = v
      calls.push({ method: 'layout', args: [v] })
    }
    set author(v: unknown) {
      props['author'] = v
      calls.push({ method: 'author', args: [v] })
    }
    set title(v: unknown) {
      props['title'] = v
      calls.push({ method: 'title', args: [v] })
    }
    addSlide(): FakeSlide {
      calls.push({ method: 'addSlide', args: [] })
      return new FakeSlide()
    }
    write(...args: unknown[]): Promise<Buffer> {
      calls.push({ method: 'write', args })
      return Promise.resolve(Buffer.from('FAKE-PPTX-BYTES'))
    }
  }

  return { FakePptx, calls, props }
})

vi.mock('pptxgenjs', () => ({ default: mocks.FakePptx }))

const { createSafePptxDeck } = await import('../../../src/main/export/safe-pptx')

afterEach(() => {
  mocks.calls.length = 0
  for (const key of Object.keys(mocks.props)) delete mocks.props[key]
})

/** Every string anywhere inside `value` — walks arrays, plain objects, and object KEYS. */
function allStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') {
    out.push(value)
  } else if (Array.isArray(value)) {
    for (const item of value) allStrings(item, out)
  } else if (value !== null && typeof value === 'object') {
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out.push(key)
      allStrings(item, out)
    }
  }
  return out
}

/** The core assertion: nothing the fake received, anywhere, still carries an illegal character. */
function expectNoDirt(recorded: Recorded[]): void {
  for (const call of recorded) {
    for (const found of allStrings(call.args)) {
      expect(
        found.includes(BELL),
        `C0 survived into ${call.method}: ${JSON.stringify(found)}`,
      ).toBe(false)
      expect(
        found.includes(NON_CHAR),
        `U+FFFE survived into ${call.method}: ${JSON.stringify(found)}`,
      ).toBe(false)
    }
  }
}

const callsTo = (method: string): Recorded[] => mocks.calls.filter((c) => c.method === method)

function dirtyDeck(): ReturnType<typeof createSafePptxDeck> {
  return createSafePptxDeck({
    layoutName: `LAYOUT${DIRT}`,
    widthInches: 13.333,
    heightInches: 7.5,
    author: `Author${DIRT}`,
    title: `Title${DIRT}`,
  })
}

describe('SafePptxDeck — constructor (author / title / layoutName)', () => {
  it('sanitizes the deck metadata before pptxgenjs sees it', () => {
    dirtyDeck()
    expectNoDirt(mocks.calls)
    expect(mocks.props['author']).toBe('Author')
    expect(mocks.props['title']).toBe('Title')
    expect(mocks.props['layout']).toBe('LAYOUT')
    expect(callsTo('defineLayout')[0]?.args[0]).toMatchObject({ name: 'LAYOUT' })
  })
})

describe('SafePptxDeck — addText', () => {
  it('sanitizes run text, per-run options (fontFace, nested hyperlink.url), and the text options', () => {
    const slide = dirtyDeck().addSlide()
    slide.addText(
      [
        {
          text: `Body${DIRT}`,
          options: {
            fontFace: `Inter${DIRT}`,
            hyperlink: { url: `https://x.test/${DIRT}`, tooltip: `Tip${DIRT}` },
            [`optKey${DIRT}`]: `optValue${DIRT}`,
            bullet: { code: `2022${DIRT}` },
          },
        },
      ],
      { align: `left${DIRT}`, [`textKey${DIRT}`]: `textValue${DIRT}` },
    )

    expectNoDirt(mocks.calls)
    const [runs, textOptions] = callsTo('addText')[0]!.args as [
      { text: string; options: Record<string, unknown> }[],
      Record<string, unknown>,
    ]
    expect(runs[0]!.text).toBe('Body')
    expect(runs[0]!.options['fontFace']).toBe('Inter')
    expect(runs[0]!.options['hyperlink']).toEqual({ url: 'https://x.test/', tooltip: 'Tip' })
    expect(runs[0]!.options['optKey']).toBe('optValue')
    expect(runs[0]!.options['bullet']).toEqual({ code: '2022' })
    expect(textOptions['align']).toBe('left')
    expect(textOptions['textKey']).toBe('textValue')
  })
})

describe('SafePptxDeck — addShape', () => {
  it('sanitizes the shape name AND every string in its options, including nested and keys', () => {
    const slide = dirtyDeck().addSlide()
    slide.addShape(`rect${DIRT}` as 'rect', {
      fill: { color: `FF0000${DIRT}` },
      line: { color: `000000${DIRT}`, dashType: `dash${DIRT}` },
      [`shapeKey${DIRT}`]: `shapeValue${DIRT}`,
    })

    expectNoDirt(mocks.calls)
    const [name, options] = callsTo('addShape')[0]!.args as [string, Record<string, unknown>]
    expect(name).toBe('rect')
    expect(options['fill']).toEqual({ color: 'FF0000' })
    expect(options['line']).toEqual({ color: '000000', dashType: 'dash' })
    expect(options['shapeKey']).toBe('shapeValue')
  })
})

describe('SafePptxDeck — addImage', () => {
  it('sanitizes every string in the image options, including nested and keys', () => {
    const slide = dirtyDeck().addSlide()
    slide.addImage({
      data: `data:image/png;base64,AAAA${DIRT}`,
      altText: `Alt${DIRT}`,
      hyperlink: { url: `https://img.test/${DIRT}` },
      [`imgKey${DIRT}`]: `imgValue${DIRT}`,
    })

    expectNoDirt(mocks.calls)
    const options = callsTo('addImage')[0]!.args[0] as Record<string, unknown>
    expect(options['data']).toBe('data:image/png;base64,AAAA')
    expect(options['altText']).toBe('Alt')
    expect(options['hyperlink']).toEqual({ url: 'https://img.test/' })
    expect(options['imgKey']).toBe('imgValue')
  })
})

describe('SafePptxDeck — addNotes', () => {
  it('sanitizes the notes text', () => {
    const slide = dirtyDeck().addSlide()
    slide.addNotes(`Speaker${DIRT} notes`)

    expectNoDirt(mocks.calls)
    expect(callsTo('addNotes')[0]!.args[0]).toBe('Speaker notes')
  })

  it('does not emit a notes part when the text is entirely illegal characters', () => {
    const slide = dirtyDeck().addSlide()
    slide.addNotes(DIRT)
    expect(callsTo('addNotes')).toHaveLength(0)
  })
})

describe('SafePptxDeck — setBackground', () => {
  it('sanitizes a colour background', () => {
    const slide = dirtyDeck().addSlide()
    slide.setBackground({ color: `112233${DIRT}` })

    expectNoDirt(mocks.calls)
    expect(callsTo('background')[0]!.args[0]).toEqual({ color: '112233' })
  })

  it('sanitizes a data-URL background', () => {
    const slide = dirtyDeck().addSlide()
    slide.setBackground({ data: `data:image/png;base64,BBBB${DIRT}` })

    expectNoDirt(mocks.calls)
    expect(callsTo('background')[0]!.args[0]).toEqual({ data: 'data:image/png;base64,BBBB' })
  })
})

describe('SafePptxDeck — write', () => {
  it('requests a node buffer and normalizes it to a Uint8Array', async () => {
    const bytes = await dirtyDeck().write()
    expect(callsTo('write')[0]!.args[0]).toMatchObject({ outputType: 'nodebuffer' })
    expect(bytes).toBeInstanceOf(Uint8Array)
    expect(Buffer.from(bytes).toString()).toBe('FAKE-PPTX-BYTES')
  })
})

describe('SafePptxDeck — the whole surface, one payload', () => {
  it('lets no illegal character through ANY forwarding method', () => {
    const deck = dirtyDeck()
    const slide = deck.addSlide()
    slide.addText([{ text: `t${DIRT}`, options: { fontFace: `f${DIRT}` } }], { align: `a${DIRT}` })
    slide.addShape(`ellipse${DIRT}` as 'ellipse', { fill: { color: `ABCDEF${DIRT}` } })
    slide.addImage({ data: `d${DIRT}` })
    slide.addNotes(`n${DIRT}`)
    slide.setBackground({ color: `C0FFEE${DIRT}` })

    // Every recorded call, every nested string, every key.
    expectNoDirt(mocks.calls)
    // Non-vacuity: the fake really was driven on each path.
    for (const method of ['addText', 'addShape', 'addImage', 'addNotes', 'background']) {
      expect(callsTo(method).length, method).toBeGreaterThan(0)
    }
  })
})
