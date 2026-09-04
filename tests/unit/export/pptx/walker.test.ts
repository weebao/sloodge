import { describe, expect, it } from 'vitest'
import { slideTextForNotes, walkSlide } from '../../../../src/shared/export/pptx/walker'
import type { ShapeSpec } from '../../../../src/shared/export/pptx/types'
import { ancestorMatrix, makeMeasure, makeNode, makeRootPaint, uniformBorder } from './_fixtures'

const textShapes = (shapes: ShapeSpec[]): Extract<ShapeSpec, { kind: 'text' }>[] =>
  shapes.filter((s): s is Extract<ShapeSpec, { kind: 'text' }> => s.kind === 'text')

/** The structured DOM→shape mapping (§3.2–§3.3). */
describe('walkSlide text mapping', () => {
  it('emits an editable text box from a leaf, mapping the box to inches and style to runs', () => {
    const node = makeNode({
      tag: 'h1',
      isLeaf: true,
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
    const node = makeNode({ isLeaf: true, text: 'quiet', style: { textTransform: 'uppercase' } })
    const t = textShapes(walkSlide(makeMeasure([node])).shapes)[0]!
    expect(t.runs[0]!.text).toBe('QUIET')
  })

  it('emits bullets for list items and a hyperlink for <a>', () => {
    const ul = makeNode({ tag: 'span', isLeaf: true, text: 'item', listType: 'ul' })
    const ol = makeNode({ tag: 'span', isLeaf: true, text: 'one', listType: 'ol' })
    const link = makeNode({ tag: 'a', isLeaf: true, text: 'go', href: 'https://x.test' })
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
      isLeaf: true,
      text: 'Discovery',
      listType: 'ul',
      style: { listStyleType: 'none' },
    })
    const [shape] = textShapes(walkSlide(makeMeasure([chip])).shapes)
    expect(shape!.runs[0]!.bullet).toBeUndefined()
  })

  it('does not double-render: a non-leaf with no paint contributes no shape', () => {
    const wrapper = makeNode({ tag: 'div', isLeaf: false })
    expect(walkSlide(makeMeasure([wrapper])).shapes).toHaveLength(0)
  })
})

describe('walkSlide shape mapping', () => {
  it('emits a filled rect for a painted container (container-paint rule)', () => {
    const node = makeNode({ isLeaf: false, style: { backgroundColor: 'rgb(0, 128, 255)' } })
    const shapes = walkSlide(makeMeasure([node])).shapes
    expect(shapes[0]).toMatchObject({ kind: 'rect', fill: { color: '0080FF' } })
  })

  it('emits a roundRect when a painted container has a corner radius', () => {
    const node = makeNode({
      isLeaf: false,
      w: 200,
      h: 100,
      style: { backgroundColor: 'rgb(10, 10, 10)', borderRadius: '12px' },
    })
    const shape = walkSlide(makeMeasure([node])).shapes[0]
    expect(shape?.kind).toBe('roundRect')
  })

  it('emits an ellipse when the radius makes the box a circle', () => {
    const node = makeNode({
      isLeaf: false,
      w: 100,
      h: 100,
      style: { backgroundColor: 'rgb(10, 10, 10)', borderRadius: '50px' },
    })
    expect(walkSlide(makeMeasure([node])).shapes[0]?.kind).toBe('ellipse')
  })

  it('maps a visible border to a line spec on the shape', () => {
    const node = makeNode({
      isLeaf: false,
      style: {
        backgroundColor: 'rgb(255, 255, 255)',
        ...uniformBorder('2px', 'rgb(0, 0, 0)', 'dashed'),
      },
    })
    const shape = walkSlide(makeMeasure([node])).shapes[0]
    expect(shape).toMatchObject({ line: { color: '000000', dashType: 'dash' } })
  })

  it('orders emission by (zIndex, domIndex)', () => {
    const back = makeNode({ isLeaf: true, text: 'back', z: 0, domIndex: 5 })
    const front = makeNode({ isLeaf: true, text: 'front', z: 10, domIndex: 1 })
    const shapes = textShapes(walkSlide(makeMeasure([front, back])).shapes)
    expect(shapes.map((s) => s.runs[0]!.text)).toEqual(['back', 'front'])
  })
})

describe('walkSlide background and coverage', () => {
  it('maps a solid body background to a slide fill', () => {
    const measure = makeMeasure([makeNode({ isLeaf: true, text: 'x' })], {
      body: makeRootPaint({ backgroundColor: 'rgb(17, 34, 51)' }),
    })
    expect(walkSlide(measure).background).toEqual({ color: '112233' })
  })

  it('reports full coverage for a text-only slide and reduced coverage when media is present', () => {
    const textOnly = makeMeasure([makeNode({ isLeaf: true, text: 'x', w: 100, h: 100 })])
    expect(walkSlide(textOnly).coveredFraction).toBe(1)

    const withImage = makeMeasure([
      makeNode({ isLeaf: true, text: 'x', w: 100, h: 100 }),
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
      isLeaf: true,
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
      isLeaf: false,
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
      isLeaf: true,
      text: 'a',
      style: { transform: 'matrix(1, 0, 0, 1, 30, 0)' },
    })
    const skewed = makeNode({
      isLeaf: true,
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
      isLeaf: true,
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
    const measure = makeMeasure([makeNode({ isLeaf: true, text: 'x', w: 100, h: 100 })], {
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
  it('joins the visible leaf text for the accessibility notes layer', () => {
    const nodes = [
      makeNode({ isLeaf: true, text: 'Title' }),
      makeNode({ isLeaf: false }),
      makeNode({ isLeaf: true, text: 'Body' }),
    ]
    expect(slideTextForNotes(nodes)).toBe('Title\nBody')
  })
})
