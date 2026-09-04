/**
 * The measurement-pass data model and the injected script that produces it (M4.3 / 60-export.md §3.2).
 *
 * The structured PPTX walk never parses CSS or re-implements layout — Chromium is the layout engine.
 * A single script runs in the slide's own sandboxed context (after the readiness + animation-settle
 * barrier, so every box is final) and returns a flat, serializable `MeasureResult`: the visible
 * elements with their measured boxes and the computed styles the walker needs. The walker and the
 * confidence scorer are then pure functions over `SlideNode[]`, unit-tested against recorded fixtures
 * with no browser and no Electron.
 *
 * The script is kept here as a source string — like `slideReadinessScript` — so the one thing a unit
 * test *can* pin about it (that it applies the leaf-text rule, the paint rule, and rejects invisible
 * nodes) is asserted by substring rather than buried in an `executeJavaScript` call.
 */

/** One side of a CSS border, as `getComputedStyle` reports it. */
export type BorderSide = { width: string; style: string; color: string }

/** The computed-style subset the walker and scorer read. All strings are `getComputedStyle` values. */
export type NodeStyle = {
  fontFamily: string
  /** Resolved font size in CSS px. */
  fontSize: number
  fontWeight: string
  fontStyle: string
  textDecorationLine: string
  color: string
  textAlign: string
  lineHeight: string
  letterSpacing: string
  textTransform: string
  textShadow: string
  backgroundColor: string
  backgroundImage: string
  borderRadius: string
  /**
   * All four sides (M4.8a). A uniform border maps to the shape outline; a partial one (`border-left`
   * accent, `border-top` rule) has no outline equivalent and becomes filled edge rects instead.
   */
  borderTop: BorderSide
  borderRight: BorderSide
  borderBottom: BorderSide
  borderLeft: BorderSide
  boxShadow: string
  filter: string
  backdropFilter: string
  mixBlendMode: string
  transform: string
  clipPath: string
  writingMode: string
  overflow: string
  position: string
}

/** One visible element from the measurement pass. Boxes are in CSS px, relative to the viewport. */
export type SlideNode = {
  /** Design Mode's stable id (`data-sl-id`), if present. */
  slId: string | null
  tag: string
  x: number
  y: number
  w: number
  h: number
  z: number
  /** DOM traversal order, the paint-order tiebreak within an equal `z`. */
  domIndex: number
  /** True when the element has no element children — the only nodes that contribute text (§3.2). */
  isLeaf: boolean
  /** Trimmed text content; non-empty only for leaf nodes. */
  text: string
  /** `href` for an `<a>`, else `null`. */
  href: string | null
  /** `'ul' | 'ol'` when this leaf is inside a list item, for bullet emission. */
  listType: 'ul' | 'ol' | null
  /** For `<svg>`: count of drawable primitives (rect/circle/ellipse/line/path/polygon/polyline). */
  svgPrimitiveCount: number
  /** `<img>` current source, else `null`. */
  src: string | null
  /**
   * Untransformed border-box size (`offsetWidth`/`offsetHeight`). Equals `w`/`h` unless the element
   * is transformed, in which case `w`/`h` are the axis-aligned bounds of the transformed box and these
   * are the box PowerPoint must be handed together with `rot` (M4.8a).
   */
  layoutW: number
  layoutH: number
  /** Computed `transform` of every transformed ancestor, nearest first. Empty in the common case. */
  ancestorTransforms: string[]
  /**
   * Direct text-node children with content on a NON-leaf element — text no leaf owns, which the
   * leaf-text rule drops (`<p>a <b>b</b> c</p>` → 2). Always 0 on a leaf. Scored as a loss until
   * M4.8b's run-level walk emits it.
   */
  bareTextCount: number
  /**
   * Own `opacity` times every ancestor's — the alpha the element actually paints at (M4.8a). Folded
   * into fill/line/run transparency by the walker; an 8 % watermark used to ship fully opaque.
   */
  effectiveOpacity: number
  /**
   * `::before`/`::after` pseudo-elements that paint (text content, background, or border). They have
   * no measurable rect, so nothing can be emitted for them; the scorer treats each as an un-modelled
   * construct.
   */
  paintedPseudoCount: number
  /**
   * Visible descendants that extend past this element's box while it clips overflow. PowerPoint has
   * no clipping, so each would spill out of the box; scored as an un-modelled construct.
   */
  escapingDescendants: number
  style: NodeStyle
}

/** The whole measurement pass: the element list plus the slide `<body>`'s own paint. */
export type MeasureResult = {
  nodes: SlideNode[]
  body: { backgroundColor: string; backgroundImage: string }
  /** True if the slide had CSS/Web/SMIL animation (now settled) — drives the degradation note (§4.2). */
  hasAnimation: boolean
}

/**
 * The injected measurement script (source). Runs in the slide's sandboxed context and returns a
 * `MeasureResult`. Mirrors 60-export.md §3.2: visibility filter, leaf-text rule (only childless
 * elements carry text — prevents the double-render bug on nested spans), and a serializable style
 * subset. The walker classifies these nodes; nothing about CSS is interpreted here.
 */
