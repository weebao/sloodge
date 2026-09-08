import type {
  BorderSide,
  InlineItem,
  MeasureResult,
  NodeStyle,
  RootPaint,
  RunStyle,
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
    paddingTop: '0px',
    paddingRight: '0px',
    paddingBottom: '0px',
    paddingLeft: '0px',
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

/** The run style a text node inherits from a block styled `style` — what `getComputedStyle` reports on it. */
export function runStyleOf(style: Partial<RunStyle> = {}): RunStyle {
  const base = makeStyle()
  return {
    fontFamily: base.fontFamily,
    fontSize: base.fontSize,
    fontWeight: base.fontWeight,
    fontStyle: base.fontStyle,
    textDecorationLine: base.textDecorationLine,
    color: base.color,
    textTransform: base.textTransform,
    letterSpacing: base.letterSpacing,
    textShadow: base.textShadow,
    ...style,
  }
}

/** One text node of a block's inline content, verbatim, in the given (resolved) style. */
export function textItem(
  text: string,
  style: Partial<RunStyle> = {},
  extra: Partial<Omit<Extract<InlineItem, { kind: 'text' }>, 'kind' | 'text' | 'style'>> = {},
): Extract<InlineItem, { kind: 'text' }> {
  return {
    kind: 'text',
    text,
    whiteSpace: 'collapse',
    style: runStyleOf(style),
    opacity: 1,
    href: null,
    ...extra,
  }
}

let seq = 0

/**
 * A visible `<div>` at (0,0,100,50) by default; override anything, including a partial `style`.
 * `text` is a convenience for the common one-text-node block: it becomes the node's whole inline
 * content, in the style the node itself carries — exactly what a childless `<h1>Title</h1>` measures as.
 */
export function makeNode(
  overrides: Omit<Partial<SlideNode>, 'style'> & { style?: Partial<NodeStyle>; text?: string } = {},
): SlideNode {
  const { style, text, ...rest } = overrides
  const nodeStyle = makeStyle(style)
  const fromText: InlineItem[] =
    text === undefined || text === ''
      ? []
      : [
          textItem(text, {
            fontFamily: nodeStyle.fontFamily,
            fontSize: nodeStyle.fontSize,
            fontWeight: nodeStyle.fontWeight,
            fontStyle: nodeStyle.fontStyle,
            textDecorationLine: nodeStyle.textDecorationLine,
            color: nodeStyle.color,
            textTransform: nodeStyle.textTransform,
            letterSpacing: nodeStyle.letterSpacing,
            textShadow: nodeStyle.textShadow,
          }),
        ]
  return {
    slId: null,
    tag: 'div',
    x: 0,
    y: 0,
    w: 100,
    h: 50,
    z: 0,
    domIndex: seq++,
    inlineContent: fromText,
    inlineOf: null,
    orphanText: false,
    listType: null,
    svgPrimitiveCount: 0,
    src: null,
    layoutW: 100,
    layoutH: 50,
    ancestorTransforms: [],
    effectiveOpacity: 1,
    paintedPseudoCount: 0,
    escapingDescendants: 0,
    clippedTextPx: 0,
    unmodelledProperties: [],
    style: nodeStyle,
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
