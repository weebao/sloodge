/**
 * @vitest-environment happy-dom
 *
 * Round-2 review blocker 1, half (b): selecting an element must not change the slide's on-screen
 * geometry. The property panel is a dock that takes its height from the slide's mat, so it has to be
 * mounted — at a fixed height — before the first selection, not on it.
 *
 * happy-dom has no layout engine (every box is 0x0), so pixels cannot be asserted here; what can is
 * the structural invariant the pixels follow from: the dock is the same node before and after a
 * selection, its size does not come from its content, and the stage's fit is untouched. The pixel
 * proof — the iframe rect identical across the first click — is the CDP run recorded in the round-2
 * fix report.
 */

import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SlHit } from '../../../src/shared/design/bridge-protocol'
import { buildSlideMap } from '../../../src/shared/design/slide-map'
import { SlideCanvas } from '../../../src/renderer/src/features/canvas/SlideCanvas'
import { useDesignStore } from '../../../src/renderer/src/features/design/designStore'
import {
  createStarterDeck,
  getSlideHtml,
  selectSlideViews,
  useDeckStore,
  type SlideView,
} from '../../../src/renderer/src/stores/deckStore'

let slide: SlideView
let titleHit: SlHit

beforeEach(() => {
  // happy-dom's `createObjectURL` has no blob store behind it; the frame's URL is irrelevant here.
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('about:blank')
  vi.spyOn(URL, 'revokeObjectURL').mockReturnValue(undefined)
  useDeckStore.setState(createStarterDeck(0))
  const state = useDeckStore.getState()
  slide = selectSlideViews(state.deck, state.slideHtml)[0]!
  const map = buildSlideMap(slide.id, getSlideHtml(state.slideHtml, slide.id)!)
  titleHit = {
    slId: [...map.byId].find(([, span]) => span.tagName === 'h1')![0],
    tag: 'h1',
    id: null,
    classes: ['title'],
    rect: { x: 48, y: 48, width: 1184, height: 55 },
    ancestors: [],
  }
  useDesignStore.setState({
    enabled: true,
    hover: null,
    selections: [],
    selection: null,
    editing: null,
  })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('SlideCanvas — the property dock never moves the slide', () => {
  it('the dock is mounted before any selection and is the same fixed-height box after one', () => {
    const { container } = render(<SlideCanvas slide={slide} />)
    const dock = screen.getByTestId('property-panel')
    expect(screen.getByTestId('property-panel-empty')).toBeTruthy()
    const stage = container.querySelector<HTMLElement>('main > div > div.relative')!
    const before = {
      className: dock.className,
      width: stage.style.width,
      height: stage.style.height,
    }

    act(() => {
      useDesignStore.getState().setSelection(titleHit)
    })

    // Nothing mounted or unmounted around the mat, so nothing for `useElementSize` to re-measure.
    expect(screen.getByTestId('property-panel')).toBe(dock)
    expect(dock.className).toBe(before.className)
    // The height is a fixed token with internal scrolling, not the content's height.
    expect(dock.className).toMatch(/\bh-64\b/)
    expect(dock.className).toMatch(/\boverflow-y-auto\b/)
    expect(stage.style.width).toBe(before.width)
    expect(stage.style.height).toBe(before.height)
    // And the dock is now the real panel.
    expect(screen.queryByTestId('property-panel-empty')).toBeNull()
    expect(screen.getByTestId('prop-text')).toBeTruthy()
  })

  it('clearing the selection keeps the same dock, back in its empty state', () => {
    useDesignStore.getState().setSelection(titleHit)
    render(<SlideCanvas slide={slide} />)
    const dock = screen.getByTestId('property-panel')
    act(() => {
      useDesignStore.getState().setSelection(null)
    })
    expect(screen.getByTestId('property-panel')).toBe(dock)
    expect(screen.getByTestId('property-panel-empty')).toBeTruthy()
  })

  it('with Design Mode off there is no dock: the live slide has no properties to show', () => {
    useDesignStore.getState().setEnabled(false)
    render(<SlideCanvas slide={slide} />)
    expect(screen.queryByTestId('property-panel')).toBeNull()
    expect(screen.getByTestId('canvas-live-hint')).toBeTruthy()
  })
})
