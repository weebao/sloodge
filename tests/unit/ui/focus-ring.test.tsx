/**
 * @vitest-environment happy-dom
 *
 * Rule R6 (ui-design-audit.md §5.2): every interactive primitive draws **one** focus ring, and it is
 * `focus-visible:outline-2 focus-visible:outline-focus focus-visible:outline-offset-2`.
 *
 * §10's unguarded list named this as the one M8b.2 property with no command behind it. What follows
 * is the strongest form this repo's harness can actually run, and it is deliberately in two halves
 * so neither half can pass for the other:
 *
 *  - **here**, that each primitive's rendered element carries the recipe, with the recipe spelled out
 *    as a literal rather than read from `FOCUS_RING` — a test that imports the constant it is
 *    checking would stay green while the constant itself drifted, which is this repo's recurring
 *    defect (a test that cannot detect its own subject);
 *  - **`focus-ring-compiles.test.ts`**, that those three class names compile, on the installed
 *    Tailwind against the real `theme.css`, to a `:focus-visible` rule that paints
 *    `var(--color-focus)` — the half that ties the string to a colour.
 *
 * What neither half can show: that the ring is *visible* on the ground the control sits on. happy-dom
 * applies no stylesheet, so there is no computed `outline-color` to read. Contrast is covered by the
 * 63-pair census (`--check`, rows 42–45), which measures `focus` against every surface role.
 *
 * Mutation: delete `${FOCUS_RING}` from any one primitive's className and the row for that primitive
 * reds, naming it.
 */

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { Button } from '../../../src/renderer/src/components/ui/Button'
import { Chip } from '../../../src/renderer/src/components/ui/Chip'
import { Input } from '../../../src/renderer/src/components/ui/Input'
import { ToolbarButton } from '../../../src/renderer/src/components/ui/ToolbarButton'
import { FOCUS_RING } from '../../../src/renderer/src/components/ui/focusRing'

/** Written out, not imported: this is the assertion, and R6 is the reason it reads this way. */
const RING = [
  'focus-visible:outline-2',
  'focus-visible:outline-focus',
  'focus-visible:outline-offset-2',
] as const

afterEach(cleanup)

describe('R6 — one focus ring, on every interactive primitive', () => {
  it('is the recipe the audit prescribes, and nothing else', () => {
    expect(FOCUS_RING).toBe(RING.join(' '))
  })

  const cases: readonly [name: string, render: () => void, find: () => HTMLElement][] = [
    ['Button', () => render(<Button>Save</Button>), () => screen.getByRole('button')],
    [
      'ToolbarButton',
      () => render(<ToolbarButton label="Bold">B</ToolbarButton>),
      () => screen.getByRole('button'),
    ],
    ['Input', () => render(<Input aria-label="Name" />), () => screen.getByRole('textbox')],
    [
      'Chip (interactive)',
      () =>
        render(
          <Chip onClick={noop} label="slide 2">
            slide 2
          </Chip>,
        ),
      () => screen.getByRole('button', { name: 'slide 2' }),
    ],
    [
      'Chip (remove)',
      () =>
        render(
          <Chip onRemove={noop} label="slide 2">
            slide 2
          </Chip>,
        ),
      () => screen.getByRole('button', { name: 'Remove slide 2' }),
    ],
  ]

  it.each(cases)('%s carries the ring', (name, mount, find) => {
    mount()
    const klass = find().className
    for (const part of RING) {
      expect(klass.split(/\s+/), `${name} is missing ${part}`).toContain(part)
    }
  })

  it('covers every interactive primitive the ui barrel exports', async () => {
    // A row-per-primitive table silently stops covering a primitive that is added later. The barrel
    // is the enumeration of what exists, so the count is pinned against it.
    const barrel = await import('../../../src/renderer/src/components/ui/index')
    expect(Object.keys(barrel).toSorted()).toEqual([
      'Button',
      'Chip',
      'Dialog',
      'FOCUS_RING',
      'Input',
      'Notice',
      'PanelHeading',
      'ToolbarButton',
      'dividerGap',
    ])
  })
})

function noop(): void {}
