/**
 * The theme-token quick row's pure resolution (M3.8): a deck's `Theme` → the ordered swatch list the
 * panel renders, and a swatch → the `var(--sl-*)` value the panel writes. The write form is the
 * load-bearing decision (a token reference, not a literal, so the element stays re-themeable), and the
 * key hygiene is a security boundary (a forward-compat catchall key is attacker-influenceable data).
 */

import { describe, expect, it } from 'vitest'
import {
  CORE_ORDER,
  DEFAULT_THEME_SWATCHES,
  themeColorSwatches,
  themeSwatchWriteValue,
  themeTokenName,
} from '../../../src/shared/design/theme-swatches'
import { isSafeStyleValue } from '../../../src/shared/design/patch'
import { THEME_TOKEN_NAME_PATTERN } from '../../../src/shared/document/starter-slide'
import type { Theme, ThemeColors } from '../../../src/shared/document/types'

/** A plain colour map — cast to `ThemeColors` at the boundary. The catchall index signature and the
 *  schema's optional keys are incompatible under a spread, so tests build with `Record` and cast. */
type ColorMap = Record<string, string>

function makeTheme(color: ColorMap, series?: readonly string[]): Theme {
  return {
    formatVersion: 1,
    id: 't_test',
    name: 'Test',
    mode: 'dark',
    tokens: {
      color: color as ThemeColors,
      font: {},
      size: {},
      space: {},
      ...(series === undefined ? {} : { series: [...series] }),
    },
  }
}

const BASE: ColorMap = {
  bg: '#0d1220',
  fg: '#f0f0f5',
  accent: '#4c8dff',
  muted: '#9aa4b8',
}

describe('themeColorSwatches', () => {
  it('returns the default palette when there is no theme', () => {
    expect(themeColorSwatches(null)).toEqual(DEFAULT_THEME_SWATCHES)
    expect(DEFAULT_THEME_SWATCHES.map((s) => s.key)).toEqual(['bg', 'fg', 'accent', 'muted'])
  })

  it('emits core colours in a fixed order, then series', () => {
    const theme = makeTheme({ ...BASE, surface: '#1a2035' }, ['#111111', '#222222', '#333333'])
    expect(themeColorSwatches(theme).map((s) => s.key)).toEqual([
      'bg',
      'fg',
      'accent',
      'muted',
      'surface',
      'series-0',
      'series-1',
      'series-2',
    ])
  })

  it('surfaces the resolved hex for each token', () => {
    const swatch = themeColorSwatches(makeTheme(BASE)).find((s) => s.key === 'accent')
    expect(swatch?.hex).toBe('#4c8dff')
  })

  it('includes forward-compat catchall colours after the core set', () => {
    const theme = makeTheme({ ...BASE, brand: '#abcdef' })
    expect(themeColorSwatches(theme).some((s) => s.key === 'brand')).toBe(true)
  })

  it('drops a catchall key that is not a clean token name (injection guard)', () => {
    const hostile: ColorMap = { ...BASE, 'x); color: red; --y: (': '#ffffff' }
    const keys = themeColorSwatches(makeTheme(hostile)).map((s) => s.key)
    expect(keys).toEqual(['bg', 'fg', 'accent', 'muted'])
  })

  it('drops an UPPERCASE-leading catchall key (it could never be declared)', () => {
    const shouty: ColorMap = { ...BASE, UPPER: '#ff0000' }
    expect(themeColorSwatches(makeTheme(shouty)).some((s) => s.key === 'UPPER')).toBe(false)
  })

  it('normalises a camelCase catchall key rather than emitting an undeclarable name', () => {
    const camel: ColorMap = { ...BASE, camelKey: '#ff0000' }
    const swatch = themeColorSwatches(makeTheme(camel)).find((s) => s.key === 'camelKey')
    expect(swatch).toBeDefined()
    expect(themeSwatchWriteValue(swatch!)).toBe('var(--sl-camel-key, #ff0000)')
  })

  it('drops an absurdly long key (bounded source and accessibility strings)', () => {
    const long: ColorMap = { ...BASE, ['a'.repeat(5000)]: '#ff0000' }
    expect(themeColorSwatches(makeTheme(long))).toHaveLength(4)
  })

  it('drops a key that collides on the same token name (no two swatches, one reference)', () => {
    // `themeTokenName` lowercases, so these two distinct keys name the identical custom property.
    // Only the first may become a swatch — two visually different swatches writing the same var()
    // reference would misrepresent what clicking them does.
    const colliding: ColorMap = { ...BASE, accentFg: '#111111', accentFG: '#eeeeee' }
    const swatches = themeColorSwatches(makeTheme(colliding))
    const references = swatches.map((s) => themeSwatchWriteValue(s))
    expect(new Set(references).size).toBe(references.length)
    const accentFgSwatches = swatches.filter((s) => themeTokenName(s.key) === '--sl-accent-fg')
    expect(accentFgSwatches).toHaveLength(1)
    // Deterministic: CORE_ORDER runs first, so the core `accentFg` spelling wins.
    expect(accentFgSwatches[0]!.key).toBe('accentFg')
    expect(accentFgSwatches[0]!.hex).toBe('#111111')
  })

  it('every swatch list has unique token names', () => {
    const theme = makeTheme({ ...BASE, accentFg: '#fff', surface: '#1a2035', brand: '#abcdef' }, [
      '#111111',
      '#222222',
      '#333333',
    ])
    const tokens = themeColorSwatches(theme).map((s) => themeTokenName(s.key))
    expect(new Set(tokens).size).toBe(tokens.length)
  })

  it('drops a non-hex value defensively', () => {
    const bad: ColorMap = { ...BASE, weird: 'not-a-color' }
    expect(themeColorSwatches(makeTheme(bad)).some((s) => s.key === 'weird')).toBe(false)
  })
})

