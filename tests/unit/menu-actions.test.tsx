/**
 * @vitest-environment happy-dom
 *
 * The native Edit menu's end of undo/redo: what `edit.undo` means when it arrives, and which of
 * the two hosts' undo paths is live.
 *
 * The second half is the point. In Electron the menu owns CmdOrCtrl+Z — its accelerator is
 * registered with the OS — so the renderer must NOT also bind the chord; in a browser host there is
 * no menu, so it must. These tests pin that the choice is made by the presence of the bridge, which
 * is what makes "both paths fire for one keypress" impossible rather than merely unlikely.
 */
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { documentEditHost, runEditAction } from '../../src/renderer/src/app/editActions'
import {
  getBridge,
  menuOwnsEditAccelerators,
  useMenuActions,
  type SloodgeBridge,
} from '../../src/renderer/src/app/useMenuActions'
import { setActiveTextEditSession } from '../../src/renderer/src/features/design/textEditSession'
import type { MenuAction } from '../../src/shared/ipc-contract'

afterEach(() => {
  cleanup()
  delete window.sloodge
  setActiveTextEditSession(null)
  vi.restoreAllMocks()
})

/** A bridge whose `onMenuAction` we can fire by hand, with unsubscribe tracking. */
function fakeBridge(): SloodgeBridge & {
  emit: (action: MenuAction) => void
  unsubscribed: () => boolean
} {
  const listeners = new Set<(action: MenuAction) => void>()
  let unsubscribed = false
  return {
    onMenuAction(listener) {
      listeners.add(listener)
      return () => {
        unsubscribed = true
        listeners.delete(listener)
      }
    },
    emit(action) {
      for (const listener of listeners) listener(action)
    },
    unsubscribed: () => unsubscribed,
  }
}

type Spy = ReturnType<typeof vi.fn<() => void>>

/** Fresh spies per case; the pair the dispatcher either calls or must not. */
const handlers = (): { undo: Spy; redo: Spy } => ({
  undo: vi.fn<() => void>(),
  redo: vi.fn<() => void>(),
})

describe('runEditAction', () => {
  it('routes to the document when nothing editable has focus', () => {
    const acted = handlers()
    const execCommand = vi.fn(() => true)

    expect(
      runEditAction('edit.undo', acted, {
        activeElement: document.body,
        execCommand,
        frameSession: null,
      }),
    ).toBe('document')
    expect(acted.undo).toHaveBeenCalledTimes(1)
    expect(execCommand).not.toHaveBeenCalled()

    expect(
      runEditAction('edit.redo', acted, { activeElement: null, execCommand, frameSession: null }),
    ).toBe('document')
    expect(acted.redo).toHaveBeenCalledTimes(1)
  })

  it('routes to the field’s own undo when an editable element has focus', () => {
    const acted = handlers()
    const execCommand = vi.fn(() => true)
    const input = document.createElement('textarea')

    expect(
      runEditAction('edit.undo', acted, { activeElement: input, execCommand, frameSession: null }),
    ).toBe('text')
    expect(execCommand).toHaveBeenCalledWith('undo')
    expect(
      runEditAction('edit.redo', acted, { activeElement: input, execCommand, frameSession: null }),
    ).toBe('text')
    expect(execCommand).toHaveBeenCalledWith('redo')

    // The whole point: the deck is untouched while the user is editing text.
    expect(acted.undo).not.toHaveBeenCalled()
    expect(acted.redo).not.toHaveBeenCalled()
  })

  /**
   * M3.11 round-1 blocker: with a caret open inside the slide frame, `document.activeElement` is the
   * `<iframe>` — nothing editable as far as the parent can see — and the chord used to fall through
   * to the deck's undo, reloading the frame and losing the typed text. The open session registers a
   * forwarder; the router must prefer it over the document stack.
   */
  it('routes to the frame session when a caret is open in the slide frame', () => {
    const acted = handlers()
    const execCommand = vi.fn(() => true)
    const frameSession = { undo: vi.fn(), redo: vi.fn() }
    const iframe = document.createElement('iframe')

    expect(
      runEditAction('edit.undo', acted, { activeElement: iframe, execCommand, frameSession }),
    ).toBe('frame')
    expect(frameSession.undo).toHaveBeenCalledTimes(1)
    expect(
      runEditAction('edit.redo', acted, { activeElement: iframe, execCommand, frameSession }),
    ).toBe('frame')
    expect(frameSession.redo).toHaveBeenCalledTimes(1)

    // Never the deck, never the parent document's execCommand.
    expect(acted.undo).not.toHaveBeenCalled()
    expect(acted.redo).not.toHaveBeenCalled()
    expect(execCommand).not.toHaveBeenCalled()
  })

  it('a focused parent field still wins over an open frame session', () => {
    // The instant between a frame blur and the session's end: the field that has focus owns it.
    const acted = handlers()
    const execCommand = vi.fn(() => true)
    const frameSession = { undo: vi.fn(), redo: vi.fn() }
    const input = document.createElement('input')

    expect(
      runEditAction('edit.undo', acted, { activeElement: input, execCommand, frameSession }),
    ).toBe('text')
    expect(frameSession.undo).not.toHaveBeenCalled()
    expect(acted.undo).not.toHaveBeenCalled()
  })

  it('binds the live host to the real document and the registered session', () => {
    const input = document.createElement('input')
    document.body.append(input)
    input.focus()

    expect(documentEditHost().activeElement).toBe(input)
    expect(documentEditHost().frameSession).toBeNull()

    const session = { undo: vi.fn(), redo: vi.fn() }
    setActiveTextEditSession(session)
    expect(documentEditHost().frameSession).toBe(session)
    input.remove()
  })
})

