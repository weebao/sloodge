/**
 * The Design Mode view store: toggling, and the invariant that turning it off clears all transient
 * selection state so no stale outline survives a re-enable.
 */

import { beforeEach, describe, expect, it } from 'vitest'
import type { SlHit } from '../../../src/shared/design/bridge-protocol'
import { useDesignStore } from '../../../src/renderer/src/features/design/designStore'

const HIT: SlHit = {
  slId: 's_x:1',
  tag: 'div',
  id: null,
  classes: ['title'],
  rect: { x: 0, y: 0, width: 100, height: 40 },
  ancestors: [],
}

beforeEach(() => {
  // The store is a module singleton; reset it to OFF between cases.
  useDesignStore.setState({ enabled: false, hover: null, selection: null })
})

describe('useDesignStore', () => {
  it('starts off with no hover or selection', () => {
    const state = useDesignStore.getState()
    expect(state.enabled).toBe(false)
    expect(state.hover).toBeNull()
    expect(state.selection).toBeNull()
  })

  it('toggle flips enabled', () => {
    useDesignStore.getState().toggle()
    expect(useDesignStore.getState().enabled).toBe(true)
    useDesignStore.getState().toggle()
    expect(useDesignStore.getState().enabled).toBe(false)
  })

  it('ignores hover/selection updates while disabled', () => {
    useDesignStore.getState().setHover(HIT)
    useDesignStore.getState().setSelection(HIT)
    expect(useDesignStore.getState().hover).toBeNull()
    expect(useDesignStore.getState().selection).toBeNull()
  })

  it('records hover and selection while enabled', () => {
    useDesignStore.getState().setEnabled(true)
    useDesignStore.getState().setHover(HIT)
    expect(useDesignStore.getState().hover).toEqual(HIT)
  })

  it('selecting supersedes the hover outline', () => {
    useDesignStore.getState().setEnabled(true)
    useDesignStore.getState().setHover(HIT)
    useDesignStore.getState().setSelection(HIT)
    expect(useDesignStore.getState().selection).toEqual(HIT)
    expect(useDesignStore.getState().hover).toBeNull()
  })

  it('turning Design Mode off clears hover and selection', () => {
    useDesignStore.getState().setEnabled(true)
    useDesignStore.getState().setHover(HIT)
    useDesignStore.getState().setSelection(HIT)
    useDesignStore.getState().setEnabled(false)
    const state = useDesignStore.getState()
    expect(state.enabled).toBe(false)
    expect(state.hover).toBeNull()
    expect(state.selection).toBeNull()
  })

  it('clearTransient drops hover/selection but stays in Design Mode', () => {
    useDesignStore.getState().setEnabled(true)
    useDesignStore.getState().setSelection(HIT)
    useDesignStore.getState().clearTransient()
    expect(useDesignStore.getState().enabled).toBe(true)
    expect(useDesignStore.getState().selection).toBeNull()
  })
})
