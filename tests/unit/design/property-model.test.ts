import { describe, expect, it } from 'vitest'
import { buildSlideMap } from '../../../src/shared/design/slide-map'
import { applyOps } from '../../../src/shared/design/patch'
import { MAX_TEXT_LENGTH, textEditBlock } from '../../../src/shared/design/text-edit'
import { CORPUS } from './corpus'
import {
  buildFieldOps,
  readPropertyValues,
  resolveElement,
  type PropertyField,
} from '../../../src/shared/design/property-model'

/** Build a map, resolve the element whose id ends in `:n`, and hand back both plus the source. */
function at(html: string, n: number) {
  const map = buildSlideMap('s', html)
  const element = resolveElement(map, `s:${String(n)}`)!
  return { map, element, source: map.source }
}

/** Apply one field edit and return the patched source. */
function edit(html: string, n: number, field: PropertyField, value: string): string {
  const { source, element } = at(html, n)
  return applyOps(source, buildFieldOps(source, element, field, value))
}

/** Every text-only element of `html`, with its map, for the M3.12 round-trip sweeps. */
function textOnlyElements(html: string) {
  const map = buildSlideMap('s', html)
  return [...map.byId.values()].filter((el) => el.textOnly).map((element) => ({ map, element }))
}

/** Apply one field edit, reparse, and read the field back — the panel's round-trip. */
function roundTrip(html: string, n: number, field: PropertyField, value: string): string | null {
  const patched = edit(html, n, field, value)
  const { source, element } = at(patched, n)
  return readPropertyValues(source, element)[field]
}

describe('resolveElement — the re-derivation rule (§2.2)', () => {
  it('resolves the parent-tracked sl-id against the parent-owned map', () => {
    const map = buildSlideMap('s', '<div>a</div><div>b</div>')
    expect(resolveElement(map, 's:0')!.slId).toBe('s:0')
    expect(resolveElement(map, 's:1')!.slId).toBe('s:1')
  })

  it('returns null for an sl-id that is not in the map (stale/forged)', () => {
    const map = buildSlideMap('s', '<div>a</div>')
    expect(resolveElement(map, 's:99')).toBeNull()
    expect(resolveElement(map, 'other:0')).toBeNull()
  })

  it('edits the element the PARENT id names, never a neighbour — a forged payload cannot redirect', () => {
    // Two sibling divs. Editing must target exactly the parent-tracked id's span. A message payload
    // claiming a different element is irrelevant: buildFieldOps only sees the resolved element.
    const html = '<div>a</div><div>b</div>'
    const patchedFirst = edit(html, 0, 'color', 'red')
    expect(patchedFirst).toBe('<div style="color: red">a</div><div>b</div>')
    const patchedSecond = edit(html, 1, 'color', 'red')
    expect(patchedSecond).toBe('<div>a</div><div style="color: red">b</div>')
  })
})

describe('readPropertyValues — HTML', () => {
  it('reads text, inline styles, and null for unset fields', () => {
    const { source, element } = at('<h1 style="color: #111; font-size: 44px">Hi</h1>', 0)
    const values = readPropertyValues(source, element)
    expect(values.text).toBe('Hi')
    expect(values.color).toBe('#111')
    expect(values.fontSize).toBe('44px')
    expect(values.fontWeight).toBeNull()
    expect(values.fill).toBeNull()
  })

  it('reads background-color as fill for HTML elements', () => {
    const { source, element } = at('<div style="background-color: #1a2035">x</div>', 0)
    expect(readPropertyValues(source, element).fill).toBe('#1a2035')
  })

  it('reads X/Y from left/top when present', () => {
    const { source, element } = at('<div style="left: 120px; top: 88px">x</div>', 0)
    const values = readPropertyValues(source, element)
    expect(values.x).toBe('120px')
    expect(values.y).toBe('88px')
  })

  it('reads X/Y from transform: translate when there is no left/top', () => {
    const { source, element } = at('<div style="transform: translate(10px, 20px)">x</div>', 0)
    const values = readPropertyValues(source, element)
    expect(values.x).toBe('10px')
    expect(values.y).toBe('20px')
  })

  it('reports text=null for mixed content', () => {
    const { source, element } = at('<p>a <b>c</b></p>', 0)
    expect(readPropertyValues(source, element).text).toBeNull()
  })
})

