import { describe, expect, it } from 'vitest'
import { slideTextForNotes, walkSlide } from '../../../../src/shared/export/pptx/walker'
import type { ShapeSpec } from '../../../../src/shared/export/pptx/types'
import { makeMeasure, makeNode } from './_fixtures'

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
        borderTopWidth: '2px',
        borderTopStyle: 'dashed',
        borderTopColor: 'rgb(0, 0, 0)',
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
      body: { backgroundColor: 'rgb(17, 34, 51)', backgroundImage: 'none' },
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
