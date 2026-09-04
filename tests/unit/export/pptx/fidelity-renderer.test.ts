import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { RENDERER_ENV, diffPixels, resolvePptxRenderer } from '../../../fidelity/lib/renderer'

/**
 * The fail-closed half of the fidelity harness's pixel step. This repo has had instruments that
 * passed on no data; the renderer lookup must say `missing` — never a quiet skip — when nothing is
 * installed, and must honour `SLOODGE_PPTX_RENDERER` so a host-side renderer can be plugged in.
 */
describe('resolvePptxRenderer', () => {
  it('reports missing, naming what it tried, when PATH has no soffice and no override is set', () => {
    const result = resolvePptxRenderer({ PATH: mkdtempSync(join(tmpdir(), 'no-renderer-')) })
    expect(result.kind).toBe('missing')
    if (result.kind === 'missing') expect(result.tried.join(' ')).toContain('soffice')
  })

  it(`honours ${RENDERER_ENV} when it points at an executable, and reports it when it does not`, () => {
    const dir = mkdtempSync(join(tmpdir(), 'renderer-'))
    const exe = join(dir, 'fake-soffice')
    writeFileSync(exe, '#!/bin/sh\nexit 0\n')
    chmodSync(exe, 0o755)
    expect(resolvePptxRenderer({ PATH: '', [RENDERER_ENV]: exe })).toEqual({
      kind: 'found',
      path: exe,
      source: 'env',
    })
    const bogus = resolvePptxRenderer({ PATH: '', [RENDERER_ENV]: join(dir, 'absent') })
    expect(bogus.kind).toBe('missing')
    if (bogus.kind === 'missing') expect(bogus.tried[0]).toContain(RENDERER_ENV)
  })

  it('finds soffice on PATH', () => {
    const dir = mkdtempSync(join(tmpdir(), 'renderer-path-'))
    const exe = join(dir, 'soffice')
    writeFileSync(exe, '#!/bin/sh\nexit 0\n')
    chmodSync(exe, 0o755)
    expect(resolvePptxRenderer({ PATH: dir })).toEqual({ kind: 'found', path: exe, source: 'PATH' })
  })
})

describe('diffPixels', () => {
  it('counts pixels whose any-channel difference exceeds the tolerance, ignoring alpha', () => {
    const a = new Uint8Array([0, 0, 0, 255, 10, 10, 10, 255, 100, 100, 100, 0])
    const b = new Uint8Array([0, 0, 0, 0, 50, 10, 10, 255, 100, 100, 100, 255])
    const diff = diffPixels(a, b, 3, 1, 32)
    expect(diff).toEqual({ differing: 1, total: 3, fraction: 1 / 3 })
  })

  it('refuses buffers smaller than the stated dimensions rather than reading past them', () => {
    expect(() => diffPixels(new Uint8Array(4), new Uint8Array(4), 2, 1)).toThrow(/too small/)
  })
})
