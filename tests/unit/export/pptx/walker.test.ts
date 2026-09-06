import { describe, expect, it } from 'vitest'
import {
  layOutInline,
  renderedBlockText,
  slideTextForNotes,
  walkSlide,
} from '../../../../src/shared/export/pptx/walker'
import type { InlineItem } from '../../../../src/shared/export/pptx/node'
import type { ShapeSpec } from '../../../../src/shared/export/pptx/types'
import {
  ancestorMatrix,
  makeMeasure,
  makeNode,
  makeRootPaint,
  runStyleOf,
  textItem,
  uniformBorder,
} from './_fixtures'

const textShapes = (shapes: ShapeSpec[]): Extract<ShapeSpec, { kind: 'text' }>[] =>
  shapes.filter((s): s is Extract<ShapeSpec, { kind: 'text' }> => s.kind === 'text')

/** The structured DOM→shape mapping (§3.2–§3.3). */
describe('walkSlide text mapping', () => {
  it('emits an editable text box from a leaf, mapping the box to inches and style to runs', () => {
    const node = makeNode({
      tag: 'h1',
      text: 'Hello',
      x: 96,
      y: 48,
      w: 192,
      h: 96,
      style: {
        fontSize: 32,
        fontWeight: '700',
        fontStyle: 'italic',
        textDecorationLine: 'underline',
        color: 'rgb(255, 0, 0)',
        textAlign: 'center',
        fontFamily: 'Georgia, serif',
      },
    })
    const { shapes } = walkSlide(makeMeasure([node]))
    const text = textShapes(shapes)
    expect(text).toHaveLength(1)
    const t = text[0]!
    expect(t.box).toEqual({ x: 1, y: 0.5, w: 2, h: 1 })
    expect(t.align).toBe('center')
    expect(t.runs[0]).toMatchObject({
      text: 'Hello',
      bold: true,
      italic: true,
      underline: true,
      color: 'FF0000',
      fontFace: 'georgia',
      fontSize: 24, // 32px * 0.75
    })
  })

  it('applies text-transform: uppercase to the run text', () => {
    const node = makeNode({ text: 'quiet', style: { textTransform: 'uppercase' } })
    const t = textShapes(walkSlide(makeMeasure([node])).shapes)[0]!
    expect(t.runs[0]!.text).toBe('QUIET')
  })

  it('emits bullets for list items and a hyperlink for <a>', () => {
    const ul = makeNode({ tag: 'span', text: 'item', listType: 'ul' })
    const ol = makeNode({ tag: 'span', text: 'one', listType: 'ol' })
    const link = makeNode({
      tag: 'a',
      inlineContent: [textItem('go', {}, { href: 'https://x.test' })],
    })
    const shapes = textShapes(walkSlide(makeMeasure([ul, ol, link])).shapes)
    expect(shapes[0]!.runs[0]!.bullet).toBe(true)
    expect(shapes[1]!.runs[0]!.bullet).toEqual({ type: 'number' })
    expect(shapes[2]!.runs[0]!.hyperlink).toBe('https://x.test')
  })

  it('emits no bullet for a `list-style: none` chip row', () => {
    // A `<ul style="list-style: none">` used as a chip/tag/nav row is one of the commonest patterns
    // in generated slide HTML; it used to ship one `<a:buChar>` per chip, glyphs the reader never
    // saw and the metric could not see either (review r2).
    const chip = makeNode({
      tag: 'li',
      text: 'Discovery',
      listType: 'ul',
      style: { listStyleType: 'none' },
    })
    const [shape] = textShapes(walkSlide(makeMeasure([chip])).shapes)
    expect(shape!.runs[0]!.bullet).toBeUndefined()
  })

  it('does not double-render: a block with no text of its own and no paint contributes no shape', () => {
    const wrapper = makeNode({ tag: 'div' })
    expect(walkSlide(makeMeasure([wrapper])).shapes).toHaveLength(0)
  })
})

