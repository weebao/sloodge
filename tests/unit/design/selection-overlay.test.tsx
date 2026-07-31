/**
 * @vitest-environment happy-dom
 *
 * The renderer-side overlay: given a selection in the store, it draws the selection box, its eight
 * handles, and the breadcrumb. The postMessage round trip cannot run under happy-dom (the iframe is
 * inert), so this covers only what the parent renders from state — the bridge itself is proven in
 * `bridge-protocol.test.ts` and `frame-script.test.tsx`.
 */

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { SlHit } from '../../../src/shared/design/bridge-protocol'
import { useDesignStore } from '../../../src/renderer/src/features/design/designStore'
import { SelectionOverlay } from '../../../src/renderer/src/features/design/SelectionOverlay'

const SELECTION: SlHit = {
  slId: 's_x:5',
  tag: 'rect',
  id: 'bar',
  classes: ['bar'],
  rect: { x: 100, y: 200, width: 320, height: 84 },
  ancestors: [
    {
      slId: 's_x:2',
      tag: 'g',
      id: null,
      classes: ['bars'],
      rect: { x: 0, y: 0, width: 1, height: 1 },
    },
    {
      slId: 's_x:0',
      tag: 'section',
      id: null,
      classes: ['slide'],
      rect: { x: 0, y: 0, width: 1, height: 1 },
    },
  ],
}

const frameRef = { current: null }

beforeEach(() => {
  useDesignStore.setState({ enabled: true, hover: null, selection: null })
})

afterEach(cleanup)

describe('SelectionOverlay', () => {
  it('renders nothing but the capture layer with no selection', () => {
    render(<SelectionOverlay frameRef={frameRef} slideId="s_x" scale={1} />)
    expect(screen.queryByTestId('design-selection')).toBeNull()
    expect(screen.queryByRole('navigation', { name: 'Selection breadcrumb' })).toBeNull()
  })

  it('draws the selection box, eight handles, and the breadcrumb', () => {
    useDesignStore.setState({ enabled: true, selection: SELECTION, hover: null })
    render(<SelectionOverlay frameRef={frameRef} slideId="s_x" scale={1} />)

    const box = screen.getByTestId('design-selection')
    expect(box.style.left).toBe('100px')
    expect(box.style.width).toBe('320px')

    for (const handle of ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']) {
      expect(screen.getByTestId(`design-handle-${handle}`)).toBeTruthy()
    }

    // Breadcrumb is root-first: section › g › rect (the selection is the last, bold crumb).
    const crumb = screen.getByRole('navigation', { name: 'Selection breadcrumb' })
    expect(crumb.textContent).toContain('section.slide')
    expect(crumb.textContent).toContain('g.bars')
    expect(crumb.textContent).toContain('rect#bar.bar')
  })

  it('scales the selection box by the fit factor', () => {
    useDesignStore.setState({ enabled: true, selection: SELECTION, hover: null })
    render(<SelectionOverlay frameRef={frameRef} slideId="s_x" scale={0.5} />)
    const box = screen.getByTestId('design-selection')
    expect(box.style.left).toBe('50px')
    expect(box.style.width).toBe('160px')
  })
})
