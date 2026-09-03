/**
 * M3.11 — the pure core of direct text editing on canvas.
 *
 * The corpus for every escaping/neutralization test is derived from `FORBIDDEN_API_TOKENS` itself,
 * never hand-picked: the repo has shipped guards whose tests only ever fed them the input the guard
 * happened to handle. Iterating the exported list means adding a token to `slide-contract.ts` without
 * teaching `text-edit.ts` about it fails *here*, loudly.
 */

import { parse } from 'parse5'
import { describe, expect, it } from 'vitest'
import {
  FORBIDDEN_API_TOKENS,
  findForbiddenApiTokens,
  packForApiScan,
  validateSlideContract,
} from '../../../src/shared/document/slide-contract'
import { buildSlideMap } from '../../../src/shared/design/slide-map'
import { escapeText } from '../../../src/shared/design/patch'
import {
  buildTextEditPatch,
  escapeAndNeutralizeText,
  isTextEditable,
  LOCK_ATTR,
  MAX_TEXT_LENGTH,
  NON_EDITABLE_TAGS,
  sanitizeEditedText,
} from '../../../src/shared/design/text-edit'
import type { ElementSpan, SlideMap } from '../../../src/shared/design/types'

function mapOf(html: string): SlideMap {
  return buildSlideMap('s', html)
}

/** The first mapped element of a one-element fixture. */
function only(html: string): ElementSpan {
  const map = mapOf(html)
  return map.byId.get(map.order[0]!)!
}

/** The sl-id of the first element whose tag is `tag`. */
function idOf(map: SlideMap, tag: string): string {
  for (const id of map.order) if (map.byId.get(id)!.tagName === tag) return id
  throw new Error(`no <${tag}> in fixture`)
}

/**
 * The rendered text of the first `<${tag}>` in `html`, as a real HTML parser sees it — entities
 * decoded. This is what the user actually reads on the slide, so it is what round-trip claims are
 * asserted against.
 */
function renderedText(html: string, tag: string): string {
  const collected: string[] = []
  const walk = (node: unknown): void => {
    const record = node as { tagName?: string; childNodes?: unknown[] }
    if (record.tagName === tag) {
      const text = (child: unknown): void => {
        const c = child as { nodeName?: string; value?: string; childNodes?: unknown[] }
        if (c.nodeName === '#text') collected.push(c.value ?? '')
        for (const grand of c.childNodes ?? []) text(grand)
      }
      for (const child of record.childNodes ?? []) text(child)
      return
    }
    for (const child of record.childNodes ?? []) walk(child)
  }
  walk(parse(html))
  return collected.join('')
}

describe('isTextEditable', () => {
  it('accepts a plain text element', () => {
    expect(isTextEditable(only('<p>hello</p>'))).toBe(true)
  })

  it('accepts an empty element (vacuously textOnly) so an emptied heading can be retyped', () => {
    expect(isTextEditable(only('<h1></h1>'))).toBe(true)
  })

  it('rejects mixed inline content — plain-text replacement would delete the <b>', () => {
    const map = mapOf('<p>Revenue <b>18%</b> Q3</p>')
    expect(isTextEditable(map.byId.get(idOf(map, 'p'))!)).toBe(false)
  })

  it('rejects a void element', () => {
    expect(isTextEditable(only('<img src="x">'))).toBe(false)
  })

  it('rejects every non-character-data tag', () => {
    for (const tag of NON_EDITABLE_TAGS) {
      const map = mapOf(`<${tag}>x</${tag}>`)
      const element = map.byId.get(idOf(map, tag))
      // Some of these are dropped or relocated by the parser; when present they must be refused.
      if (element !== undefined) expect(isTextEditable(element), tag).toBe(false)
    }
  })

  it('rejects a data-sl-lock element — selectable but not mutable (30-slide-format §3.4)', () => {
    expect(isTextEditable(only(`<p ${LOCK_ATTR}>chrome</p>`))).toBe(false)
    expect(isTextEditable(only(`<p ${LOCK_ATTR}="">chrome</p>`))).toBe(false)
  })
})

