import type {
  BorderSide,
  MeasureResult,
  NodeStyle,
  RootPaint,
  SlideNode,
  TransformSpec,
} from '../../../../src/shared/export/pptx/node'

/** A transformed ancestor carrying only a computed `transform` matrix — the common case. */
export function ancestorMatrix(transform: string): TransformSpec {
  return { transform, rotate: 'none', scale: 'none', translate: 'none' }
}

const NO_BORDER: BorderSide = { width: '0px', style: 'none', color: 'rgb(0, 0, 0)' }

/** All four sides the same — what `border: Npx solid C` computes to. */
export function uniformBorder(
  width: string,
  color: string,
  style = 'solid',
): Pick<NodeStyle, 'borderTop' | 'borderRight' | 'borderBottom' | 'borderLeft'> {
  const side: BorderSide = { width, style, color }
  return { borderTop: side, borderRight: side, borderBottom: side, borderLeft: side }
}

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
    textShadow: 'none',
    backgroundColor: 'rgba(0, 0, 0, 0)',
    backgroundImage: 'none',
    borderRadius: '0px',
    borderTop: NO_BORDER,
    borderRight: NO_BORDER,
    borderBottom: NO_BORDER,
    borderLeft: NO_BORDER,
    boxShadow: 'none',
    filter: 'none',
    backdropFilter: 'none',
    mixBlendMode: 'normal',
    transform: 'none',
    rotate: 'none',
    scale: 'none',
    translate: 'none',
    clipPath: 'none',
    writingMode: 'horizontal-tb',
    overflow: 'visible',
    position: 'static',
    listStyleType: 'disc',
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
    layoutW: 100,
    layoutH: 50,
    ancestorTransforms: [],
    bareTextCount: 0,
    effectiveOpacity: 1,
    paintedPseudoCount: 0,
    escapingDescendants: 0,
    clippedTextPx: 0,
    unmodelledProperties: [],
    style: makeStyle(style),
    ...rest,
  }
}

/** A root element painting nothing — no colour, no image, no filter, nothing un-modelled. */
export function makeRootPaint(overrides: Partial<RootPaint> = {}): RootPaint {
  return {
    backgroundColor: 'rgba(0, 0, 0, 0)',
    backgroundImage: 'none',
    filter: 'none',
    backdropFilter: 'none',
    mixBlendMode: 'normal',
    clipPath: 'none',
    unmodelledProperties: [],
    ...overrides,
  }
}

/** Wrap nodes as a `MeasureResult` with both root elements painting nothing by default. */
export function makeMeasure(
  nodes: SlideNode[],
  overrides: Partial<MeasureResult> = {},
): MeasureResult {
  return {
    nodes,
    body: makeRootPaint(),
    root: makeRootPaint(),
    hasAnimation: false,
    ...overrides,
  }
}
