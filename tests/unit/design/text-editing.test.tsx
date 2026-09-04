/**
 * @vitest-environment happy-dom
 *
 * M3.11 parent side: `useTextEditing` — the one place a committed string becomes document bytes.
 *
 * happy-dom cannot run the iframe, so the frame half is stubbed: `requestEdit` records what the
 * parent asked for, and a frame-originated end is delivered by calling `onFrameEditEnd`, exactly the
 * shape `useDesignBridge` hands over after validating the envelope. What is asserted here is the
 * part that matters and is pure of the DOM — what lands in the source, and what lands on the undo
 * stack.
 */

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  SlEditAction,
  SlEditEventPayload,
  SlEditResponse,
} from '../../../src/shared/design/bridge-protocol'
import { findForbiddenApiTokens } from '../../../src/shared/document/slide-contract'
import { buildSlideMap } from '../../../src/shared/design/slide-map'
import { DEFAULT_MAX_HISTORY_ENTRIES } from '../../../src/shared/document/history'
import { runEditAction } from '../../../src/renderer/src/app/editActions'
import { useDesignStore } from '../../../src/renderer/src/features/design/designStore'
import { activeTextEditSession } from '../../../src/renderer/src/features/design/textEditSession'
import { useTextEditing } from '../../../src/renderer/src/features/design/useTextEditing'
import {
  createStarterDeck,
  getSlideHtml,
  useDeckStore,
} from '../../../src/renderer/src/stores/deckStore'

const SLIDE_HTML = `<!doctype html><html><body>
<div class="slide" data-sl-slide="X">
  <h1 class="title">Old title</h1>
  <p class="mixed">Revenue <b>18%</b> Q3</p>
  <p class="locked" data-sl-lock>Chrome</p>
</div>
</body></html>`

let slideId = ''

function seedDeck(html = SLIDE_HTML): string {
  const base = createStarterDeck(0)
  const id = base.currentSlideId
  if (id === null) throw new Error('starter deck has no slide')
  const slides = Object.assign(Object.create(null) as Record<string, string>, { [id]: html })
  base.history.reset({
    manifest: base.deck,
    slides,
    notes: Object.create(null) as Record<string, string>,
    theme: null,
  })
  useDeckStore.setState({
    history: base.history,
    deck: base.history.doc.manifest,
    slideHtml: base.history.doc.slides,
    currentSlideId: id,
    canUndo: base.history.canUndo,
    canRedo: base.history.canRedo,
  })
  return id
}

/** The sl-id of the first element carrying `class`. */
function idOfClass(cls: string): string {
  const source = getSlideHtml(useDeckStore.getState().slideHtml, slideId) ?? ''
  const map = buildSlideMap(slideId, source)
  for (const [id, span] of map.byId as ReadonlyMap<string, { attrs: Record<string, unknown> }>) {
    const attr = span.attrs['class'] as { value: { start: number; end: number } | null } | undefined
    if (attr?.value && source.slice(attr.value.start, attr.value.end).split(/\s+/).includes(cls)) {
      return id
    }
  }
  throw new Error(`no .${cls} in fixture`)
}

function currentHtml(): string {
  return getSlideHtml(useDeckStore.getState().slideHtml, slideId) ?? ''
}

function undoDepth(): number {
  return useDeckStore.getState().history.summary().undoDepth
}

interface Harness {
  readonly result: { current: ReturnType<typeof useTextEditing> }
  readonly sent: { slId: string; action: SlEditAction }[]
  /** Every `onResult` the hook handed over, in request order, for tests that answer by hand. */
  readonly replies: ((result: SlEditResponse) => void)[]
}

/**
 * `confirm` makes the stubbed frame answer every `begin` with a caret at once — what the real frame
 * does, one message later. Tests about the reply itself pass `false` and answer through `replies`.
 */
function mount(confirm = true): Harness {
  const sent: Harness['sent'] = []
  const replies: Harness['replies'] = []
  const requestEdit = vi.fn(
    (slId: string, action: SlEditAction, onResult?: (result: SlEditResponse) => void) => {
      sent.push({ slId, action })
      if (onResult) replies.push(onResult)
      if (confirm && action === 'begin' && onResult) onResult({ slId, text: '', editing: true })
    },
  )
  const { result } = renderHook(() => useTextEditing({ slideId, requestEdit }))
  return { result, sent, replies }
}