describe('readPropertyValues — SVG', () => {
  it('reads geometry and fill from presentation attributes', () => {
    const html = '<svg><rect x="40" y="120" width="48" height="180" fill="#38bdf8"/></svg>'
    const { source, element } = at(html, 1) // 0 = svg, 1 = rect
    const values = readPropertyValues(source, element)
    expect(values.x).toBe('40')
    expect(values.y).toBe('120')
    expect(values.width).toBe('48')
    expect(values.height).toBe('180')
    expect(values.fill).toBe('#38bdf8')
  })
})

describe('buildFieldOps — text', () => {
  it('replaces textOnly content', () => {
    expect(edit('<h1>Old</h1>', 0, 'text', 'New')).toBe('<h1>New</h1>')
  })

  it('is a no-op for mixed content', () => {
    const { source, element } = at('<p>a <b>c</b></p>', 0)
    expect(buildFieldOps(source, element, 'text', 'x')).toEqual([])
  })
})

/**
 * M3.12. The Content field is the read half of a round trip whose write half escapes: the field
 * must therefore hold *decoded* text, and reading a value then committing it unchanged must not
 * touch a byte. Before the fix the field held raw source bytes, so every commit added a level of
 * escaping — `X & Y` read back as `X &amp; Y`, and committing that wrote `X &amp;amp; Y`.
 */
