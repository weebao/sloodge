/**
 * @vitest-environment happy-dom
 *
 * `ToolbarButton`'s two stated invariants (ui-design-audit.md §5.6): the button is always named —
 * `label` is required and becomes `aria-label`, because the audit's accessibility punch-list found
 * unlabelled glyph buttons on three surfaces — and a pressed toggle announces itself with
 * `aria-pressed`, never with colour alone (rule R5). The `pressed` prop drives both the fill and the
 * ARIA, so the two cannot disagree.
 *
 * **Why the last two rows are here rather than trusted to the props type.** Both attributes are
 * `Omit`ted from the passthrough, and that `Omit` does not do what it looks like it does:
 * TypeScript does not excess-property-check a JSX attribute whose name is hyphenated, so
 * `<ToolbarButton label="Bold" aria-label="spoofed" aria-pressed />` compiles clean on this tree,
 * and a spread is unchecked in either case. What actually holds the invariant is that both are
 * applied *after* `{...rest}` — which is a runtime property, so the suite can assert it, and must.
 *
 * Mutation: move `aria-label={label}` or `aria-pressed={pressed}` back above `{...rest}` and the
 * matching spoof row reds.
 *
 * The focus ring is covered by `focus-ring.test.tsx`, which owns rule R6 for every primitive.
 */

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { ToolbarButton } from '../../../src/renderer/src/components/ui/ToolbarButton'

afterEach(cleanup)

describe('ToolbarButton', () => {
  it('announces its pressed state, and draws it', () => {
    render(
      <ToolbarButton label="Bold" pressed>
        B
      </ToolbarButton>,
    )
    const button = screen.getByRole('button', { name: 'Bold' })
    expect(button.getAttribute('aria-pressed')).toBe('true')
    expect(button.className.split(/\s+/)).toContain('bg-pressed')
  })

  it('is not a toggle at all when `pressed` is omitted', () => {
    render(<ToolbarButton label="Bold">B</ToolbarButton>)
    const button = screen.getByRole('button', { name: 'Bold' })
    // Absent, not `aria-pressed="false"`: a button that is not a toggle must not be announced as an
    // un-pressed one.
    expect(button.hasAttribute('aria-pressed')).toBe(false)
    expect(button.className.split(/\s+/)).not.toContain('bg-pressed')
  })

  it('cannot be told to announce a state its fill contradicts', () => {
    const spoof = { 'aria-pressed': true }
    render(
      <ToolbarButton label="Bold" pressed={false} {...spoof}>
        B
      </ToolbarButton>,
    )
    const button = screen.getByRole('button', { name: 'Bold' })
    expect(button.getAttribute('aria-pressed')).toBe('false')
    expect(button.className.split(/\s+/)).not.toContain('bg-pressed')
  })

  it('cannot be told to announce a name other than its label', () => {
    const spoof = { 'aria-label': 'spoofed' }
    render(
      <ToolbarButton label="Bold" {...spoof}>
        B
      </ToolbarButton>,
    )
    expect(screen.getByRole('button').getAttribute('aria-label')).toBe('Bold')
    // The tooltip is not the accessible name, and overriding it is legitimate.
    expect(screen.getByRole('button').getAttribute('title')).toBe('Bold')
  })
})
