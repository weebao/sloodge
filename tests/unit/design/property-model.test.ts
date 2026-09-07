import { describe, expect, it } from 'vitest'
import { buildSlideMap } from '../../../src/shared/design/slide-map'
import { applyOps } from '../../../src/shared/design/patch'
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

  it('preserves other transform functions, prepending a new translate so it acts in parent space', () => {
    // `rotate(4deg) translate(10px, 0)` would shift the element along its own tilted axis; the
    // leading position is the one CSS applies last, i.e. in the parent's frame (§5.3 canonical order).
    // Mutation guard: appending the translate (the M3.3 behaviour) reds here.
    expect(edit('<div style="transform: rotate(4deg)">x</div>', 0, 'x', '10')).toBe(
      '<div style="transform: translate(10px, 0) rotate(4deg)">x</div>',
    )
  })

  it('folds a translateX alias into the one translate the handles write (round-1 major 2)', () => {
    // `transform.ts` folds `translateX` into the translate family; writing a second `translate()`
    // beside it made the element opaque ("translate() appears more than once") on its first drag.
    // Mutation guard: the exact-name `replaceTranslate` path reds both.
    expect(edit('<div style="transform: translateX(120px)">x</div>', 0, 'x', '40')).toBe(
      '<div style="transform: translate(40px, 0)">x</div>',
    )
    expect(
      edit('<div style="transform: translateX(120px) rotate(5deg)">x</div>', 0, 'y', '8'),
    ).toBe('<div style="transform: translate(120px, 8px) rotate(5deg)">x</div>')
  })

  it('reads the X/Y fields from a folded alias too', () => {
    const { source, element } = at('<div style="transform: translateY(8px)">x</div>', 0)
    const values = readPropertyValues(source, element)
    expect(values.x).toBe('0')
    expect(values.y).toBe('8px')
  })

  it('opaque + in-flow: an X edit is REFUSED, not written through the transform (round-4 major)', () => {
    // Round 2 made the new translate LEAD here (`translate(40px, 0) matrix(2, …)`) so it acted in
    // parent space. Round 4 goes one further: the write does not happen at all, because the panel's
    // X/Y inputs reach `buildFieldOps` without passing through the drag's gate, and on
    // `rotate(90deg) translate(10px, 0)` the in-place rewrite moved the element 40px DOWN for a +40
    // X edit. Mutation guard: restoring that write in `moveChannel`'s `refused` arm reds here
    // with `translate(40px, 0) matrix(2, 0, 0, 2, 0, 0)`.
    const html = '<div style="transform: matrix(2, 0, 0, 2, 0, 0)">x</div>'
    expect(edit(html, 0, 'x', '40')).toBe(html)
  })

  it('opaque + in-flow: a Y edit is refused too — both axes, one refusal', () => {
    // The vertical half (round-4 minor 1): a Y edit under `rotate(90deg)` moves the element LEFT.
    const html = '<div style="transform: rotate(90deg) translate(10px, 0)">x</div>'
    expect(edit(html, 0, 'y', '40')).toBe(html)
    expect(edit(html, 0, 'x', '40')).toBe(html)
  })

  it('opaque, exact translate present: still READ on both axes, so the disabled field shows them', () => {
    // The write is refused but the value is not hidden — the panel shows `5px`/`6px` greyed out with
    // the reason as its tooltip. Mutation guard: `translateArgs` returning null for an opaque value
    // reads 0/0 here.
    const { source, element } = at(
      '<div style="transform: translate(5px, 6px) skew(3deg)">x</div>',
      0,
    )
    const values = readPropertyValues(source, element)
    expect(values.x).toBe('5px')
    expect(values.y).toBe('6px')
    expect(
      edit('<div style="transform: translate(5px, 6px) skew(3deg)">x</div>', 0, 'x', '40'),
    ).toBe('<div style="transform: translate(5px, 6px) skew(3deg)">x</div>')
  })

  it('opaque but POSITIONED, or SVG: the write still lands — the refusal is narrow', () => {
    // `moveRefusal` is `movesThroughTransform && !editable`, so neither of these is refused.
    expect(
      edit('<div style="left: 10px; transform: matrix(2, 0, 0, 2, 0, 0)">x</div>', 0, 'x', '40'),
    ).toBe('<div style="left: 40px; transform: matrix(2, 0, 0, 2, 0, 0)">x</div>')
    expect(
      edit('<svg><rect x="5" style="transform: matrix(2, 0, 0, 2, 0, 0)"/></svg>', 1, 'x', '40'),
    ).toBe('<svg><rect x="40" style="transform: matrix(2, 0, 0, 2, 0, 0)"/></svg>')
  })

  it('a top-only element is positioned by offsets: Y reads top, X reads null, X writes left', () => {
    // Pins the `top` half of `positionsByOffsets` (round-2 minor: dropping it survived the suite).
    const { source, element } = at(
      '<div style="top: 5px; transform: translate(9px, 9px)">x</div>',
      0,
    )
    const values = readPropertyValues(source, element)
    expect(values.x).toBeNull()
    expect(values.y).toBe('5px')
    expect(edit('<div style="top: 5px">x</div>', 0, 'x', '120')).toBe(
      '<div style="top: 5px; left: 120px">x</div>',
    )
  })

  it('a left-only element: X reads left, Y reads null, a Y edit writes top', () => {
    // Pins the `left` half at the READER (round-3 minor 2): every other left/top fixture declares both.
    const { source, element } = at(
      '<div style="left: 100px; transform: translate(9px, 9px)">x</div>',
      0,
    )
    const values = readPropertyValues(source, element)
    expect(values.x).toBe('100px')
    expect(values.y).toBeNull()
    expect(edit('<div style="left: 100px">x</div>', 0, 'y', '20')).toBe(
      '<div style="left: 100px; top: 20px">x</div>',
    )
  })

  it('replaces an existing translate where it stands', () => {
    expect(
      edit('<div style="transform: translate(1px, 2px) rotate(4deg)">x</div>', 0, 'x', '10'),
    ).toBe('<div style="transform: translate(10px, 2px) rotate(4deg)">x</div>')
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
