import { describe, expect, it } from 'vitest'
import { buildSlideMap } from '../../../src/shared/design/slide-map'
import {
  applyOps,
  escapeAttrValue,
  escapeText,
  isSafeStyleValue,
  PatchOverlapError,
  readAttr,
  readStyleProp,
  removeStyleProp,
  setAttr,
  setStyleProp,
  type SourceOp,
} from '../../../src/shared/design/patch'
import type { ElementSpan } from '../../../src/shared/design/types'

/** Resolve the single element of a one-element slide, for helper tests. */
function only(html: string): { source: string; element: ElementSpan } {
  const map = buildSlideMap('s', html)
  const element = map.byId.get(map.order[0]!)!
  return { source: map.source, element }
}

describe('applyOps', () => {
  it('returns the source unchanged for no ops', () => {
    expect(applyOps('abc', [])).toBe('abc')
  })

  it('applies a single replace', () => {
    const ops: SourceOp[] = [{ kind: 'replaceSpan', span: { start: 1, end: 2 }, text: 'X' }]
    expect(applyOps('abc', ops)).toBe('aXc')
  })

  it('applies multiple non-overlapping ops correctly regardless of input order', () => {
    const ops: SourceOp[] = [
      { kind: 'replaceSpan', span: { start: 0, end: 1 }, text: 'A' },
      { kind: 'insertAt', at: 3, text: '!' },
      { kind: 'replaceSpan', span: { start: 1, end: 2 }, text: 'B' },
    ]
    // "abc" -> A B c ! -> "ABc!"
    expect(applyOps('abc', ops)).toBe('ABc!')
  })

  it('applies a longer replacement that shifts later offsets, high-offset-first', () => {
    const ops: SourceOp[] = [
      { kind: 'replaceSpan', span: { start: 0, end: 1 }, text: 'LONG' },
      { kind: 'replaceSpan', span: { start: 2, end: 3 }, text: 'END' },
    ]
    expect(applyOps('abc', ops)).toBe('LONGbEND')
  })

  it('allows a zero-length insert at the boundary of a replace', () => {
    const ops: SourceOp[] = [
      { kind: 'replaceSpan', span: { start: 1, end: 3 }, text: 'XY' },
      { kind: 'insertAt', at: 1, text: '|' },
    ]
    expect(applyOps('abcd', ops)).toBe('a|XYd')
  })

  it('throws PatchOverlapError when two ops overlap', () => {
    const ops: SourceOp[] = [
      { kind: 'replaceSpan', span: { start: 0, end: 3 }, text: 'X' },
      { kind: 'replaceSpan', span: { start: 2, end: 4 }, text: 'Y' },
    ]
    expect(() => applyOps('abcde', ops)).toThrow(PatchOverlapError)
  })

  it('handles deleteSpan', () => {
    const ops: SourceOp[] = [{ kind: 'deleteSpan', span: { start: 1, end: 3 } }]
    expect(applyOps('abcd', ops)).toBe('ad')
  })

  it('is safe against multi-byte / surrogate-pair content (UTF-16 spans)', () => {
    // The map's spans are UTF-16 code-unit indices; an emoji before the edit must survive intact.
    const map = buildSlideMap('s', '<p title="a">😀 hi</p>')
    const element = map.byId.get(map.order[0]!)!
    const ops = setAttr(element, 'title', 'title', 'b')
    expect(applyOps(map.source, ops)).toBe('<p title="b">😀 hi</p>')
  })
})

describe('escapeText', () => {
  it('escapes & and < only, and > after ]]', () => {
    expect(escapeText('a & b < c')).toBe('a &amp; b &lt; c')
    expect(escapeText('x]]>y')).toBe('x]]&gt;y')
  })

  it('leaves non-ASCII untouched', () => {
    expect(escapeText('Café')).toBe('Café')
  })
})

describe('escapeAttrValue', () => {
  it('escapes &, " and \'', () => {
    expect(escapeAttrValue('a & "b" \'c\'')).toBe('a &amp; &quot;b&quot; &#39;c&#39;')
  })
})