/** A caret opens only on the selected element, so select first — as every overlay path does. */
function select(slId: string): void {
  useDesignStore.getState().setSelection({
    slId,
    tag: 'h1',
    id: null,
    classes: [],
    rect: { x: 0, y: 0, width: 1, height: 1 },
    ancestors: [],
  })
}

/** Select `slId` and ask for a caret, as the overlay's double-click does. */
function open(harness: Harness, slId: string): boolean {
  let opened = false
  act(() => {
    select(slId)
    opened = harness.result.current.beginEdit(slId)
  })
  return opened
}

/** Deliver a frame-originated session end, as `useDesignBridge` would after validating it. */
function frameEnd(
  harness: Harness,
  payload: Partial<SlEditEventPayload> & { slId: string; text: string },
): void {
  act(() => {
    harness.result.current.onFrameEditEnd({ reason: 'enter', ...payload })
  })
}

beforeEach(() => {
  slideId = seedDeck()
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
})

describe('useTextEditing — opening a session', () => {
  it('opens on an editable element and asks the frame for a caret', () => {
    const harness = mount()
    const id = idOfClass('title')

    const opened = open(harness, id)

    expect(opened).toBe(true)
    expect(harness.sent).toEqual([{ slId: id, action: 'begin' }])
    expect(useDesignStore.getState().editing).toBe(id)
  })

  it.each([
    ['mixed inline content', 'mixed'],
    ['a locked element', 'locked'],
  ])('declines %s without touching the frame', (_label, cls) => {
    const harness = mount()

    const opened = open(harness, idOfClass(cls))

    expect(opened).toBe(false)
    expect(harness.sent).toEqual([])
    expect(useDesignStore.getState().editing).toBeNull()
  })

  it('declines an sl-id the map does not know', () => {
    const harness = mount()

    const opened = open(harness, 'nope:999')

    expect(opened).toBe(false)
    expect(harness.sent).toEqual([])
  })
})

/**
 * Round-2 review, minor 4: the frame is the source of truth for whether a caret exists. `editing` is
 * set on the frame's confirmation, never on the request — and the frame is told when the store
 * closes a session without going through the hook.
 */
describe('useTextEditing — the frame is the source of truth for session start', () => {
  it('editing is set only when the frame confirms the caret', () => {
    const harness = mount(false)
    const id = idOfClass('title')

    expect(open(harness, id)).toBe(true)
    expect(harness.sent).toEqual([{ slId: id, action: 'begin' }])
    expect(useDesignStore.getState().editing).toBeNull()
    expect(activeTextEditSession()).toBeNull()

    act(() => {
      harness.replies[0]!({ slId: id, text: 'Old title', editing: true })
    })
    expect(useDesignStore.getState().editing).toBe(id)
    expect(activeTextEditSession()).not.toBeNull()
  })

  it.each([
    ['editing:false', { slId: '', text: 'x', editing: false }],
    ['null', null],
  ])('a frame that declines (%s) never sets editing, so nothing is stranded', (_label, answer) => {
    const harness = mount(false)
    const id = idOfClass('title')
    open(harness, id)

    act(() => {
      harness.replies[0]!(answer === null ? null : { ...answer, slId: id })
    })
    expect(useDesignStore.getState().editing).toBeNull()
    expect(harness.sent).toEqual([{ slId: id, action: 'begin' }])
    // Enter/F2 stay armed: a fresh begin is asked for, not refused.
    expect(open(harness, id)).toBe(true)
  })

  it('a frame that never answers leaves the overlay in selection mode, not pass-through', () => {
    const harness = mount(false)
    open(harness, idOfClass('title'))
    expect(useDesignStore.getState().editing).toBeNull()
  })

  it('a reply to a superseded begin is dropped; only the newest request may open', () => {
    // A second editable target: the fixture's third paragraph with its lock removed.
    slideId = seedDeck(SLIDE_HTML.replace(' data-sl-lock', ''))
    const harness = mount(false)
    const title = idOfClass('title')
    const second = idOfClass('locked')
    open(harness, title)
    open(harness, second)

    act(() => {
      harness.replies[0]!({ slId: title, text: 'Old title', editing: true })
    })
    expect(useDesignStore.getState().editing).toBeNull()
    act(() => {
      harness.replies[1]!({ slId: second, text: 'Chrome', editing: true })
    })
    expect(useDesignStore.getState().editing).toBe(second)
  })

  it('a confirmation that arrives after the selection moved on cancels the caret', () => {
    const harness = mount(false)
    const id = idOfClass('title')
    open(harness, id)
    act(() => {
      select(idOfClass('mixed'))
    })

    act(() => {
      harness.replies[0]!({ slId: id, text: 'Old title', editing: true })
    })
    expect(useDesignStore.getState().editing).toBeNull()
    expect(harness.sent).toEqual([
      { slId: id, action: 'begin' },
      { slId: id, action: 'cancel' },
    ])
  })

  it('the store closing a session behind the hook sends the frame a cancel and unregisters it', () => {
    const harness = mount()
    const id = idOfClass('title')
    open(harness, id)
    expect(activeTextEditSession()).not.toBeNull()

    act(() => {
      select(idOfClass('mixed'))
    })
    expect(useDesignStore.getState().editing).toBeNull()
    expect(harness.sent.at(-1)).toEqual({ slId: id, action: 'cancel' })
    expect(activeTextEditSession()).toBeNull()
  })

  it('a session the hook ends itself sends no redundant cancel', () => {
    const harness = mount()
    const id = idOfClass('title')
    open(harness, id)
    frameEnd(harness, { slId: id, text: 'New title' })
    expect(harness.sent).toEqual([{ slId: id, action: 'begin' }])
  })

  it('unmounting with a session open clears the flag and asks the frame for nothing', () => {
    // The bridge's listener is gone before this cleanup runs, so a `commit` request could never be
    // answered (round-2 review, minor 3); the frame's blur is what commits on every real path.
    const harness = mount()
    const id = idOfClass('title')
    open(harness, id)
    cleanup()
    expect(useDesignStore.getState().editing).toBeNull()
    expect(harness.sent).toEqual([{ slId: id, action: 'begin' }])
  })
})