describe('sanitizeEditedText', () => {
  it('normalizes CRLF and lone CR to newline', () => {
    expect(sanitizeEditedText('a\r\nb\rc')).toBe('a\nb\nc')
  })

  it('strips control characters but keeps tab and newline', () => {
    expect(sanitizeEditedText('a\u0000b\u0007c\u001Fd\u007Fe\u009Ff\u2028g\th\ni')).toBe(
      'abcdefg\th\ni',
    )
  })

  it('caps the length so a paste bomb cannot wedge the editor', () => {
    expect(sanitizeEditedText('x'.repeat(MAX_TEXT_LENGTH * 2))).toHaveLength(MAX_TEXT_LENGTH)
  })

  it('leaves non-ASCII alone', () => {
    expect(sanitizeEditedText('Café — naïve 日本語')).toBe('Café — naïve 日本語')
  })
})

describe('escapeAndNeutralizeText', () => {
  it('agrees with escapeText exactly on text containing no forbidden token', () => {
    const corpus = [
      '',
      'plain',
      'a & b',
      'a < b',
      '<div>',
      '</p>',
      'a ]]> b',
      '5 > 3',
      '&amp;',
      'Café — naïve',
      '<script>x</script>',
      'quote " and \' apostrophe',
    ]
    for (const text of corpus) {
      expect(escapeAndNeutralizeText(text), text).toBe(escapeText(text))
    }
  })

  it('escapes < so typed markup can never become markup', () => {
    expect(escapeAndNeutralizeText('<img onerror=alert>')).toBe('&lt;img onerror=alert>')
  })

  // The corpus IS the shared token list — a token added to slide-contract.ts is covered here for
  // free, and a neutralizer that stops handling one of them reds this test.
  it.each([...FORBIDDEN_API_TOKENS])('neutralizes the literal token %s', (token) => {
    const written = escapeAndNeutralizeText(`we call ${token} here`)
    expect(packForApiScan(written)).not.toContain(packForApiScan(token))
  })

  it.each([...FORBIDDEN_API_TOKENS])('neutralizes %s written with interior spaces', (token) => {
    // The scan packs whitespace out, so `f e t c h (` is `fetch(` to the validator.
    const spaced = [...token].join(' ')
    const written = escapeAndNeutralizeText(`we call ${spaced} here`)
    expect(packForApiScan(written)).not.toContain(packForApiScan(token))
  })

  it.each([...FORBIDDEN_API_TOKENS])('neutralizes %s written in upper case', (token) => {
    const written = escapeAndNeutralizeText(`WE CALL ${token.toUpperCase()} HERE`)
    expect(packForApiScan(written)).not.toContain(packForApiScan(token))
  })

  it.each([...FORBIDDEN_API_TOKENS])('preserves the rendered text of %s exactly', (token) => {
    const prose = `we call ${token} here`
    const html = `<p>${escapeAndNeutralizeText(prose)}</p>`
    // A real parser decodes the numeric references back to the characters the user typed.
    expect(renderedText(html, 'p')).toBe(prose)
  })
})

