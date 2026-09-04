/**
 * @vitest-environment happy-dom
 *
 * M3.11 — the in-frame text-edit session (§4.1 of `.claude/plans/init/40-design-mode.md`).
 *
 * The parent can never observe these keystrokes: they land on a node inside an opaque-origin
 * document it has no access to. Everything the parent is ever told about an edit originates in the
 * frame script, so this file is the only place the behaviour can be exercised at all — the iframe
 * does not execute under happy-dom, so `designBridgeFrameMain` is called directly against a real
 * (happy-dom) document with a stand-in parent window, exactly as `frame-script.test.tsx` does.
 */

/* oxlint-disable no-underscore-dangle -- the test resets the frame's `__slDesignBridge` flag. */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  designBridgeFrameMain,
  DESIGN_BRIDGE_SCRIPT,
} from '../../../src/renderer/src/features/design/frameScript'
import { SL_EDIT, SL_MAGIC, SL_PROTOCOL_VERSION } from '../../../src/shared/design/bridge-protocol'
import { NON_EDITABLE_TAGS } from '../../../src/shared/design/text-edit'

const SLIDE = 's_x'
const EDITABLE = 's_x:1'

interface FakeParent {
  postMessage: ReturnType<typeof vi.fn>
}

function makeParent(): FakeParent {
  return { postMessage: vi.fn() }
}

/** Dispatch a message on `window` with a forced `source` (happy-dom drops a plain-object source). */
function postToFrame(data: unknown, source: unknown): void {
  const event = new MessageEvent('message', { data })
  Object.defineProperty(event, 'source', { value: source, configurable: true })
  window.dispatchEvent(event)
}

function editRequest(payload: Record<string, unknown>, id = 7): Record<string, unknown> {
  return {
    __sl: SL_MAGIC,
    v: SL_PROTOCOL_VERSION,
    id,
    dir: 'req',
    type: SL_EDIT,
    slide: SLIDE,
    payload,
  }
}

/** The payload of the last message the frame posted. */
function lastPayload(parent: FakeParent): Record<string, unknown> | null {
  const last = parent.postMessage.mock.calls.at(-1)?.[0] as Record<string, unknown> | undefined
  return (last?.['payload'] ?? null) as Record<string, unknown> | null
}

function target(): HTMLElement {
  return document.querySelector(`[data-sl-id="${EDITABLE}"]`) as HTMLElement
}

/** Arm the bridge over `body`, returning the stand-in parent with a cleared call log. */
function arm(body: string): FakeParent {
  document.body.innerHTML = body
  const parent = makeParent()
  designBridgeFrameMain(parent as unknown as Window)
  parent.postMessage.mockClear()
  return parent
}

const PLAIN = `<section data-sl-id="s_x:0" class="slide"><div data-sl-id="${EDITABLE}">bars</div></section>`

beforeEach(() => {
  // The install-once flag lives on the shared window; reset it so each test arms a fresh listener.
  delete (window as unknown as { __slDesignBridge?: boolean }).__slDesignBridge
  document.body.innerHTML = PLAIN
})

describe('designBridgeFrameMain SL_EDIT — opening a session', () => {
  it('makes the element contenteditable and reports editing', () => {
    const parent = arm(PLAIN)

    postToFrame(editRequest({ slId: EDITABLE, action: 'begin' }), parent)

    expect(target().getAttribute('contenteditable')).not.toBeNull()
    expect(lastPayload(parent)).toMatchObject({ slId: EDITABLE, text: 'bars', editing: true })
  })

  it('refuses a data-sl-lock element — selectable but not mutable (30-slide-format §3.4)', () => {
    const parent = arm(
      `<section data-sl-id="s_x:0"><p data-sl-id="${EDITABLE}" data-sl-lock>chrome</p></section>`,
    )

    postToFrame(editRequest({ slId: EDITABLE, action: 'begin' }), parent)

    expect(lastPayload(parent)).toMatchObject({ editing: false })
    expect(target().getAttribute('contenteditable')).toBeNull()
  })

  it('refuses mixed inline content rather than flattening it', () => {
    const parent = arm(
      `<section data-sl-id="s_x:0"><p data-sl-id="${EDITABLE}">Revenue <b>18%</b></p></section>`,
    )

    postToFrame(editRequest({ slId: EDITABLE, action: 'begin' }), parent)

    expect(lastPayload(parent)).toMatchObject({ editing: false })
    expect(target().getAttribute('contenteditable')).toBeNull()
  })

  it.each(['script', 'style', 'textarea', 'title'])(
    'refuses <%s>, whose text is not ordinary character data',
    (tag) => {
      const parent = arm(
        `<section data-sl-id="s_x:0"><${tag} data-sl-id="${EDITABLE}">x</${tag}></section>`,
      )

      postToFrame(editRequest({ slId: EDITABLE, action: 'begin' }), parent)

      // Whether the parser kept the node or relocated it, a caret must never open on one.
      expect(lastPayload(parent)?.['editing'] ?? false).toBe(false)
    },
  )

  it('ignores an unknown action, an unknown sl-id, and an untrusted sender', () => {
    const parent = arm(PLAIN)

    postToFrame(editRequest({ slId: EDITABLE, action: 'destroy' }), parent)
    expect(parent.postMessage).not.toHaveBeenCalled()

    postToFrame(editRequest({ slId: 's_x:404', action: 'begin' }), parent)
    expect(lastPayload(parent)).toBeNull()

    parent.postMessage.mockClear()
    postToFrame(editRequest({ slId: EDITABLE, action: 'begin' }), { postMessage: vi.fn() })
    expect(parent.postMessage).not.toHaveBeenCalled()
    expect(target().getAttribute('contenteditable')).toBeNull()
  })
})