/**
 * Run-level text (M4.8b). The measurement pass records text nodes raw; everything the reader sees
 * — collapsed spaces, trimmed line edges, `<br>`s, `text-transform` — is decided here, so it is
 * pinned against EXACT strings. The fidelity oracle's substring check cannot tell "a b c" from
 * "ab c"; these can.
 */
describe('layOutInline white-space processing (M4.8b)', () => {
  const fallback = runStyleOf()
  const texts = (items: InlineItem[]): string[][] =>
    layOutInline(items, fallback).map((p) => p.map((r) => r.text))

  it('keeps one run per text node with the spaces between them intact: "a " + "b" + " c"', () => {
    const items = [textItem('a '), textItem('b', { fontWeight: '700' }), textItem(' c')]
    expect(texts(items)).toEqual([['a ', 'b', ' c']])
  })

  it('collapses source formatting: newlines and indentation become one space, line edges are trimmed', () => {
    // `<p>\n  Growth was driven by <strong>enterprise expansion</strong> and a\n  <em>lower</em> than\n  forecast.\n</p>`
    const items = [
      textItem('\n  Growth was driven by '),
      textItem('enterprise expansion', { fontWeight: '700' }),
      textItem(' and a\n  '),
      textItem('lower', { fontStyle: 'italic' }),
      textItem(' than\n  forecast.\n'),
    ]
    const [paragraph] = texts(items)
    expect(paragraph).toEqual([
      'Growth was driven by ',
      'enterprise expansion',
      ' and a ',
      'lower',
      ' than forecast.',
    ])
    expect(paragraph!.join('')).toBe(
      'Growth was driven by enterprise expansion and a lower than forecast.',
    )
  })

  it('drops a collapsible space that follows another one across a run boundary', () => {
    // `a <span> </span> b` — three nodes, two spaces between the words in the source, one rendered.
    expect(texts([textItem('a '), textItem(' '), textItem(' b')])).toEqual([['a ', 'b']])
    // Mutation: emit the runs verbatim → 'a ', ' ', ' b' → the reader sees three spaces.
  })

  it('never collapses a non-breaking space', () => {
    expect(texts([textItem('Non\u00a0breaking  space')])).toEqual([['Non\u00a0breaking space']])
  })

  it('turns <br> into a line break inside the paragraph, and drops the one a trailing <br> would add', () => {
    const laid = layOutInline(
      [textItem('one'), { kind: 'br' }, textItem(' two'), { kind: 'br' }],
      fallback,
    )
    expect(laid).toHaveLength(1)
    expect(laid[0]!.map((r) => [r.text, r.lineBreakBefore])).toEqual([
      ['one', false],
      ['two', true],
    ])
    // `a<br><br>` does render an empty second line.
    const double = layOutInline([textItem('a'), { kind: 'br' }, { kind: 'br' }], fallback)
    expect(double[0]!.map((r) => [r.text, r.lineBreakBefore])).toEqual([
      ['a', false],
      ['', true],
    ])
  })

  it('preserves spaces and turns newlines into line breaks under white-space: pre; pre-line collapses spaces only', () => {
    const pre = layOutInline(
      [textItem('line one\n    line two', {}, { whiteSpace: 'preserve' })],
      fallback,
    )
    expect(pre[0]!.map((r) => [r.text, r.lineBreakBefore])).toEqual([
      ['line one', false],
      ['    line two', true],
    ])
    const preLine = layOutInline(
      [textItem('  first   line\n  second   line  ', {}, { whiteSpace: 'preserve-breaks' })],
      fallback,
    )
    expect(preLine[0]!.map((r) => r.text)).toEqual(['first line', 'second line'])
  })

  it('splits paragraphs at a nested block and keeps the block itself out of this box', () => {
    const items: InlineItem[] = [
      textItem('\n  Intro\n  '),
      { kind: 'block' },
      textItem('\n  more\n'),
    ]
    const laid = layOutInline(items, fallback)
    expect(laid.map((p) => p.map((r) => r.text))).toEqual([['Intro'], ['more']])
  })

  it('emits nothing for content that is only formatting white space, and drops an atomic inline silently', () => {
    expect(texts([textItem('\n  '), { kind: 'block' }, textItem('\n')])).toEqual([])
    // `Rate: <span class="pill">24%</span> up` — the pill is its own box; its neighbours collapse
    // to a single space between them (and the scorer names the gap).
    expect(texts([textItem('Rate: '), { kind: 'box' }, textItem(' up')])).toEqual([
      ['Rate: ', 'up'],
    ])
  })

  it('applies text-transform per run, with capitalize carrying the word boundary across runs', () => {
    expect(texts([textItem('quiet', { textTransform: 'uppercase' })])).toEqual([['QUIET']])
    expect(texts([textItem('LOUD', { textTransform: 'lowercase' })])).toEqual([['loud']])
    expect(
      texts([textItem("capitalize each word, don't split", { textTransform: 'capitalize' })]),
    ).toEqual([["Capitalize Each Word, Don't Split"]])
    // `<p style="text-transform: capitalize">hello <b>w</b>orld</p>`: "orld" continues a word.
    const cap = { textTransform: 'capitalize' }
    expect(texts([textItem('hello ', cap), textItem('w', cap), textItem('orld', cap)])).toEqual([
      ['Hello ', 'W', 'orld'],
    ])
  })
})

