/**
 * @vitest-environment happy-dom
 *
 * How many times the overlay parses the whole slide while the agent writes it.
 *
 * `slideHtml` changes once per streamed token, and `buildSlideMap` is a full pass over the source, so
 * this is the hot path M8.1's perf harness exists to police. Round-6 review, major 1: the caret's
 * `canEditSelection` parsed on its own account, which measured 60 parses over a 30-token stream with
 * something selected where `origin/main` did 30 — the ordinary state of watching the agent write.
 * Nothing pinned that in either direction, so the lazy map could regress silently. This pins it.
 */

import { act, cleanup, render } from '@testing-library/react'
import type { RefObject } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SlHit } from '../../../src/shared/design/bridge-protocol'
import type * as SlideMapModule from '../../../src/shared/design/slide-map'
import { buildSlideMap } from '../../../src/shared/design/slide-map'
import { useDesignStore } from '../../../src/renderer/src/features/design/designStore'
import { SelectionOverlay } from '../../../src/renderer/src/features/design/SelectionOverlay'
import {
  createStarterDeck,
  getSlideHtml,
  useDeckStore,
} from '../../../src/renderer/src/stores/deckStore'

let parses = 0

vi.mock('../../../src/shared/design/slide-map', async (importOriginal) => {
  const actual = await importOriginal<typeof SlideMapModule>()
  return {
    ...actual,
    buildSlideMap: (slideId: string, source: string) => {
      parses += 1
      return actual.buildSlideMap(slideId, source)
    },
  }
})

/** A frame that answers nothing: this measures parses, which happen before any round trip. */
function frameRef(): RefObject<HTMLIFrameElement | null> {
  const contentWindow = { postMessage: (): void => {} }
  return { current: { contentWindow } as unknown as HTMLIFrameElement }
}

const TOKENS = 30

let slideId = ''
let baseHtml = ''
let titleHit: SlHit

beforeEach(() => {
  useDeckStore.setState(createStarterDeck(0))
  const state = useDeckStore.getState()
  slideId = state.deck.slideOrder[0]!
  baseHtml = getSlideHtml(state.slideHtml, slideId)!
  const map = buildSlideMap(slideId, baseHtml)
  const titleId = [...map.byId].find(([, span]) => span.tagName === 'h1')![0]
  titleHit = {
    slId: titleId,
    tag: 'h1',
    id: null,
    classes: [],
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

afterEach(cleanup)

/** One agent token: the slide's bytes change, and every source-derived memo is invalidated. */
function stream(count: number): void {
  for (let i = 0; i < count; i++) {
    act(() => {
      const slideHtml = Object.assign(Object.create(null) as Record<string, string>, {
        ...useDeckStore.getState().slideHtml,
        [slideId]: `${baseHtml}<!--token ${String(i)}-->`,
      })
      useDeckStore.setState({ slideHtml })
    })
  }
}

describe('SelectionOverlay parses the slide at most once per source change', () => {
  it('never parses at all with nothing selected', () => {
    render(<SelectionOverlay frameRef={frameRef()} slideId={slideId} scale={1} />)
    parses = 0

    stream(TOKENS)

    // Nobody asks for a rotation or an element, so the lazy map is never built.
    expect(parses).toBe(0)
  })

  it('parses once per change with a selection, however many readers there are', () => {
    useDesignStore.getState().setSelection(titleHit)
    render(<SelectionOverlay frameRef={frameRef()} slideId={slideId} scale={1} />)
    parses = 0

    stream(TOKENS)

    // The rotation and the edit hint are two readers of one map, not two parses (round-6 major 1).
    expect(parses).toBe(TOKENS)
  })
})