describe('designBridgeFrameMain SL_EDIT — undo coalescing', () => {
  /**
   * The undo-coalescing proof, at the only place it can be observed directly.
   *
   * M3.8 shipped a bug where one colour-picker drag pushed ~250 undo entries and evicted the user's
   * history past the 200-entry cap. Typing generates far more events than a drag, so the fix here is
   * structural rather than a debounce: the frame posts **nothing at all** while the user types. No
   * message means no commit, and no commit means no undo entry — so the entry count is bounded by
   * *sessions*, never by keystrokes, and the cap can never be approached by typing.
   */
  it('posts nothing while the user types — 500 keystrokes, zero messages', () => {
    const parent = arm(PLAIN)
    postToFrame(editRequest({ slId: EDITABLE, action: 'begin' }), parent)
    parent.postMessage.mockClear()

    const el = target()
    for (let index = 0; index < 500; index += 1) {
      el.textContent = `${el.textContent ?? ''}x`
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'x', bubbles: true }))
      el.dispatchEvent(new Event('input', { bubbles: true }))
    }

    expect(parent.postMessage).not.toHaveBeenCalled()

    // ...and ending the session is exactly one message, carrying the whole burst.
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    expect(parent.postMessage).toHaveBeenCalledTimes(1)
    expect(lastPayload(parent)).toMatchObject({
      reason: 'enter',
      text: `bars${'x'.repeat(500)}`,
    })
  })
})

describe('designBridgeFrameMain SL_EDIT — ending a session', () => {
  it.each([
    ['Enter', 'enter'],
    ['Escape', 'escape'],
    ['Tab', 'tab'],
  ])('%s ends the session, reporting reason "%s" and keeping the typed text', (key, reason) => {
    const parent = arm(PLAIN)
    postToFrame(editRequest({ slId: EDITABLE, action: 'begin' }), parent)
    parent.postMessage.mockClear()

    const el = target()
    el.textContent = 'typed'
    el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))

    expect(parent.postMessage).toHaveBeenCalledTimes(1)
    // Escape *commits* rather than reverting (§9.3; PowerPoint keeps your typing too). Undo is the
    // cancel path, and the whole burst is one entry.
    expect(lastPayload(parent)).toMatchObject({ slId: EDITABLE, text: 'typed', reason })
    expect(el.getAttribute('contenteditable')).toBeNull()
  })

  it('Enter never inserts a newline — it is always a commit', () => {
    const parent = arm(PLAIN)
    postToFrame(editRequest({ slId: EDITABLE, action: 'begin' }), parent)

    const el = target()
    const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
    el.dispatchEvent(enter)

    expect(enter.defaultPrevented).toBe(true)
    expect(el.textContent).toBe('bars')
  })

  it('commits on blur — clicking elsewhere keeps the text', () => {
    const parent = arm(PLAIN)
    postToFrame(editRequest({ slId: EDITABLE, action: 'begin' }), parent)
    parent.postMessage.mockClear()

    const el = target()
    el.textContent = 'left behind'
    el.dispatchEvent(new FocusEvent('blur'))

    expect(lastPayload(parent)).toMatchObject({ text: 'left behind', reason: 'blur' })
  })

  it('cancel restores the pre-edit text; commit keeps it', () => {
    const parent = arm(PLAIN)

    postToFrame(editRequest({ slId: EDITABLE, action: 'begin' }), parent)
    target().textContent = 'scratch'
    postToFrame(editRequest({ slId: EDITABLE, action: 'cancel' }, 9), parent)
    expect(target().textContent).toBe('bars')
    expect(lastPayload(parent)).toMatchObject({ text: 'bars', editing: false })

    postToFrame(editRequest({ slId: EDITABLE, action: 'begin' }, 10), parent)
    target().textContent = 'kept'
    postToFrame(editRequest({ slId: EDITABLE, action: 'commit' }, 11), parent)
    expect(target().textContent).toBe('kept')
  })

  it('leaves data-sl-id untouched across a whole session', () => {
    const parent = arm(PLAIN)

    postToFrame(editRequest({ slId: EDITABLE, action: 'begin' }), parent)
    target().textContent = 'renamed'
    postToFrame(editRequest({ slId: EDITABLE, action: 'commit' }, 8), parent)

    // The id is the parent's only handle on this element; churning it would break selection and
    // every agent element reference.
    expect(target().getAttribute('data-sl-id')).toBe(EDITABLE)
    expect(target().getAttribute('contenteditable')).toBeNull()
  })
})

