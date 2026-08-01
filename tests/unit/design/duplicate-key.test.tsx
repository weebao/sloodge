/**
 * @vitest-environment happy-dom
 *
 * `useDuplicateKey` — `Ctrl/⌘+D` duplicates the selection, and (crucially) preempts the Design Mode
 * toggle that shares the chord. The preemption is a capture-phase listener + `stopImmediatePropagation`,
 * so a bubble-phase window listener (where `useDesignModeKey` binds) must NOT see the event when an
 * element is selected — proven here with a stand-in bubble listener. The event is dispatched on
 * `document.body` (a real descendant) so window sees capture-before-bubble, as in production.
 */

import { cleanup, fireEvent, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useDuplicateKey } from '../../../src/renderer/src/features/design/useDuplicateKey'

afterEach(cleanup)

function ctrlD(): void {
  fireEvent.keyDown(document.body, { key: 'd', ctrlKey: true })
}

describe('useDuplicateKey', () => {
  it('duplicates on Ctrl+D while enabled', () => {
    const duplicate = vi.fn()
    renderHook(() => useDuplicateKey(duplicate, true))
    ctrlD()
    expect(duplicate).toHaveBeenCalledTimes(1)
  })

  it('does nothing while disabled — the chord falls through to the toggle', () => {
    const duplicate = vi.fn()
    const toggle = vi.fn()
    window.addEventListener('keydown', toggle)
    renderHook(() => useDuplicateKey(duplicate, false))
    ctrlD()
    expect(duplicate).not.toHaveBeenCalled()
    expect(toggle).toHaveBeenCalledTimes(1)
    window.removeEventListener('keydown', toggle)
  })

  it('preempts a bubble-phase window listener when enabled (stopImmediatePropagation)', () => {
    const duplicate = vi.fn()
    const toggle = vi.fn()
    window.addEventListener('keydown', toggle) // bubble phase, like useDesignModeKey
    renderHook(() => useDuplicateKey(duplicate, true))
    ctrlD()
    expect(duplicate).toHaveBeenCalledTimes(1)
    // The toggle stand-in never fires: capture-phase stopImmediatePropagation cut it off.
    expect(toggle).not.toHaveBeenCalled()
    window.removeEventListener('keydown', toggle)
  })

  it('ignores a plain D (no modifier)', () => {
    const duplicate = vi.fn()
    renderHook(() => useDuplicateKey(duplicate, true))
    fireEvent.keyDown(document.body, { key: 'd' })
    expect(duplicate).not.toHaveBeenCalled()
  })

  it('does not steal Ctrl+D from a focused text field (editable-target guard)', () => {
    const duplicate = vi.fn()
    const toggle = vi.fn()
    window.addEventListener('keydown', toggle)
    const input = document.createElement('input')
    document.body.append(input)
    input.focus()
    renderHook(() => useDuplicateKey(duplicate, true))
    fireEvent.keyDown(input, { key: 'd', ctrlKey: true })
    // The field keeps the chord; the event even falls through (not preempted).
    expect(duplicate).not.toHaveBeenCalled()
    expect(toggle).toHaveBeenCalledTimes(1)
    window.removeEventListener('keydown', toggle)
    input.remove()
  })
})