describe('Content field round trip — read decoded, commit escaped, unchanged is a byte no-op (M3.12)', () => {
  it('the field holds decoded text, not source bytes', () => {
    const { source, element } = at(
      '<h1>X &amp; Y &lt;b&gt; a&nbsp;b &quot;q&quot; &eacute;</h1>',
      0,
    )
    expect(readPropertyValues(source, element).text).toBe('X & Y <b> a\u00A0b "q" é')
  })

  it('the roadmap repro: committing `X & Y` twice never double-escapes', () => {
    const once = edit('<h1>Hi</h1>', 0, 'text', 'X & Y')
    expect(once).toBe('<h1>X &amp; Y</h1>')
    // Read it back through the panel: the user sees exactly what they typed...
    const { source, element } = at(once, 0)
    const shown = readPropertyValues(source, element).text
    expect(shown).toBe('X & Y')
    // ...and committing the field as shown is a no-op, not a second level of escaping.
    expect(buildFieldOps(source, element, 'text', shown!)).toEqual([])
    expect(edit(once, 0, 'text', `${shown!}!`)).toBe('<h1>X &amp; Y!</h1>')
  })

  const ENTITY_SHAPES = [
    '<h1>a&nbsp;b</h1>',
    '<h1>a&amp;b</h1>',
    '<h1>a&lt;b&gt;c</h1>',
    '<h1>&quot;q&quot; &#39;s&#39;</h1>',
    '<h1>caf&eacute; &#x41; &#65;</h1>',
    '<h1>call &#102;etch(x) here</h1>',
    '<h1>]]&gt;</h1>',
    '<h1>&copy; 2026 &mdash; &rarr;</h1>',
    '<pre>\n\nkept blank line</pre>',
    '<pre>\nfirst</pre>',
    '<p>line one\r\nline two</p>',
    '<p>😀 café</p>',
    '<p>a\u0001b</p>',
    '<h1></h1>',
  ]

  it.each(ENTITY_SHAPES)('read then commit unchanged is a byte-level no-op: %s', (html) => {
    const targets = textOnlyElements(html)
    expect(targets.length).toBeGreaterThan(0)
    for (const { map, element } of targets) {
      const shown = readPropertyValues(map.source, element).text
      expect(shown).not.toBeNull()
      const ops = buildFieldOps(map.source, element, 'text', shown!)
      expect(ops).toEqual([])
      expect(applyOps(map.source, ops)).toBe(map.source)
    }
  })

  it('holds across every text-only element of the hostile corpus', () => {
    let checked = 0
    let blocked = 0
    for (const { html } of CORPUS) {
      for (const { map, element } of textOnlyElements(html)) {
        const { text, textBlock } = readPropertyValues(map.source, element)
        // Text-only to the parser but not editable from the panel (`<style>`, `<title>`, a lock):
        // reads null with its reason, and the write side refuses the same element.
        if (text === null) {
          expect(textBlock).not.toBeNull()
          expect(buildFieldOps(map.source, element, 'text', 'z')).toEqual([])
          blocked += 1
          continue
        }
        expect(textBlock).toBeNull()
        expect(applyOps(map.source, buildFieldOps(map.source, element, 'text', text))).toBe(
          map.source,
        )
        checked += 1
      }
    }
    expect(checked).toBeGreaterThan(20)
    expect(blocked).toBeGreaterThan(0)
  })

  it('a changed value is written through the same escape the caret uses', () => {
    // `&` and `<` are escaped, a no-break space keeps its entity spelling, and an SL-S04 token is
    // broken with a numeric reference — one write path for the panel and the caret.
    expect(edit('<h1>x</h1>', 0, 'text', 'a & b <c> d\u00A0e fetch(f)')).toBe(
      '<h1>a &amp; b &lt;c> d&nbsp;e &#102;etch(f)</h1>',
    )
  })

  it('a <pre> keeps the leading newline the parser drops', () => {
    const html = '<pre>\n\nHello</pre>'
    const { source, element } = at(html, 0)
    expect(readPropertyValues(source, element).text).toBe('\nHello')
    expect(edit(html, 0, 'text', '\nHello!')).toBe('<pre>\n\nHello!</pre>')
  })

  it('reads null for an element whose inner is not pure text — the field stays disabled', () => {
    // Mixed inline content, and a mis-nested original whose text nodes do not tile `inner`: neither
    // has a decoded string that could round-trip, so the panel shows no text rather than a flattened
    // preview that looks editable.
    for (const html of ['<p>a <b>c</b></p>', '<b><p>x</b>y</p>']) {
      const { source, element } = at(html, 0)
      const values = readPropertyValues(source, element)
      expect(values.text).toBeNull()
      expect(values.textBlock).toBe('mixed-content')
      expect(buildFieldOps(source, element, 'text', 'z')).toEqual([])
    }
  })

  /**
   * Round-3 review: the panel shares the caret's write core, so it has to share the caret's gate
   * too — `data-sl-lock` is "selectable but not mutable", and a `<script>`/`<style>`'s character
   * data is text-only to the parser but never slide text (an escaped `<` in raw text is six literal
   * bytes; a neutralized `fetch(` is a syntax error). The gate holds on the write as well as the
   * read, so a value forced into the field is still refused.
   */
  it.each([
    ['a data-sl-lock element', '<div data-sl-lock>Hello</div>', 'locked'],
    ['a <script>', '<script>console.log(1)</script>', 'not-text'],
    ['a <style>', '<style>a > b { color: red }</style>', 'not-text'],
    ['a <title>', '<title>Deck</title>', 'not-text'],
    ['a void element', '<img src="x">', 'not-text'],
  ] as const)('refuses %s on read and on write, with the reason', (_label, html, block) => {
    const { source, element } = at(html, 0)
    const values = readPropertyValues(source, element)
    expect(values.text).toBeNull()
    expect(values.textBlock).toBe(block)
    expect(buildFieldOps(source, element, 'text', 'fetch("x")')).toEqual([])
    expect(applyOps(source, buildFieldOps(source, element, 'text', 'Changed'))).toBe(source)
  })

  /**
   * The two places the panel gate deliberately diverges from the caret gate, pinned (round-4
   * review): the 64 KiB cap is a frame-input guard and the panel is the documented way to edit an
   * over-cap element; the one-DOM-node rule is about where the frame can put a caret, and the panel
   * writes the one source span. Both stay editable here.
   */
  it('edits an element past MAX_TEXT_LENGTH — the panel is the way to edit an over-cap element', () => {
    const long = 'a'.repeat(MAX_TEXT_LENGTH + 1)
    const html = `<h1>${long}</h1>`
    const { source, element } = at(html, 0)
    expect(textEditBlock(element)).toBe('too-long')
    const values = readPropertyValues(source, element)
    expect(values.textBlock).toBeNull()
    expect(values.text).toBe(long)
    expect(edit(html, 0, 'text', 'short')).toBe('<h1>short</h1>')
  })

  it('edits a text-only element the adoption agency rendered as two nodes', () => {
    const map = buildSlideMap('s', '<div><p><b>x</p><p>y</b></p></div>')
    const bold = [...map.byId.values()].find((el) => el.tagName === 'b')!
    expect(bold.textOnly).toBe(true)
    expect(bold.minDomNodeCount).toBe(2)
    expect(textEditBlock(bold)).toBe('mixed-content')
    const values = readPropertyValues(map.source, bold)
    expect(values.textBlock).toBeNull()
    expect(values.text).toBe('x')
    expect(applyOps(map.source, buildFieldOps(map.source, bold, 'text', 'z'))).toBe(
      '<div><p><b>z</p><p>y</b></p></div>',
    )
  })

  it('an empty element reads as "" and can be filled — emptied text stays retypable', () => {
    const { source, element } = at('<h1></h1>', 0)
    const values = readPropertyValues(source, element)
    expect(values.text).toBe('')
    expect(values.textBlock).toBeNull()
    expect(edit('<h1></h1>', 0, 'text', 'Filled')).toBe('<h1>Filled</h1>')
    expect(edit('<p class="x"></p>', 0, 'text', 'a & b')).toBe('<p class="x">a &amp; b</p>')
  })
})

