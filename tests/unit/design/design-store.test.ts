/**
 * The Design Mode view store: toggling, and the invariant that turning it off clears all transient
 * selection state so no stale outline survives a re-enable.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
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
  useDesignStore.setState({
    enabled: false,
    hover: null,
    selection: null,
    selections: [],
    notice: null,
    finishing: 0,
  })
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

/**
 * M3.11. `enabled` initialized to `false` from M3.2 through M3.10, which meant a fresh deck handed
 * pointer events to the slide and clicking text did nothing at all until the user found `Ctrl/⌘+D`.
 * That is the bug this milestone exists to fix, so the default is pinned here rather than left to
 * whatever the store literal happens to say.
 */
describe('Design Mode is edit-first by default', () => {
  it('initializes enabled with nothing selected or being edited', async () => {
    // A genuinely fresh module instance, so this reads the store's own initializer rather than
    // whatever the surrounding `beforeEach` reset it to.
    vi.resetModules()
    const fresh = await import('../../../src/renderer/src/features/design/designStore')
    const state = fresh.useDesignStore.getState()

    expect(state.enabled).toBe(true)
    expect(state.selection).toBeNull()
    expect(state.selections).toEqual([])
    expect(state.editing).toBeNull()
  })
})

describe('text-edit sessions (M3.11)', () => {
  beforeEach(() => {
    useDesignStore.setState({
      enabled: true,
      hover: null,
      selection: null,
      selections: [],
      editing: null,
    })
  })

  it('opens a session and clears hover', () => {
    useDesignStore.getState().setHover(HIT)
    useDesignStore.getState().beginEditing(HIT.slId)

    expect(useDesignStore.getState().editing).toBe(HIT.slId)
    expect(useDesignStore.getState().hover).toBeNull()
  })

  it('refuses to open a session while Design Mode is off', () => {
    useDesignStore.getState().setEnabled(false)
    useDesignStore.getState().beginEditing(HIT.slId)

    expect(useDesignStore.getState().editing).toBeNull()
  })

  it('ends the session when Design Mode is turned off', () => {
    useDesignStore.getState().beginEditing(HIT.slId)
    useDesignStore.getState().setEnabled(false)

    expect(useDesignStore.getState().editing).toBeNull()
  })

  // M3.13: the stage frame's hold is a count of sessions, one per open or finishing caret, so two
  // sessions overlapping inside the finish window hold twice and each releases only its own. The
  // toggle does not touch it — `OFF` leaves it alone — and it never goes below zero.
  it('holds the frame per session and releases per session', () => {
    useDesignStore.getState().holdFinishing()
    useDesignStore.getState().holdFinishing()
    expect(useDesignStore.getState().finishing).toBe(2)

    useDesignStore.getState().setEnabled(false)
    expect(useDesignStore.getState().finishing).toBe(2)

    useDesignStore.getState().settleFinishing()
    expect(useDesignStore.getState().finishing).toBe(1)
    useDesignStore.getState().settleFinishing()
    useDesignStore.getState().settleFinishing()
    expect(useDesignStore.getState().finishing).toBe(0)
  })

  it('endEditing is idempotent', () => {
    useDesignStore.getState().beginEditing(HIT.slId)
    useDesignStore.getState().endEditing()
    useDesignStore.getState().endEditing()

    expect(useDesignStore.getState().editing).toBeNull()
  })

  it('clearTransient drops the session with the rest of the transient state', () => {
    useDesignStore.getState().setSelection(HIT)
    useDesignStore.getState().beginEditing(HIT.slId)
    useDesignStore.getState().clearTransient()

    expect(useDesignStore.getState().editing).toBeNull()
    expect(useDesignStore.getState().selection).toBeNull()
  })

  it('selecting a DIFFERENT element ends the session', () => {
    useDesignStore.getState().setSelection(HIT)
    useDesignStore.getState().beginEditing(HIT.slId)
    useDesignStore.getState().setSelection(HIT2)

    expect(useDesignStore.getState().editing).toBeNull()
  })

  /**
   * Double-click fires `click` first, so the single click's hit-test response can land *after*
   * `beginEditing`. Re-selecting the element already being edited therefore must not cancel the
   * session, or double-click would race itself and open a caret that immediately closed.
   */
  it('re-selecting the element being edited keeps the session — the double-click race', () => {
    useDesignStore.getState().setSelection(HIT)
    useDesignStore.getState().beginEditing(HIT.slId)
    useDesignStore.getState().setSelection(HIT)

    expect(useDesignStore.getState().editing).toBe(HIT.slId)
  })

  it('shift-click and marquee selection both end the session', () => {
    useDesignStore.getState().beginEditing(HIT.slId)
    useDesignStore.getState().toggleSelection(HIT2)
    expect(useDesignStore.getState().editing).toBeNull()

    useDesignStore.getState().beginEditing(HIT.slId)
    useDesignStore.getState().setSelections([HIT, HIT2])
    expect(useDesignStore.getState().editing).toBeNull()
  })
})

/**
 * The refused-edit notice outlives what clears the rest of the store, which is the whole point of it
 * living here: the toggle — and Present, which forces it off — decide a refusal a moment *after*
 * flipping the flag, so `OFF` clearing the notice would erase the explanation they exist to give
 * (round-8). That invariant was carried only by the `Omit<DesignSnapshot, 'notice'>` on `OFF`.
 */
describe('the refused-edit notice (M3.11)', () => {
  const NOTICE = { slideId: 's_a', text: 'That text is too long to store on a slide.' } as const

  it('survives turning Design Mode off — the exit that raised it', () => {
    useDesignStore.getState().setEnabled(true)
    useDesignStore.getState().setSelection(HIT)
    useDesignStore.getState().setNotice(NOTICE)

    useDesignStore.getState().setEnabled(false)

    expect(useDesignStore.getState().notice).toEqual(NOTICE)
    // ...while everything else the toggle owns is gone, so this is not a store that failed to reset.
    expect(useDesignStore.getState().selection).toBeNull()
  })

  it('survives the toggle for the same reason', () => {
    useDesignStore.getState().setEnabled(true)
    useDesignStore.getState().setNotice(NOTICE)

    useDesignStore.getState().toggle()

    expect(useDesignStore.getState().enabled).toBe(false)
    expect(useDesignStore.getState().notice).toEqual(NOTICE)
  })

  it('survives clearTransient — Escape must not erase what it is still explaining', () => {
    useDesignStore.getState().setEnabled(true)
    useDesignStore.getState().setSelection(HIT)
    useDesignStore.getState().setNotice(NOTICE)

    useDesignStore.getState().clearTransient()

    expect(useDesignStore.getState().selection).toBeNull()
    expect(useDesignStore.getState().notice).toEqual(NOTICE)
  })
})
