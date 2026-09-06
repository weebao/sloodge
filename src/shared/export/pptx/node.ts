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
 * test *can* pin about it (that it applies the block-root rule, the paint rule, and rejects invisible
 * nodes) is asserted by substring rather than buried in an `executeJavaScript` call.
 *
 * ## Text is collected per block, one item per text node (M4.8b)
 *
 * Until M4.8b an element contributed text only when it had no element children — the leaf-text rule —
 * and the bare text beside an inline element (`<p>a <b>b</b> c</p>` → `a `, ` c`) belonged to no leaf
 * and was never visited (research §1.3(c)). The rule now keys on the **block**: every element whose
 * computed `display` is not `inline`/`contents` is a *block root*, and its `inlineContent` is the
 * sequence of text nodes reachable through inline descendants, each carrying the computed style of
 * its own parent element, plus markers for `<br>`, for nested block children, and for atomic inline
 * boxes. The walker turns that into one text box with one run per text node. A text node has exactly
 * one block root, so nothing is emitted twice — the anti-double-render guarantee the leaf rule bought
 * is kept by keying on the root rather than the leaf.
 *
 * Text is recorded **raw**: CSS white-space processing (collapsing, trimming at line edges) and
 * `text-transform` are applied by the pure walker, where they are unit-tested against exact strings.
 *
 * ## The style subset is no longer the whole story (M4.8a, review r2)
 *
 * `NodeStyle` is the set of computed values the walker and scorer *read*. It used to also be, by
 * omission, the set of CSS the pipeline claimed to understand — so a property nobody had listed
 * (`mask-image`, `-webkit-text-stroke`, the standalone `rotate:`) was silently absent from the
 * measurement and therefore silently absent from the score. `unmodelledProperties` closes that:
 * every element is censused against `properties.ts`'s explicit modelled set, and anything set to a
 * non-initial value that nobody has claimed is reported by name. See `properties.ts` for the
 * taxonomy and how to extend it.
 *
 * ## …but a closed world is a claim about a quantifier (M4.8a, review r3)
 *
 * r3 left the list alone and attacked the enumeration instead, three ways. The census ran over
 * `document.body.querySelectorAll('*')`, which yields neither `<body>` nor `<html>` — so paint on
 * a root element was outside it entirely (`RootPaint` closes that). Its baseline lived one shadow
 * root deep, and author `!important` reaches a shadow *host* — so the baseline could be made equal
 * to the value under test (the probe is two roots deep now). And the visibility and leaf-text
 * rules below admitted two constructs Chromium paints nowhere, so the file carried content the
 * slide never showed — `visibility: collapse` and `content: url()`, both fixed at the filter
 * rather than at the score, because a deduction does not help a forced-`editable` export.
 */

import {
  CURRENTCOLOR_PROPERTIES,
  LAYOUT_RESOLVED_PROPERTIES,
  MAX_UNMODELLED_PER_NODE,
  MODELLED_PROPERTIES,
  VALUE_SCOPED_EXEMPTIONS,
} from './properties'

/** One side of a CSS border, as `getComputedStyle` reports it. */
export type BorderSide = { width: string; style: string; color: string }

/**
 * The four properties that build an element's transform, as CSS Transforms Level 2 defines them.
 * The standalone `translate`/`rotate`/`scale` do **not** fold into the computed `transform`, so
 * reading `transform` alone reported `none` for an element the reader sees rotated (review r2).
 */
export type TransformSpec = {
  transform: string
  rotate: string
  scale: string
  translate: string
}

/** The computed-style subset the walker and scorer read. All strings are `getComputedStyle` values. */
export type NodeStyle = TransformSpec & {
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
  /**
   * The padding, in px (M4.8b). The measured rect is the border box; the text a block carries starts
   * at its content box, so padding and border width become the text box's inset.
   */
  paddingTop: string
  paddingRight: string
  paddingBottom: string
  paddingLeft: string
  boxShadow: string
  filter: string
  backdropFilter: string
  mixBlendMode: string
  clipPath: string
  writingMode: string
  overflow: string
  position: string
  /** `none` on a `list-style: none` chip row, where emitting a bullet invents a glyph (review r2). */
  listStyleType: string
}

/**
 * The computed style of one text node's parent element — everything a run carries (M4.8b). Computed
 * values are already inherited, so a `<strong>` inside a coloured `<p>` reports both the weight and
 * the colour; nothing here is specified-vs-inherited.
 */
