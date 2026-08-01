/**
 * Pure colour parsing / normalisation for M3.8's colour controls (§5.1-5.2 of
 * `.claude/plans/init/40-design-mode.md`, the roadmap M3.8 row). The property panel's swatch, native
 * picker and eyedropper all funnel a colour value through here before it is written back to the slide
 * **source** via the M3.3 byte-span patch layer, so this module has one job: turn the shapes a colour
 * can take in real slides (`#abc`, `#aabbcc`, `#aabbccdd`, `rgb(...)`, `rgba(...)`, `red`,
 * `transparent`) into a canonical hex string, and back into the 6-digit form a native
 * `<input type="color">` accepts — **never dropping alpha silently** on the way.
 *
 * ## Why hex is the written form, and why alpha is preserved explicitly
 *
 * A native colour input only speaks `#rrggbb` — it cannot represent alpha at all. So the picker's UI
 * value and the value we *write* are two different things: the swatch seeds from the 6-digit form
 * (`toColorInputValue`), but the write re-attaches whatever alpha the source declared
 * (`applyPickedColor`). Reading `rgba(20, 24, 40, .5)` and writing back `#141828` would silently make
 * a translucent fill opaque; the plan's colour path must not do that, so alpha carries through.
 *
 * ## Safety
 *
 * Every string this module *emits* is either a hex literal or a value assembled from clamped integers
 * — none can contain `;`, `{` or `}`, so `isSafeStyleValue` (the single-property write guard in
 * `patch.ts`) always accepts it. Parsing is total: any input it cannot make sense of returns `null`,
 * which the caller treats as "not a colour, do not write", rather than throwing.
 */

/** A colour as clamped channels: `r`/`g`/`b` are integers in `[0, 255]`, `a` is a float in `[0, 1]`. */
export interface Rgba {
  readonly r: number
  readonly g: number
  readonly b: number
  readonly a: number
}

/**
 * The CSS named colours (Level 4 extended set) plus `transparent`, lowercased. A named colour is
 * resolved to its hex and then parsed like any other hex, so every downstream path (alpha, 6-digit
 * form) is shared. `transparent` maps to fully-transparent black, matching the CSS keyword.
 */