describe('designBridgeFrameMain SL_EDIT — untrusted input', () => {
  it('returns textContent, never innerHTML, so smuggled markup is flattened by the read', () => {
    const parent = arm(PLAIN)
    postToFrame(editRequest({ slId: EDITABLE, action: 'begin' }), parent)
    parent.postMessage.mockClear()

    // Simulate markup reaching the element despite `plaintext-only`.
    const el = target()
    el.innerHTML = 'safe<img src=x onerror=alert(1)><b>bold</b>'
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))

    const text = String(lastPayload(parent)?.['text'])
    expect(text).toBe('safebold')
    expect(text).not.toContain('<')
  })

  it('pastes plain text only, never asking for the clipboard text/html flavour', () => {
    const parent = arm(PLAIN)
    postToFrame(editRequest({ slId: EDITABLE, action: 'begin' }), parent)

    const el = target()
    el.textContent = ''
    const event = new Event('paste', { bubbles: true, cancelable: true })
    const getData = vi.fn((type: string) =>
      type === 'text/plain' ? 'plain <b>text</b>' : '<b>evil</b>',
    )
    Object.defineProperty(event, 'clipboardData', { value: { getData }, configurable: true })
    el.dispatchEvent(event)

    expect(event.defaultPrevented).toBe(true)
    expect(getData).toHaveBeenCalledWith('text/plain')
    expect(getData.mock.calls.every((call) => call[0] === 'text/plain')).toBe(true)
    // The angle brackets survive as *characters*, not as an element.
    expect(el.textContent).toBe('plain <b>text</b>')
    expect(el.querySelector('b')).toBeNull()
  })

  it('refuses a drop, which could carry text/html', () => {
    const parent = arm(PLAIN)
    postToFrame(editRequest({ slId: EDITABLE, action: 'begin' }), parent)

    const drop = new Event('drop', { bubbles: true, cancelable: true })
    target().dispatchEvent(drop)

    expect(drop.defaultPrevented).toBe(true)
  })
})

describe('DESIGN_BRIDGE_SCRIPT edit drift guards', () => {
  it('inlines every NON_EDITABLE_TAGS entry (drift guard against text-edit.ts)', () => {
    // The frame's copy must stay in step with the parent's gate; the shipped script string is the
    // only place the copy is observable.
    for (const tag of NON_EDITABLE_TAGS) {
      const present =
        DESIGN_BRIDGE_SCRIPT.includes(`${tag}: true`) ||
        DESIGN_BRIDGE_SCRIPT.includes(`"${tag}"`) ||
        DESIGN_BRIDGE_SCRIPT.includes(`'${tag}'`)
      expect(present, `non-editable tag "${tag}" missing from shipped script`).toBe(true)
    }
  })

  it('ships the plaintext-only contenteditable mode', () => {
    expect(DESIGN_BRIDGE_SCRIPT).toContain('plaintext-only')
  })
})

/**
 * Round-1 review blocker 2, half (a), frame side: in Electron the Edit menu consumes Ctrl/⌘+Z, so the
 * chord never reaches this document as a keystroke. The parent forwards it as an `SL_EDIT` `undo` /
 * `redo`, and the frame runs the editing host's own command — the same thing the keystroke would
 * have done in a browser host — keeping the session open.
 */
