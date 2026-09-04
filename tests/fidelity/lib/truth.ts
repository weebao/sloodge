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
  /** The parent element's own computed transform, or `'none'`. */
  transform: string
  /** True when this text node or an ancestor carries a non-identity transform. */
  transformed: boolean
  /** Own `opacity` times every ancestor's — the alpha these glyphs actually paint at. */
  opacity: number
  /**
   * Uniform scale the transform chain applies, as √|det| of each 2D matrix. Glyphs render at
   * `fontSizePx * scale`, which is what the exporter must emit; `matrix3d` counts as 1 (it is
   * un-modelled and scored as such).
   */
  scale: number
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
  borderPx: number
  borderColor: string | null
  transform: string
  /** Own `opacity` times every ancestor's — the alpha this box actually paints at. */
  opacity: number
}

/** A `::before`/`::after` that paints. It has no measurable rect, so nothing can be emitted for it. */
export type TruthPseudo = {
  hostTag: string
  which: '::before' | '::after'
}

export type GroundTruth = {
  texts: TruthText[]
  boxes: TruthBox[]
  pseudos: TruthPseudo[]
  bodyBg: string | null
  bodyBgImage: string
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
  const transformedAncestor = (el) => {
    for (let p = el; p && p !== document.documentElement; p = p.parentElement) {
      if (getComputedStyle(p).transform !== 'none') return true;
    }
    return false;
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
  const chain = (el, f, combine, unit) => {
    let acc = unit;
    for (let p = el; p && p !== document.documentElement; p = p.parentElement) {
      acc = combine(acc, f(getComputedStyle(p)));
    }
    return acc;
  };
  const opacityOf = (el) =>
    chain(el, (cs) => (Number.isFinite(parseFloat(cs.opacity)) ? parseFloat(cs.opacity) : 1), (a, b) => a * b, 1);
  const scaleChain = (el) => chain(el, (cs) => scaleOf(cs.transform), (a, b) => a * b, 1);
  const pseudos = [];
  const pseudoPaints = (el, which) => {
    const ps = getComputedStyle(el, which);
    if (ps.display === 'none' || ps.content === 'none' || ps.content === 'normal') return false;
    if (parseFloat(ps.opacity) <= 0.01) return false;
    return ps.content !== '""' || alphaOf(ps.backgroundColor) > 0.03 ||
      /gradient\\(|url\\(/.test(ps.backgroundImage) || (parseFloat(ps.borderTopWidth) || 0) > 0;
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
    if (cs.display === 'none' || cs.visibility === 'hidden') continue;
    const r = document.createRange();
    r.selectNodeContents(n);
    const b = r.getBoundingClientRect();
    if (b.width < 0.5 || b.height < 0.5) continue;
    texts.push({
      text: t,
      inSvg: el.namespaceURI === 'http://www.w3.org/2000/svg',
      parentTag: el.tagName.toLowerCase(),
      x: b.x, y: b.y, w: b.width, h: b.height,
      color: toHex(cs.color), colorAlpha: alphaOf(cs.color), fontSizePx: parseFloat(cs.fontSize),
      fontWeight: cs.fontWeight, fontStyle: cs.fontStyle, textTransform: cs.textTransform,
      transform: cs.transform, transformed: transformedAncestor(el),
      opacity: opacityOf(el), scale: scaleChain(el),
    });
  }
  const boxes = [];
  for (const el of document.body.querySelectorAll('*')) {
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    if (cs.display === 'none' || cs.visibility === 'hidden' || r.width < 0.5 || r.height < 0.5) continue;
    if (pseudoPaints(el, '::before')) pseudos.push({ hostTag: el.tagName.toLowerCase(), which: '::before' });
    if (pseudoPaints(el, '::after')) pseudos.push({ hostTag: el.tagName.toLowerCase(), which: '::after' });
    const bgAlpha = alphaOf(cs.backgroundColor);
    const hasGradient = /gradient\\(/.test(cs.backgroundImage);
    const borderPx = parseFloat(cs.borderTopWidth) || 0;
    if (bgAlpha > 0.03 || hasGradient || borderPx > 0) {
      boxes.push({
        tag: el.tagName.toLowerCase(), x: r.x, y: r.y, w: r.width, h: r.height,
        bg: bgAlpha > 0.03 ? toHex(cs.backgroundColor) : null, bgAlpha, hasGradient,
        borderPx, borderColor: borderPx > 0 ? toHex(cs.borderTopColor) : null, transform: cs.transform,
        opacity: opacityOf(el),
      });
    }
  }
  const bodyCs = getComputedStyle(document.body);
  return { texts, boxes, pseudos, bodyBg: alphaOf(bodyCs.backgroundColor) > 0.03 ? toHex(bodyCs.backgroundColor) : null, bodyBgImage: bodyCs.backgroundImage };
})()`
}