const NAMED_COLORS: Readonly<Record<string, string>> = {
  transparent: '#00000000',
  aliceblue: '#f0f8ff',
  antiquewhite: '#faebd7',
  aqua: '#00ffff',
  aquamarine: '#7fffd4',
  azure: '#f0ffff',
  beige: '#f5f5dc',
  bisque: '#ffe4c4',
  black: '#000000',
  blanchedalmond: '#ffebcd',
  blue: '#0000ff',
  blueviolet: '#8a2be2',
  brown: '#a52a2a',
  burlywood: '#deb887',
  cadetblue: '#5f9ea0',
  chartreuse: '#7fff00',
  chocolate: '#d2691e',
  coral: '#ff7f50',
  cornflowerblue: '#6495ed',
  cornsilk: '#fff8dc',
  crimson: '#dc143c',
  cyan: '#00ffff',
  darkblue: '#00008b',
  darkcyan: '#008b8b',
  darkgoldenrod: '#b8860b',
  darkgray: '#a9a9a9',
  darkgreen: '#006400',
  darkgrey: '#a9a9a9',
  darkkhaki: '#bdb76b',
  darkmagenta: '#8b008b',
  darkolivegreen: '#556b2f',
  darkorange: '#ff8c00',
  darkorchid: '#9932cc',
  darkred: '#8b0000',
  darksalmon: '#e9967a',
  darkseagreen: '#8fbc8f',
  darkslateblue: '#483d8b',
  darkslategray: '#2f4f4f',
  darkslategrey: '#2f4f4f',
  darkturquoise: '#00ced1',
  darkviolet: '#9400d3',
  deeppink: '#ff1493',
  deepskyblue: '#00bfff',
  dimgray: '#696969',
  dimgrey: '#696969',
  dodgerblue: '#1e90ff',
  firebrick: '#b22222',
  floralwhite: '#fffaf0',
  forestgreen: '#228b22',
  fuchsia: '#ff00ff',
  gainsboro: '#dcdcdc',
  ghostwhite: '#f8f8ff',
  gold: '#ffd700',
  goldenrod: '#daa520',
  gray: '#808080',
  green: '#008000',
  greenyellow: '#adff2f',
  grey: '#808080',
  honeydew: '#f0fff0',
  hotpink: '#ff69b4',
  indianred: '#cd5c5c',
  indigo: '#4b0082',
  ivory: '#fffff0',
  khaki: '#f0e68c',
  lavender: '#e6e6fa',
  lavenderblush: '#fff0f5',
  lawngreen: '#7cfc00',
  lemonchiffon: '#fffacd',
  lightblue: '#add8e6',
  lightcoral: '#f08080',
  lightcyan: '#e0ffff',
  lightgoldenrodyellow: '#fafad2',
  lightgray: '#d3d3d3',
  lightgreen: '#90ee90',
  lightgrey: '#d3d3d3',
  lightpink: '#ffb6c1',
  lightsalmon: '#ffa07a',
  lightseagreen: '#20b2aa',
  lightskyblue: '#87cefa',
  lightslategray: '#778899',
  lightslategrey: '#778899',
  lightsteelblue: '#b0c4de',
  lightyellow: '#ffffe0',
  lime: '#00ff00',
  limegreen: '#32cd32',
  linen: '#faf0e6',
  magenta: '#ff00ff',
  maroon: '#800000',
  mediumaquamarine: '#66cdaa',
  mediumblue: '#0000cd',
  mediumorchid: '#ba55d3',
  mediumpurple: '#9370db',
  mediumseagreen: '#3cb371',
  mediumslateblue: '#7b68ee',
  mediumspringgreen: '#00fa9a',
  mediumturquoise: '#48d1cc',
  mediumvioletred: '#c71585',
  midnightblue: '#191970',
  mintcream: '#f5fffa',
  mistyrose: '#ffe4e1',
  moccasin: '#ffe4b5',
  navajowhite: '#ffdead',
  navy: '#000080',
  oldlace: '#fdf5e6',
  olive: '#808000',
  olivedrab: '#6b8e23',
  orange: '#ffa500',
  orangered: '#ff4500',
  orchid: '#da70d6',
  palegoldenrod: '#eee8aa',
  palegreen: '#98fb98',
  paleturquoise: '#afeeee',
  palevioletred: '#db7093',
  papayawhip: '#ffefd5',
  peachpuff: '#ffdab9',
  peru: '#cd853f',
  pink: '#ffc0cb',
  plum: '#dda0dd',
  powderblue: '#b0e0e6',
  purple: '#800080',
  rebeccapurple: '#663399',
  red: '#ff0000',
  rosybrown: '#bc8f8f',
  royalblue: '#4169e1',
  saddlebrown: '#8b4513',
  salmon: '#fa8072',
  sandybrown: '#f4a460',
  seagreen: '#2e8b57',
  seashell: '#fff5ee',
  sienna: '#a0522d',
  silver: '#c0c0c0',
  skyblue: '#87ceeb',
  slateblue: '#6a5acd',
  slategray: '#708090',
  slategrey: '#708090',
  snow: '#fffafa',
  springgreen: '#00ff7f',
  steelblue: '#4682b4',
  tan: '#d2b48c',
  teal: '#008080',
  thistle: '#d8bfd8',
  tomato: '#ff6347',
  turquoise: '#40e0d0',
  violet: '#ee82ee',
  wheat: '#f5deb3',
  white: '#ffffff',
  whitesmoke: '#f5f5f5',
  yellow: '#ffff00',
  yellowgreen: '#9acd32',
}

/** Clamp to an integer in `[0, 255]`; non-finite input clamps to 0. */
function clampByte(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(255, Math.max(0, Math.round(value)))
}

/** Clamp to a float in `[0, 1]`; non-finite input clamps to 1 (opaque). */
function clampAlpha(value: number): number {
  if (!Number.isFinite(value)) return 1
  return Math.min(1, Math.max(0, value))
}

/** Two-digit lowercase hex for one byte. */
function hexByte(value: number): string {
  return clampByte(value).toString(16).padStart(2, '0')
}

const HEX_RE = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i

/** Parse a two-character hex pair to a byte. */
function expand(pair: string): number {
  return Number.parseInt(pair, 16)
}

