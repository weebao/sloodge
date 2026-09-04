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
import { MAX_TEXT_LENGTH } from '../../../src/shared/design/text-edit'
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

/** Two elements a caret can open on, for the paths that need a second one to move to. */
const TWO_EDITABLE = SLIDE_HTML.replace(
  '<p class="mixed">Revenue <b>18%</b> Q3</p>',
  '<p class="second">Second line</p>',
)

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

/**
 * What one frame is showing, for the assertions that matter: not "was a message posted at it" but
 * "what does the element actually say now".
 */
interface FrameView {
  /** The text this frame renders for `slId` — its DOM, which is not always the document's bytes. */
  readonly shows: (slId: string) => string
  /** Whether `slId` still carries `contenteditable`: a session the frame has open. */
  readonly isEditing: (slId: string) => boolean
  /** The user types into the open caret. The whole value is replaced, as the `begin` select-all does. */
  readonly type: (text: string) => void
  /**
   * Focus left the editing host — a click elsewhere, or a re-render around it. `frameScript`'s
   * `endEdit(false)`: the `contenteditable` goes and the typed text **stays**, and the frame posts
   * the parent an `SL_EDIT` event it may or may not still be listening for. Returns that payload.
   */
  readonly blur: () => SlEditEventPayload | null
  /**
   * The node leaves the frame's document — author JS replacing a block, say. `frameScript` answers
   * for an element it cannot find with `null`, and `revertEdit`'s `doc.contains` guard refuses to
   * write into one; both are things the parent has to cope with.
   */
  readonly remove: (slId: string) => void
}

/**
 * One frame's edit state, *modelled* rather than recorded — the round-6 review's major 2.
 *
 * A stub that only pushes `{slId, action}` into an array can prove a message was addressed to the
 * right frame and never that the frame did anything with it — so a whole green suite could not tell
 * `cancel` (which reaches an open session) from `revert` (which rewinds a closed one), which is the
 * difference the blocker turned on. This mirrors `frameScript.ts` instead: the open `session`, the
 * `lastEnded` that `revert` rewinds to, the text each element renders, and `applyEdit`'s branches.
 */
function frameModel(
  textOf: (slId: string) => string,
  // The frame judges editability on its live DOM, which author JS may have changed since the source
  // was parsed — the one thing the parent cannot decide for itself, and the reason `begin` has a
  // refusal at all.
  frameEditable: (slId: string) => boolean = () => true,
): FrameView & {
  readonly apply: (slId: string, action: SlEditAction) => SlEditResponse
} {
  const rendered = new Map<string, string>()
  const gone = new Set<string>()
  let session: { slId: string; original: string } | null = null
  let lastEnded: { slId: string; original: string } | null = null

  const shows = (slId: string): string => {
    const seen = rendered.get(slId)
    if (seen !== undefined) return seen
    // Never typed into: the frame renders what the document said when it loaded.
    const initial = textOf(slId)
    rendered.set(slId, initial)
    return initial
  }

  /** `endEdit`: the session goes either way, and `restore` is the only thing that puts text back. */
  const endEdit = (restore: boolean): string => {
    const ending = session
    if (ending === null) return ''
    session = null
    lastEnded = ending
    if (restore) rendered.set(ending.slId, ending.original)
    return shows(ending.slId)
  }

  const apply = (slId: string, action: SlEditAction): SlEditResponse => {
    if (action === 'begin') {
      endEdit(false)
      lastEnded = null
      // `beginEdit`'s two refusals, which have different shapes: no such node at all, and a node the
      // live DOM says cannot host a caret.
      if (gone.has(slId)) return null
      if (!frameEditable(slId)) return { slId, text: shows(slId), editing: false }
      session = { slId, original: shows(slId) }
      return { slId, text: session.original, editing: true }
    }
    if (action === 'revert') {
      const last = lastEnded
      lastEnded = null
      // That element, once, and only while it is still in the document — `revertEdit`'s own three
      // guards, which are what make a parent that sends it unconditionally harmless.
      if (last === null || last.slId !== slId || gone.has(slId)) return null
      rendered.set(slId, last.original)
      return { slId, text: last.original, editing: false }
    }
    // Anything but the open session touches nothing. This is the branch the blocker lands on: a
    // re-render blurred the host first, so `cancel` arrives with no session left to cancel — and
    // where the element has left the document there is nothing to answer for at all.
    if (session === null || session.slId !== slId)
      return gone.has(slId) ? null : { slId, text: shows(slId), editing: false }
    if (action === 'undo' || action === 'redo') return { slId, text: shows(slId), editing: true }
    return { slId, text: endEdit(action === 'cancel'), editing: false }
  }

  return {
    apply,
    shows,
    isEditing: (slId) => session?.slId === slId,
    type: (text) => {
      if (session === null) throw new Error('typed into a frame with no caret open')
      rendered.set(session.slId, text)
    },
    blur: () => {
      if (session === null) return null
      const { slId } = session
      return { slId, text: endEdit(false), reason: 'blur' }
    },
    remove: (slId) => {
      gone.add(slId)
    },
  }
}

