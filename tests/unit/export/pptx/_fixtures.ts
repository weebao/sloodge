import type { MeasureResult, NodeStyle, SlideNode } from '../../../../src/shared/export/pptx/node'

/** A neutral computed-style baseline — everything "off" so a test only sets what it exercises. */
export function makeStyle(overrides: Partial<NodeStyle> = {}): NodeStyle {
  return {
    fontFamily: 'Arial',
    fontSize: 16,
    fontWeight: '400',
    fontStyle: 'normal',
    textDecorationLine: '',
    color: 'rgb(0, 0, 0)',
    textAlign: 'left',
    lineHeight: 'normal',
    letterSpacing: 'normal',
    textTransform: 'none',
    backgroundColor: 'rgba(0, 0, 0, 0)',
    backgroundImage: 'none',
    borderRadius: '0px',
    borderTopWidth: '0px',
    borderTopStyle: 'none',
    borderTopColor: 'rgb(0, 0, 0)',
    boxShadow: 'none',
    filter: 'none',
    backdropFilter: 'none',
    mixBlendMode: 'normal',
    transform: 'none',
    clipPath: 'none',
    writingMode: 'horizontal-tb',
    overflow: 'visible',
    position: 'static',
    opacity: '1',
    ...overrides,
  }
}

let seq = 0

/** A visible `<div>` leaf at (0,0,100,50) by default; override anything, including a partial `style`. */
export function makeNode(
  overrides: Omit<Partial<SlideNode>, 'style'> & { style?: Partial<NodeStyle> } = {},
): SlideNode {
  const { style, ...rest } = overrides
  return {
    slId: null,
    tag: 'div',
    x: 0,
    y: 0,
    w: 100,
    h: 50,
    z: 0,
    domIndex: seq++,
    isLeaf: true,
    text: '',
    href: null,
    listType: null,
    svgPrimitiveCount: 0,
    src: null,
    style: makeStyle(style),
    ...rest,
  }
}

/** Wrap nodes as a `MeasureResult` with an opaque-nothing body by default. */
export function makeMeasure(
  nodes: SlideNode[],
  overrides: Partial<MeasureResult> = {},
): MeasureResult {
  return {
    nodes,
    body: { backgroundColor: 'rgba(0, 0, 0, 0)', backgroundImage: 'none' },
    hasAnimation: false,
    ...overrides,
  }
}