function Harness({ undo, redo }: { undo: () => void; redo: () => void }): React.JSX.Element {
  useMenuActions({ undo, redo })
  return <div />
}

describe('useMenuActions', () => {
  it('does nothing at all without a bridge', () => {
    expect(getBridge()).toBeUndefined()
    expect(menuOwnsEditAccelerators()).toBe(false)
    // Mounting without a bridge must not throw and must not subscribe to anything.
    expect(() => render(<Harness undo={vi.fn()} redo={vi.fn()} />)).not.toThrow()
  })

  it('runs undo and redo from the menu when the bridge is present', () => {
    const bridge = fakeBridge()
    window.sloodge = bridge
    const undo = vi.fn()
    const redo = vi.fn()
    render(<Harness undo={undo} redo={redo} />)

    expect(menuOwnsEditAccelerators()).toBe(true)
    bridge.emit('edit.undo')
    expect(undo).toHaveBeenCalledTimes(1)
    bridge.emit('edit.redo')
    expect(redo).toHaveBeenCalledTimes(1)
  })

  it('menu undo during an open frame session never reaches the deck', () => {
    const bridge = fakeBridge()
    window.sloodge = bridge
    const undo = vi.fn()
    const session = { undo: vi.fn(), redo: vi.fn() }
    setActiveTextEditSession(session)
    render(<Harness undo={undo} redo={vi.fn()} />)

    bridge.emit('edit.undo')
    expect(session.undo).toHaveBeenCalledTimes(1)
    expect(undo).not.toHaveBeenCalled()

    // Session over: the same chord is the deck's again.
    setActiveTextEditSession(null)
    bridge.emit('edit.undo')
    expect(undo).toHaveBeenCalledTimes(1)
  })

  it('ignores the ids that belong to other milestones', () => {
    const bridge = fakeBridge()
    window.sloodge = bridge
    const undo = vi.fn()
    render(<Harness undo={undo} redo={vi.fn()} />)

    bridge.emit('file.new')
    bridge.emit('file.export.pdf')
    expect(undo).not.toHaveBeenCalled()
  })

  it('unsubscribes on unmount', () => {
    const bridge = fakeBridge()
    window.sloodge = bridge
    const undo = vi.fn()
    const { unmount } = render(<Harness undo={undo} redo={vi.fn()} />)
    unmount()

    expect(bridge.unsubscribed()).toBe(true)
    bridge.emit('edit.undo')
    expect(undo).not.toHaveBeenCalled()
  })
})
