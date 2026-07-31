/**
 * The grabbable climb (§4.3). Exercised over the minimal `HitNode` interface — no DOM — so every
 * rule the frame script mirrors is pinned here, where the iframe's inability to run under happy-dom
 * cannot hide a regression.
 */

import { describe, expect, it } from 'vitest'
import {
  resolveSelectionTarget,
  SL_ID_ATTR,
  SL_IGNORE_ATTR,
  type HitNode,
} from '../../../src/shared/design/grabbable'

type Attrs = Record<string, string>

/** Build a node with a fluent parent chain. `attrs` are literal attribute values. */
function node(
  tagName: string,
  attrs: Attrs = {},
  options: { text?: string; empty?: boolean; parent?: HitNode | null } = {},
): HitNode {
  return {
    tagName,
    parent: options.parent ?? null,
    getAttribute: (name) => (name in attrs ? attrs[name]! : null),
    text: options.text ?? '',
    empty: options.empty ?? false,
  }
}

const sl = (n: number): Attrs => ({ [SL_ID_ATTR]: `s_x:${String(n)}` })

describe('resolveSelectionTarget', () => {
  it('returns the hit itself when it is already addressable', () => {
    const el = node('rect', sl(3))
    expect(resolveSelectionTarget(el, false)?.tagName).toBe('rect')
  })

  it('climbs past a synthetic (unmapped) node to the nearest mapped ancestor', () => {
    const parent = node('div', sl(1))
    const child = node('span', {}, { parent })
    expect(resolveSelectionTarget(child, false)).toBe(parent)
  })

  it('climbs past a bare inline wrapper whose text equals its parent', () => {
    const parent = node('p', sl(1), { text: 'Revenue' })
    const wrapper = node('span', sl(2), { text: 'Revenue', parent })
    // Same text, no class/style of its own → transparent; the block wins.
    expect(resolveSelectionTarget(wrapper, false)).toBe(parent)
  })

  it('keeps an inline element that carries its own class', () => {
    const parent = node('p', sl(1), { text: 'Revenue rose' })
    const styled = node('span', { ...sl(2), class: 'kpi' }, { text: 'rose', parent })
    expect(resolveSelectionTarget(styled, false)).toBe(styled)
  })

  it('resolves an SVG <tspan> to its enclosing addressable ancestor', () => {
    const text = node('text', sl(1))
    const tspan = node('tspan', sl(2), { parent: text })
    expect(resolveSelectionTarget(tspan, false)).toBe(text)
  })

  it('climbs past a 0×0 box', () => {
    const parent = node('div', sl(1))
    const zero = node('div', sl(2), { parent, empty: true })
    expect(resolveSelectionTarget(zero, false)).toBe(parent)
  })

  it('returns null inside a data-sl-ignore subtree', () => {
    const ignored = node('div', { [SL_IGNORE_ATTR]: '' })
    const child = node('rect', sl(2), { parent: ignored })
    expect(resolveSelectionTarget(child, false)).toBeNull()
  })

  it('never selects html/head/body and returns null at the root', () => {
    const body = node('body', sl(0))
    const wrapper = node('span', {}, { parent: body })
    expect(resolveSelectionTarget(wrapper, false)).toBeNull()
  })

  it('returns null for a null hit', () => {
    expect(resolveSelectionTarget(null, false)).toBeNull()
  })

  describe('alt bypasses the grabbable heuristics', () => {
    it('selects the deepest addressable node, keeping a bare wrapper', () => {
      const parent = node('p', sl(1), { text: 'Revenue' })
      const wrapper = node('span', sl(2), { text: 'Revenue', parent })
      expect(resolveSelectionTarget(wrapper, true)).toBe(wrapper)
    })

    it('still refuses an ignored subtree and the document roots', () => {
      const ignored = node('div', { [SL_IGNORE_ATTR]: '' })
      const child = node('rect', sl(2), { parent: ignored })
      expect(resolveSelectionTarget(child, true)).toBeNull()

      const body = node('body', sl(0))
      expect(resolveSelectionTarget(body, true)).toBeNull()
    })

    it('climbs past a purely synthetic node to the deepest addressable one', () => {
      const parent = node('div', sl(1))
      const synthetic = node('span', {}, { parent })
      expect(resolveSelectionTarget(synthetic, true)).toBe(parent)
    })
  })
})