export type RunStyle = {
  fontFamily: string
  /** Resolved font size in CSS px. */
  fontSize: number
  fontWeight: string
  fontStyle: string
  /**
   * The union of `text-decoration-line` up the ancestor chain. Decoration is not inherited but
   * *propagates*: an underline on the `<p>` is drawn under the `<strong>` inside it, whose own
   * computed value is `none`.
   */
  textDecorationLine: string
  color: string
  textTransform: string
  letterSpacing: string
  textShadow: string
}

/**
 * The computed `white-space-collapse`, reduced to the three behaviours that change a run's text:
 * collapse everything (`normal`, `nowrap`), preserve everything (`pre`, `pre-wrap`), or collapse
 * spaces but keep segment breaks (`pre-line`).
 */
export type WhiteSpaceMode = 'collapse' | 'preserve' | 'preserve-breaks'

/**
 * One item of a block root's inline content, in DOM order (M4.8b).
 *
 * - `text` — a text node, verbatim, with the style and effective opacity of its parent element.
 * - `br` — a `<br>`: a hard line break inside the same paragraph.
 * - `block` — a nested block-level child. It has its own node and its own box; here it only ends
 *   the paragraph.
 * - `box` — an atomic inline (inline-block, inline-flex, a replaced `<img>`/`<svg>`, a float, a
 *   `visibility: hidden` inline) that occupies space in the line no run can reproduce. It has its
 *   own node when it paints or carries text; here it marks that the text after it will land
 *   elsewhere in PowerPoint's own flow, which the scorer deducts for.
 */
export type InlineItem =
  | {
      kind: 'text'
      text: string
      whiteSpace: WhiteSpaceMode
      style: RunStyle
      /** The parent element's own `opacity` times every ancestor's. */
      opacity: number
      /** `href` of the nearest `<a>` ancestor, else `null`. */
      href: string | null
    }
  | { kind: 'br' }
  | { kind: 'block' }
  | { kind: 'box' }

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
  /**
   * The text this element's box carries (M4.8b): its inline content when it is a block root that
   * contains text, else empty. An SVG `<text>`/`<tspan>` leaf carries its own text as a single item.
   */
  inlineContent: InlineItem[]
  /**
   * For a `display: inline` element, the `domIndex` of the block root its text belongs to — the box
   * that must be emitted *after* this element's own paint, so a highlighted span's background sits
   * under the paragraph's glyphs rather than over them. `null` for a block root, and for an inline
   * whose root is not itself a visible node.
   */
  inlineOf: number | null
  /**
   * True for a visible inline element whose block root is not visible (`visibility: hidden` on the
   * block, `visible` re-declared inside it): its text belongs to no emitted box and is dropped.
   */
  orphanText: boolean
  /** `'ul' | 'ol'` when this block carries the list marker of its `<li>`, for bullet emission. */
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
  /** Every transformed ancestor's four transform properties, nearest first. Empty in the common case. */
  ancestorTransforms: TransformSpec[]
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
  /**
   * Px of this block's **own text** that its own `overflow` clips away (`scrollWidth − clientWidth`,
   * or the block-axis equivalent). PowerPoint cannot clip, so the whole string ships and overflows:
   * an ellipsised headline arrives at full length, a three-of-six-lines tile spills over the footer
   * (review r2). Always 0 on an element with no text of its own — a child escaping a clip is
   * `escapingDescendants`.
   */
  clippedTextPx: number
  /**
   * Computed properties set to a non-initial value that `properties.ts` claims neither to emit nor to
   * score — the closed-world signal. Names only, deduped, capped at `MAX_UNMODELLED_PER_NODE`.
   */
  unmodelledProperties: string[]
  style: NodeStyle
}

/**
 * One document root element's own paint, censused like any other element (M4.8a, review r3).
 *
 * `querySelectorAll('*')` on `<body>` never yields `<body>` or `<html>`, so for two rounds the
 * census quantified over body's *descendants* while the two elements that paint underneath them all
 * were outside it entirely. A `body { filter: invert(1) }` scored 100 with an empty loss list while
 * every colour in the emitted deck was the exact complement of what the reader saw.
 */
