/**
 * @vitest-environment happy-dom
 *
 * The Cmd/Ctrl+D toggle chord matcher and its window binding (§4.2).
 */

import { renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  matchDesignModeKey,
  useDesignModeKey,
} from '../../../src/renderer/src/features/design/useDesignModeKey'

function key(init: Partial<KeyboardEvent> & { key: string }): KeyboardEvent {
  return new KeyboardEvent('keydown', init)
}

describe('matchDesignModeKey', () => {
  it('matches Ctrl+D and ⌘+D, case-insensitively', () => {
    expect(matchDesignModeKey(key({ key: 'd', ctrlKey: true }))).toBe(true)
    expect(matchDesignModeKey(key({ key: 'd', metaKey: true }))).toBe(true)
    expect(matchDesignModeKey(key({ key: 'D', ctrlKey: true }))).toBe(true)
  })

  it('does not match a bare D or the wrong modifiers', () => {
    expect(matchDesignModeKey(key({ key: 'd' }))).toBe(false)
    expect(matchDesignModeKey(key({ key: 'd', ctrlKey: true, altKey: true }))).toBe(false)
    expect(matchDesignModeKey(key({ key: 'd', ctrlKey: true, shiftKey: true }))).toBe(false)
    expect(matchDesignModeKey(key({ key: 'k', ctrlKey: true }))).toBe(false)
  })
})

describe('useDesignModeKey', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('calls the toggle on the chord and unbinds on unmount', () => {
    const toggle = vi.fn()
    const { unmount } = renderHook(() => {
      useDesignModeKey(toggle)
    })

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'd', ctrlKey: true }))
    expect(toggle).toHaveBeenCalledTimes(1)

    // A non-chord key does nothing.
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }))
    expect(toggle).toHaveBeenCalledTimes(1)

    unmount()
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'd', ctrlKey: true }))
    expect(toggle).toHaveBeenCalledTimes(1)
  })
})
