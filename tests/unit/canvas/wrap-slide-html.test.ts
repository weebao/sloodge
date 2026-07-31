import { describe, expect, it } from 'vitest'
import {
  cspInjectionOffset,
  SLIDE_BLOCKED_SOCKET_APIS,
  SLIDE_CSP,
  SLIDE_CSP_INJECTION,
  SLIDE_RUNTIME_GUARD,
  wrapSlideHtml,
} from '../../../src/renderer/src/features/canvas/wrapSlideHtml'
import { createStarterSlideHtml } from '../../../src/shared/document/starter-slide'

const SLIDE_ID = 's_01H8XQZ4P7K2M9NB3VYRTC6FDA'
const CSP_META = `<meta http-equiv="Content-Security-Policy" content="${SLIDE_CSP}">`
const BOM = '﻿'

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

  it('never emits a sandbox-defeating token', () => {
    expect(wrapSlideHtml(createStarterSlideHtml({ id: SLIDE_ID }))).not.toContain(
      'allow-same-origin',
    )
  })
})

/**
 * The socket-API guard. No CSP directive governs WebRTC, so `connect-src 'none'` does not stop a
 * running slide from reaching an arbitrary host through `RTCPeerConnection` — measured, real STUN
 * packets left a `slide://` slide. The guard neutralizes the constructors before author script runs.
 * That behaviour is proven end-to-end in Chromium by the smoke harness (probe 7); these pin the
 * static shape so the guard cannot be quietly gutted, and the browser evaluates the emitted script
 * so the string is at least syntactically live.
 */
describe('SLIDE_RUNTIME_GUARD', () => {
  it('injects a bootstrap that neutralizes every socket API CSP cannot reach', () => {
    for (const api of SLIDE_BLOCKED_SOCKET_APIS) {
      expect(SLIDE_RUNTIME_GUARD).toContain(api)
    }
    // WebRTC is the confirmed channel; WebTransport is the belt-and-braces sibling.
    expect(SLIDE_BLOCKED_SOCKET_APIS).toContain('RTCPeerConnection')
    expect(SLIDE_BLOCKED_SOCKET_APIS).toContain('WebTransport')
  })

  it('is part of the injection and runs after the policy that permits it', () => {
    const wrapped = wrapSlideHtml(createStarterSlideHtml({ id: SLIDE_ID }))
    const meta = wrapped.indexOf('http-equiv="Content-Security-Policy"')
    const guard = wrapped.indexOf('RTCPeerConnection')

    expect(guard).toBeGreaterThan(-1)
    // The meta declares `script-src 'unsafe-inline'`; it must precede the inline guard it authorizes.
    expect(meta).toBeGreaterThan(-1)
    expect(meta).toBeLessThan(guard)
  })

  it('actually removes the constructors when evaluated', () => {
    // Execute the guard's IIFE against a fake global and confirm the properties become undefined and
    // non-configurable — the string is otherwise untested logic shipped into every slide.
    const script = SLIDE_RUNTIME_GUARD.replace(/^<script>/, '').replace(/<\/script>$/, '')
    const win: Record<string, unknown> = {
      RTCPeerConnection: function () {},
      WebTransport: function () {},
    }
    new Function('window', 'Object', script)(win, Object)

    expect(win['RTCPeerConnection']).toBeUndefined()
    expect(win['WebTransport']).toBeUndefined()
    const descriptor = Object.getOwnPropertyDescriptor(win, 'RTCPeerConnection')
    expect(descriptor?.configurable).toBe(false)
    expect(descriptor?.writable).toBe(false)
  })

  it('the emitted guard is one <script> with no closing-tag break-out', () => {
    // A stray `</script>` in the payload would end the tag early and dump the rest as text.
    expect(SLIDE_RUNTIME_GUARD.startsWith('<script>')).toBe(true)
    expect(SLIDE_RUNTIME_GUARD.endsWith('</script>')).toBe(true)
    expect(SLIDE_RUNTIME_GUARD.slice(8, -9)).not.toContain('</script')
  })
})

/**
 * The contract is a constant-length prefix insertion at a computed offset. These are the properties
 * every caller depends on — most of all Design Mode, whose byte spans into the file map into the
 * rendered document by adding exactly one constant.
 */