export type RootPaint = {
  backgroundColor: string
  backgroundImage: string
  /**
   * The four properties that recolour or recomposite everything painted beneath them. On an element
   * they cost a dropped-class deduction; here they make every emitted colour wrong, which is why
   * `confidence.ts` scores them with `rootPaint` rather than the per-element weights.
   */
  filter: string
  backdropFilter: string
  mixBlendMode: string
  clipPath: string
  /** The closed-world census of this root element, exactly as for a node. */
  unmodelledProperties: string[]
}

/** The whole measurement pass: the element list plus the paint of the two document root elements. */
export type MeasureResult = {
  nodes: SlideNode[]
  /** `<body>`. */
  body: RootPaint
  /** `<html>`. Its opacity and transform reach the nodes; its own paint does not, so it is censused. */
  root: RootPaint
  /** True if the slide had CSS/Web/SMIL animation (now settled) — drives the degradation note (§4.2). */
  hasAnimation: boolean
}

/** True when a block root carries at least one text node with something other than collapsible space. */
export function hasOwnText(node: SlideNode): boolean {
  return node.inlineContent.some((item) => item.kind === 'text' && /[^ \t\n\r\f]/.test(item.text))
}

/** Every text item across the slide — what the scorer's per-run checks (font, shadow) range over. */
export function textItems(nodes: readonly SlideNode[]): Extract<InlineItem, { kind: 'text' }>[] {
  return nodes.flatMap((n) =>
    n.inlineContent.filter((i): i is Extract<InlineItem, { kind: 'text' }> => i.kind === 'text'),
  )
}

/**
 * The injected measurement script (source). Runs in the slide's sandboxed context and returns a
 * `MeasureResult`. Mirrors 60-export.md §3.2: visibility filter, block-root text rule (each text node
 * belongs to its nearest non-inline ancestor's box, so nothing is emitted twice), and a serializable
 * style subset. The walker classifies these nodes; nothing about CSS is interpreted here.
 */