describe('setAttr', () => {
  it('replaces an existing value, leaving the quoting style alone', () => {
    const { source, element } = only("<div class='a'>x</div>")
    const patched = applyOps(source, setAttr(element, 'class', 'class', 'b'))
    expect(patched).toBe("<div class='b'>x</div>")
  })

  it('inserts a new attribute after the tag name when absent', () => {
    const { source, element } = only('<div>x</div>')
    const patched = applyOps(source, setAttr(element, 'title', 'title', 'hi'))
    expect(patched).toBe('<div title="hi">x</div>')
  })

  it('rewrites a valueless attribute into name="value"', () => {
    const { source, element } = only('<input disabled>')
    const patched = applyOps(source, setAttr(element, 'disabled', 'disabled', 'true'))
    expect(patched).toBe('<input disabled="true">')
  })

  it('escapes the written value', () => {
    const { source, element } = only('<div>x</div>')
    const patched = applyOps(source, setAttr(element, 'title', 'title', 'a"b'))
    expect(patched).toBe('<div title="a&quot;b">x</div>')
  })

  it('cannot break out of a single-quoted attribute — apostrophe values are escaped', () => {
    // The value span of a single-quoted attr excludes the quotes; a raw `'` in the value would
    // otherwise terminate it and inject a new attribute into the saved (exportable) source.
    const { source, element } = only("<rect fill='red' x='10'/>")
    const patched = applyOps(
      source,
      setAttr(element, 'fill', 'fill', "blue' onmouseover='alert(1)"),
    )
    expect(patched).toBe("<rect fill='blue&#39; onmouseover=&#39;alert(1)' x='10'/>")
    // The `'` never appears raw, so no live attribute breaks out of the value.
    expect(patched).not.toContain("onmouseover='alert")
  })
})

describe('setStyleProp', () => {
  it('inserts a whole style attribute when the element has none', () => {
    const { source, element } = only('<div>x</div>')
    const patched = applyOps(source, setStyleProp(source, element, 'color', 'red'))
    expect(patched).toBe('<div style="color: red">x</div>')
  })

  it('upserts one property, preserving the other declarations', () => {
    const { source, element } = only('<div style="color: red; margin: 0">x</div>')
    const patched = applyOps(source, setStyleProp(source, element, 'color', 'blue'))
    expect(patched).toBe('<div style="color: blue; margin: 0">x</div>')
  })

  it('appends a new property to an existing style', () => {
    const { source, element } = only('<div style="color: red">x</div>')
    const patched = applyOps(source, setStyleProp(source, element, 'font-size', '20px'))
    expect(patched).toBe('<div style="color: red; font-size: 20px">x</div>')
  })

  it('rejects a value that would inject a sibling declaration (; or { or })', () => {
    const { source, element } = only('<div>x</div>')
    // Without the guard, this serializes to `color: red;background:url(x)` — two declarations.
    expect(setStyleProp(source, element, 'color', 'red;background:url(x)')).toEqual([])
    expect(setStyleProp(source, element, 'color', 'red}')).toEqual([])
    expect(setStyleProp(source, element, 'color', 'red{')).toEqual([])
    // A safe value still writes exactly one declaration.
    expect(applyOps(source, setStyleProp(source, element, 'color', 'red'))).toBe(
      '<div style="color: red">x</div>',
    )
  })
})

describe('isSafeStyleValue', () => {
  it('rejects declaration/block terminators, accepts everything else', () => {
    expect(isSafeStyleValue('red')).toBe(true)
    expect(isSafeStyleValue('url("a.png")')).toBe(true)
    expect(isSafeStyleValue('red;x:1')).toBe(false)
    expect(isSafeStyleValue('a{b')).toBe(false)
    expect(isSafeStyleValue('a}')).toBe(false)
  })
})

describe('readStyleProp / readAttr', () => {
  it('reads a style property value or null', () => {
    const { source, element } = only('<div style="color: red">x</div>')
    expect(readStyleProp(source, element, 'color')).toBe('red')
    expect(readStyleProp(source, element, 'font-size')).toBeNull()
  })

  it('reads a raw attribute value or null', () => {
    const { source, element } = only('<rect fill="#abc"/>')
    expect(readAttr(source, element, 'fill')).toBe('#abc')
    expect(readAttr(source, element, 'stroke')).toBeNull()
  })
})

describe('removeStyleProp', () => {
  it('removes one declaration, preserving the others', () => {
    const { source, element } = only('<div style="color: red; transform: rotate(45deg)">x</div>')
    const next = applyOps(source, removeStyleProp(source, element, 'transform'))
    expect(next).toBe('<div style="color: red">x</div>')
  })

  it('deletes the whole style attribute (and its leading space) when nothing is left', () => {
    const { source, element } = only('<div style="transform: rotate(45deg)">x</div>')
    const next = applyOps(source, removeStyleProp(source, element, 'transform'))
    // No `style=""` husk, no stray double space — the tag is exactly as it was without the attribute.
    expect(next).toBe('<div>x</div>')
  })

  it('is a no-op when the property or the style attribute is absent', () => {
    const withStyle = only('<div style="color: red">x</div>')
    expect(removeStyleProp(withStyle.source, withStyle.element, 'transform')).toEqual([])
    const noStyle = only('<div>x</div>')
    expect(removeStyleProp(noStyle.source, noStyle.element, 'transform')).toEqual([])
  })

  it('is case-insensitive on the property name', () => {
    const { source, element } = only('<div style="TRANSFORM: rotate(45deg)">x</div>')
    expect(applyOps(source, removeStyleProp(source, element, 'transform'))).toBe('<div>x</div>')
  })
})