function parseHex(input: string): Rgba | null {
  const match = HEX_RE.exec(input)
  if (match === null) return null
  const digits = match[1]!
  if (digits.length === 3 || digits.length === 4) {
    const r = expand(digits[0]! + digits[0]!)
    const g = expand(digits[1]! + digits[1]!)
    const b = expand(digits[2]! + digits[2]!)
    const a = digits.length === 4 ? expand(digits[3]! + digits[3]!) / 255 : 1
    return { r, g, b, a }
  }
  const r = expand(digits.slice(0, 2))
  const g = expand(digits.slice(2, 4))
  const b = expand(digits.slice(4, 6))
  const a = digits.length === 8 ? expand(digits.slice(6, 8)) / 255 : 1
  return { r, g, b, a }
}

/** Parse one `rgb()` channel: a percentage of 255, or a raw 0-255 number. `null` if not a number. */
function parseChannel(token: string): number | null {
  const trimmed = token.trim()
  if (trimmed.length === 0) return null
  if (trimmed.endsWith('%')) {
    const percent = Number(trimmed.slice(0, -1))
    return Number.isFinite(percent) ? (percent / 100) * 255 : null
  }
  const value = Number(trimmed)
  return Number.isFinite(value) ? value : null
}

/** Parse an alpha token: a percentage or a 0-1 float. `null` if not a number. */
function parseAlphaToken(token: string): number | null {
  const trimmed = token.trim()
  if (trimmed.length === 0) return null
  if (trimmed.endsWith('%')) {
    const percent = Number(trimmed.slice(0, -1))
    return Number.isFinite(percent) ? percent / 100 : null
  }
  const value = Number(trimmed)
  return Number.isFinite(value) ? value : null
}

const RGB_RE = /^rgba?\(([^)]*)\)$/i

/** Parse `rgb(...)`/`rgba(...)`, both the comma form and the modern `r g b / a` slash form. */
function parseRgb(input: string): Rgba | null {
  const match = RGB_RE.exec(input.trim())
  if (match === null) return null
  const body = match[1]!
  // Split alpha off a `/` if present, then split the channels on commas or whitespace.
  const [rgbPart, slashAlpha] = body.includes('/') ? splitOnce(body, '/') : [body, undefined]
  const tokens = rgbPart!.split(/[\s,]+/).filter((token) => token.length > 0)

  // Resolve `[r, g, b]` and the alpha token from the three shapes: `r g b / a`, legacy
  // `rgba(r, g, b, a)`, and a bare `rgb(r, g, b)`.
  let channels: string[]
  let alphaToken: string | undefined
  if (slashAlpha !== undefined) {
    channels = tokens
    alphaToken = slashAlpha
  } else if (tokens.length === 4) {
    channels = tokens.slice(0, 3)
    alphaToken = tokens[3]
  } else {
    channels = tokens
  }
  if (channels.length !== 3) return null

  let alpha = 1
  if (alphaToken !== undefined) {
    const parsed = parseAlphaToken(alphaToken)
    if (parsed === null) return null
    alpha = parsed
  }
  const r = parseChannel(channels[0]!)
  const g = parseChannel(channels[1]!)
  const b = parseChannel(channels[2]!)
  if (r === null || g === null || b === null) return null
  return { r: clampByte(r), g: clampByte(g), b: clampByte(b), a: clampAlpha(alpha) }
}

/** Split `input` into `[before, after]` at the first `sep`; `after` is `undefined` when absent. */
function splitOnce(input: string, sep: string): [string, string | undefined] {
  const index = input.indexOf(sep)
  return index === -1 ? [input, undefined] : [input.slice(0, index), input.slice(index + 1)]
}

/**
 * Parse a CSS colour value into clamped `Rgba`, or `null` when it is not one this module handles.
 * Accepts `#rgb`/`#rgba`/`#rrggbb`/`#rrggbbaa`, `rgb()`/`rgba()` (comma or slash-alpha), and the
 * extended set of CSS named colours plus `transparent`. Leading/trailing whitespace is ignored.
 */
