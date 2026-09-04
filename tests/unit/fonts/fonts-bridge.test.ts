import { describe, expect, it, vi } from 'vitest'

import { createFontsBridge } from '../../../src/preload/fontsBridge'
import { APP_LIST_FONTS_CHANNEL } from '../../../src/shared/ipc-contract'

describe('createFontsBridge', () => {
  it('invokes the shared channel constant', async () => {
    const invoke = vi.fn().mockResolvedValue({ families: ['Arial'], source: 'powershell' })
    await createFontsBridge(invoke).listSystemFonts()
    expect(invoke).toHaveBeenCalledWith(APP_LIST_FONTS_CHANNEL, {})
  })

  it('passes a well-formed response through', async () => {
    const invoke = vi.fn().mockResolvedValue({ families: ['Arial', '宋体'], source: 'powershell' })
    await expect(createFontsBridge(invoke).listSystemFonts()).resolves.toEqual({
      families: ['Arial', '宋体'],
      source: 'powershell',
    })
  })

  it('re-filters names on the way in, so main is not the only thing standing between the OS and the DOM', async () => {
    const invoke = vi.fn().mockResolvedValue({
      families: ['Arial', 'Evil"; } body {', 'url(//x)', 'Georgia'],
      source: 'powershell',
    })
    await expect(createFontsBridge(invoke).listSystemFonts()).resolves.toEqual({
      families: ['Arial', 'Georgia'],
      source: 'powershell',
    })
  })

  it('degrades to an empty list rather than throwing when the channel rejects', async () => {
    const invoke = vi.fn().mockRejectedValue(new Error('no handler'))
    await expect(createFontsBridge(invoke).listSystemFonts()).resolves.toEqual({
      families: [],
      source: 'none',
    })
  })

  it('degrades on a malformed response instead of trusting its shape', async () => {
    const malformed = [null, undefined, 'nope', 42, {}, { families: 'Arial' }, { families: null }]
    const results = await Promise.all(
      malformed.map((bad) => createFontsBridge(vi.fn().mockResolvedValue(bad)).listSystemFonts()),
    )
    for (const result of results) {
      expect(result).toEqual({ families: [], source: 'none' })
    }
  })

  it('normalises an unrecognised source to none', async () => {
    const invoke = vi.fn().mockResolvedValue({ families: ['Arial'], source: 'sorcery' })
    await expect(createFontsBridge(invoke).listSystemFonts()).resolves.toEqual({
      families: ['Arial'],
      source: 'none',
    })
  })
})