describe('useTextEditing — committing', () => {
  it('writes the text and pushes exactly one undo entry', () => {
    const harness = mount()
    const id = idOfClass('title')
    const before = undoDepth()

    open(harness, id)
    frameEnd(harness, { slId: id, text: 'New title' })

    expect(currentHtml()).toContain('<h1 class="title">New title</h1>')
    expect(undoDepth()).toBe(before + 1)
    expect(useDesignStore.getState().editing).toBeNull()
  })

  it('undo restores the previous text byte-exactly in one step', () => {
    const harness = mount()
    const id = idOfClass('title')

    open(harness, id)
    frameEnd(harness, { slId: id, text: 'New title' })
    act(() => {
      useDeckStore.getState().undo()
    })

    expect(currentHtml()).toBe(SLIDE_HTML)
  })

  it('commits nothing when the text is unchanged — a no-op cannot consume a Ctrl+Z', () => {
    const harness = mount()
    const id = idOfClass('title')
    const before = undoDepth()

    open(harness, id)
    frameEnd(harness, { slId: id, text: 'Old title' })

    expect(undoDepth()).toBe(before)
    expect(currentHtml()).toBe(SLIDE_HTML)
  })

  it('ignores an end event for an element that is not the open session', () => {
    const harness = mount()
    const id = idOfClass('title')
    const before = undoDepth()

    open(harness, id)
    // A forged event naming a different element must not write to it.
    frameEnd(harness, { slId: idOfClass('mixed'), text: 'hijacked' })

    expect(undoDepth()).toBe(before)
    expect(currentHtml()).toBe(SLIDE_HTML)
  })

  it('ignores an end event when no session is open at all', () => {
    const harness = mount()
    const before = undoDepth()

    frameEnd(harness, { slId: idOfClass('title'), text: 'unsolicited' })

    expect(undoDepth()).toBe(before)
    expect(currentHtml()).toBe(SLIDE_HTML)
  })
})

/**
 * The other half of the coalescing proof. `frame-script-edit.test.tsx` shows the frame posts nothing
 * while typing; this shows that even if it did, one *session* is at most one entry — and that a long
 * run of real sessions cannot evict the user's history past the cap the way M3.8's colour picker did.
 */
