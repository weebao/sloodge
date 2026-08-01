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
  useDesignStore.setState({ enabled: false, hover: null, selection: null, selections: [] })
})

/** A second hit distinct from `HIT`, for multi-select cases. */
const HIT2: SlHit = {
  slId: 's_x:2',
  tag: 'p',
  id: null,
  classes: ['subtitle'],
  rect: { x: 0, y: 60, width: 120, height: 30 },
  ancestors: [],
}

const HIT3: SlHit = {
  slId: 's_x:3',
  tag: 'rect',
  id: null,
  classes: [],
  rect: { x: 200, y: 0, width: 40, height: 40 },
  ancestors: [],
}

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

const enable = (): void => {
  useDesignStore.getState().setEnabled(true)
}

describe('useDesignStore multi-select (M3.7)', () => {
  it('setSelection collapses to a single-element ordered set with the anchor mirror', () => {
    enable()
    useDesignStore.getState().setSelection(HIT)
    const state = useDesignStore.getState()
    expect(state.selections.map((h) => h.slId)).toEqual([HIT.slId])
    expect(state.selection?.slId).toBe(HIT.slId) // anchor mirrors the last entry
  })

  it('toggleSelection appends a new element and moves the anchor to it', () => {
    enable()
    useDesignStore.getState().setSelection(HIT)
    useDesignStore.getState().toggleSelection(HIT2)
    const state = useDesignStore.getState()
    expect(state.selections.map((h) => h.slId)).toEqual([HIT.slId, HIT2.slId])
    expect(state.selection?.slId).toBe(HIT2.slId) // newest is the anchor
  })

  it('toggleSelection removes an already-selected element', () => {
    enable()
    useDesignStore.getState().setSelections([HIT, HIT2, HIT3])
    useDesignStore.getState().toggleSelection(HIT2)
    const state = useDesignStore.getState()
    expect(state.selections.map((h) => h.slId)).toEqual([HIT.slId, HIT3.slId])
    expect(state.selection?.slId).toBe(HIT3.slId)
  })

  it('toggleSelection ignores a null hit and empty clears the anchor', () => {
    enable()
    useDesignStore.getState().setSelection(HIT)
    useDesignStore.getState().toggleSelection(null)
    expect(useDesignStore.getState().selections.map((h) => h.slId)).toEqual([HIT.slId])
    useDesignStore.getState().toggleSelection(HIT)
    expect(useDesignStore.getState().selections).toEqual([])
    expect(useDesignStore.getState().selection).toBeNull()
  })

  it('setSelections replaces the whole selection and de-dupes by slId (last wins)', () => {
    enable()
    const moved: SlHit = { ...HIT2, rect: { x: 5, y: 5, width: 9, height: 9 } }
    useDesignStore.getState().setSelections([HIT, HIT2, moved])
    const state = useDesignStore.getState()
    expect(state.selections.map((h) => h.slId)).toEqual([HIT.slId, HIT2.slId])
    // The duplicate kept the freshest geometry.
    expect(state.selections.find((h) => h.slId === HIT2.slId)?.rect.x).toBe(5)
    expect(state.selection?.slId).toBe(HIT2.slId)
  })

  it('multi-select actions are ignored while Design Mode is off', () => {
    useDesignStore.getState().setEnabled(false)
    useDesignStore.getState().toggleSelection(HIT)
    useDesignStore.getState().setSelections([HIT, HIT2])
    expect(useDesignStore.getState().selections).toEqual([])
  })

  it('turning Design Mode off clears the whole ordered selection', () => {
    enable()
    useDesignStore.getState().setSelections([HIT, HIT2, HIT3])
    useDesignStore.getState().setEnabled(false)
    expect(useDesignStore.getState().selections).toEqual([])
    expect(useDesignStore.getState().selection).toBeNull()
  })
})