describe('buildFieldOps — style fields insert when absent, upsert when present', () => {
  it('font-size inserts px onto a bare number and creates the style attr', () => {
    expect(edit('<h1>x</h1>', 0, 'fontSize', '46')).toBe('<h1 style="font-size: 46px">x</h1>')
  })

  it('font-size upserts an existing declaration, preserving others', () => {
    expect(edit('<h1 style="color: red; font-size: 44px">x</h1>', 0, 'fontSize', '46')).toBe(
      '<h1 style="color: red; font-size: 46px">x</h1>',
    )
  })

  it('font-weight writes verbatim (keyword or number)', () => {
    expect(edit('<h1>x</h1>', 0, 'fontWeight', '700')).toBe('<h1 style="font-weight: 700">x</h1>')
  })

  it('color writes the color declaration', () => {
    expect(edit('<h1>x</h1>', 0, 'color', '#f0f2f5')).toBe('<h1 style="color: #f0f2f5">x</h1>')
  })

  it('a non-numeric length value is written verbatim (no px)', () => {
    expect(edit('<div>x</div>', 0, 'width', '50%')).toBe('<div style="width: 50%">x</div>')
  })

  it('a value with a ; (or { }) never injects a second declaration', () => {
    const { source, element } = at('<div>x</div>', 0)
    // The panel edit path rejects the write; the source is left untouched (no sibling property).
    expect(buildFieldOps(source, element, 'color', 'red;background:url(x)')).toEqual([])
    expect(edit('<div>x</div>', 0, 'color', 'red;background:url(x)')).toBe('<div>x</div>')
    // Sanity: the same field with a safe value writes exactly one declaration.
    expect(edit('<div>x</div>', 0, 'color', 'red')).toBe('<div style="color: red">x</div>')
  })

  it('empty values are no-ops', () => {
    const { source, element } = at('<div>x</div>', 0)
    for (const f of ['fontSize', 'color', 'fill', 'width', 'x'] as PropertyField[]) {
      expect(buildFieldOps(source, element, f, '   ')).toEqual([])
    }
  })
})