describe('the reference namespace equals the declaration namespace', () => {
  /**
   * The cross-check that keeps this module pinned to `starter-slide.ts`'s emitter. CSS custom-property
   * names are case-sensitive and the emitter only ever declares `/^--[a-z0-9-]+$/`, so a token name
   * outside that set is a permanently dead reference — it renders from its hex fallback and never
   * responds to a re-theme. Every key we ship must map into the declarable set.
   */
  it('EVERY core key produces a token name THEME_TOKEN_NAME_PATTERN accepts', () => {
    for (const [key] of CORE_ORDER) {
      expect(THEME_TOKEN_NAME_PATTERN.test(themeTokenName(key))).toBe(true)
    }
  })

  it('kebab-cases camelCase keys (accentFg is declarable, --sl-accentFg would not be)', () => {
    expect(themeTokenName('accentFg')).toBe('--sl-accent-fg')
    expect(themeTokenName('accent')).toBe('--sl-accent')
    expect(themeTokenName('series-0')).toBe('--sl-series-0')
  })

  it('every swatch a real theme yields is declarable, series included', () => {
    const theme = makeTheme({ ...BASE, accentFg: '#ffffff', surface: '#1a2035' }, [
      '#111111',
      '#222222',
      '#333333',
    ])
    const swatches = themeColorSwatches(theme)
    expect(swatches.length).toBeGreaterThan(4)
    for (const swatch of swatches) {
      expect(THEME_TOKEN_NAME_PATTERN.test(themeTokenName(swatch.key))).toBe(true)
    }
  })

  it('every default-palette swatch is declarable too', () => {
    for (const swatch of DEFAULT_THEME_SWATCHES) {
      expect(THEME_TOKEN_NAME_PATTERN.test(themeTokenName(swatch.key))).toBe(true)
    }
  })
})

describe('themeSwatchWriteValue', () => {
  it('writes a var() token reference with the resolved hex as a fallback', () => {
    expect(themeSwatchWriteValue({ key: 'accent', hex: '#4c8dff', label: 'Accent' })).toBe(
      'var(--sl-accent, #4c8dff)',
    )
    expect(themeSwatchWriteValue({ key: 'series-0', hex: '#111111', label: 'Series 1' })).toBe(
      'var(--sl-series-0, #111111)',
    )
  })

  it('references the kebab-cased, declarable name for a camelCase key', () => {
    expect(themeSwatchWriteValue({ key: 'accentFg', hex: '#ffffff', label: 'Accent text' })).toBe(
      'var(--sl-accent-fg, #ffffff)',
    )
  })

  it('emits a value that passes the single-property write guard', () => {
    for (const swatch of themeColorSwatches(makeTheme({ ...BASE, surface: '#1a2035' }))) {
      expect(isSafeStyleValue(themeSwatchWriteValue(swatch))).toBe(true)
    }
  })
})
