/**
 * The theme-token quick row's pure resolution (M3.8): a deck's `Theme` → the ordered swatch list the
 * panel renders, and a swatch → the `var(--sl-*)` value the panel writes. The write form is the
 * load-bearing decision (a token reference, not a literal, so the element stays re-themeable), and the
 * key hygiene is a security boundary (a forward-compat catchall key is attacker-influenceable data).
 */

import { describe, expect, it } from 'vitest'
import {
  DEFAULT_THEME_SWATCHES,
  themeColorSwatches,
  themeSwatchWriteValue,
} from '../../../src/shared/design/theme-swatches'
import { isSafeStyleValue } from '../../../src/shared/design/patch'
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

  it('drops a non-hex value defensively', () => {
    const bad: ColorMap = { ...BASE, weird: 'not-a-color' }
    expect(themeColorSwatches(makeTheme(bad)).some((s) => s.key === 'weird')).toBe(false)
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

  it('emits a value that passes the single-property write guard', () => {
    for (const swatch of themeColorSwatches(makeTheme({ ...BASE, surface: '#1a2035' }))) {
      expect(isSafeStyleValue(themeSwatchWriteValue(swatch))).toBe(true)
    }
  })
})
