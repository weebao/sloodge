import { describe, expect, it, vi } from 'vitest'
import {
  applyPresentFullscreen,
  parsePresentFullscreenRequest,
  type FullscreenWindow,
} from '../../../src/main/present/presentFullscreen'

function fakeWindow(initial: boolean): FullscreenWindow & { flag: boolean } {
  const win = {
    flag: initial,
    setFullScreen: vi.fn((value: boolean) => {
      win.flag = value
    }),
    isFullScreen: () => win.flag,
    isDestroyed: () => false,
  }
  return win
}

describe('parsePresentFullscreenRequest', () => {
  it('accepts a well-formed boolean request', () => {
    expect(parsePresentFullscreenRequest({ fullscreen: true })).toEqual({ fullscreen: true })
    expect(parsePresentFullscreenRequest({ fullscreen: false })).toEqual({ fullscreen: false })
  })

  it('rejects anything that is not a boolean fullscreen field', () => {
    for (const bad of [null, undefined, 42, 'true', {}, { fullscreen: 'yes' }, { fullscreen: 1 }]) {
      expect(parsePresentFullscreenRequest(bad)).toBeNull()
    }
  })
})

describe('applyPresentFullscreen', () => {
  it('drives the window into fullscreen and reports the resulting state', () => {
    const win = fakeWindow(false)
    const response = applyPresentFullscreen(win, { fullscreen: true })
    expect(win.setFullScreen).toHaveBeenCalledWith(true)
    expect(response).toEqual({ fullscreen: true })
  })

  it('restores the editor when asked to leave fullscreen', () => {
    const win = fakeWindow(true)
    const response = applyPresentFullscreen(win, { fullscreen: false })
    expect(win.setFullScreen).toHaveBeenCalledWith(false)
    expect(response).toEqual({ fullscreen: false })
  })

  // A malformed payload must never reach setFullScreen — `setFullScreen(undefined)` would strand the
  // window with no chrome to escape from.
  it('never calls setFullScreen for a malformed payload, and reports the unchanged state', () => {
    const win = fakeWindow(false)
    const response = applyPresentFullscreen(win, { fullscreen: 'nope' })
    expect(win.setFullScreen).not.toHaveBeenCalled()
    expect(response).toEqual({ fullscreen: false })
  })

  it('reports fullscreen:false when there is no window', () => {
    expect(applyPresentFullscreen(null, { fullscreen: true })).toEqual({ fullscreen: false })
  })

  it('treats a destroyed window as no window', () => {
    const win = { ...fakeWindow(true), isDestroyed: () => true }
    expect(applyPresentFullscreen(win, { fullscreen: false })).toEqual({ fullscreen: false })
    expect(win.setFullScreen).not.toHaveBeenCalled()
  })
})
