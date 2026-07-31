import { describe, expect, it } from 'vitest'
import { SLIDE_CSP, wrapSlideHtml } from '../../../src/renderer/src/features/canvas/wrapSlideHtml'
import { createStarterSlideHtml } from '../../../src/shared/document/starter-slide'

const SLIDE_ID = 's_01H8XQZ4P7K2M9NB3VYRTC6FDA'
const CSP_META = `<meta http-equiv="Content-Security-Policy" content="${SLIDE_CSP}">`

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

/**
 * The anchor must be a *tag*, never merely the text `<head>`.
 *
 * A `<head>` inside a comment, a script string or an attribute value captures a naive regex, and
 * the injected meta is then swallowed by whatever it landed inside — the policy vanishes with the
 * document still rendering perfectly and nothing logged. Under blob delivery this policy is the
 * only thing enforcing `connect-src 'none'`, so each of these is a silent exfiltration path.
 *
 * Every case asserts the meta is really *outside* the decoy and inside the real head.
 */
describe('wrapSlideHtml anchor is markup-aware', () => {
  function assertLivePolicy(wrapped: string): void {
    const meta = wrapped.indexOf(CSP_META)
    expect(meta).toBeGreaterThan(-1)
    // Not buried in a comment: no unclosed `<!--` may precede the meta.
    const commentOpen = wrapped.lastIndexOf('<!--', meta)
    if (commentOpen !== -1) {
      expect(wrapped.indexOf('-->', commentOpen)).toBeLessThan(meta)
    }
    // Not buried in a script.
    const scriptOpen = wrapped.lastIndexOf('<script', meta)
    if (scriptOpen !== -1) {
      expect(wrapped.indexOf('</script', scriptOpen)).toBeLessThan(meta)
    }
  }

  it('ignores a <head> hidden inside an HTML comment', () => {
    const wrapped = wrapSlideHtml(
      '<!doctype html>\n<html>\n<!-- <head> is below -->\n<head><title>t</title></head>\n<body>b</body></html>',
    )

    assertLivePolicy(wrapped)
    expect(wrapped.indexOf(CSP_META)).toBeGreaterThan(wrapped.indexOf('-->'))
    expect(wrapped.indexOf(CSP_META)).toBeLessThan(wrapped.indexOf('<title>'))
  })

  it('ignores a <head> inside a script string', () => {
    const wrapped = wrapSlideHtml(
      '<!doctype html>\n<html><script>var s = "<head>"</script>\n<head><title>t</title></head>',
    )

    assertLivePolicy(wrapped)
    expect(wrapped.indexOf(CSP_META)).toBeGreaterThan(wrapped.indexOf('</script>'))
    expect(wrapped.indexOf(CSP_META)).toBeLessThan(wrapped.indexOf('<title>'))
  })

  it('ignores a <head> inside a quoted attribute value', () => {
    const wrapped = wrapSlideHtml('<html data-note="<head> not really"><head><title>t</title>')

    assertLivePolicy(wrapped)
    // Strictly after the attribute value closes: landing inside it would parse the whole policy
    // as part of `data-note` and leave the document with no CSP at all.
    expect(wrapped.indexOf(CSP_META)).toBeGreaterThan(wrapped.indexOf('not really">'))
    expect(wrapped.indexOf(CSP_META)).toBeLessThan(wrapped.indexOf('<title>'))
  })

  it('ignores a <head> inside a style block', () => {
    const wrapped = wrapSlideHtml(
      '<!doctype html>\n<html><style>a[x="<head>"]{color:red}</style><head><title>t</title>',
    )

    assertLivePolicy(wrapped)
    expect(wrapped.indexOf(CSP_META)).toBeGreaterThan(wrapped.indexOf('</style>'))
  })

  it('anchors on an uppercase <HEAD> and on an attributed <head lang=…>', () => {
    for (const source of [
      '<!doctype html>\n<HTML><HEAD><TITLE>t</TITLE>',
      '<!doctype html>\n<html><head lang="en" data-x=\'a>b\'><title>t</title>',
    ]) {
      const wrapped = wrapSlideHtml(source)
      assertLivePolicy(wrapped)
      expect(wrapped.toLowerCase().indexOf(CSP_META.toLowerCase())).toBeLessThan(
        wrapped.toLowerCase().indexOf('<title>'),
      )
    }
  })

  it('never injects into the middle of an unterminated tag', () => {
    const wrapped = wrapSlideHtml('<!doctype html>\n<html lang="en"')
    assertLivePolicy(wrapped)
    // The tag runs to EOF, so the doctype is the only usable anchor.
    expect(wrapped.indexOf(CSP_META)).toBeLessThan(wrapped.indexOf('<html'))
  })

  it('falls back rather than injecting inside <body>', () => {
    const wrapped = wrapSlideHtml('<!doctype html>\n<html><body><p>no head here</p></body></html>')
    assertLivePolicy(wrapped)
    expect(wrapped.indexOf(CSP_META)).toBeLessThan(wrapped.indexOf('<body>'))
  })

  it('leaves an unterminated comment blinded to the end of the document', () => {
    const wrapped = wrapSlideHtml('<!doctype html>\n<html>\n<!-- <head> and no terminator')
    assertLivePolicy(wrapped)
    expect(wrapped.indexOf(CSP_META)).toBeLessThan(wrapped.indexOf('<!--'))
  })

  it('treats a bare `<` in text as text, not as a tag', () => {
    const wrapped = wrapSlideHtml('<!doctype html>\n<html><head><p>a < b</p>')
    assertLivePolicy(wrapped)
    expect(wrapped.indexOf(CSP_META)).toBeGreaterThan(wrapped.indexOf('<head>'))
  })
})