export function slideMeasurementScript(): string {
  return `(() => {
  const alphaOf = (c) => {
    const m = /^rgba?\\(([^)]+)\\)$/.exec(c.trim());
    if (!m) return c === 'transparent' ? 0 : 1;
    const p = m[1].split(/[,/\\s]+/).filter(Boolean).map(parseFloat);
    return p.length > 3 ? p[3] : 1;
  };
  const effectiveOpacity = (el) => {
    let o = 1;
    for (let p = el; p && p !== document.documentElement; p = p.parentElement) {
      const v = parseFloat(getComputedStyle(p).opacity);
      if (Number.isFinite(v)) o *= v;
    }
    return o;
  };
  const visible = (el, cs, r) =>
    cs.display !== 'none' && cs.visibility !== 'hidden' && effectiveOpacity(el) > 0.01 &&
    r.width > 0.5 && r.height > 0.5;
  const side = (cs, s) => ({ width: cs['border' + s + 'Width'], style: cs['border' + s + 'Style'], color: cs['border' + s + 'Color'] });
  const pseudoPaints = (el, which) => {
    const ps = getComputedStyle(el, which);
    if (ps.display === 'none' || ps.content === 'none' || ps.content === 'normal') return false;
    return ps.content !== '""' || alphaOf(ps.backgroundColor) > 0.03 ||
      /gradient\\(|url\\(/.test(ps.backgroundImage) || (parseFloat(ps.borderTopWidth) || 0) > 0;
  };
  const clips = (v) => v === 'hidden' || v === 'clip' || v === 'scroll' || v === 'auto';
  const escapingDescendants = (el, cs, r) => {
    if (!clips(cs.overflowX) && !clips(cs.overflowY)) return 0;
    let n = 0;
    for (const d of el.querySelectorAll('*')) {
      const dr = d.getBoundingClientRect();
      if (!visible(d, getComputedStyle(d), dr)) continue;
      if (dr.left < r.left - 0.5 || dr.top < r.top - 0.5 || dr.right > r.right + 0.5 || dr.bottom > r.bottom + 0.5) n++;
    }
    return n;
  };
  const SVG_PRIMS = 'rect,circle,ellipse,line,path,polygon,polyline';
  const nodes = [];
  const all = document.body ? document.body.querySelectorAll('*') : [];
  let domIndex = 0;
  for (const el of all) {
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    if (!visible(el, cs, r)) continue;
    const isLeaf = el.children.length === 0;
    const tag = el.tagName.toLowerCase();
    const ancestorTransforms = [];
    for (let p = el.parentElement; p && p !== document.documentElement; p = p.parentElement) {
      const t = getComputedStyle(p).transform;
      if (t && t !== 'none') ancestorTransforms.push(t);
    }
    let bareTextCount = 0;
    if (!isLeaf) for (const c of el.childNodes) if (c.nodeType === 3 && (c.textContent || '').trim() !== '') bareTextCount++;
    let listType = null;
    const li = el.closest('li');
    if (li) { const list = li.parentElement; listType = list && list.tagName.toLowerCase() === 'ol' ? 'ol' : 'ul'; }
    nodes.push({
      slId: el.getAttribute('data-sl-id') || null,
      tag,
      x: r.x, y: r.y, w: r.width, h: r.height,
      z: cs.zIndex === 'auto' ? 0 : (parseInt(cs.zIndex, 10) || 0),
      domIndex: domIndex++,
      isLeaf,
      text: isLeaf ? (el.textContent || '').trim() : '',
      href: tag === 'a' ? el.getAttribute('href') : null,
      listType,
      svgPrimitiveCount: tag === 'svg' ? el.querySelectorAll(SVG_PRIMS).length : 0,
      src: tag === 'img' ? (el.currentSrc || el.src || null) : null,
      layoutW: el.offsetWidth > 0 ? el.offsetWidth : r.width,
      layoutH: el.offsetHeight > 0 ? el.offsetHeight : r.height,
      ancestorTransforms,
      bareTextCount,
      effectiveOpacity: effectiveOpacity(el),
      paintedPseudoCount: (pseudoPaints(el, '::before') ? 1 : 0) + (pseudoPaints(el, '::after') ? 1 : 0),
      escapingDescendants: escapingDescendants(el, cs, r),
      style: {
        fontFamily: cs.fontFamily, fontSize: parseFloat(cs.fontSize) || 0, fontWeight: cs.fontWeight,
        fontStyle: cs.fontStyle, textDecorationLine: cs.textDecorationLine || '',
        color: cs.color, textAlign: cs.textAlign, lineHeight: cs.lineHeight,
        letterSpacing: cs.letterSpacing, textTransform: cs.textTransform, textShadow: cs.textShadow,
        backgroundColor: cs.backgroundColor, backgroundImage: cs.backgroundImage,
        borderRadius: cs.borderRadius,
        borderTop: side(cs, 'Top'), borderRight: side(cs, 'Right'), borderBottom: side(cs, 'Bottom'), borderLeft: side(cs, 'Left'),
        boxShadow: cs.boxShadow, filter: cs.filter, backdropFilter: cs.backdropFilter || cs.webkitBackdropFilter || 'none',
        mixBlendMode: cs.mixBlendMode, transform: cs.transform, clipPath: cs.clipPath || 'none',
        writingMode: cs.writingMode, overflow: cs.overflow, position: cs.position,
      },
    });
  }
  const bodyCs = document.body ? getComputedStyle(document.body) : null;
  const hasAnimation =
    (typeof document.getAnimations === 'function' && document.getAnimations().length > 0) ||
    document.querySelectorAll('svg animate, svg animateTransform, svg animateMotion').length > 0;
  return {
    nodes,
    body: {
      backgroundColor: bodyCs ? bodyCs.backgroundColor : 'rgba(0, 0, 0, 0)',
      backgroundImage: bodyCs ? bodyCs.backgroundImage : 'none',
    },
    hasAnimation,
  };
})()`
}