/** The text the document currently gives `slId` — what a fresh frame would render for it. */
function documentTextOf(slId: string): string {
  return buildSlideMap(slideId, currentHtml()).byId.get(slId)?.textContent ?? ''
}

interface Harness {
  readonly result: { current: ReturnType<typeof useTextEditing> }
  readonly sent: { slId: string; action: SlEditAction }[]
  /**
   * What went out through a sender pinned by `pinEdit`, tagged with the slide the bridge was bound
   * to when it was pinned. Since M8.2 that is not always the slide showing when it is *used*, and
   * the difference is the whole point: it is how a test can tell a cancel reached the frame the
   * caret was in rather than the frame the user navigated to.
   */
  readonly pinned: { slId: string; slide: string; action: SlEditAction }[]
  /** Every `onResult` the hook handed over, in request order, for tests that answer by hand. */
  readonly replies: ((result: SlEditResponse) => void)[]
  /**
   * Every `finish` callback the hook handed over — the answer a session leaving with the overlay is
   * waiting for. A deaf frame leaves them here so a test can answer late, or not at all, which is
   * the whole difficulty of that path.
   */
  readonly finishers: ((text: string | null) => void)[]
  /** The frame for `slide` (the current one by default), to ask what it is showing. */
  readonly frame: (slide?: string) => FrameView
}

/**
 * The frame half of the bridge, stubbed: message log plus the session model above, one per slide —
 * `pinEdit` captures the frame that was current when it was called, which since M8.2 is not always
 * the frame a later send lands on.
 *
 * `confirm` makes the frame answer every request at once, from its model, which is what the real
 * one does a message later. `confirm: false` is a *deaf* frame: it records the request and hands the
 * reply channel to the test, which then speaks for the frame — so its model is deliberately left
 * out of those exchanges rather than asserting things the test just contradicted.
 */
function frameStub(
  currentSlide: () => string,
  confirm: boolean,
  frameEditable?: (slId: string) => boolean,
) {
  const sent: Harness['sent'] = []
  const pinned: Harness['pinned'] = []
  const replies: Harness['replies'] = []
  const finishers: Harness['finishers'] = []
  const frames = new Map<string, ReturnType<typeof frameModel>>()
  const frameOf = (slide: string): ReturnType<typeof frameModel> => {
    const known = frames.get(slide)
    if (known !== undefined) return known
    const fresh = frameModel(documentTextOf, frameEditable)
    frames.set(slide, fresh)
    return fresh
  }
  const requestEdit = vi.fn(
    (slId: string, action: SlEditAction, onResult?: (result: SlEditResponse) => void) => {
      sent.push({ slId, action })
      if (onResult) replies.push(onResult)
      if (!confirm) return
      const result = frameOf(currentSlide()).apply(slId, action)
      if (onResult) onResult(result)
    },
  )
  const pinEdit = vi.fn((slId: string) => {
    const slide = currentSlide()
    const apply = (action: SlEditAction): SlEditResponse => {
      pinned.push({ slId, slide, action })
      return frameOf(slide).apply(slId, action)
    }
    return {
      send: (action: SlEditAction): void => {
        apply(action)
      },
      // `finish` is a `commit` plus a listener that outlives the bridge (see `PinnedEdit`). The
      // frame does the same thing to its document either way; what a deaf frame withholds is the
      // answer, which is exactly the gap the parent has to survive.
      finish: (onText: (text: string | null) => void): void => {
        const answer = apply('commit')
        if (!confirm) {
          finishers.push(onText)
          return
        }
        onText(answer === null ? null : answer.text)
      },
    }
  })
  return { requestEdit, pinEdit, sent, pinned, replies, finishers, frameOf }
}

