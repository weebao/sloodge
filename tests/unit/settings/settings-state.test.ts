/**
 * The Settings dialog's state machine (M2.7) — tabs, and the dirty guard that stops a stray Escape
 * discarding a half-typed credential.
 */

import { describe, expect, it } from 'vitest'
import {
  INITIAL_SETTINGS_STATE,
  isSettingsTab,
  nextTab,
  settingsReducer,
  SETTINGS_TABS,
  SETTINGS_TAB_LABELS,
  type SettingsState,
} from '../../../src/renderer/src/features/settings/settingsState'

const open = (): SettingsState => settingsReducer(INITIAL_SETTINGS_STATE, { type: 'open' })
const dirty = (): SettingsState => settingsReducer(open(), { type: 'set-dirty', dirty: true })

describe('SETTINGS_TABS', () => {
  it('leads with Auth — the tab that gates everything else', () => {
    expect(SETTINGS_TABS[0]).toBe('auth')
  })

  it('labels every tab', () => {
    for (const tab of SETTINGS_TABS) expect(SETTINGS_TAB_LABELS[tab]).toBeTruthy()
  })

  it('guards unknown values crossing from an untyped source', () => {
    expect(isSettingsTab('auth')).toBe(true)
    expect(isSettingsTab('nope')).toBe(false)
    expect(isSettingsTab(undefined)).toBe(false)
  })
})

describe('open', () => {
  it('lands on Auth by default', () => {
    expect(open()).toMatchObject({ open: true, tab: 'auth' })
  })

  it('honours a deep link (the chat gate opens Auth explicitly)', () => {
    const state = settingsReducer(INITIAL_SETTINGS_STATE, { type: 'open', tab: 'about' })
    expect(state.tab).toBe('about')
  })

  it('reopens clean, so an abandoned draft never resurfaces', () => {
    const stale = settingsReducer(dirty(), { type: 'request-close' })
    expect(stale.confirmingDiscard).toBe(true)
    const reopened = settingsReducer(stale, { type: 'open' })
    expect(reopened).toMatchObject({
      open: true,
      tab: 'auth',
      dirty: false,
      confirmingDiscard: false,
    })
  })
})

describe('select-tab', () => {
  it('switches tabs', () => {
    expect(settingsReducer(open(), { type: 'select-tab', tab: 'budget' }).tab).toBe('budget')
  })

  it('returns the same object when the tab is unchanged, so React can skip the render', () => {
    const state = open()
    expect(settingsReducer(state, { type: 'select-tab', tab: 'auth' })).toBe(state)
  })

  it('clears dirty — the input unmounted, so there is nothing left to confirm about', () => {
    const state = settingsReducer(dirty(), { type: 'select-tab', tab: 'about' })
    expect(state.dirty).toBe(false)
    // …and a subsequent close must not be intercepted.
    expect(settingsReducer(state, { type: 'request-close' }).open).toBe(false)
  })
})

describe('the dirty guard', () => {
  it('closes immediately when nothing is unsaved', () => {
    expect(settingsReducer(open(), { type: 'request-close' }).open).toBe(false)
  })

  /** The reason the machine exists. Mutation check: drop the `state.dirty` branch and this fails. */
  it('intercepts a close while a credential is half-typed', () => {
    const state = settingsReducer(dirty(), { type: 'request-close' })
    expect(state.open).toBe(true)
    expect(state.confirmingDiscard).toBe(true)
  })

  it('closes on confirm', () => {
    const asked = settingsReducer(dirty(), { type: 'request-close' })
    expect(settingsReducer(asked, { type: 'confirm-discard' })).toMatchObject({
      open: false,
      dirty: false,
      confirmingDiscard: false,
    })
  })

  it('stays open and still dirty on cancel', () => {
    const asked = settingsReducer(dirty(), { type: 'request-close' })
    const kept = settingsReducer(asked, { type: 'cancel-discard' })
    expect(kept).toMatchObject({ open: true, dirty: true, confirmingDiscard: false })
  })

  it('ignores a close request when already closed', () => {
    expect(settingsReducer(INITIAL_SETTINGS_STATE, { type: 'request-close' })).toBe(
      INITIAL_SETTINGS_STATE,
    )
  })

  it('no-ops when dirty is set to its current value', () => {
    const state = open()
    expect(settingsReducer(state, { type: 'set-dirty', dirty: false })).toBe(state)
  })
})

describe('nextTab', () => {
  it('moves forward and backward', () => {
    expect(nextTab('auth', 1)).toBe('model')
    expect(nextTab('model', -1)).toBe('auth')
  })

  it('wraps at both ends like a native tab strip', () => {
    expect(nextTab('auth', -1)).toBe(SETTINGS_TABS[SETTINGS_TABS.length - 1])
    expect(nextTab(SETTINGS_TABS[SETTINGS_TABS.length - 1] as 'about', 1)).toBe('auth')
  })

  it('visits every tab in a full cycle', () => {
    const seen = new Set<string>()
    let tab = SETTINGS_TABS[0] as 'auth'
    for (let i = 0; i < SETTINGS_TABS.length; i += 1) {
      seen.add(tab)
      tab = nextTab(tab, 1) as 'auth'
    }
    expect(seen.size).toBe(SETTINGS_TABS.length)
  })
})