describe('walkSlide run-level text boxes (M4.8b)', () => {
  it('emits ONE box with three runs for <p>a <strong>b</strong> c</p>, the strong bold, all in the inherited colour', () => {
    const p = makeNode({
      tag: 'p',
      x: 72,
      y: 398,
      w: 1136,
      h: 24,
      style: { color: 'rgb(203, 213, 225)', fontSize: 20 },
      inlineContent: [
        textItem('Growth was driven by ', { color: 'rgb(203, 213, 225)', fontSize: 20 }),
        textItem('enterprise expansion', {
          color: 'rgb(203, 213, 225)',
          fontSize: 20,
          fontWeight: '700',
        }),
        textItem(' than forecast.', { color: 'rgb(203, 213, 225)', fontSize: 20 }),
      ],
    })
    // The <strong> is a node too (it has a rect) but carries no text of its own and paints nothing.
    const strong = makeNode({ tag: 'strong', inlineOf: p.domIndex, x: 296, y: 398, w: 239, h: 24 })
    const shapes = walkSlide(makeMeasure([p, strong])).shapes
    expect(shapes).toHaveLength(1)
    const [box] = textShapes(shapes)
    expect(box!.box).toEqual({ x: 0.75, y: 398 / 96, w: 1136 / 96, h: 0.25 })
    expect(box!.runs.map((r) => r.text)).toEqual([
      'Growth was driven by ',
      'enterprise expansion',
      ' than forecast.',
    ])
    expect(box!.runs.map((r) => r.bold)).toEqual([undefined, true, undefined])
    expect(box!.runs.map((r) => r.color)).toEqual(['CBD5E1', 'CBD5E1', 'CBD5E1'])
    expect(box!.runs.map((r) => r.fontSize)).toEqual([15, 15, 15])
  })

  it("carries a run's own size, colour, decoration, letter spacing and opacity — not the block's", () => {
    const p = makeNode({
      tag: 'p',
      style: { fontSize: 20, color: 'rgb(0, 0, 0)' },
      inlineContent: [
        textItem('Sized ', { fontSize: 20 }),
        textItem(
          'bigger',
          {
            fontSize: 34,
            color: 'rgba(244, 114, 182, 0.5)',
            textDecorationLine: 'underline line-through',
            letterSpacing: '2px',
            fontStyle: 'italic',
          },
          { opacity: 0.5, href: 'https://x.test' },
        ),
      ],
    })
    const [box] = textShapes(walkSlide(makeMeasure([p])).shapes)
    expect(box!.runs[0]).toEqual({
      text: 'Sized ',
      color: '000000',
      fontFace: 'arial',
      fontSize: 15,
    })
    expect(box!.runs[1]).toEqual({
      text: 'bigger',
      italic: true,
      underline: true,
      strike: true,
      color: 'F472B6',
      transparency: 75, // 0.5 alpha × 0.5 opacity
      fontFace: 'arial',
      fontSize: 25.5,
      charSpacing: 1.5,
      hyperlink: 'https://x.test',
    })
  })

  it('marks line and paragraph breaks on the run that starts the new line/paragraph', () => {
    const li = makeNode({
      tag: 'li',
      listType: 'ul',
      inlineContent: [
        textItem('one'),
        { kind: 'br' },
        textItem('two'),
        { kind: 'block' },
        textItem('after'),
      ],
    })
    const [box] = textShapes(walkSlide(makeMeasure([li])).shapes)
    expect(box!.runs.map((r) => [r.text, r.lineBreakBefore, r.paragraphBreakBefore])).toEqual([
      ['one', undefined, undefined],
      ['two', true, undefined],
      ['after', undefined, true],
    ])
    // One marker per <li>, on the first paragraph only — Chromium draws one, not one per line.
    expect(box!.runs.map((r) => r.bullet)).toEqual([true, undefined, undefined])
  })

  it("insets the runs by padding plus border width, so a padded pill's label lands on its content box", () => {
    const pill = makeNode({
      tag: 'span',
      text: 'Shipped',
      w: 120,
      h: 40,
      style: {
        paddingTop: '8px',
        paddingRight: '18px',
        paddingBottom: '8px',
        paddingLeft: '18px',
        ...uniformBorder('2px', 'rgb(185, 28, 28)'),
      },
    })
    const [box] = textShapes(walkSlide(makeMeasure([pill])).shapes)
    // (18 + 2) px × 0.75 = 15 pt; (8 + 2) px × 0.75 = 7.5 pt.
    expect(box!.inset).toEqual({ left: 15, top: 7.5, right: 15, bottom: 7.5 })
    // An unpadded block carries no inset at all (the writer then passes `margin: 0`).
    const plain = makeNode({ text: 'Plain' })
    expect(textShapes(walkSlide(makeMeasure([plain])).shapes)[0]!.inset).toBeUndefined()
  })

  it('scales the inset with a scaled element, like the font size', () => {
    const scaled = makeNode({
      text: '42%',
      w: 220,
      h: 110,
      layoutW: 110,
      layoutH: 55,
      style: { paddingLeft: '10px', transform: 'matrix(2, 0, 0, 2, 0, 0)' },
    })
    const [box] = textShapes(walkSlide(makeMeasure([scaled])).shapes)
    expect(box!.inset).toEqual({ left: 15, top: 0, right: 0, bottom: 0 })
  })

  it("paints an inline highlight UNDER the paragraph's glyphs: block fill, span fill, then the bare text box", () => {
    const p = makeNode({
      tag: 'p',
      x: 0,
      y: 0,
      w: 400,
      h: 30,
      style: { backgroundColor: 'rgb(15, 23, 42)' },
      inlineContent: [textItem('with '), textItem('record retention'), textItem(' in')],
    })
    const hi = makeNode({
      tag: 'span',
      inlineOf: p.domIndex,
      x: 50,
      y: 0,
      w: 120,
      h: 30,
      style: { backgroundColor: 'rgb(253, 230, 138)', borderRadius: '4px' },
    })
    const shapes = walkSlide(makeMeasure([p, hi])).shapes
    expect(shapes.map((s) => s.kind)).toEqual(['rect', 'roundRect', 'text'])
    expect(shapes[0]).toMatchObject({ fill: { color: '0F172A' }, box: { x: 0, w: 400 / 96 } })
    expect(shapes[1]).toMatchObject({ fill: { color: 'FDE68A' }, box: { x: 50 / 96, w: 120 / 96 } })
    // The text box is bare — its fill went out first — and is emitted exactly once.
    expect(shapes[2]).not.toHaveProperty('fill')
    expect(shapes.filter((s) => s.kind === 'text')).toHaveLength(1)
    // Mutation: emit the span at its DOM position → order becomes text, roundRect and the yellow
    // rect covers the words.
  })

  it('emits an inline element that paints but whose block has no text under the plain paint rule', () => {
    const div = makeNode({ tag: 'div' })
    const dot = makeNode({
      tag: 'span',
      inlineOf: div.domIndex,
      style: { backgroundColor: 'rgb(255, 0, 0)' },
    })
    const shapes = walkSlide(makeMeasure([div, dot])).shapes
    expect(shapes.map((s) => s.kind)).toEqual(['rect'])
  })

  it("renders a block's text as its lines, for the notes layer and the oracle", () => {
    const li = makeNode({
      inlineContent: [
        textItem('one'),
        { kind: 'br' },
        textItem(' two '),
        { kind: 'block' },
        textItem('after'),
      ],
    })
    expect(renderedBlockText(li)).toBe('one\ntwo\nafter')
  })
})