describe('wrapSlideHtml is a pure insertion', () => {
  const SOURCES = [
    createStarterSlideHtml({ id: SLIDE_ID, title: 'Q3', subtitle: '<b> & "x"' }),
    '<!doctype html>\n<html><head><title>t</title></head><body>b</body></html>',
    '<html>no doctype</html>',
    '<p>fragment</p>',
    '',
    `${BOM}<!doctype html><html>`,
    '<!-- leading comment --><!doctype html><html>',
  ]

  it.each(SOURCES.map((source, index) => [index, source] as const))(
    'leaves every author byte intact (%i)',
    (_index, source) => {
      const at = cspInjectionOffset(source)
      const wrapped = wrapSlideHtml(source)

      // Byte identity, stated three ways: the prefix, the suffix, and removing the injection.
      expect(wrapped.slice(0, at)).toBe(source.slice(0, at))
      expect(wrapped.slice(at + SLIDE_CSP_INJECTION.length)).toBe(source.slice(at))
      expect(wrapped.replace(SLIDE_CSP_INJECTION, '')).toBe(source)
      expect(wrapped).toHaveLength(source.length + SLIDE_CSP_INJECTION.length)
    },
  )

  it.each(SOURCES.map((source, index) => [index, source] as const))(
    'shifts trailing author offsets by exactly one constant (%i)',
    (_index, source) => {
      const at = cspInjectionOffset(source)
      const wrapped = wrapSlideHtml(source)

      for (let offset = at; offset < source.length; offset += 1) {
        expect(wrapped[offset + SLIDE_CSP_INJECTION.length]).toBe(source[offset])
      }
    },
  )

  it('injects the policy exactly once', () => {
    const wrapped = wrapSlideHtml(createStarterSlideHtml({ id: SLIDE_ID }))
    expect(wrapped.split('http-equiv="Content-Security-Policy"')).toHaveLength(2)
  })

  // Policies compose by intersection, so an author's own meta can only narrow their document
  // further. Nothing is stripped — rewriting author bytes is what the contract above forbids.
  it('leaves an author-supplied policy in place and adds ours ahead of it', () => {
    const hostile =
      '<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src *">'
    const wrapped = wrapSlideHtml(hostile)

    expect(wrapped).toContain('content="default-src *"')
    expect(wrapped.indexOf(SLIDE_CSP)).toBeLessThan(wrapped.indexOf('default-src *'))
  })
})

/**
 * The injection point. Only two things can go wrong: displacing the doctype (which drops the
 * document into quirks mode, where the slide's box model no longer matches the 1280x720 the format
 * contract measured), and landing after author markup (where the policy would not govern it).
 *
 * That the resulting meta really is a child of `<head>` and really is enforced is not a string
 * property and is not asserted here — it is measured against Chromium for all 22 corpus inputs by
 * `experiments/init/harness/csp-meta-placement.mjs`.
 */
