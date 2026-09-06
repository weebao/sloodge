/**
 * The independent ground truth for a rendered slide (research/pptx-export-fidelity.md §0).
 *
 * Deliberately NOT derived from the exporter's own measurement pass: it walks every **text node**
 * with `TreeWalker` + `Range.getBoundingClientRect()` and the computed style of its parent, plus every
 * element that paints a background or border. The exporter's leaf-element rule is one of the things
 * under test, so the oracle must not share it.
 *
 * It also records what a reader would *see* rather than what the CSS says: the effective opacity of
 * every painted thing (own `opacity` times every ancestor's) and the uniform scale its transform
 * chain applies, so `assess.ts` can compare against rendered glyph size and rendered alpha rather
 * than authored values. Painting `::before`/`::after` are recorded separately because
 * `querySelectorAll('*')` cannot see them at all — an exporter that drops them silently would
 * otherwise leave no trace in the truth (M4.8a, review r1).
 */

export type TruthText = {
  text: string
  inSvg: boolean
  parentTag: string
  x: number
  y: number
  w: number
  h: number
  /** 6-digit uppercase hex of the parent's computed `color`. */
  color: string
  /** Alpha of that computed `color`, before the element's own `opacity`. */
  colorAlpha: number
  fontSizePx: number
  fontWeight: string
  fontStyle: string
  textTransform: string
  /** The parent's computed `text-align`; the glyph-origin check applies to start-aligned text only. */
  textAlign: string
  /** The parent element's own four transform properties, as computed. */
  transform: string
  rotate: string
  scale: string
  translate: string
  /** True when this text node or an ancestor carries a non-identity transform. */
  transformed: boolean
  /**
   * The parent element's axis-aligned bounds and its untransformed layout box. When these disagree
   * the element is rotated or scaled by *something*; the oracle never asks by what, which is what
   * stops it sharing the exporter's blindness. An element shipped at its bounds with `rot=0` is the
   * exact signature of research §1.3(b), whether the angle came from a `transform` matrix or from
   * the standalone `rotate:` property (review r2).
   */
  hostW: number
  hostH: number
  hostLayoutW: number
  hostLayoutH: number
  /**
   * True when a clipping ancestor cuts this text off — the `text-overflow: ellipsis` headline, the
   * fixed-height tile showing three lines of six. PowerPoint cannot clip, so the exporter ships the
   * whole string and it overflows (review r2).
   */
  clipped: boolean
  /** True when the reader sees a list marker beside this text (`list-style-type` is not `none`). */
  bulleted: boolean
  /** Own `opacity` times every ancestor's — the alpha these glyphs actually paint at. */
  opacity: number
  /**
   * Uniform scale the transform chain applies, as √|det| of each 2D matrix times each standalone
   * `scale:` property. Glyphs render at `fontSizePx * renderedScale`, which is what the exporter
   * must emit; `matrix3d` counts as 1 (it is un-modelled and scored as such).
   */
  renderedScale: number
}

export type TruthBox = {
  tag: string
  x: number
  y: number
  w: number
  h: number
  /** Background hex, or null when transparent. */
  bg: string | null
  bgAlpha: number
  hasGradient: boolean
  /** Width of the widest side that actually paints — not necessarily the top one. */
  borderPx: number
  /** Colour of that side, or null when no side paints. */
  borderColor: string | null
  transform: string
  rotate: string
  scale: string
  translate: string
  /** The untransformed layout box, against `w`/`h`'s bounds; see `TruthText.hostLayoutW`. */
  layoutW: number
  layoutH: number
  /** Own `opacity` times every ancestor's — the alpha this box actually paints at. */
  opacity: number
}

/**
 * An element with a text node of its own, and what Chromium says that text READS as: `innerText`,
 * which applies white-space collapsing, `text-transform`, `<br>`s and block boundaries (as `\n`)
 * exactly as the reader sees them (M4.8b). It is the only rendered-text API the platform has, and
 * it is computed by Chromium rather than by the exporter, so an emitted box whose lines are not
 * among these lines has doubled, eaten or invented a space or a break. SVG text has no `innerText`
 * and is recorded whitespace-normalized instead.
 */
