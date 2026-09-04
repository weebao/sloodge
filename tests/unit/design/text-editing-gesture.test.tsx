/**
 * @vitest-environment happy-dom
 *
 * Round-2 review blockers, both found only in the running app and both in the overlay's gesture and
 * focus rules around a text-edit session:
 *
 * 1. A double-click must edit the element the **first click selected**, never re-hit-test the
 *    pointer — the first click's selection mounts the property panel, and on a fresh deck the stage
 *    re-fit between the two clicks, so a second hit-test landed on the slide root and no caret opened.
 * 2. When a session ends because focus moved somewhere useful — the chat composer, a property field,
 *    the Settings dialog — the overlay must not pull focus back to itself.
 *
 * happy-dom cannot run the iframe, so the frame is a stub whose `postMessage` records what the parent
 * asked for: a hit-test or a caret, and on which element.
 */

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { RefObject } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SL_EDIT, SL_HITTEST, type SlHit } from '../../../src/shared/design/bridge-protocol'
import { buildSlideMap } from '../../../src/shared/design/slide-map'
import { useDesignStore } from '../../../src/renderer/src/features/design/designStore'
import { SelectionOverlay } from '../../../src/renderer/src/features/design/SelectionOverlay'
import { SettingsDialog } from '../../../src/renderer/src/features/settings/SettingsDialog'
import {
  createStarterDeck,
  getSlideHtml,
  useDeckStore,
} from '../../../src/renderer/src/stores/deckStore'

vi.mock('../../../src/renderer/src/features/chat/agentClient', () => ({
  getAgentBridge: () => undefined,
}))

interface Posted {
  readonly type: string
  readonly payload: Record<string, unknown>
}

/** A frame that only records what the parent posts to it. */
function fakeFrame(): { frameRef: RefObject<HTMLIFrameElement | null>; posted: Posted[] } {
  const posted: Posted[] = []
  const contentWindow = {
    postMessage: (message: unknown): void => {
      posted.push(message as Posted)
    },
  }
  return { frameRef: { current: { contentWindow } as unknown as HTMLIFrameElement }, posted }
}

let slideId = ''
let titleHit: SlHit

