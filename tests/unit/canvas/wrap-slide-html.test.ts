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
 * document still rendering perfectly and nothing logged. Today the host policy the frame inherits
 * still denies the fetch that would need (see `useSlideUrl`), but `slide://` delivery removes that
 * net and makes this policy the only thing enforcing `connect-src 'none'` — at which point each of
 * these is a silent exfiltration path.
 *
 * Every case asserts the meta is really *outside* the decoy and inside the real head. Placement in
 * the *parsed tree* — the half a string assertion cannot see — is measured against Chromium by
 * `experiments/init/harness/csp-meta-placement.mjs`.
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

  // The tokenizer has several states in which `<head>` is character data rather than a tag. Each
  // of these anchors the meta into a text node, where the policy is inert — the same silent
  // failure class as the comment case, reached with adversarial rather than ordinary input.
  it('ignores a <head> inside RCDATA (<title>)', () => {
    const wrapped = wrapSlideHtml('<!doctype html>\n<html><title>a<head>b</title>')

    assertLivePolicy(wrapped)
    // Anchored at the <html> fallback, before the decoy — not between `a` and `b`.
    expect(wrapped.indexOf(CSP_META)).toBeLessThan(wrapped.indexOf('<title>'))
  })

  it('ignores a <head> inside RCDATA (<textarea>)', () => {
    const wrapped = wrapSlideHtml('<!doctype html>\n<html><textarea><head></textarea>')

    assertLivePolicy(wrapped)
    expect(wrapped.indexOf(CSP_META)).toBeLessThan(wrapped.indexOf('<textarea>'))
  })

  // Slide frames are `allow-scripts`, i.e. scripting-enabled, so <noscript> content is raw text.
  it('ignores a <head> inside <noscript>', () => {
    const wrapped = wrapSlideHtml('<!doctype html>\n<html><noscript><head></noscript>')

    assertLivePolicy(wrapped)
    expect(wrapped.indexOf(CSP_META)).toBeLessThan(wrapped.indexOf('<noscript>'))
  })

  // Inside a script, `<!--` followed by `<script` enters the double-escaped state, where the next
  // `</script>` does NOT close the element — so the `<head>` after it is still script text.
  it('ignores a <head> after a script-data-double-escaped false close', () => {
    const wrapped = wrapSlideHtml(
      '<!doctype html>\n<html><script>/*<!--<script>*/</script><head><title>t</title>',
    )

    assertLivePolicy(wrapped)
    expect(wrapped.indexOf(CSP_META)).toBeLessThan(wrapped.indexOf('<script>'))
  })

  // Fail-safe, not fail-open: `<!-->` is a complete comment, and mishandling it used to blind the
  // walk to EOF and skip a perfectly good <head>.
  it('handles the abrupt-closing comment forms and still finds the real head', () => {
    for (const abrupt of ['<!-->', '<!--->']) {
      const wrapped = wrapSlideHtml(`<!doctype html>\n<html>${abrupt}<head><title>t</title>`)

      assertLivePolicy(wrapped)
      expect(wrapped.indexOf(CSP_META)).toBeGreaterThan(wrapped.indexOf('<head>'))
      expect(wrapped.indexOf(CSP_META)).toBeLessThan(wrapped.indexOf('<title>'))
    }
  })

  /**
   * A `<head>` *tag* is not enough — the tree builder has to keep it. Non-whitespace text or a
   * non-head start tag closes the implied head and opens the body, and the `<head>` token after
   * that is discarded. A meta injected there is a child of `<body>`, where CSP pragma processing
   * drops the policy outright (verified in Chromium: `--dump-dom` shows an empty `<head>`, and
   * under `script-src 'none'` the inline script runs). The fallback placement is what saves it.
   *
   * See `experiments/init/harness/csp-meta-placement.mjs`.
   */
  it.each([
    ['text', '<!doctype html>\n<html>hello<head><title>t</title>'],
    ['a <div>', '<!doctype html>\n<html><div></div><head><title>t</title>'],
    ['a <p> with text', '<!doctype html>\n<html><p>x<head><title>t</title>'],
  ])('ignores a <head> that %s has already pushed into the body', (_label, source) => {
    const wrapped = wrapSlideHtml(source)

    assertLivePolicy(wrapped)
    // Anchored at the <html> fallback — before the body-implying content, where the parser is
    // still in "before head" and hoists the meta into the implied head.
    expect(wrapped.indexOf(CSP_META)).toBeLessThan(wrapped.indexOf('<head>'))
    expect(wrapped.indexOf(CSP_META)).toBeGreaterThan(wrapped.indexOf('<html>'))
  })

  // Negative control: `<style>` IS head content, so the implied head is still open and the literal
  // `<head>` after it remains a valid anchor. The implied-body rule must not overreach.
  it('still anchors on a <head> preceded only by head content', () => {
    const wrapped = wrapSlideHtml(
      '<!doctype html>\n<html><style>.a{}</style><head><title>t</title>',
    )

    assertLivePolicy(wrapped)
    expect(wrapped.indexOf(CSP_META)).toBeGreaterThan(wrapped.indexOf('<head>'))
    expect(wrapped.indexOf(CSP_META)).toBeLessThan(wrapped.indexOf('<title>'))
  })

  it('is not tripped by whitespace before the head', () => {
    const wrapped = wrapSlideHtml('<!doctype html>\n<html>\n\t  \n<head><title>t</title>')

    assertLivePolicy(wrapped)
    expect(wrapped.indexOf(CSP_META)).toBeGreaterThan(wrapped.indexOf('<head>'))
  })

  it('treats a bare `<` in text as text, not as a tag', () => {
    const wrapped = wrapSlideHtml('<!doctype html>\n<html><head><p>a < b</p>')
    assertLivePolicy(wrapped)
    expect(wrapped.indexOf(CSP_META)).toBeGreaterThan(wrapped.indexOf('<head>'))
  })
})