export type TruthBlock = {
  tag: string
  x: number
  y: number
  w: number
  h: number
  /** The rendered lines of the element, `innerText.split('\n')`. */
  lines: string[]
}

/** A `::before`/`::after` that paints. It has no measurable rect, so nothing can be emitted for it. */
export type TruthPseudo = {
  hostTag: string
  which: '::before' | '::after'
}

/**
 * What `<html>` and `<body>` do to everything painted beneath them.
 *
 * The oracle recorded computed colours and stopped there, so when `body { filter: invert(1) }`
 * made every rendered colour the complement of its authored value, the oracle read the *authored*
 * value and agreed with the exporter — the independent check shared the exporter's blind spot
 * exactly where it mattered most (review r3). Recording the operation itself is the fix that does
 * not require pixels: a root recomposite means no emitted colour can be trusted, whatever the
 * computed style says, and `assess.ts` counts that as a lost construct.
 */
export type TruthRootPaint = {
  filter: string
  backdropFilter: string
  mixBlendMode: string
  clipPath: string
}

export type GroundTruth = {
  texts: TruthText[]
  boxes: TruthBox[]
  blocks: TruthBlock[]
  pseudos: TruthPseudo[]
  bodyBg: string | null
  bodyBgImage: string
  rootPaint: { html: TruthRootPaint; body: TruthRootPaint }
}

