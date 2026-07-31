import { describe, expect, it } from 'vitest'
import {
  cspInjectionOffset,
  SLIDE_CSP,
  SLIDE_CSP_INJECTION,
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
})