describe('designBridgeFrameMain SL_EDIT — forwarded undo/redo', () => {
  function armWithExecCommand(): { parent: FakeParent; exec: ReturnType<typeof vi.fn> } {
    const exec = vi.fn(() => true)
    // happy-dom has no execCommand; the frame calls whatever the document exposes.
    Object.defineProperty(document, 'execCommand', { value: exec, configurable: true })
    return { parent: arm(PLAIN), exec }
  }

  it.each(['undo', 'redo'] as const)(
    '%s runs the document editing command and keeps the session open',
    (action) => {
      const { parent, exec } = armWithExecCommand()
      postToFrame(editRequest({ slId: EDITABLE, action: 'begin' }), parent)
      target().textContent = 'typed'
      parent.postMessage.mockClear()

      postToFrame(editRequest({ slId: EDITABLE, action }, 12), parent)

      expect(exec).toHaveBeenCalledWith(action)
      expect(lastPayload(parent)).toMatchObject({ slId: EDITABLE, text: 'typed', editing: true })
      expect(target().getAttribute('contenteditable')).not.toBeNull()
    },
  )

  it('ignores undo/redo when no session is open, or for an element that is not the session', () => {
    const { parent, exec } = armWithExecCommand()

    postToFrame(editRequest({ slId: EDITABLE, action: 'undo' }), parent)
    expect(exec).not.toHaveBeenCalled()
    expect(lastPayload(parent)).toMatchObject({ slId: EDITABLE, editing: false })

    postToFrame(editRequest({ slId: EDITABLE, action: 'begin' }, 2), parent)
    postToFrame(editRequest({ slId: 's_x:0', action: 'redo' }, 3), parent)
    expect(exec).not.toHaveBeenCalled()
    expect(target().getAttribute('contenteditable')).not.toBeNull()
  })
})

/**
 * Round-4 major 2, frame side. The frame ends a session on its own keystrokes and reports the text
 * afterwards, so by the time the parent judges the value unwritable there is no open session left
 * for `cancel` to restore — and the rejected text stayed on screen. `revert` is the parent's answer:
 * put the element back to what it held when the session began. It carries no text, so the parent
 * never writes into the frame's DOM and the frame never has to trust a payload.
 */
describe('designBridgeFrameMain SL_EDIT — revert (round-4)', () => {
  function endedSession(parent: FakeParent, typed: string): void {
    postToFrame(editRequest({ slId: EDITABLE, action: 'begin' }), parent)
    target().textContent = typed
    postToFrame(editRequest({ slId: EDITABLE, action: 'commit' }), parent)
    parent.postMessage.mockClear()
  }

  it('puts back the text the session began with', () => {
    const parent = arm(PLAIN)
    endedSession(parent, 'a rejected 70,000-character paste')
    expect(target().textContent).toBe('a rejected 70,000-character paste')

    postToFrame(editRequest({ slId: EDITABLE, action: 'revert' }), parent)

    expect(target().textContent).toBe('bars')
    expect(lastPayload(parent)).toMatchObject({ slId: EDITABLE, text: 'bars', editing: false })
  })

  it('reverts once — a second revert is a no-op, not a second rewind', () => {
    const parent = arm(PLAIN)
    endedSession(parent, 'typed')
    postToFrame(editRequest({ slId: EDITABLE, action: 'revert' }), parent)
    target().textContent = 'written by something else'
    parent.postMessage.mockClear()

    postToFrame(editRequest({ slId: EDITABLE, action: 'revert' }), parent)

    expect(target().textContent).toBe('written by something else')
    expect(lastPayload(parent)).toBeNull()
  })

  it('refuses to revert an element other than the one that was edited', () => {
    const parent = arm(
      `<section data-sl-id="s_x:0" class="slide"><div data-sl-id="${EDITABLE}">bars</div>` +
        `<div data-sl-id="s_x:2">other</div></section>`,
    )
    endedSession(parent, 'typed')

    postToFrame(editRequest({ slId: 's_x:2', action: 'revert' }), parent)

    expect(document.querySelector('[data-sl-id="s_x:2"]')?.textContent).toBe('other')
    expect(target().textContent).toBe('typed')
  })

  it('a fresh begin discards the previous session’s revert point', () => {
    const parent = arm(PLAIN)
    endedSession(parent, 'typed')
    postToFrame(editRequest({ slId: EDITABLE, action: 'begin' }), parent)
    parent.postMessage.mockClear()

    postToFrame(editRequest({ slId: EDITABLE, action: 'revert' }), parent)

    // The open session is what `cancel` is for; `revert` must not reach behind it to an older value.
    expect(target().textContent).toBe('typed')
  })
})