/** Source of the injected oracle script; evaluates to a `GroundTruth`. */
export function groundTruthScript(): string {
  return `(() => {
  const toHex = (c) => {
    const m = /^rgba?\\(([^)]+)\\)$/.exec(c.trim());
    if (!m) return null;
    const p = m[1].split(/[,/\\s]+/).filter(Boolean).map(parseFloat);
    const h = (n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0').toUpperCase();
    return h(p[0]) + h(p[1]) + h(p[2]);
  };
  const alphaOf = (c) => {
    const m = /^rgba?\\(([^)]+)\\)$/.exec(c.trim());
    if (!m) return 0;
    const p = m[1].split(/[,/\\s]+/).filter(Boolean).map(parseFloat);
    return p.length > 3 ? p[3] : 1;
  };
  const spec = (cs) => ({ transform: cs.transform, rotate: cs.rotate || 'none', scale: cs.scale || 'none', translate: cs.translate || 'none' });
  const isTransformed = (t) => t.transform !== 'none' || t.rotate !== 'none' || t.scale !== 'none' || t.translate !== 'none';
  // Up to and including <html>: a transform or an opacity on a root element reaches the reader
  // exactly as one on a wrapper div does.
  const transformedAncestor = (el) => {
    for (let p = el; p; p = p.parentElement) {
      if (isTransformed(spec(getComputedStyle(p)))) return true;
    }
    return false;
  };
  // Bounds vs layout box, measured rather than parsed. \`getBoundingClientRect\` is the axis-aligned
  // footprint AFTER the transform; \`offsetWidth\`/\`offsetHeight\` is the box before it. They disagree
  // exactly when the element is rotated or scaled, by any syntax at all.
  const layoutBox = (el, r) => ({
    layoutW: el.offsetWidth > 0 ? el.offsetWidth : r.width,
    layoutH: el.offsetHeight > 0 ? el.offsetHeight : r.height,
  });
  const clips = (v) => v === 'hidden' || v === 'clip' || v === 'scroll' || v === 'auto';
  // Does a clipping ancestor cut this rect off in a way PowerPoint will NOT reproduce? Only the
  // part of the text inside the slide viewport counts: a watermark bled off the top edge is cropped
  // by PowerPoint's own slide boundary just as it is by \`body { overflow: hidden }\`, so that is not
  // a loss. Text cut off by an INNER box is, because PowerPoint has no clipping at all.
  const clippedBy = (el, b) => {
    const left = Math.max(b.left, 0), top = Math.max(b.top, 0);
    const right = Math.min(b.right, window.innerWidth), bottom = Math.min(b.bottom, window.innerHeight);
    if (right - left < 0.5 || bottom - top < 0.5) return false;
    for (let p = el; p && p !== document.documentElement; p = p.parentElement) {
      const pcs = getComputedStyle(p);
      if (!clips(pcs.overflowX) && !clips(pcs.overflowY)) continue;
      const pr = p.getBoundingClientRect();
      if (left < pr.left - 0.5 || top < pr.top - 0.5 || right > pr.right + 0.5 || bottom > pr.bottom + 0.5) return true;
    }
    return false;
  };
  const bulletedText = (el) => {
    const li = el.closest('li');
    if (!li) return false;
    return getComputedStyle(li).listStyleType !== 'none';
  };
  // Uniform scale of one computed transform: sqrt of the 2D determinant's magnitude. A flip
  // (det < 0) and a skew (det = 1) both scale glyphs by 1, which is what a reader sees.
  const scaleOf = (t) => {
    const m = /^matrix\\(([^)]+)\\)$/.exec((t || '').trim());
    if (!m) return 1;
    const p = m[1].split(',').map(parseFloat);
    if (p.length !== 6 || p.some((n) => !Number.isFinite(n))) return 1;
    const det = Math.abs(p[0] * p[3] - p[1] * p[2]);
    return det > 0 ? Math.sqrt(det) : 1;
  };
  // Both opacity and scale accumulate as a product up the ancestor chain.
  const chainProduct = (el, f) => {
    let acc = 1;
    for (let p = el; p; p = p.parentElement) acc *= f(getComputedStyle(p));
    return acc;
  };
  const opacityOf = (el) =>
    chainProduct(el, (cs) => (Number.isFinite(parseFloat(cs.opacity)) ? parseFloat(cs.opacity) : 1));
  // The standalone \`scale:\` property multiplies glyphs exactly like a \`transform: scale()\` and
  // does NOT fold into the computed transform, so the rendered size needs both (review r2).
  const scalePropOf = (v) => {
    const t = (v || 'none').trim();
    if (t === 'none' || t === '') return 1;
    const p = t.split(/\\s+/).map((n) => parseFloat(n) * (n.endsWith('%') ? 0.01 : 1));
    if (p.some((n) => !Number.isFinite(n))) return 1;
    const sx = p[0], sy = p.length > 1 ? p[1] : p[0];
    const det = Math.abs(sx * sy);
    return det > 0 ? Math.sqrt(det) : 1;
  };
  const scaleChain = (el) => chainProduct(el, (cs) => scaleOf(cs.transform) * scalePropOf(cs.scale));
  const pseudos = [];
  const pseudoPaints = (el, which) => {
    const ps = getComputedStyle(el, which);
    if (ps.display === 'none' || ps.content === 'none' || ps.content === 'normal') return false;
    if (parseFloat(ps.opacity) <= 0.01) return false;
    return ps.content !== '""' || alphaOf(ps.backgroundColor) > 0.03 ||
      /gradient\\(|url\\(/.test(ps.backgroundImage) || (parseFloat(ps.borderTopWidth) || 0) > 0;
  };
  // A reader sees text only where visibility computes to \`visible\` (\`collapse\` paints nothing on a
  // non-table element) and where no ancestor's \`content\` has replaced the subtree with an image.
  const painted = (cs) => cs.visibility === 'visible' && cs.display !== 'none';
  const replacedAncestor = (el) => {
    for (let p = el; p; p = p.parentElement) {
      const c = getComputedStyle(p).content;
      if (c !== 'normal' && c !== 'none') return true;
    }
    return false;
  };
  const texts = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let n;
  while ((n = walker.nextNode())) {
    const t = (n.textContent || '').replace(/\\s+/g, ' ').trim();
    if (t === '') continue;
    const el = n.parentElement;
    if (!el) continue;
    const cs = getComputedStyle(el);
    if (!painted(cs) || replacedAncestor(el)) continue;
    const r = document.createRange();
    r.selectNodeContents(n);
    const b = r.getBoundingClientRect();
    if (b.width < 0.5 || b.height < 0.5) continue;
    const host = el.getBoundingClientRect();
    const hostLayout = layoutBox(el, host);
    texts.push({
      text: t,
      inSvg: el.namespaceURI === 'http://www.w3.org/2000/svg',
      parentTag: el.tagName.toLowerCase(),
      x: b.x, y: b.y, w: b.width, h: b.height,
      color: toHex(cs.color), colorAlpha: alphaOf(cs.color), fontSizePx: parseFloat(cs.fontSize),
      fontWeight: cs.fontWeight, fontStyle: cs.fontStyle, textTransform: cs.textTransform,
      textAlign: cs.textAlign,
      ...spec(cs), transformed: transformedAncestor(el),
      hostW: host.width, hostH: host.height,
      hostLayoutW: hostLayout.layoutW, hostLayoutH: hostLayout.layoutH,
      clipped: clippedBy(el, b), bulleted: bulletedText(el),
      opacity: opacityOf(el), renderedScale: scaleChain(el),
    });
  }
  // The widest side that actually paints, not the top one. A \`border-left: 5px\` accent bar is a
  // paint the reader sees and the exporter emits as an edge rect, but reading \`borderTopWidth\`
  // alone left the element out of \`boxes\` entirely — so neither dropping it nor inventing it was
  // visible to the metric. Found by the surplus check, which accused a correct emission (r4).
  const widestBorder = (cs) => {
    let px = 0;
    let color = null;
    for (const side of ['Top', 'Right', 'Bottom', 'Left']) {
      const w = parseFloat(cs['border' + side + 'Width']) || 0;
      const style = cs['border' + side + 'Style'];
      if (w <= px || style === 'none' || style === 'hidden') continue;
      if (alphaOf(cs['border' + side + 'Color']) <= 0.03) continue;
      px = w;
      color = toHex(cs['border' + side + 'Color']);
    }
    return { px, color };
  };
  const boxes = [];
  const blocks = [];
  // What the text of an element READS as, from Chromium itself. \`innerText\` is undefined on SVG
  // elements, which fall back to their normalized text content.
  const renderedLines = (el) =>
    (typeof el.innerText === 'string' ? el.innerText : (el.textContent || '').replace(/\\s+/g, ' ').trim()).split('\\n');
  for (const el of document.body.querySelectorAll('*')) {
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    // A replaced element's OWN background still paints behind the replacement image; its
    // descendants do not render at all, so only a strict ancestor disqualifies the box.
    if (!painted(cs) || replacedAncestor(el.parentElement) || r.width < 0.5 || r.height < 0.5) continue;
    if (!replacedAncestor(el) && [...el.childNodes].some((c) => c.nodeType === 3 && /[^ \\t\\n\\r\\f]/.test(c.data)))
      blocks.push({ tag: el.tagName.toLowerCase(), x: r.x, y: r.y, w: r.width, h: r.height, lines: renderedLines(el) });
    if (pseudoPaints(el, '::before')) pseudos.push({ hostTag: el.tagName.toLowerCase(), which: '::before' });
    if (pseudoPaints(el, '::after')) pseudos.push({ hostTag: el.tagName.toLowerCase(), which: '::after' });
    const bgAlpha = alphaOf(cs.backgroundColor);
    const hasGradient = /gradient\\(/.test(cs.backgroundImage);
    const border = widestBorder(cs);
    if (bgAlpha > 0.03 || hasGradient || border.px > 0) {
      boxes.push({
        tag: el.tagName.toLowerCase(), x: r.x, y: r.y, w: r.width, h: r.height,
        bg: bgAlpha > 0.03 ? toHex(cs.backgroundColor) : null, bgAlpha, hasGradient,
        borderPx: border.px, borderColor: border.color,
        ...spec(cs), ...layoutBox(el, r),
        opacity: opacityOf(el),
      });
    }
  }
  const rootPaintOf = (el) => {
    const cs = getComputedStyle(el);
    return {
      filter: cs.filter,
      backdropFilter: cs.backdropFilter || cs.webkitBackdropFilter || 'none',
      mixBlendMode: cs.mixBlendMode,
      clipPath: cs.clipPath || 'none',
    };
  };
  const bodyCs = getComputedStyle(document.body);
  return {
    texts, boxes, blocks, pseudos,
    bodyBg: alphaOf(bodyCs.backgroundColor) > 0.03 ? toHex(bodyCs.backgroundColor) : null,
    bodyBgImage: bodyCs.backgroundImage,
    rootPaint: { html: rootPaintOf(document.documentElement), body: rootPaintOf(document.body) },
  };
})()`
}
