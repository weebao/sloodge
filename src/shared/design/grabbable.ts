/**
 * The grabbable filter — §4.3 of `.claude/plans/init/40-design-mode.md`.
 *
 * `document.elementFromPoint` returns the *deepest* node under a point, which is very often a
 * layout-only `<span>` or an SVG `<tspan>` that the user did not mean to select. Following
 * react-grab's `isElementGrabbable`, the bridge climbs from the hit node to the first sensible
 * selection target. This module is that climb, written as a pure function over a **minimal node
 * interface** so it is unit-testable without a DOM — the iframe never executes in happy-dom, so the
 * real climb (mirrored inside `frame-script.ts`) could not otherwise be exercised at all.
 *
 * The frame script cannot import this (it ships as a serialized self-contained IIFE), so the two
 * carry the same rules independently; `frame-script.test.ts` drives the shipped copy against a real
 * happy-dom tree and this suite pins the rules in isolation, so a divergence fails a test.
 */

/** The reserved attributes this filter reads. Lowercased — how the tokenizer reports every name. */
export const SL_ID_ATTR = 'data-sl-id'
export const SL_IGNORE_ATTR = 'data-sl-ignore'

/**
 * The least a node must expose for the climb to reason about it. A real `Element` satisfies this;
 * so does a plain test object, which is the point.
 */
export interface HitNode {
  /** Lowercased tag name, e.g. `div`, `tspan`, `body`. */
  readonly tagName: string
  readonly parent: HitNode | null
  /** `null` for an attribute that is absent. */
  getAttribute: (name: string) => string | null
  /** The element's own trimmed text, used by the bare-inline-wrapper rule. */
  readonly text: string
  /** `true` when the element's rendered box is 0×0 (unrenderable). */
  readonly empty: boolean
}

/** Inline wrappers that are transparent to selection when they add nothing of their own (§4.3). */
const BARE_INLINE_TAGS: ReadonlySet<string> = new Set(['span', 'b', 'i', 'em', 'a', 'strong'])

/** SVG text-fragment tags that should resolve to their enclosing `<text>` (§4.3). */
const SVG_TEXT_FRAGMENT_TAGS: ReadonlySet<string> = new Set(['tspan', 'textpath'])

/** The three roots that are never selectable — the climb stops at `body` and selects nothing above. */
const NEVER_SELECTABLE: ReadonlySet<string> = new Set(['html', 'head', 'body'])

function isAddressable(node: HitNode): boolean {
  return node.getAttribute(SL_ID_ATTR) !== null && node.getAttribute(SL_IGNORE_ATTR) === null
}

/**
 * Whether `node` sits inside a `data-sl-ignore` subtree (itself or any ancestor). Such nodes are
 * decorative motif layers the author opted out of Design Mode entirely, so a hit on one resolves to
 * nothing rather than to the nearest mapped ancestor outside the ignored subtree.
 */
function isInsideIgnored(node: HitNode): boolean {
  for (let current: HitNode | null = node; current !== null; current = current.parent) {
    if (current.getAttribute(SL_IGNORE_ATTR) !== null) return true
  }
  return false
}

/**
 * A bare inline wrapper (§4.3): an inline tag whose text equals its parent's text and which carries
 * no class or style of its own. Selecting it is never what the user meant — they wanted the block
 * that contains the phrase, not the `<span>` layout wrapper around it.
 */
function isBareInlineWrapper(node: HitNode): boolean {
  if (!BARE_INLINE_TAGS.has(node.tagName)) return false
  if (node.getAttribute('class') !== null || node.getAttribute('style') !== null) return false
  const parent = node.parent
  return parent !== null && parent.text === node.text
}

/**
 * Climb from `hit` to the first sensible selection target, or `null` when there is none.
 *
 * With `alt` the climb is disabled: the deepest addressable node under the point wins, so a power
 * user can still reach a `<tspan>` or a layout `<span>` (§4.3). Without it, the loop steps past
 * every node that is transparent to selection — unmapped/synthetic, ignored, a bare inline wrapper,
 * an SVG text fragment, or a 0×0 box — and stops at the first real target, never rising above
 * `body`.
 *
 * `null` is returned for a hit inside a `data-sl-ignore` subtree and for a hit that reaches the
 * document roots without finding anything addressable — both are "nothing to select here", which
 * the parent renders as clearing the hover/selection rather than as an error.
 */
export function resolveSelectionTarget(hit: HitNode | null, alt: boolean): HitNode | null {
  if (hit === null) return null
  if (isInsideIgnored(hit)) return null

  if (alt) {
    // Deepest-addressable: take the hit itself if it qualifies, else climb only past nodes that are
    // not addressable at all (synthetic wrappers). The grabbable heuristics are skipped entirely.
    for (let node: HitNode | null = hit; node !== null; node = node.parent) {
      if (NEVER_SELECTABLE.has(node.tagName)) return null
      if (isAddressable(node)) return node
    }
    return null
  }

  for (let node: HitNode | null = hit; node !== null; node = node.parent) {
    if (NEVER_SELECTABLE.has(node.tagName)) return null

    if (!isAddressable(node)) continue
    if (SVG_TEXT_FRAGMENT_TAGS.has(node.tagName)) continue
    if (isBareInlineWrapper(node)) continue
    if (node.empty) continue

    return node
  }

  return null
}
