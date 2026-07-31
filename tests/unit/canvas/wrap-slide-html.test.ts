import { describe, expect, it } from 'vitest'
import { SLIDE_CSP, wrapSlideHtml } from '../../../src/renderer/src/features/canvas/wrapSlideHtml'
import { createStarterSlideHtml } from '../../../src/shared/document/starter-slide'

const SLIDE_ID = 's_01H8XQZ4P7K2M9NB3VYRTC6FDA'

describe('SLIDE_CSP', () => {
  it('is the layer-3 policy of 10-architecture.md §7', () => {
    const directives = new Map(
      SLIDE_CSP.split('; ').map((directive) => {
        const [name, ...value] = directive.split(' ')
        return [name, value.join(' ')]
      }),
    )
    expect(directives.get('default-src')).toBe("'none'")
    // The load-bearing one: a slide cannot phone home or exfiltrate deck content.
    expect(directives.get('connect-src')).toBe("'none'")
    expect(directives.get('frame-src')).toBe("'none'")
    expect(directives.get('object-src')).toBe("'none'")
    expect(directives.get('base-uri')).toBe("'none'")
    expect(directives.get('form-action')).toBe("'none'")
    // Inline script and style are the format itself (§3.1 of 30-slide-format.md), so they are
    // permitted — but only inline. No host, no scheme, nothing remote.
    expect(directives.get('script-src')).toBe("'unsafe-inline'")
    expect(directives.get('style-src')).toBe("'unsafe-inline'")
    expect(SLIDE_CSP).not.toMatch(/https?:/)
    expect(SLIDE_CSP).not.toContain("'self'")
    expect(SLIDE_CSP).not.toContain('*')
  })
})

describe('wrapSlideHtml', () => {
  it('injects the policy as the first thing inside <head>', () => {
    const wrapped = wrapSlideHtml(createStarterSlideHtml({ id: SLIDE_ID, title: 'Q3' }))
    const meta = wrapped.indexOf('<meta http-equiv="Content-Security-Policy"')
    expect(meta).toBeGreaterThan(-1)
    expect(wrapped).toContain(`content="${SLIDE_CSP}"`)
    // Before every piece of author content the policy has to govern.
    expect(meta).toBeGreaterThan(wrapped.indexOf('<head>'))
    expect(meta).toBeLessThan(wrapped.indexOf('<title>'))
    expect(meta).toBeLessThan(wrapped.indexOf('<style>'))
    expect(meta).toBeLessThan(wrapped.indexOf('<body>'))
  })

  it('keeps the doctype first so the slide stays out of quirks mode', () => {
    const wrapped = wrapSlideHtml(createStarterSlideHtml({ id: SLIDE_ID }))
    expect(wrapped.startsWith('<!doctype html>')).toBe(true)
  })

  it('preserves the author bytes exactly — injection is an insert, never a re-serialization', () => {
    const original = createStarterSlideHtml({ id: SLIDE_ID, title: 'Q3', subtitle: '<b> & "x"' })
    const wrapped = wrapSlideHtml(original)
    const injected = wrapped.replace(/\n<meta http-equiv="Content-Security-Policy"[^>]*>/, '')
    expect(injected).toBe(original)
  })

  it('falls back to <html> when there is no head', () => {
    const wrapped = wrapSlideHtml('<!doctype html>\n<html lang="en"><body>hi</body></html>')
    expect(wrapped.indexOf('<meta')).toBeGreaterThan(wrapped.indexOf('<html lang="en">'))
    expect(wrapped.indexOf('<meta')).toBeLessThan(wrapped.indexOf('<body>'))
  })

  it('falls back to the doctype when there is no html tag', () => {
    const wrapped = wrapSlideHtml('<!DOCTYPE html>\n<body>hi</body>')
    expect(wrapped.startsWith('<!DOCTYPE html>')).toBe(true)
    expect(wrapped.indexOf('<meta')).toBeLessThan(wrapped.indexOf('<body>'))
  })

  it('prepends to a bare fragment', () => {
    expect(wrapSlideHtml('<p>hi</p>')).toBe(
      `<meta http-equiv="Content-Security-Policy" content="${SLIDE_CSP}">\n<p>hi</p>`,
    )
  })

  it('matches head and html case-insensitively, with attributes', () => {
    const wrapped = wrapSlideHtml('<HTML><HEAD data-x="1"><title>t</title></HEAD></HTML>')
    expect(wrapped.indexOf('<meta')).toBeGreaterThan(wrapped.indexOf('<HEAD data-x="1">'))
    expect(wrapped.indexOf('<meta')).toBeLessThan(wrapped.indexOf('<title>'))
  })

  // CSP composes by intersection: a second policy can only narrow the document further, so a
  // hostile slide shipping its own permissive meta cannot widen ours. Nothing is stripped —
  // rewriting author bytes is what Design Mode's byte-span patcher must never have to undo.
  it('leaves an author-supplied policy in place and adds ours ahead of it', () => {
    const hostile =
      '<html><head><meta http-equiv="Content-Security-Policy" content="default-src *">'
    const wrapped = wrapSlideHtml(hostile)
    expect(wrapped).toContain('content="default-src *"')
    expect(wrapped.indexOf(SLIDE_CSP)).toBeLessThan(wrapped.indexOf('default-src *'))
  })

  it('never emits a sandbox-defeating token', () => {
    expect(wrapSlideHtml(createStarterSlideHtml({ id: SLIDE_ID }))).not.toContain(
      'allow-same-origin',
    )
  })
})