describe('cspInjectionOffset', () => {
  it('lands immediately after the doctype, before all author markup', () => {
    const wrapped = wrapSlideHtml(createStarterSlideHtml({ id: SLIDE_ID, title: 'Q3' }))

    expect(wrapped.startsWith('<!doctype html>')).toBe(true)
    const meta = wrapped.indexOf(CSP_META)
    expect(meta).toBeGreaterThan(-1)
    for (const authorMarkup of ['<html', '<head', '<title>', '<style>', '<body>']) {
      expect(meta).toBeLessThan(wrapped.indexOf(authorMarkup))
    }
  })

  it('matches the doctype case-insensitively and with legacy identifiers', () => {
    for (const doctype of [
      '<!DOCTYPE html>',
      '<!DocType HTML>',
      '<!DOCTYPE html SYSTEM "about:legacy-compat">',
    ]) {
      const wrapped = wrapSlideHtml(`${doctype}<html><head>`)
      expect(wrapped.startsWith(`${doctype}\n`)).toBe(true)
      expect(wrapped.indexOf(CSP_META)).toBe(doctype.length + 1)
    }
  })

  /**
   * Everything HTML's "initial" insertion mode allows before a doctype has to be stepped over, or
   * the meta lands ahead of the doctype and the document silently becomes quirks — where the box
   * model stops matching the 1280x720 the format contract measured.
   *
   * This table is the closed set from the module docstring, case for case: whitespace, comments
   * (including both abrupt forms), and the three source forms the tokenizer reconsumes as bogus
   * comments or discards entirely — `<!foo>`, `<?…>`, `</` + non-alpha, and `</>`. If a form is
   * added to the scan it belongs here; if one is missing here the scan is not provably complete.
   */
  it.each([
    ['leading whitespace', '\n\t  <!doctype html><html>'],
    ['a comment', '<!-- hello --><!doctype html><html>'],
    ['several comments and whitespace', '<!--a-->\n<!--b--> <!doctype html><html>'],
    ['an abrupt comment', '<!--><!doctype html><html>'],
    ['the other abrupt comment', '<!---><!doctype html><html>'],
    ['a bogus declaration', '<!foo><!doctype html><html>'],
    // `?` in tag-open is a parse error reconsumed as a bogus comment, so an XML declaration is a
    // comment in HTML — not a processing instruction, and not something that leaves "initial".
    ['an XML declaration', '<?xml version="1.0" encoding="utf-8"?><!doctype html><html>'],
    ['a processing instruction', '<?php echo 1; ?><!doctype html><html>'],
    // `</` + a non-alpha is invalid-first-character-of-tag-name: also a bogus comment.
    ['a bogus end tag with a space', '</ x><!doctype html><html>'],
    ['a bogus end tag with a digit', '</1><!doctype html><html>'],
    // `</>` is missing-end-tag-name: it emits no token at all.
    ['an empty end tag', '</><!doctype html><html>'],
    // HTML closes a comment on `--!>` as well as `-->` (the comment-end-bang state).
    ['a comment closed with --!>', '<!-- c --!><!doctype html><html>'],
    ['a comment closed with --!> among others', '<!--a--><!-- b --!> <!doctype html><html>'],
    // All five HTML whitespace characters, and only these five.
    ['every HTML whitespace character', '\t\n\f\r <!doctype html><html>'],
  ])('steps over %s to keep the doctype first', (_label, source) => {
    const wrapped = wrapSlideHtml(source)

    const doctypeEnd = wrapped.indexOf('<!doctype html>') + '<!doctype html>'.length
    expect(wrapped.indexOf(CSP_META)).toBe(doctypeEnd + 1)
  })

  it('keeps a byte-order mark first', () => {
    expect(wrapSlideHtml(`${BOM}<!doctype html><html>`).startsWith(BOM)).toBe(true)
    // With no doctype the injection still goes after the BOM, never before it.
    expect(cspInjectionOffset(`${BOM}<html>`)).toBe(1)
    expect(wrapSlideHtml(`${BOM}<html>`).startsWith(BOM)).toBe(true)
  })

  it('injects at the front when there is no doctype', () => {
    expect(cspInjectionOffset('<html><head>')).toBe(0)
    expect(cspInjectionOffset('')).toBe(0)
    expect(cspInjectionOffset('<p>fragment</p>')).toBe(0)
  })

  // A doctype only counts in the prologue. After author markup the parser discards it as a parse
  // error and the document is already quirks, so injecting after it would gain nothing and would
  // put the policy behind author content.
  it('ignores a doctype that appears after author markup', () => {
    expect(cspInjectionOffset('<html><!doctype html>')).toBe(0)
    expect(cspInjectionOffset('text<!doctype html>')).toBe(0)
  })

  it('does not run past an unterminated comment or declaration', () => {
    expect(cspInjectionOffset('<!-- unterminated <!doctype html>')).toBe(0)
    expect(cspInjectionOffset('<!unterminated')).toBe(0)
    expect(cspInjectionOffset('<?unterminated')).toBe(0)
  })

  // The boundary of form 5: `</` + ASCII alpha is a *real* end tag, which takes the parser out of
  // "initial" — so the document is already quirks and a later doctype is discarded. And `</` at EOF
  // is emitted as character data, not as a bogus comment. Both must stop the scan.
  it('stops at a real end tag or a bare `</` at EOF', () => {
    expect(cspInjectionOffset('</p><!doctype html>')).toBe(0)
    expect(cspInjectionOffset('</')).toBe(0)
  })

  /**
   * The boundary of form 1, and the sharpest one in the file.
   *
   * These characters are matched by JavaScript's `\s` but are *not* HTML whitespace: the tokenizer
   * emits each as an ordinary character token, which takes the parser out of "initial" and makes
   * the doctype after it a discarded parse error. Stepping over them would inject past a doctype
   * that no longer exists — the meta lands in `<body>` and the whole policy is dropped, which
   * Chromium confirmed for U+00A0. Injecting in *front* of them is the correct answer.
   */
  it.each([
    ['U+00A0 NO-BREAK SPACE', ' '],
    ['U+000B VERTICAL TAB', ''],
    ['U+3000 IDEOGRAPHIC SPACE', '　'],
    ['U+2028 LINE SEPARATOR', ' '],
    ['U+FEFF as a second BOM', `${BOM}﻿`],
    // Negative control: U+0085 is not in JS `\s` either, so it stopped the scan even before the
    // fix. It is here so the test states the rule, not just the characters that used to slip.
    ['U+0085 NEXT LINE', ''],
  ])('does not treat %s as whitespace', (_label, prefix) => {
    const source = `${prefix}<!doctype html><html>`

    // In front of the character, never after the (discarded) doctype.
    expect(cspInjectionOffset(source)).toBe(prefix.startsWith(BOM) ? 1 : 0)
    expect(wrapSlideHtml(source).indexOf(CSP_META)).toBeLessThan(
      wrapSlideHtml(source).indexOf('<!doctype'),
    )
  })
})