describe('useTextEditing — the undo cap cannot be flooded', () => {
  it('a burst of end events for one session yields at most one entry', () => {
    const harness = mount()
    const id = idOfClass('title')
    const before = undoDepth()

    open(harness, id)
    // Only the first is accepted: the session closes on the first end, so the rest are unsolicited.
    for (let index = 0; index < 200; index += 1) {
      frameEnd(harness, { slId: id, text: `burst ${String(index)}` })
    }

    expect(undoDepth()).toBe(before + 1)
  })

  it('300 genuine edits stay one entry each and never exceed the 200-entry cap', () => {
    const harness = mount()
    const id = idOfClass('title')

    for (let index = 0; index < 300; index += 1) {
      open(harness, id)
      frameEnd(harness, { slId: id, text: `title ${String(index)}` })
    }

    // Each session contributed exactly one entry, so the stack is capped rather than blown past it.
    expect(undoDepth()).toBe(DEFAULT_MAX_HISTORY_ENTRIES)
    expect(currentHtml()).toContain('title 299')
  })
})

describe('useTextEditing — the text is untrusted', () => {
  it('escapes typed markup instead of injecting it', () => {
    const harness = mount()
    const id = idOfClass('title')

    open(harness, id)
    frameEnd(harness, { slId: id, text: '<img src=x onerror=alert(1)>' })

    const html = currentHtml()
    // The `<` is escaped, so this can never be an element — and `alert(` is additionally broken by
    // a numeric reference, because SL-S04 scans for it as a substring regardless of whether it is
    // executable. Both are visible to the reader as the exact characters typed.
    expect(html).toContain('&lt;img src=x onerror=&#97;lert(1)>')
    expect(html).not.toContain('<img')
    expect(findForbiddenApiTokens(html)).toEqual([])
  })

  it('keeps the slide contract passing when a forbidden API name is typed as prose', () => {
    const harness = mount()
    const id = idOfClass('title')

    open(harness, id)
    frameEnd(harness, { slId: id, text: 'Do not call fetch( or localStorage' })

    expect(findForbiddenApiTokens(currentHtml())).toEqual([])
  })

  it('refuses to write into a locked element even if the frame reports a session on one', () => {
    const harness = mount()
    const locked = idOfClass('locked')
    const before = undoDepth()

    // Force the store open on a locked element, as a forged `begin` response would.
    act(() => {
      useDesignStore.getState().beginEditing(locked)
    })
    frameEnd(harness, { slId: locked, text: 'tampered' })

    expect(undoDepth()).toBe(before)
    expect(currentHtml()).toBe(SLIDE_HTML)
  })
})

/**
 * Round-1 review blocker 2, half (b): the document moving under an open caret must end the session
 * deterministically — never leave `editing` set with no caret in the frame, which strands the overlay
 * in pass-through mode with Enter/F2 disarmed. Ended by *cancel*: the in-progress text is not written
 * against bytes the `slId` no longer describes.
 */
describe('useTextEditing — the document moving under an open caret ends the session', () => {
  function openSession(harness: Harness): string {
    const id = idOfClass('title')
    open(harness, id)
    expect(useDesignStore.getState().editing).toBe(id)
    return id
  }

  /** Enter/F2 are armed again only when `editing` is null; a fresh `beginEdit` proves the same. */
  function canBeginAgain(harness: Harness): boolean {
    return open(harness, idOfClass('title'))
  }

  it('a deck:updated snapshot replacing the slide ends the session and re-arms editing', () => {
    const harness = mount()
    openSession(harness)
    const before = undoDepth()

    const replaced = SLIDE_HTML.replace('Old title', 'Agent title')
    act(() => {
      const state = useDeckStore.getState()
      useDeckStore.getState().applyRemoteDeck({
        manifest: state.deck,
        slides: { [slideId]: replaced },
        notes: {},
        theme: null,
      })
    })

    expect(useDesignStore.getState().editing).toBeNull()
    expect(currentHtml()).toBe(replaced)
    // Nothing was committed against the new bytes, and no frame message was needed to end it.
    expect(undoDepth()).toBe(before)
    expect(harness.sent.filter((s) => s.action !== 'begin')).toEqual([])
    expect(canBeginAgain(harness)).toBe(true)
  })

  it('an outside setSlideHtml (property panel, agent tool edit) ends the session without committing', () => {
    const harness = mount()
    openSession(harness)

    const outside = SLIDE_HTML.replace('Old title', 'Panel title')
    act(() => {
      useDeckStore.getState().setSlideHtml(slideId, outside, 'x', 'Panel edit')
    })

    expect(useDesignStore.getState().editing).toBeNull()
    expect(currentHtml()).toBe(outside)
    expect(canBeginAgain(harness)).toBe(true)
  })

  it('the frame announcing a fresh document (SL_READY) ends the session', () => {
    const harness = mount()
    openSession(harness)

    act(() => {
      harness.result.current.onFrameReady()
    })

    expect(useDesignStore.getState().editing).toBeNull()
    expect(harness.sent.filter((s) => s.action !== 'begin')).toEqual([])
    expect(canBeginAgain(harness)).toBe(true)
  })

  it('SL_READY with no session open is a no-op', () => {
    const harness = mount()
    act(() => {
      harness.result.current.onFrameReady()
    })
    expect(useDesignStore.getState().editing).toBeNull()
    expect(harness.sent).toEqual([])
  })

  it('a late end event from the destroyed session commits nothing', () => {
    const harness = mount()
    const id = openSession(harness)
    act(() => {
      harness.result.current.onFrameReady()
    })
    const before = undoDepth()

    frameEnd(harness, { slId: id, text: 'from the old document' })

    expect(undoDepth()).toBe(before)
    expect(currentHtml()).toBe(SLIDE_HTML)
  })

  it('the hook’s own commit does not trip the bytes-changed guard (one entry, session closed once)', () => {
    const harness = mount()
    const id = openSession(harness)
    const before = undoDepth()

    frameEnd(harness, { slId: id, text: 'New title' })

    expect(undoDepth()).toBe(before + 1)
    expect(useDesignStore.getState().editing).toBeNull()
    expect(canBeginAgain(harness)).toBe(true)
  })
})

