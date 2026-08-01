/**
 * The eyedropper seam (M3.8). The native `EyeDropper` cannot run under a test, so what is tested is
 * exactly the seam's contract: feature-detection, the happy path (a sampled hex), and the two ways it
 * yields `null` (API absent, user cancelled). A fake window stands in for `window.EyeDropper`.
 */

import { describe, expect, it } from 'vitest'
import {
  createEyeDropperPicker,
  hasEyeDropper,
  type EyeDropperHost,
} from '../../../src/renderer/src/features/design/eyedropper'

function fakeWindow(ctor?: unknown): EyeDropperHost {
  return { EyeDropper: ctor }
}

class ResolvingEyeDropper {
  open(): Promise<{ sRGBHex: string }> {
    return Promise.resolve({ sRGBHex: '#abcdef' })
  }
}

class CancellingEyeDropper {
  open(): Promise<{ sRGBHex: string }> {
    return Promise.reject(new Error('AbortError'))
  }
}

describe('hasEyeDropper', () => {
  it('detects the API when the constructor is present', () => {
    expect(hasEyeDropper(fakeWindow(ResolvingEyeDropper))).toBe(true)
  })

  it('reports absence when the global is missing or not a constructor', () => {
    expect(hasEyeDropper(fakeWindow(undefined))).toBe(false)
    expect(hasEyeDropper(fakeWindow('nope'))).toBe(false)
  })
})

describe('createEyeDropperPicker', () => {
  it('resolves the sampled sRGB hex', async () => {
    const picker = createEyeDropperPicker(fakeWindow(ResolvingEyeDropper))
    await expect(picker.pickColor()).resolves.toBe('#abcdef')
  })

  it('resolves null when the user cancels (the API rejects)', async () => {
    const picker = createEyeDropperPicker(fakeWindow(CancellingEyeDropper))
    await expect(picker.pickColor()).resolves.toBeNull()
  })

  it('resolves null when the API is unavailable', async () => {
    const picker = createEyeDropperPicker(fakeWindow(undefined))
    await expect(picker.pickColor()).resolves.toBeNull()
  })
})
