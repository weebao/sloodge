/**
 * @vitest-environment happy-dom
 *
 * The undo/redo chords, and above all the guard that keeps them away from text fields — §5 of
 * 10-architecture.md: the renderer binds Ctrl/⌘+Z "*only* when focus is not inside a text input
 * that has its own native undo". Getting that wrong is not a missing feature, it is a data-loss
 * bug: a user taking back three characters of a title would rewind the whole deck instead.
 */
import { cleanup, createEvent, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  isEditableTarget,
  matchUndoRedoKey,
  useUndoRedoKeys,
} from '../../src/renderer/src/app/useUndoRedoKeys'

afterEach(cleanup)

function key(init: Partial<KeyboardEvent> & { key: string }): KeyboardEvent {
  return new KeyboardEvent('keydown', init)
}

describe('matchUndoRedoKey', () => {
  it('maps the undo chords', () => {
    expect(matchUndoRedoKey(key({ key: 'z', ctrlKey: true }))).toBe('undo')
    expect(matchUndoRedoKey(key({ key: 'z', metaKey: true }))).toBe('undo')
    // Caps lock or a shifted layout still reports a letter; only the modifier decides.
    expect(matchUndoRedoKey(key({ key: 'Z', ctrlKey: true }))).toBe('undo')
  })

  it('maps both redo chords', () => {
    expect(matchUndoRedoKey(key({ key: 'z', ctrlKey: true, shiftKey: true }))).toBe('redo')
    expect(matchUndoRedoKey(key({ key: 'z', metaKey: true, shiftKey: true }))).toBe('redo')
    expect(matchUndoRedoKey(key({ key: 'y', ctrlKey: true }))).toBe('redo')
  })

  it('ignores everything else', () => {
    expect(matchUndoRedoKey(key({ key: 'z' }))).toBeNull()
    expect(matchUndoRedoKey(key({ key: 'a', ctrlKey: true }))).toBeNull()
    // Alt+Ctrl+Z is a different chord on every desktop; it is not ours.
    expect(matchUndoRedoKey(key({ key: 'z', ctrlKey: true, altKey: true }))).toBeNull()
    // ⌘+Y is not redo on macOS — it belongs to the system.
    expect(matchUndoRedoKey(key({ key: 'y', metaKey: true }))).toBeNull()
    expect(matchUndoRedoKey(key({ key: 'y', ctrlKey: true, shiftKey: true }))).toBeNull()
  })
})

describe('isEditableTarget', () => {
  it('claims form controls', () => {
    for (const tag of ['input', 'textarea', 'select']) {
      expect(isEditableTarget(document.createElement(tag))).toBe(true)
    }
  })

  it('claims contenteditable hosts and their descendants', () => {
    const host = document.createElement('div')
    host.setAttribute('contenteditable', '')
    const child = document.createElement('span')
    host.append(child)
    document.body.append(host)

    expect(isEditableTarget(host)).toBe(true)
    expect(isEditableTarget(child)).toBe(true)
    host.remove()
  })

  it('does not claim contenteditable="false"', () => {
    const host = document.createElement('div')
    host.setAttribute('contenteditable', 'false')
    document.body.append(host)

    expect(isEditableTarget(host)).toBe(false)
    host.remove()
  })

  it('does not claim ordinary chrome', () => {
    expect(isEditableTarget(document.createElement('button'))).toBe(false)
    expect(isEditableTarget(document.body)).toBe(false)
    expect(isEditableTarget(null)).toBe(false)
    expect(isEditableTarget(new EventTarget())).toBe(false)
  })

  it('is structural, so an element from another realm still counts', () => {
    // `instanceof HTMLInputElement` is false across realms (a slide frame's document, a detached
    // one); the two properties this reads are not.
    expect(isEditableTarget({ tagName: 'INPUT' } as unknown as EventTarget)).toBe(true)
  })
})

function Harness({ undo, redo }: { undo: () => void; redo: () => void }): React.JSX.Element {
  useUndoRedoKeys(undo, redo)
  return (
    <div>
      <input aria-label="title" />
      <button type="button">plain</button>
    </div>
  )
}

describe('useUndoRedoKeys', () => {
  it('runs the document action for a chord outside an editable element', () => {
    const undo = vi.fn()
    const redo = vi.fn()
    const { getByRole } = render(<Harness undo={undo} redo={redo} />)

    fireEvent.keyDown(getByRole('button'), { key: 'z', ctrlKey: true })
    expect(undo).toHaveBeenCalledTimes(1)

    fireEvent.keyDown(document.body, { key: 'y', ctrlKey: true })
    expect(redo).toHaveBeenCalledTimes(1)
  })

  it('preventDefaults what it handles, so the menu role does not fire it twice', () => {
    render(<Harness undo={vi.fn()} redo={vi.fn()} />)
    const event = createEvent.keyDown(document.body, { key: 'z', ctrlKey: true })
    fireEvent(document.body, event)

    expect(event.defaultPrevented).toBe(true)
  })

  it('leaves the chord alone inside a text field — no undo, no preventDefault', () => {
    const undo = vi.fn()
    const { getByLabelText } = render(<Harness undo={undo} redo={vi.fn()} />)
    const input = getByLabelText('title')

    const event = createEvent.keyDown(input, { key: 'z', ctrlKey: true })
    fireEvent(input, event)

    expect(undo).not.toHaveBeenCalled()
    expect(event.defaultPrevented).toBe(false)
  })

  it('ignores an event another handler already dealt with', () => {
    const undo = vi.fn()
    render(<Harness undo={undo} redo={vi.fn()} />)
    const event = createEvent.keyDown(document.body, { key: 'z', ctrlKey: true })
    event.preventDefault()
    fireEvent(document.body, event)

    expect(undo).not.toHaveBeenCalled()
  })

  it('unbinds on unmount', () => {
    const undo = vi.fn()
    const { unmount } = render(<Harness undo={undo} redo={vi.fn()} />)
    unmount()

    fireEvent.keyDown(document.body, { key: 'z', ctrlKey: true })
    expect(undo).not.toHaveBeenCalled()
  })
})