/**
 * Round-1 review blocker 2, half (a): while a caret is open the Edit menu's Undo/Redo must reach the
 * *field's* undo inside the frame, never the deck's. The session registers a forwarder for exactly
 * as long as it is open.
 */
describe('useTextEditing — registers the open session for the Edit menu', () => {
  it('is registered while editing and forwards undo/redo to the frame', () => {
    const harness = mount()
    expect(activeTextEditSession()).toBeNull()
    const id = idOfClass('title')
    open(harness, id)

    const session = activeTextEditSession()
    expect(session).not.toBeNull()
    session!.undo()
    session!.redo()
    expect(harness.sent.slice(1)).toEqual([
      { slId: id, action: 'undo' },
      { slId: id, action: 'redo' },
    ])
  })

  it('is unregistered by every way a session ends', () => {
    const harness = mount()
    const id = idOfClass('title')

    open(harness, id)
    frameEnd(harness, { slId: id, text: 'x' })
    expect(activeTextEditSession()).toBeNull()

    open(harness, id)
    act(() => {
      harness.result.current.onFrameReady()
    })
    expect(activeTextEditSession()).toBeNull()

    open(harness, id)
    cleanup()
    expect(activeTextEditSession()).toBeNull()
  })

  it('menu Undo with focus on the iframe runs the frame field’s undo, not the deck’s', () => {
    const harness = mount()
    const id = idOfClass('title')
    open(harness, id)
    const deck = { undo: vi.fn(), redo: vi.fn() }
    const iframe = document.createElement('iframe')

    const route = runEditAction('edit.undo', deck, {
      activeElement: iframe,
      execCommand: vi.fn(() => true),
      frameSession: activeTextEditSession(),
    })

    expect(route).toBe('frame')
    expect(deck.undo).not.toHaveBeenCalled()
    expect(harness.sent.at(-1)).toEqual({ slId: id, action: 'undo' })
    expect(useDesignStore.getState().editing).toBe(id)
    expect(currentHtml()).toBe(SLIDE_HTML)
  })
})

describe('useTextEditing — entity-bearing text is a no-op when unchanged (review major)', () => {
  it('open + Esc on an &nbsp; heading: zero patches, zero undo entries, canUndo unchanged', () => {
    slideId = seedDeck(SLIDE_HTML.replace('Old title', 'Q3&nbsp;Revenue &mdash; 2026'))
    const harness = mount()
    const id = idOfClass('title')
    const html = currentHtml()
    const before = undoDepth()
    const canUndo = useDeckStore.getState().canUndo

    open(harness, id)
    // What the frame's textContent reads for that heading.
    frameEnd(harness, { slId: id, text: 'Q3\u00A0Revenue — 2026', reason: 'escape' })

    expect(currentHtml()).toBe(html)
    expect(undoDepth()).toBe(before)
    expect(useDeckStore.getState().canUndo).toBe(canUndo)
  })
})
