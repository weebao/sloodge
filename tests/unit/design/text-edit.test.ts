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
  resolveTextEdit,
  escapeAndNeutralizeText,
  isTextEditable,
  LOCK_ATTR,
  MAX_TEXT_LENGTH,
  NON_EDITABLE_TAGS,
  sanitizeEditedText,
} from '../../../src/shared/design/text-edit'
import type { ElementSpan, SlideMap } from '../../../src/shared/design/types'
import { CORPUS } from './corpus'

function mapOf(html: string): SlideMap {
  return buildSlideMap('s', html)
}

/**
 * The bytes `resolveTextEdit` would write, or `null` for every outcome that writes nothing. Most of
 * these tests only care whether an edit lands and what it lands as; the ones that care *why* it did
 * not — the round-4 refusal reasons — call `resolveTextEdit` directly.
 */
function patchOf(map: SlideMap, slId: string, rawText: string): string | null {
  const outcome = resolveTextEdit(map, slId, rawText)
  return outcome.kind === 'patched' ? outcome.source : null
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

  it.each([...NON_EDITABLE_TAGS])('rejects <%s> wherever the parser keeps it', (tag) => {
    // Table-model tags only exist inside a table, so each tag is tried in the contexts that let the
    // parser keep it; whitespace content is what makes a table or list text-only at all.
    const contexts = [
      `<${tag}> x </${tag}>`,
      `<table><${tag}> </${tag}></table>`,
      `<table><tbody><${tag}> </${tag}></tbody></table>`,
      `<${tag}> </${tag}>`,
    ]
    const found = contexts
      .map((html) => mapOf(html))
      .flatMap((map) => map.order.map((id) => map.byId.get(id)!))
      .filter((element) => element.tagName === tag)
    expect(found.length, `no context keeps <${tag}>`).toBeGreaterThan(0)
    for (const element of found) expect(isTextEditable(element)).toBe(false)
  })

  it('rejects an element the adoption agency rendered as two nodes — the caret has no one home', () => {
    // One source <b>, two <b> nodes in the DOM with different text ("x" and "y"), both carrying the
    // same data-sl-id. The frame can only open a caret in one of them.
    const map = mapOf('<div><p><b>x</p><p>y</b></p></div>')
    const bold = map.byId.get(idOf(map, 'b'))!
    expect(bold.textOnly).toBe(true)
    expect(bold.minDomNodeCount).toBe(2)
    expect(isTextEditable(bold)).toBe(false)
    expect(patchOf(map, bold.slId, 'z')).toBeNull()
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

  it('does not truncate — the cap is a refusal at commit, not a normalization', () => {
    // Truncating here was the round-3 major: the same cut value went in on both sides of the
    // "did it change?" comparison *and* into the source, deleting the tail of an over-cap element.
    expect(sanitizeEditedText('x'.repeat(MAX_TEXT_LENGTH * 2))).toHaveLength(MAX_TEXT_LENGTH * 2)
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

  // The validator strips ALL whitespace, including the one inside `new Function(`: `newFunction(`
  // is a violation to it, so the neutralizer must see it too. Building the matcher from the raw
  // token instead of `packForApiScan(token)` makes that space a required literal and reds this.
  it.each([...FORBIDDEN_API_TOKENS])('neutralizes %s with every whitespace removed', (token) => {
    const written = escapeAndNeutralizeText(`we call ${packForApiScan(token)} here`)
    expect(packForApiScan(written)).not.toContain(packForApiScan(token))
  })

  it.each([...FORBIDDEN_API_TOKENS])('neutralizes %s in mixed case', (token) => {
    const mixed = [...token].map((c, i) => (i % 2 ? c.toUpperCase() : c.toLowerCase())).join('')
    const written = escapeAndNeutralizeText(`we call ${mixed} here`)
    expect(packForApiScan(written)).not.toContain(packForApiScan(token))
    expect(renderedText(`<p>${written}</p>`, 'p')).toBe(`we call ${mixed} here`)
  })

  it('an honest sentence using the whitespace-free spelling is written, not refused', () => {
    const map = mapOf('<div class="slide"><h1>Old</h1></div>')
    const prose = 'avoid newFunction( in modern JS'
    const patched = patchOf(map, idOf(map, 'h1'), prose)
    expect(patched).not.toBeNull()
    expect(findForbiddenApiTokens(patched!)).toEqual([])
    expect(renderedText(patched!, 'h1')).toBe(prose)
  })

  it.each([...FORBIDDEN_API_TOKENS])('preserves the rendered text of %s exactly', (token) => {
    const prose = `we call ${token} here`
    const html = `<p>${escapeAndNeutralizeText(prose)}</p>`
    // A real parser decodes the numeric references back to the characters the user typed.
    expect(renderedText(html, 'p')).toBe(prose)
  })
})

describe('resolveTextEdit', () => {
  const fixture = '<div class="slide"><h1 id="t">Old</h1></div>'

  it('splices only the inner span, leaving every other byte identical', () => {
    const map = mapOf(fixture)
    const patched = patchOf(map, idOf(map, 'h1'), 'New')
    expect(patched).toBe('<div class="slide"><h1 id="t">New</h1></div>')
  })

  it('preserves the author formatting, attributes and quoting around the edit', () => {
    const source = `<div class='slide'>\n  <!-- keep -->\n  <h1   id='t'  >Old</h1>\n</div>`
    const map = mapOf(source)
    const patched = patchOf(map, idOf(map, 'h1'), 'New')!
    expect(patched).toContain(`<h1   id='t'  >New</h1>`)
    expect(patched).toContain('<!-- keep -->')
    expect(patched).toContain(`<div class='slide'>`)
  })

  it('returns null for an unchanged value so a no-op cannot consume an undo entry', () => {
    const map = mapOf(fixture)
    expect(patchOf(map, idOf(map, 'h1'), 'Old')).toBeNull()
  })

  it('returns null for an sl-id the map does not know', () => {
    expect(patchOf(mapOf(fixture), 's:999', 'New')).toBeNull()
  })

  it('returns null for a non-editable target even when the id is real', () => {
    const map = mapOf('<div class="slide"><p>a<b>c</b></p></div>')
    expect(patchOf(map, idOf(map, 'p'), 'plain')).toBeNull()
  })

  it('returns null for a locked element', () => {
    const map = mapOf(`<div class="slide"><h1 ${LOCK_ATTR}>Old</h1></div>`)
    expect(patchOf(map, idOf(map, 'h1'), 'New')).toBeNull()
  })

  it('round-trips typed markup as visible prose through edit -> save -> reopen', () => {
    const map = mapOf(fixture)
    const typed = 'use <div> & <span> for layout'
    const patched = patchOf(map, idOf(map, 'h1'), typed)!
    expect(renderedText(patched, 'h1')).toBe(typed)

    // Reopen: re-parse the saved bytes, edit again with the same text, and the value is stable —
    // no double-escaping ratchet across sessions.
    const reopened = mapOf(patched)
    expect(patchOf(reopened, idOf(reopened, 'h1'), typed)).toBeNull()
  })

  it('cannot inject an element: a typed <script> stays text', () => {
    const map = mapOf(fixture)
    const patched = patchOf(map, idOf(map, 'h1'), '<script>alert(1)</script>')!
    expect(patched).not.toContain('<script')
    expect(renderedText(patched, 'script')).toBe('')
  })

  it.each([...FORBIDDEN_API_TOKENS])(
    'keeps the slide contract passing when %s is typed as prose',
    (token) => {
      const map = mapOf(fixture)
      const prose = `we call ${token} in prose`
      const patched = patchOf(map, idOf(map, 'h1'), prose)
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
    const patched = patchOf(map, idOf(map, 'h1'), 'New')
    expect(patched).not.toBeNull()
    expect(findForbiddenApiTokens(patched!)).toEqual(['localStorage'])
  })

  it('keeps every data-sl-id stable across an edit', () => {
    const source = '<div class="slide"><h1>A</h1><p>B</p><span>C</span></div>'
    const map = mapOf(source)
    const patched = patchOf(map, idOf(map, 'h1'), 'Changed')!
    const after = mapOf(patched)
    expect([...after.order]).toEqual([...map.order])
    for (const id of map.order) {
      expect(after.byId.get(id)!.tagName, id).toBe(map.byId.get(id)!.tagName)
    }
  })

  it('strips control characters on the way into source', () => {
    const map = mapOf(fixture)
    const patched = patchOf(map, idOf(map, 'h1'), 'a\u0000\u0007b')!
    expect(patched).toContain('<h1 id="t">ab</h1>')
  })
})

/**
 * Round-1 review fixes. Blocker: on an adoption-agency mis-nested slide the mapped (original)
 * formatting element had zero tree children while its `inner` bytes held markup, so `textOnly` was
 * vacuously true and a text edit spliced over the markup — deleting a `<p>` and shifting every later
 * `data-sl-id`. Major: the no-op check compared bytes, so an untouched `&nbsp;` heading pushed a
 * phantom undo entry on every Esc. Minors: the Kelvin sign defeated the neutralizer's case fold,
 * table/list containers and the RAWTEXT `noembed`/`noframes` were editable, and lone surrogates
 * reached the source.
 *
 * Every invisible or control character below is written as an escape on purpose — a raw one in a
 * test file is the same diff hazard the code under test refuses to write.
 */

const MIS_NESTED = [
  // The original <b> ends up with no children; its inner is `<p>x`.
  ['formatting element wrapping a block', '<div><b><p>x</b>y</p></div>', 'b'],
  // Contract-valid slide shape from the review.
  ['inline wrapping a classed div', '<div><em><div class="note">x</em> more</div></div>', 'em'],
  // One text child covering `x`, but the inner continues into `<p>y`.
  ['text then a block inside the formatting element', '<div><b>x<p>y</b>z</p></div>', 'b'],
] as const

describe('resolveTextEdit — mis-nested source is refused, never patched', () => {
  it.each([...MIS_NESTED])('%s: not text-only, not editable, no patch', (_label, html, tag) => {
    const map = mapOf(html)
    const element = map.byId.get(idOf(map, tag))!
    expect(element.textOnly).toBe(false)
    expect(element.textContent).toBeNull()
    expect(isTextEditable(element)).toBe(false)
    expect(patchOf(map, element.slId, 'hello')).toBeNull()
    // A forged SL_EDIT naming the shared id with an empty text is refused the same way.
    expect(patchOf(map, element.slId, '')).toBeNull()
  })

  it('keeps a well-formed inline element inside mis-nested siblings editable', () => {
    // The <em> is not a clone and its text covers its inner exactly: still a text box.
    const html = '<div><p><strong>Q3 <em>revenue</em></p><p>rose</strong></p></div>'
    const map = mapOf(html)
    expect(patchOf(map, idOf(map, 'em'), 'sales')).toBe(
      '<div><p><strong>Q3 <em>sales</em></p><p>rose</strong></p></div>',
    )
  })

  /**
   * The invariant behind the blocker, over the whole adversarial corpus: for every element an edit is
   * *accepted* on, the map rebuilt from the patched source has the same ids, in the same order, with
   * the same tags and paths — and the patched element's decoded text is exactly what was typed.
   */
  it.each(CORPUS.map((entry) => [entry.name, entry.html] as const))(
    'id-stability: every accepted edit in "%s" keeps the id set, order and paths',
    (_name, html) => {
      const map = mapOf(html)
      for (const id of map.order) {
        const patched = patchOf(map, id, 'edited <text> & more')
        if (patched === null) continue
        const after = mapOf(patched)
        expect([...after.order], id).toEqual([...map.order])
        for (const other of map.order) {
          expect(after.byId.get(other)!.tagName, other).toBe(map.byId.get(other)!.tagName)
          expect(after.byId.get(other)!.path, other).toEqual(map.byId.get(other)!.path)
        }
        expect(after.byId.get(id)!.textContent).toBe('edited <text> & more')
      }
    },
  )

  it('the corpus exercises the invariant: most entries accept at least one edit', () => {
    const accepting = CORPUS.filter((entry) => {
      const map = mapOf(entry.html)
      return map.order.some((id) => patchOf(map, id, 'edited') !== null)
    })
    expect(accepting.length).toBeGreaterThan(CORPUS.length / 2)
  })
})

describe('textOnly coverage rule — the shapes around the blocker', () => {
  it('a stray ignored end tag inside text is still one text node covering the inner', () => {
    // parse5 ignores `</b>` and merges the characters around it; nothing addressable is lost.
    const map = mapOf('<div><p>a</b>b</p></div>')
    const p = map.byId.get(idOf(map, 'p'))!
    expect(p.textOnly).toBe(true)
    expect(p.textContent).toBe('ab')
    expect(patchOf(map, p.slId, 'ab')).toBeNull()
    expect(patchOf(map, p.slId, 'abc')).toBe('<div><p>abc</p></div>')
  })

  it('a <pre> whose leading newline the parser drops stays text-only', () => {
    const map = mapOf('<div><pre>\nline</pre></div>')
    const pre = map.byId.get(idOf(map, 'pre'))!
    expect(pre.textOnly).toBe(true)
    expect(pre.textContent).toBe('line')
    expect(patchOf(map, pre.slId, 'line')).toBeNull()
    expect(patchOf(map, pre.slId, 'code')).toBe('<div><pre>code</pre></div>')
  })
})

/**
 * Round-3 major 1: the parser's dropped `<pre>` newline and the writer's `inner` splice have to be
 * inverses. Every case asserts the *rendered* text after a re-parse, not the bytes — the bytes are
 * only interesting in that they must survive a round trip.
 */
describe('resolveTextEdit — the <pre> leading newline round-trips (round-3 major)', () => {
  it('keeps a blank first line that an unrelated edit did not touch', () => {
    const source = '<div><pre>\n\nHello</pre></div>'
    const map = mapOf(source)
    const pre = map.byId.get(idOf(map, 'pre'))!
    expect(pre.textContent).toBe('\nHello')

    const patched = patchOf(map, pre.slId, '\nHello!')!
    expect(patched).not.toBeNull()
    // The blank line is still there after the edit — this is the assertion that reds without the
    // compensating newline (it read back 'Hello!', one line short).
    expect(renderedText(patched, 'pre')).toBe('\nHello!')
    expect(mapOf(patched).byId.get(idOf(mapOf(patched), 'pre'))!.textContent).toBe('\nHello!')
  })

  it('a committed leading newline is a real change, not a byte-identical no-op', () => {
    // Source reads as 'Hello' (its one newline is the dropped one); committing '\nHello' must add a
    // blank line, and must not return `map.source` unchanged while claiming an edit happened.
    const source = '<div><pre>\nHello</pre></div>'
    const map = mapOf(source)
    const pre = map.byId.get(idOf(map, 'pre'))!
    const patched = patchOf(map, pre.slId, '\nHello')!
    expect(patched).not.toBe(source)
    expect(mapOf(patched).byId.get(idOf(mapOf(patched), 'pre'))!.textContent).toBe('\nHello')
  })

  it('adds no newline when the committed text does not start with one', () => {
    const map = mapOf('<div><pre>\nHello</pre></div>')
    expect(patchOf(map, idOf(map, 'pre'), 'Bye')).toBe('<div><pre>Bye</pre></div>')
  })

  it('does not compensate a tag that keeps its leading newline', () => {
    const map = mapOf('<div><p>Hello</p></div>')
    expect(patchOf(map, idOf(map, 'p'), '\nHello')).toBe('<div><p>\nHello</p></div>')
  })

  it('the element stays editable after the compensated write', () => {
    const map = mapOf('<div><pre>\n\nHello</pre></div>')
    const patched = patchOf(map, idOf(map, 'pre'), '\nHello!')!
    const next = mapOf(patched)
    // A `&#10;` "fix" would land here as textOnly:false — the element it just edited, uneditable.
    expect(isTextEditable(next.byId.get(idOf(next, 'pre'))!)).toBe(true)
  })

  it('a <listing> is compensated the same way', () => {
    const map = mapOf('<div><listing>\n\nx</listing></div>')
    const patched = patchOf(map, idOf(map, 'listing'), '\nxy')!
    expect(mapOf(patched).byId.get(idOf(mapOf(patched), 'listing'))!.textContent).toBe('\nxy')
  })
})

describe('resolveTextEdit — a patch that changes no byte is not an edit (round-3 major)', () => {
  it('returns null when the write lands identical to the source', () => {
    // The only shape that reaches this guard: a map whose `textContent` disagrees with what `inner`
    // actually spells, so the decoded-text comparison says "changed" and the byte comparison says
    // "did not". Hand-built for the same reason as the SL-S04 pin below — a real parse never yields
    // it, and `useTextEditing` would turn the identical bytes into an undo entry that undoes nothing.
    const source = 'X'
    const element: ElementSpan = {
      slId: 's:0',
      tagName: 'p',
      outer: { start: 0, end: 1 },
      inner: { start: 0, end: 1 },
      attrs: {},
      attrInsert: 0,
      parentSlId: null,
      childSlIds: [],
      path: [0],
      textOnly: true,
      textContent: 'Y',
      ns: 'html',
      authoredSlId: null,
      minDomNodeCount: 1,
    }
    const map: SlideMap = {
      slideId: 's',
      sourceHash: 'test',
      source,
      byId: new Map([[element.slId, element]]),
      order: [element.slId],
    }
    expect(patchOf(map, 's:0', 'X')).toBeNull()
    expect(patchOf(map, 's:0', 'Z')).toBe('Z')
  })
})

/** A one-paragraph slide holding `text`. */
function bodyOf(text: string): string {
  return `<div class="slide"><p>${text}</p></div>`
}

/**
 * Round-3 major 2: the 64 KiB cap refuses, it never truncates. The old behaviour deleted 4 465
 * authored characters from a 70 000-character element on an edit made before the cap.
 */
describe('MAX_TEXT_LENGTH refuses rather than truncating (round-3 major)', () => {
  it('an element whose text is exactly at the cap is editable', () => {
    const map = mapOf(bodyOf('x'.repeat(MAX_TEXT_LENGTH)))
    const p = map.byId.get(idOf(map, 'p'))!
    expect(isTextEditable(p)).toBe(true)
    expect(patchOf(map, p.slId, 'short')).toBe(bodyOf('short'))
  })

  it('an element one character past the cap is not editable at all', () => {
    const map = mapOf(bodyOf('x'.repeat(MAX_TEXT_LENGTH + 1)))
    const p = map.byId.get(idOf(map, 'p'))!
    expect(isTextEditable(p)).toBe(false)
    // The tail is not deleted: the source is returned untouched, whatever the commit said.
    expect(patchOf(map, p.slId, 'x'.repeat(MAX_TEXT_LENGTH + 1))).toBeNull()
    expect(patchOf(map, p.slId, 'short')).toBeNull()
  })

  it('an over-cap value committed into a small element is refused, not trimmed', () => {
    const map = mapOf(bodyOf('small'))
    const p = map.byId.get(idOf(map, 'p'))!
    expect(patchOf(map, p.slId, 'y'.repeat(MAX_TEXT_LENGTH + 1))).toBeNull()
    // Exactly at the cap still lands.
    const atCap = patchOf(map, p.slId, 'y'.repeat(MAX_TEXT_LENGTH))!
    expect(renderedText(atCap, 'p')).toHaveLength(MAX_TEXT_LENGTH)
  })

  it('control characters cannot walk an over-cap payload past the guard', () => {
    const map = mapOf(bodyOf('small'))
    const p = map.byId.get(idOf(map, 'p'))!
    // Sanitizing would strip the NULs and bring this back under the cap; the guard reads the raw
    // length, so it refuses.
    expect(patchOf(map, p.slId, `${'y'.repeat(10)}${'\u0000'.repeat(MAX_TEXT_LENGTH)}`)).toBeNull()
  })
})

describe('resolveTextEdit — entity-bearing text (review major)', () => {
  const ENTITY_SOURCE =
    '<div class="slide"><h1>a&nbsp;b &mdash; &quot;c&quot; &lt;d&gt; e&amp;f</h1></div>'

  it('an unchanged commit on entity-bearing text is a no-op', () => {
    const map = mapOf(ENTITY_SOURCE)
    const h1 = map.byId.get(idOf(map, 'h1'))!
    // What the frame's textContent returns for this element.
    const seen = renderedText(ENTITY_SOURCE, 'h1')
    expect(seen).toBe('a\u00A0b — "c" <d> e&f')
    expect(h1.textContent).toBe(seen)
    expect(patchOf(map, h1.slId, seen)).toBeNull()
  })

  it.each(['&nbsp;', '&mdash;', '&quot;', '&rarr;', '&copy;', '&#8212;', '&#x2014;', '&amp;'])(
    'unchanged text containing %s is a no-op',
    (entity) => {
      const html = `<div class="slide"><p>x ${entity} y</p></div>`
      const map = mapOf(html)
      expect(patchOf(map, idOf(map, 'p'), renderedText(html, 'p'))).toBeNull()
    },
  )

  it('a real change lands, and the no-break space keeps its entity spelling', () => {
    const map = mapOf(ENTITY_SOURCE)
    const typed = 'a\u00A0b — "c" <d> e&f!'
    const patched = patchOf(map, idOf(map, 'h1'), typed)!
    expect(patched).toBe('<div class="slide"><h1>a&nbsp;b — "c" &lt;d> e&amp;f!</h1></div>')
    expect(renderedText(patched, 'h1')).toBe(typed)
  })

  it('a control character in the source does not make an untouched edit look changed', () => {
    // The tokenizer keeps U+0001; the frame's textContent carries it; the sanitizer strips it on
    // both sides of the comparison.
    const html = '<div class="slide"><p>a\u0001b</p></div>'
    const map = mapOf(html)
    expect(patchOf(map, idOf(map, 'p'), 'a\u0001b')).toBeNull()
    expect(patchOf(map, idOf(map, 'p'), 'ab')).toBeNull()
  })
})

describe('escapeAndNeutralizeText — invisible characters are written as references', () => {
  it.each([
    ['\u00A0', '&nbsp;'],
    ['\u00AD', '&#173;'],
    ['\u200B', '&#8203;'],
    ['\u200C', '&#8204;'],
    ['\u200D', '&#8205;'],
    ['\u2060', '&#8288;'],
    ['\uFEFF', '&#65279;'],
  ])('writes %o as %s, which decodes back to the same character', (char, reference) => {
    const written = escapeAndNeutralizeText(`a${char}b`)
    expect(written).toBe(`a${reference}b`)
    expect(renderedText(`<p>${written}</p>`, 'p')).toBe(`a${char}b`)
  })
})

describe('escapeAndNeutralizeText — folds case the way the validator does (review minor)', () => {
  it('neutralizes a token spelled with a Kelvin sign, which lowercases to k', () => {
    const text = 'open a WebSocKet here'
    const written = escapeAndNeutralizeText(text)
    expect(packForApiScan(written)).not.toContain('websocket')
    expect(renderedText(`<p>${written}</p>`, 'p')).toBe(text)
  })

  it.each([
    ['Kelvin sign', 'WebSocKet'],
    ['dotted capital I (two-code-unit lowercase)', 'İndexedDB'],
    ['long s', 'WebSocketſ'],
    ['fullwidth letters', 'ｆetch('],
    ['fi ligature', 'ﬁetch('],
    ['mixed: Kelvin inside spaced token', 'W e b S o c K e t'],
  ])('%s: the patch is never refused and never violates SL-S04', (_label, text) => {
    const map = mapOf('<div class="slide"><h1>Old</h1></div>')
    const patched = patchOf(map, idOf(map, 'h1'), text)
    expect(patched).not.toBeNull()
    expect(findForbiddenApiTokens(patched!)).toEqual([])
    expect(renderedText(patched!, 'h1')).toBe(text)
  })

  it('the post-patch assertion refuses a patch that gains a token — pinned through a non-text span', () => {
    // A map whose `inner` is not flanked by tags is the only way past the neutralizer: the shape a
    // future slide-map change could produce. Hand-built, because a real parse never yields it.
    const source = 'fetcX('
    const element: ElementSpan = {
      slId: 's:0',
      tagName: 'p',
      outer: { start: 0, end: source.length },
      inner: { start: 4, end: 5 },
      attrs: {},
      attrInsert: 0,
      parentSlId: null,
      childSlIds: [],
      path: [0],
      textOnly: true,
      textContent: 'X',
      ns: 'html',
      authoredSlId: null,
      minDomNodeCount: 1,
    }
    const map: SlideMap = {
      slideId: 's',
      sourceHash: 'test',
      source,
      byId: new Map([[element.slId, element]]),
      order: [element.slId],
    }
    expect(patchOf(map, 's:0', 'h')).toBeNull()
    expect(patchOf(map, 's:0', 'Y')).toBe('fetcY(')
  })
})

describe('sanitizeEditedText — lone surrogates (review minor)', () => {
  it('replaces a lone high or low surrogate with U+FFFD', () => {
    expect(sanitizeEditedText('a\uD800b')).toBe('a�b')
    expect(sanitizeEditedText('a\uDC00b')).toBe('a�b')
  })

  it('keeps a well-formed pair intact', () => {
    expect(sanitizeEditedText('a\u{1F600}b')).toBe('a\u{1F600}b')
  })

  it('repairs a pair a caller cut in half', () => {
    const out = sanitizeEditedText(`${'x'.repeat(4)}\u{1F600}`.slice(0, 5))
    expect(out).toHaveLength(5)
    expect(out.endsWith('�')).toBe(true)
  })

  it('edit -> save -> reopen is identity for a pasted lone surrogate', () => {
    const map = mapOf('<div class="slide"><h1>Old</h1></div>')
    const patched = patchOf(map, idOf(map, 'h1'), 'a\uD800b')!
    // A UTF-8 round trip changes nothing, because nothing lone is left to become U+FFFD on save.
    expect(Buffer.from(patched, 'utf8').toString('utf8')).toBe(patched)
    expect(renderedText(patched, 'h1')).toBe('a�b')
  })
})

/**
 * Round-4: the outcome is discriminated, because "nothing to do" and "I refused that" must not look
 * the same to the caller. A refusal puts the frame back and tells the user; an unchanged value does
 * neither, and mixing them either nags on every stray double-click or hides a rejected paste.
 */
describe('resolveTextEdit — why an edit did not land', () => {
  const html = '<div><h1>Old</h1><p>Mixed <b>x</b></p><p data-sl-lock>Chrome</p></div>'

  it('separates unchanged from refused', () => {
    const map = mapOf(html)
    expect(resolveTextEdit(map, idOf(map, 'h1'), 'Old')).toEqual({ kind: 'unchanged' })
    expect(resolveTextEdit(map, idOf(map, 'h1'), 'New')).toMatchObject({ kind: 'patched' })
  })

  it.each([
    [
      'an over-cap value',
      () => idOf(mapOf(html), 'h1'),
      'x'.repeat(MAX_TEXT_LENGTH + 1),
      'too-long',
    ],
    ['mixed inline content', () => idOf(mapOf(html), 'p'), 'plain', 'not-editable'],
    ['an sl-id the map has never had', () => 's:999', 'New', 'unknown-element'],
  ])('names %s', (_label, idFor, text, reason) => {
    expect(resolveTextEdit(mapOf(html), idFor(), text)).toEqual({ kind: 'refused', reason })
  })

  it('names a locked element not-editable', () => {
    const map = mapOf(html)
    const locked = map.order
      .map((id) => map.byId.get(id)!)
      .find((el) => 'data-sl-lock' in el.attrs)!
    expect(resolveTextEdit(map, locked.slId, 'New')).toEqual({
      kind: 'refused',
      reason: 'not-editable',
    })
  })
})
