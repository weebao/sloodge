/**
 * The independent ground truth for a rendered slide (research/pptx-export-fidelity.md §0).
 *
 * Deliberately NOT derived from the exporter's own measurement pass: it walks every **text node**
 * with `TreeWalker` + `Range.getBoundingClientRect()` and the computed style of its parent, plus every
 * element that paints a background or border. The exporter's leaf-element rule is one of the things
 * under test, so the oracle must not share it.
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
  fontSizePx: number
  fontWeight: string
  fontStyle: string
  textTransform: string
  /** The parent element's own computed transform, or `'none'`. */
  transform: string
  /** True when this text node or an ancestor carries a non-identity transform. */
  transformed: boolean
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
}

export type GroundTruth = {
  texts: TruthText[]
  boxes: TruthBox[]
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
      color: toHex(cs.color), fontSizePx: parseFloat(cs.fontSize),
      fontWeight: cs.fontWeight, fontStyle: cs.fontStyle, textTransform: cs.textTransform,
      transform: cs.transform, transformed: transformedAncestor(el),
    });
  }
  const boxes = [];
  for (const el of document.body.querySelectorAll('*')) {
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    if (cs.display === 'none' || cs.visibility === 'hidden' || r.width < 0.5 || r.height < 0.5) continue;
    const bgAlpha = alphaOf(cs.backgroundColor);
    const hasGradient = /gradient\\(/.test(cs.backgroundImage);
    const borderPx = parseFloat(cs.borderTopWidth) || 0;
    if (bgAlpha > 0.03 || hasGradient || borderPx > 0) {
      boxes.push({
        tag: el.tagName.toLowerCase(), x: r.x, y: r.y, w: r.width, h: r.height,
        bg: bgAlpha > 0.03 ? toHex(cs.backgroundColor) : null, bgAlpha, hasGradient,
        borderPx, borderColor: borderPx > 0 ? toHex(cs.borderTopColor) : null, transform: cs.transform,
      });
    }
  }
  const bodyCs = getComputedStyle(document.body);
  return { texts, boxes, bodyBg: alphaOf(bodyCs.backgroundColor) > 0.03 ? toHex(bodyCs.backgroundColor) : null, bodyBgImage: bodyCs.backgroundImage };
})()`
}