export function parseColor(input: string): Rgba | null {
  const trimmed = input.trim()
  if (trimmed.length === 0) return null
  if (trimmed.startsWith('#')) return parseHex(trimmed)
  if (/^rgba?\(/i.test(trimmed)) return parseRgb(trimmed)
  const named = NAMED_COLORS[trimmed.toLowerCase()]
  return named === undefined ? null : parseHex(named)
}

/** `#rrggbb` for an opaque colour, `#rrggbbaa` when `a < 1` — the canonical written form. */
export function toHex(color: Rgba): string {
  const base = `#${hexByte(color.r)}${hexByte(color.g)}${hexByte(color.b)}`
  return color.a >= 1 ? base : `${base}${hexByte(color.a * 255)}`
}

/** Always the 6-digit `#rrggbb` form, alpha discarded — what a native `<input type="color">` needs. */
export function toHex6(color: Rgba): string {
  return `#${hexByte(color.r)}${hexByte(color.g)}${hexByte(color.b)}`
}

/**
 * Normalise any accepted colour string to canonical hex (preserving alpha), or `null` when the input
 * is not a colour. `normalizeColor('RED')` → `'#ff0000'`; `normalizeColor('rgba(0,0,0,.5)')` →
 * `'#00000080'`; `normalizeColor('nonsense')` → `null`.
 */
export function normalizeColor(input: string): string | null {
  const parsed = parseColor(input)
  return parsed === null ? null : toHex(parsed)
}

/**
 * The 6-digit value to seed a native colour input from a source string. Falls back to `#000000` when
 * the source declares nothing or a value the input cannot represent (a `var(--sl-*)` token, `inherit`),
 * so the widget always has a valid starting swatch even though the source is left untouched until the
 * user actually picks.
 */
export function toColorInputValue(input: string | null): string {
  if (input === null) return '#000000'
  const parsed = parseColor(input)
  return parsed === null ? '#000000' : toHex6(parsed)
}

/**
 * The value to *write* when a user picks `pickedHex` (from the swatch or the eyedropper) for a field
 * whose current source value is `current`. The picked RGB is kept; the **alpha of the current source
 * value is preserved** so picking a new hue for a translucent fill stays translucent. When `current`
 * has no alpha (or is absent/unparseable) the result is the plain 6-digit hex.
 *
 * An **unparseable `pickedHex` is passed through verbatim** rather than rejected here. No caller
 * pre-validates it — the swatch forwards the browser's input value and the eyedropper forwards whatever
 * `EyeDropper` resolved — so the guarantee that a junk value cannot reach the slide is supplied
 * *downstream*, at the single chokepoint every style write funnels through: `isSafeStyleValue` in
 * `patch.ts` rejects the whole batch (zero ops, nothing committed). Passing through rather than
 * silently substituting a colour keeps this function honest about what it was given; the safety is
 * defence-in-depth at the write, not a precondition on the caller.
 */
/**
 * Whether two colour strings denote the *same* colour, comparing parsed channels rather than source
 * bytes — `red`, `#f00`, `#ff0000` and `rgb(255,0,0)` are all equal here. Returns `false` when either
 * side is absent or is not a colour this module understands (`var(--sl-accent)`, `inherit`): two things
 * we cannot compare are not known to be equal, and the caller's safe move is to treat them as different.
 *
 * The panel uses this to drop a no-op commit. `PropertyPanel`'s `patched === map.source` check already
 * absorbs a byte-identical rewrite, but it cannot see that `red` and `#ff0000` are the same colour — so
 * a picker that cancels by *reverting and firing `change`* against a non-canonical source value would
 * otherwise spend one undo entry silently rewriting `color: red` to `color: #ff0000`, for a gesture the
 * user cancelled and with no visible change. Comparing colours, not bytes, is what closes that.
 */
export function sameColor(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return false
  const left = parseColor(a)
  const right = parseColor(b)
  if (left === null || right === null) return false
  // Compare canonical hex rather than raw channels: that is exactly the precision this module *writes*,
  // so "equal" means "would serialize to the same declaration". Comparing raw floats instead would call
  // `rgba(0,0,0,0.5)` and `#00000080` different over the 8-bit quantization of alpha (0.5 vs 0.50196…),
  // and then commit an undo entry whose only effect is to round the alpha.
  return toHex(left) === toHex(right)
}

export function applyPickedColor(current: string | null, pickedHex: string): string {
  const picked = parseColor(pickedHex)
  if (picked === null) return pickedHex
  const previous = current === null ? null : parseColor(current)
  const alpha = previous === null ? picked.a : previous.a
  return toHex({ r: picked.r, g: picked.g, b: picked.b, a: alpha })
}