function mount(confirm = true, frameEditable?: (slId: string) => boolean): Harness {
  const stub = frameStub(() => slideId, confirm, frameEditable)
  const { result } = renderHook(() =>
    useTextEditing({ slideId, requestEdit: stub.requestEdit, pinEdit: stub.pinEdit }),
  )
  return {
    result,
    sent: stub.sent,
    pinned: stub.pinned,
    replies: stub.replies,
    finishers: stub.finishers,
    frame: (slide = slideId) => stub.frameOf(slide),
  }
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
    expect(harness.sent).toEqual([{ slId: id, action: 'begin' }])
    // The cancel goes to the frame that opened the caret, not to whatever the bridge is bound to.
    expect(harness.pinned).toEqual([{ slId: id, slide: slideId, action: 'cancel' }])
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
    // Both halves of ending a caret from the parent — see `endFrameCaret`.
    expect(harness.pinned.slice(-2)).toEqual([
      { slId: id, slide: slideId, action: 'cancel' },
      { slId: id, slide: slideId, action: 'revert' },
    ])
    expect(harness.frame().isEditing(id)).toBe(false)
    expect(activeTextEditSession()).toBeNull()
  })

  it('a session the hook ends itself sends no redundant cancel', () => {
    const harness = mount()
    const id = idOfClass('title')
    open(harness, id)
    frameEnd(harness, { slId: id, text: 'New title' })
    expect(harness.sent).toEqual([{ slId: id, action: 'begin' }])
  })

  it('unmounting with a session open finishes it, and what was typed is kept', () => {
    // Design Mode turned off, or Present. The overlay goes and the bridge's listener with it, so the
    // session is finished on a channel that outlives both — `PinnedEdit.finish` — rather than
    // cancelled, which is what silently threw the typing away (round-7 major).
    const harness = mount()
    const id = idOfClass('title')
    open(harness, id)
    act(() => {
      harness.frame().type('Typed then left')
    })

    cleanup()

    expect(useDesignStore.getState().editing).toBeNull()
    expect(harness.pinned).toEqual([{ slId: id, slide: slideId, action: 'commit' }])
    expect(currentHtml()).toContain('Typed then left')
    // Still one entry for the whole session: leaving is an end, not a second edit.
    expect(undoDepth()).toBe(1)
  })

  it('unmounting a session that changed nothing writes nothing', () => {
    const harness = mount()
    open(harness, idOfClass('title'))

    cleanup()

    expect(undoDepth()).toBe(0)
    expect(currentHtml()).toBe(SLIDE_HTML)
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
 * Round-6 blocker: a `deck:updated` that leaves the *edited* slide's own bytes untouched — the agent
 * writing slide 3 while the user types on slide 1, or the deck simply being re-sent — left the frame
 * rendering text no document contained, which then vanished at the next unrelated commit
 * (reproduced twice in the built app).
 *
 * Neither byte-watching signal can see it: `slideId` is unchanged and so is this slide's source
 * string, so `clearTransient` is the whole signal — and by the time the parent acts on it, React's
 * re-render for the adoption has already blurred the frame's editing host, which ends the frame's
 * session and deliberately *keeps* the typed text. `cancel` reaches only a session the frame still
 * has open, so the parent must also send the `revert` that rewinds one it has closed.
 *
 * These assert what the frame shows rather than what was posted at it — the point of the session
 * model in `frameModel` (round-6 major 2), without which none of this suite can see the bug.
 */
/** Type into the open caret, then let a re-render blur the host, as the adoption does. */
function typeThenBlur(harness: Harness, id: string, text: string): SlEditEventPayload {
  act(() => {
    harness.frame().type(text)
  })
  expect(harness.frame().shows(id)).toBe(text)
  const ended = harness.frame().blur()
  if (ended === null) throw new Error('the frame had no session to blur')
  return ended
}

/** `useAgentDeckSync`'s two steps in its order: adopt, then clear the transient design state. */
function pushSnapshot(slides: Record<string, string>): void {
  act(() => {
    const state = useDeckStore.getState()
    expect(state.applyRemoteDeck({ manifest: state.deck, slides, notes: {}, theme: null })).toBe(
      true,
    )
    useDesignStore.getState().clearTransient()
  })
}

describe('useTextEditing — a caret the frame closed by itself is still put back (round-6)', () => {
  it.each([
    [
      'edits a different slide',
      (): Record<string, string> => {
        const other = useDeckStore.getState().deck.slideOrder.find((id) => id !== slideId)
        if (other === undefined) throw new Error('the fixture deck has only one slide')
        return { [slideId]: currentHtml(), [other]: SLIDE_HTML.replace('Old title', 'Agent slide') }
      },
    ],
    ['is byte-identical', (): Record<string, string> => ({ [slideId]: currentHtml() })],
  ])(
    'a deck:updated that %s puts the frame back instead of stranding the typed text',
    (_label, slidesOf) => {
      const harness = mount()
      const id = idOfClass('title')
      open(harness, id)
      const ended = typeThenBlur(harness, id, 'GHOST')

      pushSnapshot(slidesOf())
      // The frame's own `SL_EDIT` arrives after the store dropped the session, so it commits
      // nothing: the parent's message is the ghost's only way home.
      act(() => {
        harness.result.current.onFrameEditEnd(ended)
      })

      expect(harness.result.current.editing).toBeNull()
      expect(harness.frame().isEditing(id)).toBe(false)
      // Red before the fix: the frame keeps rendering `GHOST`, which no document contains.
      expect(harness.frame().shows(id)).toBe('Old title')
      expect(currentHtml()).toBe(SLIDE_HTML)
      expect(open(harness, id)).toBe(true)
    },
  )

  it('a session the frame still has open is cancelled, and the revert behind it changes nothing', () => {
    const harness = mount()
    const id = idOfClass('title')
    open(harness, id)
    act(() => {
      harness.frame().type('GHOST')
    })

    // A shift-click or a marquee: the store closes the session while the caret is still live.
    act(() => {
      useDesignStore.getState().setSelection(null)
    })

    expect(harness.frame().isEditing(id)).toBe(false)
    expect(harness.frame().shows(id)).toBe('Old title')
    expect(harness.pinned).toEqual([
      { slId: id, slide: slideId, action: 'cancel' },
      { slId: id, slide: slideId, action: 'revert' },
    ])
  })

  it('a slide switch over a frame that blurred first still restores the outgoing frame', () => {
    const id = idOfClass('title')
    const harness = mountSwitchable()
    act(() => {
      select(id)
      harness.result.current.beginEdit(id)
    })
    act(() => {
      harness.frame().type('GHOST')
    })
    harness.frame().blur()

    harness.switchTo('some-other-slide')

    expect(harness.frame().isEditing(id)).toBe(false)
    expect(harness.frame().shows(id)).toBe('Old title')
  })

  it('unmounting over a frame that blurred first keeps the text, and the two agree', () => {
    // Design Mode off, or Present: the toggle's own click blurs the frame, so the session is already
    // closed and the text it kept has been posted to a parent that is no longer listening. Round 6
    // put the element back, which is consistent but throws the sentence away; asking the frame for
    // the text it is showing keeps both properties at once.
    const harness = mount()
    const id = idOfClass('title')
    open(harness, id)
    act(() => {
      harness.frame().type('Typed then blurred')
    })
    harness.frame().blur()

    cleanup()

    expect(harness.frame().shows(id)).toBe('Typed then blurred')
    expect(currentHtml()).toContain('Typed then blurred')
    // The point of the round-6 fix survives: no frame shows text the document does not have.
    expect(harness.frame().shows(id)).toBe(documentTextOf(id))
  })

  it('unmounting over a frame with nothing left to answer for writes nothing', () => {
    // The fallback, and the reason `finish` reports `null` rather than an empty string: text the
    // parent could not read is text it cannot write. Here the frame's own JS replaced the element
    // after the blur closed the session, so there is no node left to answer from.
    const harness = mount()
    const id = idOfClass('title')
    open(harness, id)
    act(() => {
      harness.frame().type('GHOST')
    })
    harness.frame().blur()
    harness.frame().remove(id)

    cleanup()

    expect(harness.pinned).toEqual([
      { slId: id, slide: slideId, action: 'commit' },
      { slId: id, slide: slideId, action: 'cancel' },
      { slId: id, slide: slideId, action: 'revert' },
    ])
    expect(currentHtml()).toBe(SLIDE_HTML)
    expect(undoDepth()).toBe(0)
  })

  it('a frame that answers after the overlay has gone still lands its text', () => {
    // The real answer is a postMessage round trip that crosses a process boundary while React is
    // mid-teardown, so it arrives strictly later than the cleanup that asked for it.
    const harness = mount(false)
    const id = idOfClass('title')
    open(harness, id)
    act(() => {
      harness.replies[0]!({ slId: id, text: 'Old title', editing: true })
    })

    cleanup()
    expect(harness.finishers).toHaveLength(1)
    act(() => {
      harness.finishers[0]!('Late but ours')
    })

    expect(currentHtml()).toContain('Late but ours')
    expect(undoDepth()).toBe(1)
  })

  it('a refusal that arrives after the overlay has gone still puts the frame back', () => {
    const harness = mount(false)
    const id = idOfClass('title')
    open(harness, id)
    act(() => {
      harness.replies[0]!({ slId: id, text: 'Old title', editing: true })
    })

    cleanup()
    act(() => {
      harness.finishers[0]!('x'.repeat(MAX_TEXT_LENGTH + 1))
    })

    expect(undoDepth()).toBe(0)
    expect(harness.pinned).toEqual([
      { slId: id, slide: slideId, action: 'commit' },
      { slId: id, slide: slideId, action: 'revert' },
    ])
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

/**
 * Round-4 major 2: a refusal used to be indistinguishable from "nothing to do". The 64 KiB cap did
 * refuse and the source was never touched — but the frame went on showing the rejected text, so the
 * user read the paste as accepted and lost it later, at an unrelated moment, with no warning at any
 * point (70 000 characters, reproduced in the built app).
 */
describe('useTextEditing — a refused commit is put back and said out loud (round-4)', () => {
  it('tells the frame to revert an over-cap value and raises a notice', () => {
    const harness = mount()
    const id = idOfClass('title')
    open(harness, id)

    frameEnd(harness, { slId: id, text: 'x'.repeat(MAX_TEXT_LENGTH + 1) })

    // The refusal itself: the source is byte-identical and nothing reached the undo stack.
    expect(currentHtml()).toContain('<h1 class="title">Old title</h1>')
    expect(undoDepth()).toBe(0)
    // What round 4 adds: the frame is put back, and the user is told.
    expect(harness.sent).toEqual([{ slId: id, action: 'begin' }])
    expect(harness.pinned).toEqual([{ slId: id, slide: slideId, action: 'revert' }])
    expect(harness.result.current.notice).toMatch(/too long/i)
  })

  it.each([
    ['a locked element', 'locked'],
    ['mixed inline content', 'mixed'],
  ])('reverts and notifies for %s', (_label, cls) => {
    const harness = mount()
    const id = idOfClass(cls)
    // These elements decline a caret, so the session is forced open the way a frame that judged its
    // live DOM differently from the source would leave it.
    act(() => {
      select(id)
      useDesignStore.getState().beginEditing(id)
    })
    frameEnd(harness, { slId: id, text: 'anything' })

    expect(undoDepth()).toBe(0)
    expect(harness.sent).toEqual([])
    expect(harness.pinned).toEqual([{ slId: id, slide: slideId, action: 'revert' }])
    expect(harness.result.current.notice).not.toBeNull()
  })

  it('stays silent when the text is simply unchanged', () => {
    const harness = mount()
    const id = idOfClass('title')
    open(harness, id)

    frameEnd(harness, { slId: id, text: 'Old title' })

    expect(undoDepth()).toBe(0)
    // No revert: there is nothing to put back, and no notice, because nothing went wrong.
    expect(harness.sent).toEqual([{ slId: id, action: 'begin' }])
    expect(harness.result.current.notice).toBeNull()
  })

  it('an accepted commit neither reverts nor notifies', () => {
    const harness = mount()
    const id = idOfClass('title')
    open(harness, id)

    frameEnd(harness, { slId: id, text: 'New title' })

    expect(currentHtml()).toContain('New title')
    expect(harness.sent).toEqual([{ slId: id, action: 'begin' }])
    expect(harness.result.current.notice).toBeNull()
  })

  it('a notice is dismissible, and a new caret clears it', () => {
    const harness = mount()
    const id = idOfClass('title')
    open(harness, id)
    frameEnd(harness, { slId: id, text: 'x'.repeat(MAX_TEXT_LENGTH + 1) })
    expect(harness.result.current.notice).not.toBeNull()

    act(() => {
      harness.result.current.dismissNotice()
    })
    expect(harness.result.current.notice).toBeNull()

    // A fresh caret is about a fresh edit; a notice from the last one must not follow it.
    open(harness, id)
    expect(harness.result.current.notice).toBeNull()
    frameEnd(harness, { slId: id, text: 'x'.repeat(MAX_TEXT_LENGTH + 1) })
    expect(harness.result.current.notice).not.toBeNull()
  })
})

/** A hook bound to a slide id the test can move, with the bridge stub that follows it. */
function mountSwitchable(): {
  result: { current: ReturnType<typeof useTextEditing> }
  switchTo: (id: string) => void
  sent: Harness['sent']
  pinned: Harness['pinned']
  frame: (slide?: string) => FrameView
} {
  let bound = slideId
  const stub = frameStub(() => bound, true)
  // The real `pinEdit` is a `useCallback` on `[frameRef, slideId]`, so its identity changes on every
  // slide change and effects that name it in their deps re-run mid-session. Modelling that here is
  // what makes this harness able to say anything about *when* a session is pinned.
  type PinFor = (slId: string) => ReturnType<typeof stub.pinEdit>
  const pins = new Map<string, PinFor>()
  const pinFor = (slide: string): PinFor => {
    const known = pins.get(slide)
    if (known !== undefined) return known
    const fresh: PinFor = (slId) => stub.pinEdit(slId)
    pins.set(slide, fresh)
    return fresh
  }
  const { result, rerender } = renderHook(
    (props: { slideId: string }) =>
      useTextEditing({
        slideId: props.slideId,
        requestEdit: stub.requestEdit,
        pinEdit: pinFor(props.slideId),
      }),
    { initialProps: { slideId } },
  )
  return {
    result,
    // The bridge re-binds to the incoming slide before the hook's effect runs, which is exactly the
    // condition that made the unpinned cancel address the wrong frame.
    switchTo: (id: string) => {
      bound = id
      rerender({ slideId: id })
    },
    sent: stub.sent,
    pinned: stub.pinned,
    frame: (slide = slideId) => stub.frameOf(slide),
  }
}

describe('useTextEditing — a notice belongs to the slide it was raised on (round-4)', () => {
  it('clears when the slide changes', () => {
    const id = idOfClass('title')
    const harness = mountSwitchable()

    act(() => {
      select(id)
      harness.result.current.beginEdit(id)
    })
    act(() => {
      harness.result.current.onFrameEditEnd({
        slId: id,
        text: 'x'.repeat(MAX_TEXT_LENGTH + 1),
        reason: 'enter',
      })
    })
    expect(harness.result.current.notice).not.toBeNull()

    harness.switchTo('some-other-slide')

    expect(harness.result.current.notice).toBeNull()
  })
})

describe('useTextEditing — a caret is cancelled on its own frame, not the current one (round-5)', () => {
  it('a slide switch cancels the session on the frame it was opened in', () => {
    const id = idOfClass('title')
    const harness = mountSwitchable()
    act(() => {
      select(id)
      harness.result.current.beginEdit(id)
    })
    expect(harness.result.current.editing).toBe(id)
    const opened = slideId

    harness.switchTo('some-other-slide')

    // The flag goes, as it always did...
    expect(harness.result.current.editing).toBeNull()
    // ...and so does the frame's `contenteditable`: a cancel addressed to the slide the caret was
    // opened on. Before M8.2 that frame was destroyed by the switch and this was unnecessary; it now
    // survives as a hidden neighbour, so without this it stays typeable and shows uncommitted text.
    expect(harness.pinned).toEqual([
      { slId: id, slide: opened, action: 'cancel' },
      { slId: id, slide: opened, action: 'revert' },
    ])
    expect(harness.frame(opened).isEditing(id)).toBe(false)
    // Nothing went to the *incoming* frame, which has no session and a different slide guard.
    expect(harness.sent.filter((message) => message.action === 'cancel')).toEqual([])
  })

  it('switching back re-arms the element, and the new caret pins the frame it is now in', () => {
    const id = idOfClass('title')
    const harness = mountSwitchable()
    act(() => {
      select(id)
      harness.result.current.beginEdit(id)
    })
    harness.switchTo('some-other-slide')
    harness.switchTo(slideId)

    act(() => {
      select(id)
      harness.result.current.beginEdit(id)
    })
    expect(harness.result.current.editing).toBe(id)
    expect(harness.result.current.notice).toBeNull()

    // And this session's own end goes to the frame pinned on the way back in, not the one the first
    // caret was cancelled on — the pin is per session, not per element.
    act(() => {
      useDesignStore.getState().setSelection(null)
    })
    expect(harness.pinned).toEqual([
      { slId: id, slide: slideId, action: 'cancel' },
      { slId: id, slide: slideId, action: 'revert' },
      { slId: id, slide: slideId, action: 'cancel' },
      { slId: id, slide: slideId, action: 'revert' },
    ])
  })

  it('the store closing a session behind the hook cancels the pinned frame too', () => {
    const harness = mount()
    const id = idOfClass('title')
    open(harness, id)

    // A shift-click or a marquee moves the selection, which clears `editing` in the store.
    act(() => {
      useDesignStore.getState().setSelection(null)
    })

    expect(harness.result.current.editing).toBeNull()
    expect(harness.pinned).toEqual([
      { slId: id, slide: slideId, action: 'cancel' },
      { slId: id, slide: slideId, action: 'revert' },
    ])
  })

  it('a refused commit reverts through the pinned frame', () => {
    const harness = mount()
    const id = idOfClass('title')
    open(harness, id)
    frameEnd(harness, { slId: id, text: 'x'.repeat(MAX_TEXT_LENGTH + 1) })

    expect(harness.pinned).toEqual([{ slId: id, slide: slideId, action: 'revert' }])
    expect(harness.result.current.notice).not.toBeNull()
  })

  it('a session opened in the store pins the frame it is in, not the one the bridge moves to', () => {
    // `beginEditing` called directly is the one way a session can open without `beginEdit` having
    // pinned it, and the effect that fills that in re-runs on every slide change (the real `pinEdit`
    // is a new function per slide). It must pin at the open and never again: a re-pin mid-session
    // would bind the caret to the incoming frame, and the switch would cancel a frame that never
    // had one.
    const id = idOfClass('title')
    const harness = mountSwitchable()
    const opened = slideId
    act(() => {
      select(id)
      useDesignStore.getState().beginEditing(id)
    })
    expect(harness.result.current.editing).toBe(id)

    harness.switchTo('some-other-slide')

    expect(harness.pinned).toEqual([
      { slId: id, slide: opened, action: 'cancel' },
      { slId: id, slide: opened, action: 'revert' },
    ])
    expect(harness.frame(opened).isEditing(id)).toBe(false)
  })

  it('a begin the user superseded closes the caret the frame may have opened for it', () => {
    // Two double-clicks in quick succession. The first frame answer is no longer wanted, but the
    // frame acted on it: it set `contenteditable` and focused the element before answering. Dropping
    // that answer silently leaves a caret no parent state knows about (round-7 nit).
    slideId = seedDeck(TWO_EDITABLE)
    const harness = mount(false)
    const first = idOfClass('title')
    const second = idOfClass('second')
    open(harness, first)
    open(harness, second)

    act(() => {
      harness.replies[0]!({ slId: first, text: 'Old title', editing: true })
    })

    expect(harness.result.current.editing).toBeNull()
    expect(harness.pinned).toEqual([{ slId: first, slide: slideId, action: 'cancel' }])
  })

  it('a committed session cancels nothing — the frame already ended it', () => {
    const harness = mount()
    const id = idOfClass('title')
    open(harness, id)
    frameEnd(harness, { slId: id, text: 'New title' })

    expect(currentHtml()).toContain('New title')
    expect(harness.pinned).toEqual([])
  })
})

describe('useTextEditing — a caret that will not open says why (round-5)', () => {
  it('mixed inline content is refused out loud rather than silently', () => {
    const harness = mount()
    const id = idOfClass('mixed')
    let opened = true
    act(() => {
      select(id)
      opened = harness.result.current.beginEdit(id)
    })

    expect(opened).toBe(false)
    // The exact failure the milestone exists to answer: a double-click that does nothing at all.
    expect(harness.result.current.notice).toContain('formatting')
    // Refusing still means refusing: no request reached the frame, no session was opened.
    expect(harness.sent).toEqual([])
    expect(harness.result.current.editing).toBeNull()
  })

  it('a locked element says it is locked', () => {
    const harness = mount()
    const id = idOfClass('locked')
    act(() => {
      select(id)
      harness.result.current.beginEdit(id)
    })
    expect(harness.result.current.notice).toContain('locked')
  })

  it('an id the map no longer has says the element is gone', () => {
    const harness = mount()
    act(() => {
      harness.result.current.beginEdit('sl-not-here')
    })
    expect(harness.result.current.notice).toContain('no longer on this slide')
  })

  it('the frame declining a begin from its own model says so, and opens nothing', () => {
    // The same refusal as the test below, but spoken by the frame rather than by the test: the
    // session-modelling stub can decline too, so this path is not only ever seen through a frame
    // the test is speaking for.
    const title = idOfClass('title')
    const harness = mount(true, (slId) => slId !== title)

    act(() => {
      select(title)
      harness.result.current.beginEdit(title)
    })

    expect(harness.result.current.editing).toBeNull()
    expect(harness.result.current.notice).toContain('formatting')
    expect(harness.frame().isEditing(title)).toBe(false)
  })

  it('an element the frame does not have at all is closed rather than left open', () => {
    // `beginEdit` answers `null` for an sl-id the frame cannot find — a different refusal from "not
    // editable", and one where a caret must not be assumed absent: the same `null` is what the
    // bridge answers with when the slide moves on under an unanswered request.
    const harness = mount()
    const id = idOfClass('title')
    harness.frame().remove(id)

    act(() => {
      select(id)
      harness.result.current.beginEdit(id)
    })

    expect(harness.result.current.editing).toBeNull()
    expect(harness.result.current.notice).toContain('no longer on this slide')
    expect(harness.pinned).toEqual([{ slId: id, slide: slideId, action: 'cancel' }])
  })

  it('the frame declining a begin on its live DOM says so too', () => {
    const harness = mount(false)
    const id = idOfClass('title')
    act(() => {
      select(id)
      harness.result.current.beginEdit(id)
    })
    // Author JS split the text into spans after the source was parsed, so the frame refuses.
    act(() => {
      harness.replies[0]?.({ slId: id, text: 'Old title', editing: false })
    })

    expect(harness.result.current.editing).toBeNull()
    expect(harness.result.current.notice).toContain('formatting')
  })

  it('a caret that does open says nothing, and clears a previous refusal', () => {
    const harness = mount()
    act(() => {
      select(idOfClass('mixed'))
      harness.result.current.beginEdit(idOfClass('mixed'))
    })
    expect(harness.result.current.notice).not.toBeNull()

    open(harness, idOfClass('title'))
    expect(harness.result.current.notice).toBeNull()
    expect(harness.result.current.editing).toBe(idOfClass('title'))
  })
})