describe('buildFieldOps — fill prefers the channel the source uses', () => {
  it('HTML fill writes background-color', () => {
    expect(edit('<div>x</div>', 0, 'fill', '#fff')).toBe(
      '<div style="background-color: #fff">x</div>',
    )
  })

  it('SVG fill patches the existing fill attribute', () => {
    expect(edit('<svg><rect fill="#000"/></svg>', 1, 'fill', '#fff')).toBe(
      '<svg><rect fill="#fff"/></svg>',
    )
  })

  it('SVG fill falls back to a style declaration when no fill attribute exists', () => {
    expect(edit('<svg><rect/></svg>', 1, 'fill', '#fff')).toBe(
      '<svg><rect style="fill: #fff"/></svg>',
    )
  })
})

describe('readPropertyValues — stroke (M3.8)', () => {
  it('reads border-color as stroke for HTML elements', () => {
    const { source, element } = at('<div style="border-color: #38bdf8">x</div>', 0)
    expect(readPropertyValues(source, element).stroke).toBe('#38bdf8')
  })

  it('reads the SVG stroke attribute', () => {
    const { source, element } = at('<svg><rect stroke="#f00"/></svg>', 1)
    expect(readPropertyValues(source, element).stroke).toBe('#f00')
  })

  it('is null when no stroke channel is set', () => {
    const { source, element } = at('<div>x</div>', 0)
    expect(readPropertyValues(source, element).stroke).toBeNull()
  })
})

describe('buildFieldOps — stroke (M3.8)', () => {
  it('HTML stroke writes border-color plus a border-style so it renders', () => {
    expect(edit('<div>x</div>', 0, 'stroke', '#38bdf8')).toBe(
      '<div style="border-color: #38bdf8; border-style: solid">x</div>',
    )
  })

  it('HTML stroke keeps an author-set border-style (dashed stays dashed)', () => {
    expect(edit('<div style="border-style: dashed">x</div>', 0, 'stroke', '#38bdf8')).toBe(
      '<div style="border-style: dashed; border-color: #38bdf8">x</div>',
    )
  })

  it('SVG stroke patches the existing stroke attribute', () => {
    expect(edit('<svg><rect stroke="#000"/></svg>', 1, 'stroke', '#fff')).toBe(
      '<svg><rect stroke="#fff"/></svg>',
    )
  })

  it('SVG stroke falls back to a style declaration when no attribute exists', () => {
    expect(edit('<svg><rect/></svg>', 1, 'stroke', '#fff')).toBe(
      '<svg><rect style="stroke: #fff"/></svg>',
    )
  })

  it('a stroke value with a ; never injects a second declaration', () => {
    const { source, element } = at('<div>x</div>', 0)
    expect(buildFieldOps(source, element, 'stroke', 'red;background:url(x)')).toEqual([])
    expect(edit('<div>x</div>', 0, 'stroke', 'red;background:url(x)')).toBe('<div>x</div>')
  })

  it('a var() token reference is a valid stroke value (theme swatch write form)', () => {
    expect(edit('<div>x</div>', 0, 'stroke', 'var(--sl-accent, #4c8dff)')).toBe(
      '<div style="border-color: var(--sl-accent, #4c8dff); border-style: solid">x</div>',
    )
  })
})

describe('buildFieldOps — color accepts a theme var() token (M3.8)', () => {
  it('writes a var() reference verbatim (it passes the safe-value guard)', () => {
    expect(edit('<h1>x</h1>', 0, 'color', 'var(--sl-fg, #f0f0f5)')).toBe(
      '<h1 style="color: var(--sl-fg, #f0f0f5)">x</h1>',
    )
  })
})