describe('walkSlide shape mapping', () => {
  it('emits a filled rect for a painted container (container-paint rule)', () => {
    const node = makeNode({ style: { backgroundColor: 'rgb(0, 128, 255)' } })
    const shapes = walkSlide(makeMeasure([node])).shapes
    expect(shapes[0]).toMatchObject({ kind: 'rect', fill: { color: '0080FF' } })
  })

  it('emits a roundRect when a painted container has a corner radius', () => {
    const node = makeNode({
      w: 200,
      h: 100,
      style: { backgroundColor: 'rgb(10, 10, 10)', borderRadius: '12px' },
    })
    const shape = walkSlide(makeMeasure([node])).shapes[0]
    expect(shape?.kind).toBe('roundRect')
  })

  it('emits an ellipse when the radius makes the box a circle', () => {
    const node = makeNode({
      w: 100,
      h: 100,
      style: { backgroundColor: 'rgb(10, 10, 10)', borderRadius: '50px' },
    })
    expect(walkSlide(makeMeasure([node])).shapes[0]?.kind).toBe('ellipse')
  })

  it('maps a visible border to a line spec on the shape', () => {
    const node = makeNode({
      style: {
        backgroundColor: 'rgb(255, 255, 255)',
        ...uniformBorder('2px', 'rgb(0, 0, 0)', 'dashed'),
      },
    })
    const shape = walkSlide(makeMeasure([node])).shapes[0]
    expect(shape).toMatchObject({ line: { color: '000000', dashType: 'dash' } })
  })

  it('orders emission by (zIndex, domIndex)', () => {
    const back = makeNode({ text: 'back', z: 0, domIndex: 5 })
    const front = makeNode({ text: 'front', z: 10, domIndex: 1 })
    const shapes = textShapes(walkSlide(makeMeasure([front, back])).shapes)
    expect(shapes.map((s) => s.runs[0]!.text)).toEqual(['back', 'front'])
  })
})