export function slideMeasurementScript(): string {
  return `(() => {
  const MODELLED = new Set(${JSON.stringify(MODELLED_PROPERTIES)});
  const LAYOUT_RESOLVED = new Set(${JSON.stringify(LAYOUT_RESOLVED_PROPERTIES)});
  const CURRENTCOLOR = new Set(${JSON.stringify(CURRENTCOLOR_PROPERTIES)});
  const VALUE_SCOPED = ${JSON.stringify(VALUE_SCOPED_EXEMPTIONS)};
  const MAX_UNMODELLED = ${String(MAX_UNMODELLED_PER_NODE)};
  const SVG_NS = 'http://www.w3.org/2000/svg';
  // Elements whose box is a replacement, not a container for inline text: atomic in the line.
  const REPLACED = new Set(['img', 'svg', 'canvas', 'video', 'audio', 'iframe', 'embed', 'object', 'input', 'select', 'textarea']);
  const alphaOf = (c) => {
    const m = /^rgba?\\(([^)]+)\\)$/.exec(c.trim());
    if (!m) return c === 'transparent' ? 0 : 1;
    const p = m[1].split(/[,/\\s]+/).filter(Boolean).map(parseFloat);
    return p.length > 3 ? p[3] : 1;
  };
  // Up to and including <html>: the root elements paint too, and stopping short of them was how
  // \`html { opacity: .5 }\` reached the file fully opaque (review r3).
  const effectiveOpacity = (el) => {
    let o = 1;
    for (let p = el; p; p = p.parentElement) {
      const v = parseFloat(getComputedStyle(p).opacity);
      if (Number.isFinite(v)) o *= v;
    }
    return o;
  };
  // \`=== 'visible'\`, not \`!== 'hidden'\`: \`visibility: collapse\` paints nothing on a non-table
  // element but is not the string 'hidden', so it passed the filter, kept its rect, and shipped a
  // full-width banner the reader never saw — content INVENTED by the exporter (review r3).
  const visible = (el, cs, r) =>
    cs.display !== 'none' && cs.visibility === 'visible' && effectiveOpacity(el) > 0.01 &&
    r.width > 0.5 && r.height > 0.5;
  const side = (cs, s) => ({ width: cs['border' + s + 'Width'], style: cs['border' + s + 'Style'], color: cs['border' + s + 'Color'] });
  const transformSpec = (cs) => ({ transform: cs.transform, rotate: cs.rotate || 'none', scale: cs.scale || 'none', translate: cs.translate || 'none' });
  const transformed = (t) => t.transform !== 'none' || t.rotate !== 'none' || t.scale !== 'none' || t.translate !== 'none';
  const pseudoPaints = (el, which) => {
    const ps = getComputedStyle(el, which);
    if (ps.display === 'none' || ps.content === 'none' || ps.content === 'normal') return false;
    return ps.content !== '""' || alphaOf(ps.backgroundColor) > 0.03 ||
      /gradient\\(|url\\(/.test(ps.backgroundImage) || (parseFloat(ps.borderTopWidth) || 0) > 0;
  };
  const clips = (v) => v === 'hidden' || v === 'clip' || v === 'scroll' || v === 'auto';
  // \`contain: paint|strict|content\` clips descendants to the padding box exactly like
  // \`overflow: hidden\` while leaving the computed \`overflow\` at \`visible\`, so a 460×340 block
  // clipped to a 380×200 card on screen shipped unclipped and painted over the background (r3).
  const clipsByContain = (cs) => /(^|\\s)(paint|strict|content)(\\s|$)/.test(cs.contain || '');
  const clipsBox = (cs) => clips(cs.overflowX) || clips(cs.overflowY) || clipsByContain(cs);
  const escapingDescendants = (el, cs, r) => {
    if (!clipsBox(cs)) return 0;
    let n = 0;
    for (const d of el.querySelectorAll('*')) {
      const dr = d.getBoundingClientRect();
      if (!visible(d, getComputedStyle(d), dr)) continue;
      if (dr.left < r.left - 0.5 || dr.top < r.top - 0.5 || dr.right > r.right + 0.5 || dr.bottom > r.bottom + 0.5) n++;
    }
    return n;
  };
  // How much of a block's OWN text its own overflow cuts off. \`scrollWidth\`/\`scrollHeight\` include
  // the overflowing content; \`clientWidth\`/\`clientHeight\` are the visible padding box.
  const clippedTextPx = (el, cs, ownText) => {
    if (!ownText) return 0;
    const contained = clipsByContain(cs);
    let px = 0;
    if (contained || clips(cs.overflowX)) px = Math.max(px, el.scrollWidth - el.clientWidth);
    if (contained || clips(cs.overflowY)) px = Math.max(px, el.scrollHeight - el.clientHeight);
    return Math.max(0, px);
  };
  // --- Run-level text (M4.8b) ---
  // An element takes part in its parent's line rather than making a box of its own when its
  // computed display is \`inline\` (and it is not replaced) or \`contents\`. Everything else — block,
  // flex/grid items and floats (blockified in the computed value), list items, table cells,
  // inline-block and friends, replaced elements — is a box: a block ROOT for the text inside it.
  const inlineFlow = (el, cs) =>
    cs.display === 'contents' || (cs.display === 'inline' && !REPLACED.has(el.tagName.toLowerCase()) && el.namespaceURI !== SVG_NS);
  // An atomic inline sits IN the line without contributing runs; a float is out of flow but still
  // shortens the lines beside it. Both leave a hole PowerPoint's own flow will close up.
  const atomicInline = (cs) => cs.display.startsWith('inline-') || cs.float !== 'none';
  const outOfFlow = (cs) => cs.position === 'absolute' || cs.position === 'fixed';
  const whiteSpaceMode = (cs) => {
    const c = cs.whiteSpaceCollapse || '';
    if (c !== '') return c === 'collapse' ? 'collapse' : c === 'preserve-breaks' ? 'preserve-breaks' : 'preserve';
    const w = cs.whiteSpace;
    return w === 'pre-line' ? 'preserve-breaks' : (w === 'pre' || w === 'pre-wrap' || w === 'break-spaces') ? 'preserve' : 'collapse';
  };
  // Text decoration propagates to in-flow descendants without being inherited: the \`<strong>\`
  // inside an underlined \`<p>\` computes \`none\` and is drawn underlined. The walk stops at the
  // first box that is atomic or out of flow, which decoration does not cross.
  const decorationChain = (el) => {
    const parts = new Set();
    for (let p = el; p && p !== document.documentElement; p = p.parentElement) {
      const pcs = getComputedStyle(p);
      const d = pcs.textDecorationLine || 'none';
      if (d !== 'none') for (const t of d.split(/\\s+/)) parts.add(t);
      if (atomicInline(pcs) || outOfFlow(pcs)) break;
    }
    return parts.size > 0 ? [...parts].join(' ') : 'none';
  };
  const runStyle = (el, cs) => ({
    fontFamily: cs.fontFamily, fontSize: parseFloat(cs.fontSize) || 0, fontWeight: cs.fontWeight,
    fontStyle: cs.fontStyle, textDecorationLine: decorationChain(el), color: cs.color,
    textTransform: cs.textTransform, letterSpacing: cs.letterSpacing, textShadow: cs.textShadow,
  });
  const hrefOf = (el) => { const a = el.closest('a[href]'); return a ? a.getAttribute('href') : null; };
  // The inline content of one block root, in DOM order. Recurses through inline elements; a nested
  // block ends the paragraph; an atomic inline, a float or a hidden inline leaves a \`box\` marker.
  const collectInline = (el, items) => {
    for (const c of el.childNodes) {
      if (c.nodeType === 3) { items.push({ kind: 'text', text: c.data, el }); continue; }
      if (c.nodeType !== 1) continue;
      if (c.tagName.toLowerCase() === 'br') { items.push({ kind: 'br' }); continue; }
      const ccs = getComputedStyle(c);
      if (ccs.display === 'none' || outOfFlow(ccs)) continue;
      if (inlineFlow(c, ccs)) {
        if (ccs.visibility !== 'visible' && ccs.display !== 'contents') { items.push({ kind: 'box' }); continue; }
        collectInline(c, items);
        continue;
      }
      items.push({ kind: atomicInline(ccs) || REPLACED.has(c.tagName.toLowerCase()) || c.namespaceURI === SVG_NS ? 'box' : 'block' });
    }
    return items;
  };
  const hasText = (items) => items.some((i) => i.kind === 'text' && /[^ \\t\\n\\r\\f]/.test(i.text));
  const finishInline = (items) => items.map((i) => {
    if (i.kind !== 'text') return i;
    const pcs = getComputedStyle(i.el);
    return { kind: 'text', text: i.text, whiteSpace: whiteSpaceMode(pcs), style: runStyle(i.el, pcs), opacity: effectiveOpacity(i.el), href: hrefOf(i.el) };
  });
  const blockRootOf = (el) => {
    for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
      if (!inlineFlow(p, getComputedStyle(p))) return p;
    }
    return document.body;
  };
  // The baseline every element is censused against: its own tag's computed style under the UA
  // stylesheet alone. A single \`all: initial\` probe is NOT enough — the HTML UA stylesheet sets
  // \`unicode-bidi: isolate\` on block containers but not on inline ones, so one baseline flagged
  // either every <div> or every <span> depending which way it was read.
  //
  // The probes sit TWO shadow roots deep, and the nesting is the whole mechanism (review r3).
  //
  // One root is not enough. Author CSS cannot style inside a shadow tree, but it can style the
  // host — and \`* { font-variant-caps: small-caps !important }\` beats the host's normal inline
  // \`all: initial\`. The authored value then inherits host → shadow root → probe, the baseline
  // becomes the very value the census exists to find, and the deviation vanishes: the same slide
  // scored 65/raster or 100/structured on the presence of one keyword.
  //
  // The INNER host is itself inside a shadow tree, so no author rule in the document can match it
  // at any priority, and its \`all: initial\` is uncontested. The outer host only has to stay out of
  // the slide's layout, which its inline \`!important\` positioning guarantees (a style attribute
  // outranks any selector at equal importance). \`direction\` is set explicitly because CSS Cascade
  // §3.2 excludes it (and \`unicode-bidi\`) from \`all\`, so \`all\` cannot express its initial value.
  const probeOuter = document.createElement('div');
  probeOuter.setAttribute('style', 'position: fixed !important; top: -99999px !important; left: -99999px !important;');
  document.documentElement.appendChild(probeOuter);
  const probeHost = document.createElement('div');
  probeHost.setAttribute('style', 'all: initial; direction: ltr;');
  probeOuter.attachShadow({ mode: 'open' }).appendChild(probeHost);
  const probeRoot = probeHost.attachShadow({ mode: 'open' });
  const baselines = new Map();
  const baselineFor = (tag) => {
    let known = baselines.get(tag);
    if (known) return known;
    const probe = document.createElement(tag);
    probeRoot.appendChild(probe);
    const cs = getComputedStyle(probe);
    known = new Map();
    for (let i = 0; i < cs.length; i++) known.set(cs.item(i), cs.getPropertyValue(cs.item(i)));
    probe.remove();
    baselines.set(tag, known);
    return known;
  };
  const watch = [];
  for (const name of baselineFor('div').keys()) if (!MODELLED.has(name) && !LAYOUT_RESOLVED.has(name)) watch.push(name);
  // A property that establishes a stacking context can never be exempted outright — see
  // \`properties.ts\`. \`view-transition-name\` is exempted for the UA's own \`root\` on the document
  // element and for nothing else, so the deviation is re-checked against value AND element here.
  const valueScoped = (el, name, value) => VALUE_SCOPED.some((e) =>
    e.property === name && e.value === value &&
    (!e.documentElementOnly || el === document.documentElement));
  const censusOf = (el, cs, tag) => {
    const baseline = baselineFor(tag);
    const out = [];
    for (const name of watch) {
      const value = cs.getPropertyValue(name);
      const want = CURRENTCOLOR.has(name) ? cs.color : baseline.get(name);
      if (value !== want && !valueScoped(el, name, value)) {
        out.push(name);
        if (out.length >= MAX_UNMODELLED) break;
      }
    }
    return out;
  };
  // A non-\`normal\` \`content\` makes an ordinary element replaced: it renders the given image
  // INSTEAD of its children. The exporter used to emit the children anyway, shipping a sentence
  // that appears nowhere on screen (review r3). The census reports \`content\` besides, so the slide
  // rasterizes; this is what stops the phantom text reaching a forced-\`editable\` file too.
  const contentReplaced = (cs) => cs.content !== 'normal' && cs.content !== 'none';
  const SVG_PRIMS = 'rect,circle,ellipse,line,path,polygon,polyline';
  const nodes = [];
  const all = document.body ? document.body.querySelectorAll('*') : [];
  const replaced = new Set();
  const rootIndex = new Map();
  const bulletedLis = new Set();
  let domIndex = 0;
  // <body> is a block root like any other when text sits directly in it (or in an inline child of
  // it); it is outside \`querySelectorAll('*')\`, so it is walked first, with its paint left to
  // \`RootPaint\` — the slide background already carries it.
  const bodyItems = document.body ? collectInline(document.body, []) : [];
  const elements = hasText(bodyItems) ? [document.body, ...all] : [...all];
  for (const el of elements) {
    if (el.parentElement !== null && replaced.has(el.parentElement)) { replaced.add(el); continue; }
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    const isReplaced = contentReplaced(cs);
    if (isReplaced) replaced.add(el);
    if (!visible(el, cs, r)) continue;
    const tag = el.tagName.toLowerCase();
    const isBody = el === document.body;
    const inSvg = el.namespaceURI === SVG_NS || el.closest('svg') !== null;
    const ancestorTransforms = [];
    for (let p = el.parentElement; p; p = p.parentElement) {
      const t = transformSpec(getComputedStyle(p));
      if (transformed(t)) ancestorTransforms.push(t);
    }
    // Inline text of this root. A replaced element renders an image instead of its children; SVG
    // keeps the leaf rule, since a childless <text>/<tspan> is one run.
    let inlineContent = [];
    let inlineOf = null;
    let orphanText = false;
    if (!isReplaced) {
      if (inSvg) {
        if (el.children.length === 0 && (el.textContent || '').trim() !== '')
          inlineContent = [{ kind: 'text', text: el.textContent, whiteSpace: 'collapse', style: runStyle(el, cs), opacity: effectiveOpacity(el), href: null }];
      } else if (isBody) {
        inlineContent = finishInline(bodyItems);
      } else if (inlineFlow(el, cs)) {
        const root = blockRootOf(el);
        const idx = rootIndex.get(root);
        if (idx !== undefined) inlineOf = idx;
        else orphanText = /[^ \\t\\n\\r\\f]/.test(el.textContent || '');
      } else {
        const items = collectInline(el, []);
        if (hasText(items)) inlineContent = finishInline(items);
      }
    }
    const ownText = inlineContent.length > 0;
    rootIndex.set(el, domIndex);
    // The list marker belongs to the FIRST block that carries text inside the <li>: the <li>
    // itself when its text is direct, else the <p> markdown-style lists put inside it. Every later
    // block in the same <li> would otherwise invent a second marker.
    let listType = null;
    const li = ownText && !inSvg ? el.closest('li') : null;
    if (li && !bulletedLis.has(li)) {
      bulletedLis.add(li);
      const list = li.parentElement;
      listType = list && list.tagName.toLowerCase() === 'ol' ? 'ol' : 'ul';
    }
    nodes.push({
      slId: el.getAttribute('data-sl-id') || null,
      tag,
      x: r.x, y: r.y, w: r.width, h: r.height,
      z: cs.zIndex === 'auto' ? 0 : (parseInt(cs.zIndex, 10) || 0),
      domIndex: domIndex++,
      inlineContent,
      inlineOf,
      orphanText,
      listType,
      svgPrimitiveCount: tag === 'svg' ? el.querySelectorAll(SVG_PRIMS).length : 0,
      src: tag === 'img' ? (el.currentSrc || el.src || null) : null,
      layoutW: el.offsetWidth > 0 ? el.offsetWidth : r.width,
      layoutH: el.offsetHeight > 0 ? el.offsetHeight : r.height,
      ancestorTransforms,
      effectiveOpacity: effectiveOpacity(el),
      paintedPseudoCount: (pseudoPaints(el, '::before') ? 1 : 0) + (pseudoPaints(el, '::after') ? 1 : 0),
      escapingDescendants: escapingDescendants(el, cs, r),
      clippedTextPx: clippedTextPx(el, cs, ownText),
      // SVG interiors are accounted for wholesale by the SVG deduction and the coverage metric —
      // the walker never emits them — so a per-property census there would say nothing new.
      unmodelledProperties: inSvg ? [] : censusOf(el, cs, tag),
      style: {
        fontFamily: cs.fontFamily, fontSize: parseFloat(cs.fontSize) || 0, fontWeight: cs.fontWeight,
        fontStyle: cs.fontStyle, textDecorationLine: cs.textDecorationLine || '',
        color: cs.color, textAlign: cs.textAlign, lineHeight: cs.lineHeight,
        letterSpacing: cs.letterSpacing, textTransform: cs.textTransform, textShadow: cs.textShadow,
        // <body>'s own paint is the slide background (RootPaint); repeating it as a shape would
        // stack a second copy over it.
        backgroundColor: isBody ? 'rgba(0, 0, 0, 0)' : cs.backgroundColor,
        backgroundImage: isBody ? 'none' : cs.backgroundImage,
        borderRadius: cs.borderRadius,
        borderTop: side(cs, 'Top'), borderRight: side(cs, 'Right'), borderBottom: side(cs, 'Bottom'), borderLeft: side(cs, 'Left'),
        paddingTop: cs.paddingTop, paddingRight: cs.paddingRight, paddingBottom: cs.paddingBottom, paddingLeft: cs.paddingLeft,
        boxShadow: cs.boxShadow, filter: cs.filter, backdropFilter: cs.backdropFilter || cs.webkitBackdropFilter || 'none',
        mixBlendMode: cs.mixBlendMode, clipPath: cs.clipPath || 'none',
        writingMode: cs.writingMode, overflow: cs.overflow, position: cs.position,
        listStyleType: cs.listStyleType || 'none',
        ...transformSpec(cs),
      },
    });
  }
  // <body> and <html> are censused like any other element. \`querySelectorAll('*')\` cannot reach
  // them, so until r3 a paint property declared on either was measured by nothing and scored by
  // nothing — \`body { filter: invert(1) }\` shipped every colour in the deck complemented, at 100.
  const NO_PAINT = { backgroundColor: 'rgba(0, 0, 0, 0)', backgroundImage: 'none', filter: 'none',
    backdropFilter: 'none', mixBlendMode: 'normal', clipPath: 'none', unmodelledProperties: [] };
  const rootPaint = (el) => {
    if (!el) return NO_PAINT;
    const cs = getComputedStyle(el);
    return {
      backgroundColor: cs.backgroundColor,
      backgroundImage: cs.backgroundImage,
      filter: cs.filter,
      backdropFilter: cs.backdropFilter || cs.webkitBackdropFilter || 'none',
      mixBlendMode: cs.mixBlendMode,
      clipPath: cs.clipPath || 'none',
      unmodelledProperties: censusOf(el, cs, el.tagName.toLowerCase()),
    };
  };
  const body = rootPaint(document.body);
  const root = rootPaint(document.documentElement);
  probeOuter.remove();
  const hasAnimation =
    (typeof document.getAnimations === 'function' && document.getAnimations().length > 0) ||
    document.querySelectorAll('svg animate, svg animateTransform, svg animateMotion').length > 0;
  return { nodes, body, root, hasAnimation };
})()`
}
