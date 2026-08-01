/**
 * CSS colour → OOXML `RRGGBB` + transparency, for PPTX export (M4.3 / 60-export.md §3.3). Pure and
 * exhaustively unit-tested (§7.2): `getComputedStyle` returns `rgb()`/`rgba()` in Chromium, but the
 * walker also sees author values through the measurement pass, so `#rgb`, `#rrggbb(aa)`, `hsl(a)`,
 * the named colours, and `transparent` are all parsed here rather than half-handled at a call site.
 *
 * pptxgenjs wants an uppercase 6-digit hex for `color`/`fill.color` and a separate `transparency`
 * percentage (0 = opaque, 100 = invisible). We normalize to `{ hex, alpha }` (alpha 0–1) so the
 * caller decides — a fully transparent fill is *not painted at all* rather than emitted as a
 * 100 %-transparent shape, which PowerPoint would show as a selectable empty box.
 */

/** A parsed colour: `hex` is 6 uppercase hex digits, `alpha` in [0, 1] (1 = opaque). */
export type ParsedColor = { hex: string; alpha: number }

/**
 * The 16 CSS Level-1 keywords plus the handful generated slides actually use. `getComputedStyle`
 * resolves keywords to `rgb()`, so this only matters for author values seen via the measurement
 * pass; kept small on purpose — the full 148-name table is dead weight the walker never exercises.
 */
const NAMED_COLORS: Readonly<Record<string, string>> = {
  black: '000000',
  white: 'FFFFFF',
  red: 'FF0000',
  green: '008000',
  lime: '00FF00',
  blue: '0000FF',
  yellow: 'FFFF00',
  cyan: '00FFFF',
  aqua: '00FFFF',
  magenta: 'FF00FF',
  fuchsia: 'FF00FF',
  gray: '808080',
  grey: '808080',
  silver: 'C0C0C0',
  maroon: '800000',
  olive: '808000',
  navy: '000080',
  purple: '800080',
  teal: '008080',
  orange: 'FFA500',
}

const clamp255 = (n: number): number => Math.max(0, Math.min(255, Math.round(n)))
const toHex2 = (n: number): string => clamp255(n).toString(16).padStart(2, '0').toUpperCase()

/** Double a single hex digit (`f` → `ff`) for the 3/4-digit shorthand. */
const expandHexDigit = (c: string): string => `${c}${c}`

/** One `rgb()` channel token → 0–255, honouring the `%` form. */
const rgbChannel = (p: string): number =>
  p.endsWith('%') ? (parseFloat(p) / 100) * 255 : parseFloat(p)

/** hue(0–360)/sat(0–1)/light(0–1) → [r, g, b] each 0–255. */
function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const hue = ((h % 360) + 360) % 360
  const c = (1 - Math.abs(2 * l - 1)) * s
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1))
  const m = l - c / 2
  const [r, g, b] =
    hue < 60
      ? [c, x, 0]
      : hue < 120
        ? [x, c, 0]
        : hue < 180
          ? [0, c, x]
          : hue < 240
            ? [0, x, c]
            : hue < 300
              ? [x, 0, c]
              : [c, 0, x]
  return [(r + m) * 255, (g + m) * 255, (b + m) * 255]
}

/**
 * Parse a CSS colour string. Returns `null` for `transparent`, empty, `none`, and anything
 * unrecognized — the caller reads `null` as "do not paint this", which is the correct default for an
 * un-set background rather than a black box.
 */
export function parseCssColor(value: string | null | undefined): ParsedColor | null {
  if (value === null || value === undefined) return null
  const raw = value.trim().toLowerCase()
  if (raw === '' || raw === 'transparent' || raw === 'none') return null

  if (raw in NAMED_COLORS) return { hex: NAMED_COLORS[raw] ?? '000000', alpha: 1 }

  if (raw.startsWith('#')) {
    const hex = raw.slice(1)
    if (hex.length === 3 || hex.length === 4) {
      const r = expandHexDigit(hex[0] ?? '0')
      const g = expandHexDigit(hex[1] ?? '0')
      const b = expandHexDigit(hex[2] ?? '0')
      const a = hex.length === 4 ? parseInt(expandHexDigit(hex[3] ?? 'f'), 16) / 255 : 1
      const parsed = `${r}${g}${b}`.toUpperCase()
      if (/^[0-9A-F]{6}$/.test(parsed)) return { hex: parsed, alpha: a }
      return null
    }
    if (hex.length === 6 || hex.length === 8) {
      const parsed = hex.slice(0, 6).toUpperCase()
      if (!/^[0-9A-F]{6}$/.test(parsed)) return null
      const a = hex.length === 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1
      return { hex: parsed, alpha: a }
    }
    return null
  }

  const rgbMatch = /^rgba?\(([^)]+)\)$/.exec(raw)
  if (rgbMatch) {
    const parts = (rgbMatch[1] ?? '').split(/[,/\s]+/).filter((p) => p !== '')
    if (parts.length < 3) return null
    const r = rgbChannel(parts[0] ?? '0')
    const g = rgbChannel(parts[1] ?? '0')
    const b = rgbChannel(parts[2] ?? '0')
    if (![r, g, b].every(Number.isFinite)) return null
    const alphaRaw = parts[3]
    const alpha =
      alphaRaw === undefined
        ? 1
        : alphaRaw.endsWith('%')
          ? parseFloat(alphaRaw) / 100
          : parseFloat(alphaRaw)
    return {
      hex: `${toHex2(r)}${toHex2(g)}${toHex2(b)}`,
      alpha: Number.isFinite(alpha) ? Math.max(0, Math.min(1, alpha)) : 1,
    }
  }

  const hslMatch = /^hsla?\(([^)]+)\)$/.exec(raw)
  if (hslMatch) {
    const parts = (hslMatch[1] ?? '').split(/[,/\s]+/).filter((p) => p !== '')
    if (parts.length < 3) return null
    const h = parseFloat(parts[0] ?? '0')
    const s = parseFloat((parts[1] ?? '0').replace('%', '')) / 100
    const l = parseFloat((parts[2] ?? '0').replace('%', '')) / 100
    if (![h, s, l].every(Number.isFinite)) return null
    const [r, g, b] = hslToRgb(h, s, l)
    const alphaRaw = parts[3]
    const alpha =
      alphaRaw === undefined
        ? 1
        : alphaRaw.endsWith('%')
          ? parseFloat(alphaRaw) / 100
          : parseFloat(alphaRaw)
    return {
      hex: `${toHex2(r)}${toHex2(g)}${toHex2(b)}`,
      alpha: Number.isFinite(alpha) ? Math.max(0, Math.min(1, alpha)) : 1,
    }
  }

  return null
}

/** pptxgenjs transparency percent (0 = opaque, 100 = invisible) from an alpha in [0, 1]. */
export function alphaToTransparency(alpha: number): number {
  return Math.round((1 - Math.max(0, Math.min(1, alpha))) * 100)
}