beforeEach(() => {
  useDeckStore.setState(createStarterDeck(0))
  const state = useDeckStore.getState()
  slideId = state.deck.slideOrder[0]!
  const map = buildSlideMap(slideId, getSlideHtml(state.slideHtml, slideId)!)
  const titleSlId = [...map.byId].find(([, span]) => span.tagName === 'h1')![0]
  titleHit = {
    slId: titleSlId,
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

afterEach(cleanup)

function overlay(frameRef: RefObject<HTMLIFrameElement | null>): HTMLElement {
  const { container } = render(<SelectionOverlay frameRef={frameRef} slideId={slideId} scale={1} />)
  return container.firstElementChild as HTMLElement
}

describe('SelectionOverlay — double-click edits the selection, not the pointer (round-2 blocker 1)', () => {
  it('a single click hit-tests the pointer in select mode (the control)', () => {
    const { frameRef, posted } = fakeFrame()
    const root = overlay(frameRef)
    fireEvent.click(root, { detail: 1, clientX: 5, clientY: 700 })
    expect(posted.map((m) => m.type)).toEqual([SL_HITTEST])
    expect(posted[0]!.payload['mode']).toBe('select')
  })

  it('the second click of a double-click sends no hit-test', () => {
    const { frameRef, posted } = fakeFrame()
    const root = overlay(frameRef)
    fireEvent.click(root, { detail: 2, clientX: 5, clientY: 700 })
    expect(posted).toEqual([])
  })

  it('with an element selected, dblclick asks for a caret on it — even at a point over another element', () => {
    const { frameRef, posted } = fakeFrame()
    useDesignStore.getState().setSelection(titleHit)
    const root = overlay(frameRef)

    // The pair's second click and the dblclick, at a point ~600px below the title (the slide root, as
    // in the review's repro after the stage re-fit). Neither may hit-test.
    fireEvent.click(root, { detail: 2, clientX: 5, clientY: 700 })
    fireEvent.dblClick(root, { detail: 2, clientX: 5, clientY: 700 })

    expect(posted.map((m) => m.type)).toEqual([SL_EDIT])
    expect(posted[0]!.payload).toEqual({ slId: titleHit.slId, action: 'begin' })
    expect(useDesignStore.getState().selection?.slId).toBe(titleHit.slId)
  })

  it('with nothing selected, dblclick falls back to a hit-test (select-then-edit on the answer)', () => {
    const { frameRef, posted } = fakeFrame()
    const root = overlay(frameRef)
    fireEvent.dblClick(root, { detail: 2, clientX: 600, clientY: 70 })
    // The edit intent is parent-side (`HitMode`); on the wire every point hit-test is a `select`.
    expect(posted.map((m) => m.type)).toEqual([SL_HITTEST])
    expect(posted[0]!.payload['mode']).toBe('select')
  })

  it('with a group selected, dblclick hit-tests: a group has no one element to type into', () => {
    const { frameRef, posted } = fakeFrame()
    useDesignStore.getState().setSelections([titleHit, { ...titleHit, slId: `${slideId}:99` }])
    const root = overlay(frameRef)
    fireEvent.dblClick(root, { detail: 2, clientX: 600, clientY: 70 })
    expect(posted.map((m) => m.type)).toEqual([SL_HITTEST])
  })
})

/** Open a session in the store, move focus, then end it — the sequence a blur-commit produces. */
function endSessionWithFocusOn(target: HTMLElement): void {
  act(() => {
    useDesignStore.setState({ editing: titleHit.slId })
  })
  target.focus()
  act(() => {
    useDesignStore.setState({ editing: null })
  })
}

describe('SelectionOverlay — a session ending never steals focus (round-2 blocker 2)', () => {
  it('commit by clicking the chat composer: the composer keeps focus and the next keystroke', () => {
    const { frameRef } = fakeFrame()
    useDesignStore.getState().setSelection(titleHit)
    render(
      <>
        <textarea id="chat-composer" aria-label="Ask Claude" />
        <SelectionOverlay frameRef={frameRef} slideId={slideId} scale={1} />
      </>,
    )
    const composer = screen.getByLabelText('Ask Claude')

    endSessionWithFocusOn(composer)

    expect(document.activeElement).toBe(composer)
    const seen = vi.fn()
    composer.addEventListener('keydown', seen)
    fireEvent.keyDown(document.activeElement as Element, { key: 'h' })
    expect(seen).toHaveBeenCalledTimes(1)
  })

  it('commit by clicking a property-panel field: the field keeps focus', () => {
    const { frameRef } = fakeFrame()
    useDesignStore.getState().setSelection(titleHit)
    render(
      <>
        <input aria-label="Size" name="fontSize" />
        <SelectionOverlay frameRef={frameRef} slideId={slideId} scale={1} />
      </>,
    )
    const field = screen.getByLabelText('Size')
    endSessionWithFocusOn(field)
    expect(document.activeElement).toBe(field)
  })

  it('commit by opening Settings: the dialog keeps focus and Escape closes it', () => {
    const { frameRef } = fakeFrame()
    useDesignStore.getState().setSelection(titleHit)
    const onClose = vi.fn()
    act(() => {
      useDesignStore.setState({ editing: titleHit.slId })
    })
    render(
      <>
        <SelectionOverlay frameRef={frameRef} slideId={slideId} scale={1} />
        <SettingsDialog open initialTab="auth" onClose={onClose} />
      </>,
    )
    const dialog = screen.getByRole('dialog')
    // The dialog took focus on open (its own effect); the frame blurred and the session committed.
    expect(document.activeElement).toBe(dialog)
    act(() => {
      useDesignStore.setState({ editing: null })
    })

    expect(document.activeElement).toBe(dialog)
    fireEvent.keyDown(dialog, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('commit by Enter/Escape (focus still in the frame): the overlay takes focus back for its keys', () => {
    const iframe = document.createElement('iframe')
    document.body.appendChild(iframe)
    useDesignStore.getState().setSelection(titleHit)
    const root = overlay({ current: iframe })
    endSessionWithFocusOn(iframe)
    expect(document.activeElement).toBe(root)
    iframe.remove()
  })

  it('commit with focus on nothing (body): the overlay takes focus back', () => {
    const { frameRef } = fakeFrame()
    useDesignStore.getState().setSelection(titleHit)
    const root = overlay(frameRef)
    act(() => {
      useDesignStore.setState({ editing: titleHit.slId })
    })
    ;(document.activeElement as HTMLElement | null)?.blur()
    expect(document.activeElement).toBe(document.body)
    act(() => {
      useDesignStore.setState({ editing: null })
    })
    expect(document.activeElement).toBe(root)
  })
})