describe('buildTextEditPatch', () => {
  const fixture = '<div class="slide"><h1 id="t">Old</h1></div>'

  it('splices only the inner span, leaving every other byte identical', () => {
    const map = mapOf(fixture)
    const patched = buildTextEditPatch(map, idOf(map, 'h1'), 'New')
    expect(patched).toBe('<div class="slide"><h1 id="t">New</h1></div>')
  })

  it('preserves the author formatting, attributes and quoting around the edit', () => {
    const source = `<div class='slide'>\n  <!-- keep -->\n  <h1   id='t'  >Old</h1>\n</div>`
    const map = mapOf(source)
    const patched = buildTextEditPatch(map, idOf(map, 'h1'), 'New')!
    expect(patched).toContain(`<h1   id='t'  >New</h1>`)
    expect(patched).toContain('<!-- keep -->')
    expect(patched).toContain(`<div class='slide'>`)
  })

  it('returns null for an unchanged value so a no-op cannot consume an undo entry', () => {
    const map = mapOf(fixture)
    expect(buildTextEditPatch(map, idOf(map, 'h1'), 'Old')).toBeNull()
  })

  it('returns null for an sl-id the map does not know', () => {
    expect(buildTextEditPatch(mapOf(fixture), 's:999', 'New')).toBeNull()
  })

  it('returns null for a non-editable target even when the id is real', () => {
    const map = mapOf('<div class="slide"><p>a<b>c</b></p></div>')
    expect(buildTextEditPatch(map, idOf(map, 'p'), 'plain')).toBeNull()
  })

  it('returns null for a locked element', () => {
    const map = mapOf(`<div class="slide"><h1 ${LOCK_ATTR}>Old</h1></div>`)
    expect(buildTextEditPatch(map, idOf(map, 'h1'), 'New')).toBeNull()
  })

  it('round-trips typed markup as visible prose through edit -> save -> reopen', () => {
    const map = mapOf(fixture)
    const typed = 'use <div> & <span> for layout'
    const patched = buildTextEditPatch(map, idOf(map, 'h1'), typed)!
    expect(renderedText(patched, 'h1')).toBe(typed)

    // Reopen: re-parse the saved bytes, edit again with the same text, and the value is stable —
    // no double-escaping ratchet across sessions.
    const reopened = mapOf(patched)
    expect(buildTextEditPatch(reopened, idOf(reopened, 'h1'), typed)).toBeNull()
  })

  it('cannot inject an element: a typed <script> stays text', () => {
    const map = mapOf(fixture)
    const patched = buildTextEditPatch(map, idOf(map, 'h1'), '<script>alert(1)</script>')!
    expect(patched).not.toContain('<script')
    expect(renderedText(patched, 'script')).toBe('')
  })

  it.each([...FORBIDDEN_API_TOKENS])(
    'keeps the slide contract passing when %s is typed as prose',
    (token) => {
      const map = mapOf(fixture)
      const prose = `we call ${token} in prose`
      const patched = buildTextEditPatch(map, idOf(map, 'h1'), prose)
      expect(patched).not.toBeNull()
      expect(findForbiddenApiTokens(patched!)).toEqual([])
      expect(renderedText(patched!, 'h1')).toBe(prose)
      expect(
        validateSlideContract(patched!).issues.filter((issue) => issue.rule === 'SL-S04'),
      ).toEqual([])
    },
  )

  it('does not block editing a slide that already violated SL-S04 elsewhere', () => {
    // The guard is "must not get worse", not "must be clean" — otherwise an imported slide with a
    // pre-existing violation would be permanently uneditable.
    const dirty = '<div class="slide"><h1>Old</h1><p>localStorage</p></div>'
    const map = mapOf(dirty)
    const patched = buildTextEditPatch(map, idOf(map, 'h1'), 'New')
    expect(patched).not.toBeNull()
    expect(findForbiddenApiTokens(patched!)).toEqual(['localStorage'])
  })

  it('keeps every data-sl-id stable across an edit', () => {
    const source = '<div class="slide"><h1>A</h1><p>B</p><span>C</span></div>'
    const map = mapOf(source)
    const patched = buildTextEditPatch(map, idOf(map, 'h1'), 'Changed')!
    const after = mapOf(patched)
    expect([...after.order]).toEqual([...map.order])
    for (const id of map.order) {
      expect(after.byId.get(id)!.tagName, id).toBe(map.byId.get(id)!.tagName)
    }
  })

  it('strips control characters on the way into source', () => {
    const map = mapOf(fixture)
    const patched = buildTextEditPatch(map, idOf(map, 'h1'), 'a\u0000\u0007b')!
    expect(patched).toContain('<h1 id="t">ab</h1>')
  })
})