describe('walkSlide background and coverage', () => {
  it('maps a solid body background to a slide fill', () => {
    const measure = makeMeasure([makeNode({ text: 'x' })], {
      body: makeRootPaint({ backgroundColor: 'rgb(17, 34, 51)' }),
    })
    expect(walkSlide(measure).background).toEqual({ color: '112233' })
  })

  it('reports full coverage for a text-only slide and reduced coverage when media is present', () => {
    const textOnly = makeMeasure([makeNode({ text: 'x', w: 100, h: 100 })])
    expect(walkSlide(textOnly).coveredFraction).toBe(1)

    const withImage = makeMeasure([
      makeNode({ text: 'x', w: 100, h: 100 }),
      makeNode({ tag: 'img', src: 'p.png', w: 100, h: 100 }),
    ])
    expect(walkSlide(withImage).coveredFraction).toBeLessThan(1)
  })
})

/** -14° as Chromium serializes it: matrix(cos, sin, -sin, cos, 0, 0). */
const ROT_MINUS_14 = 'matrix(0.970296, -0.241922, 0.241922, 0.970296, 0, 0)'
const ROT_90 = 'matrix(0, 1, -1, 0, 0, 0)'

describe('walkSlide rotation (M4.8a)', () => {
  it('decomposes rot from the transform matrix and hands PowerPoint the unrotated, centred box', () => {
    // A 200×100 layout box rotated -14° has axis-aligned bounds 218.25×148.38 (w·cos+h·sin, w·sin+h·cos).
    const node = makeNode({
      text: 'CONFIDENTIAL',
      x: 400 - 218.251 / 2,
      y: 300 - 148.377 / 2,
      w: 218.251,
      h: 148.377,
      layoutW: 200,
      layoutH: 100,
      style: { transform: ROT_MINUS_14 },
    })
    const t = textShapes(walkSlide(makeMeasure([node])).shapes)[0]!
    expect(t.rotate).toBeCloseTo(346, 3)
    // Centre preserved, size from the layout box, not the bounds. (Mutation: emit the measured rect →
    // box.w would be 218.25/96 and rotate undefined.)
    expect(t.box.x * 96).toBeCloseTo(300, 6)
    expect(t.box.y * 96).toBeCloseTo(250, 6)
    expect(t.box.w * 96).toBe(200)
    expect(t.box.h * 96).toBe(100)
  })

  it("composes a transformed ancestor into the child's rotation", () => {
    const node = makeNode({
      w: 100,
      h: 50,
      layoutW: 50,
      layoutH: 100,
      style: { backgroundColor: 'rgb(0, 0, 0)' },
      ancestorTransforms: [ancestorMatrix(ROT_90)],
    })
    const shape = walkSlide(makeMeasure([node])).shapes[0]!
    expect(shape.kind).toBe('rect')
    expect((shape as { rotate?: number }).rotate).toBe(90)
    expect(shape.box.w * 96).toBe(50)
    expect(shape.box.h * 96).toBe(100)
  })

  it('leaves the measured rect alone for translate/none and for skew (no single angle)', () => {
    const plain = makeNode({
      text: 'a',
      style: { transform: 'matrix(1, 0, 0, 1, 30, 0)' },
    })
    const skewed = makeNode({
      text: 'b',
      style: { transform: 'matrix(1, 0.5, 0, 1, 0, 0)' },
    })
    const shapes = textShapes(walkSlide(makeMeasure([plain, skewed])).shapes)
    expect(shapes[0]!.rotate).toBeUndefined()
    expect(shapes[1]!.rotate).toBeUndefined()
    expect(shapes[1]!.box).toEqual({ x: 0, y: 0, w: 100 / 96, h: 50 / 96 })
  })
})

