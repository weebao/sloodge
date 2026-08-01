import { describe, expect, it } from 'vitest'
import {
  EXPORT_READINESS_TIMEOUT_MS,
  SLIDE_PRINT_STYLE,
  slideReadinessScript,
} from '../../../src/shared/export/readiness'

describe('slideReadinessScript', () => {
  const script = slideReadinessScript()

  it('waits on document load, webfonts, and image decode before printing', () => {
    expect(script).toContain("document.readyState === 'complete'")
    expect(script).toContain('document.fonts.ready')
    expect(script).toContain('.decode()')
  })

  it('honours the __slideReady contract hook', () => {
    expect(script).toContain('window.__slideReady')
  })

  it('settles finite animations, pins loops, and settles SMIL (final-frame policy)', () => {
    expect(script).toContain('getAnimations')
    expect(script).toContain('.finish()')
    expect(script).toContain('pauseAnimations()')
  })

  it('injects the defensive @page stylesheet idempotently', () => {
    expect(script).toContain('data-sloodge-print')
    expect(SLIDE_PRINT_STYLE).toContain('@page { size: 1280px 720px; margin: 0; }')
  })

  it('commits two frames before returning', () => {
    expect(script).toContain('requestAnimationFrame')
    expect(script.match(/requestAnimationFrame/g)?.length).toBeGreaterThanOrEqual(2)
  })

  it('is bounded by a 6s timeout constant', () => {
    expect(EXPORT_READINESS_TIMEOUT_MS).toBe(6000)
  })
})