describe('buildFieldOps — position and size', () => {
  it('SVG width/height/x/y patch presentation attributes', () => {
    const html = '<svg><rect x="0" y="0" width="10" height="10"/></svg>'
    expect(edit(html, 1, 'width', '48')).toContain('width="48"')
    expect(edit(html, 1, 'x', '40')).toContain('x="40"')
  })

  it('HTML X writes left when the element is already positioned with left/top', () => {
    expect(edit('<div style="left: 10px; top: 5px">x</div>', 0, 'x', '120')).toBe(
      '<div style="left: 120px; top: 5px">x</div>',
    )
  })

  it('HTML X writes transform: translate when there is no left/top', () => {
    expect(edit('<div>x</div>', 0, 'x', '120')).toBe(
      '<div style="transform: translate(120px, 0)">x</div>',
    )
  })

  it('HTML Y preserves the existing translate X', () => {
    expect(edit('<div style="transform: translate(30px, 5px)">x</div>', 0, 'y', '88')).toBe(
      '<div style="transform: translate(30px, 88px)">x</div>',
    )
  })

  it('preserves other transform functions when editing translate', () => {
    expect(edit('<div style="transform: rotate(4deg)">x</div>', 0, 'x', '10')).toBe(
      '<div style="transform: rotate(4deg) translate(10px, 0)">x</div>',
    )
  })
})

describe('multi-field edits over one element are non-overlapping', () => {
  it('a text edit and an attribute edit apply together', () => {
    const { source, element } = at('<h1 class="t">Old</h1>', 0)
    const ops = [
      ...buildFieldOps(source, element, 'text', 'New'),
      ...buildFieldOps(source, element, 'color', 'red'),
    ]
    // A new `style` attribute inserts at `attrInsert` (just after the tag name), ahead of `class`.
    expect(applyOps(source, ops)).toBe('<h1 style="color: red" class="t">New</h1>')
  })
})

describe('round-trips — edit, reparse, read back the new value', () => {
  it('font-size', () => {
    expect(roundTrip('<h1 style="font-size: 44px">x</h1>', 0, 'fontSize', '46')).toBe('46px')
  })

  it('color inserted from scratch', () => {
    expect(roundTrip('<div>x</div>', 0, 'color', '#abc')).toBe('#abc')
  })

  it('text', () => {
    expect(roundTrip('<h1>Old</h1>', 0, 'text', 'New')).toBe('New')
  })

  it('SVG geometry', () => {
    expect(roundTrip('<svg><rect x="0"/></svg>', 1, 'x', '40')).toBe('40')
  })

  it('HTML position via translate', () => {
    expect(roundTrip('<div>x</div>', 0, 'x', '120')).toBe('120px')
  })
})

describe('hostile-corpus span safety', () => {
  it('an edit near mis-nested formatting patches only the targeted element (non-overlap holds)', () => {
    // Mis-nested formatting: <b> and <p> are siblings with partially-overlapping outer spans
    // (see the ElementSpan.outer note). Editing an attribute on one must not corrupt the other.
    const html = '<b>1<p>2</b>3</p>'
    const map = buildSlideMap('s', html)
    // Edit the <p>'s style; the op is anchored to the p's own attrInsert and must apply cleanly.
    const pId = [...map.byId.values()].find((s) => s.tagName === 'p')!.slId
    const element = resolveElement(map, pId)!
    const patched = applyOps(map.source, buildFieldOps(map.source, element, 'color', 'red'))
    expect(patched).toContain('<p style="color: red"')
    // The <b> start tag is untouched.
    expect(patched.startsWith('<b>1')).toBe(true)
  })

  it('preserves multi-byte content around an edited attribute', () => {
    expect(edit('<div>😀 café</div>', 0, 'color', 'red')).toBe(
      '<div style="color: red">😀 café</div>',
    )
  })
})