describe('walkSlide text-box decoration (M4.8a)', () => {
  it("keeps a leaf text box's border and corner radius instead of dropping them", () => {
    const node = makeNode({
      text: 'Shipped',
      w: 120,
      h: 40,
      style: {
        ...uniformBorder('6px', 'rgb(185, 28, 28)'),
        borderRadius: '8px',
      },
    })
    const t = textShapes(walkSlide(makeMeasure([node])).shapes)[0]!
    expect(t.line).toEqual({ color: 'B91C1C', width: 4.5, dashType: 'solid' })
    expect(t.rectRadius).toBeCloseTo(8 / 40, 6)
  })

  it('flags a gradient body for the planner and no longer fakes coverage for it', () => {
    const measure = makeMeasure([makeNode({ text: 'x', w: 100, h: 100 })], {
      body: makeRootPaint({
        backgroundImage: 'linear-gradient(135deg, rgb(76, 29, 149) 0%, rgb(30, 58, 138) 100%)',
      }),
    })
    const walk = walkSlide(measure)
    expect(walk.bodyImage).toBe(true)
    expect(walk.background).toBeNull()
    expect(walk.coveredFraction).toBe(1)
  })
})

describe('slideTextForNotes', () => {
  it('joins the visible block text for the accessibility notes layer', () => {
    const nodes = [makeNode({ text: 'Title' }), makeNode({}), makeNode({ text: 'Body' })]
    expect(slideTextForNotes(nodes)).toBe('Title\nBody')
  })
})
