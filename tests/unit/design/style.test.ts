import { describe, expect, it } from 'vitest'
import {
  getDeclaration,
  parseDeclarations,
  parseTransform,
  serializeDeclarations,
  upsertDeclaration,
  upsertTransform,
} from '../../../src/shared/design/style'

describe('parseDeclarations', () => {
  it('parses a simple declaration list, lowercasing property names', () => {
    expect(parseDeclarations('Color: red; Font-Size: 12px')).toEqual([
      { prop: 'color', value: 'red', important: false },
      { prop: 'font-size', value: '12px', important: false },
    ])
  })

  it('does not split on ; or : inside parens or quotes', () => {
    expect(parseDeclarations('background: url(a;b:c); font-family: "a, b:c"')).toEqual([
      { prop: 'background', value: 'url(a;b:c)', important: false },
      { prop: 'font-family', value: '"a, b:c"', important: false },
    ])
  })

  it('preserves value case and captures !important', () => {
    expect(parseDeclarations('color: #AABBCC !important')).toEqual([
      { prop: 'color', value: '#AABBCC', important: true },
    ])
  })

  it('drops empty declarations and pieces with no colon', () => {
    expect(parseDeclarations(';; color: red ; garbage ;')).toEqual([
      { prop: 'color', value: 'red', important: false },
    ])
  })

  it('returns [] for an empty or whitespace value', () => {
    expect(parseDeclarations('')).toEqual([])
    expect(parseDeclarations('   ')).toEqual([])
  })
})

describe('serializeDeclarations', () => {
  it('round-trips through parse with canonical spacing', () => {
    const declarations = parseDeclarations('color:red;font-size:12px')
    expect(serializeDeclarations(declarations)).toBe('color: red; font-size: 12px')
  })

  it('restores !important', () => {
    expect(serializeDeclarations(parseDeclarations('color: red !important'))).toBe(
      'color: red !important',
    )
  })
})

describe('getDeclaration', () => {
  it('finds a declaration case-insensitively, or null', () => {
    const declarations = parseDeclarations('Color: red')
    expect(getDeclaration(declarations, 'color')).toBe('red')
    expect(getDeclaration(declarations, 'COLOR')).toBe('red')
    expect(getDeclaration(declarations, 'font-size')).toBeNull()
  })
})

describe('upsertDeclaration', () => {
  it('replaces an existing value in place, preserving order and every other declaration', () => {
    const before = parseDeclarations('color: red; font-size: 12px; margin: 0')
    const after = upsertDeclaration(before, 'font-size', '20px')
    expect(serializeDeclarations(after)).toBe('color: red; font-size: 20px; margin: 0')
  })

  it('appends a new declaration when the property is absent', () => {
    const after = upsertDeclaration(parseDeclarations('color: red'), 'font-size', '20px')
    expect(serializeDeclarations(after)).toBe('color: red; font-size: 20px')
  })

  it('does not mutate its input', () => {
    const before = parseDeclarations('color: red')
    upsertDeclaration(before, 'color', 'blue')
    expect(before[0]!.value).toBe('red')
  })

  it('matches the property case-insensitively when upserting', () => {
    const after = upsertDeclaration(parseDeclarations('Color: red'), 'color', 'blue')
    expect(serializeDeclarations(after)).toBe('color: blue')
  })
})

describe('parseTransform', () => {
  it('parses an ordered function list', () => {
    expect(parseTransform('translate(10px, 20px) rotate(4deg)')).toEqual([
      { name: 'translate', args: '10px, 20px' },
      { name: 'rotate', args: '4deg' },
    ])
  })

  it('returns [] for an unparseable or empty value', () => {
    expect(parseTransform('')).toEqual([])
    expect(parseTransform('none')).toEqual([])
  })
})

describe('upsertTransform', () => {
  it('replaces only the named function, preserving order and the rest', () => {
    expect(upsertTransform('translate(1px, 2px) rotate(4deg)', 'translate', '9px, 8px')).toBe(
      'translate(9px, 8px) rotate(4deg)',
    )
  })

  it('appends the function when absent', () => {
    expect(upsertTransform('rotate(4deg)', 'translate', '9px, 8px')).toBe(
      'rotate(4deg) translate(9px, 8px)',
    )
  })

  it('inserts into an empty transform', () => {
    expect(upsertTransform('', 'translate', '9px, 8px')).toBe('translate(9px, 8px)')
  })
})
