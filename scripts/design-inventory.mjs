#!/usr/bin/env node
/**
 * Design inventory for the renderer (M8b.1). Prints Markdown to stdout.
 *
 * Three sections, each reproducible from source so every number in
 * `.claude/plans/init/research/ui-design-audit.md` can be checked:
 *
 *   node scripts/design-inventory.mjs            # utility + literal inventory, with file:line
 *   node scripts/design-inventory.mjs --contrast # WCAG ratios for every fg/bg pair the app renders
 *   node scripts/design-inventory.mjs --proposed # the same check over the canonical token set
 *
 * Utilities are read from `.tsx` string literals only: the `.ts` files hold no chrome, and their
 * strings (`'transition'`, `'border-color'`) would otherwise read as classes. Raw colour and px
 * literals are read from `.ts`, `.tsx` and `.css`. Comments are stripped first so prose that quotes
 * a class (`w-[188px]` in ThumbnailPreview's header) is not counted as a use.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOT = process.cwd()
const RENDERER = join(ROOT, 'src', 'renderer', 'src')
const THEME = join(RENDERER, 'styles', 'theme.css')
const TAILWIND_THEME = join(ROOT, 'node_modules', 'tailwindcss', 'theme.css')

const out = []
const print = (line = '') => out.push(line)

// ---------------------------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------------------------

function walk(dir) {
  const files = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) files.push(...walk(full))
    else if (/\.(ts|tsx|css)$/.test(entry)) files.push(full)
  }
  return files.toSorted()
}

const stripComments = (source) =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/^[ \t]*\/\/.*$/gm, '')

const short = (file) => relative(RENDERER, file)

// ---------------------------------------------------------------------------------------------
// Utility classification
// ---------------------------------------------------------------------------------------------

const THEME_CSS = readFileSync(THEME, 'utf8')

/**
 * Names declared under one `@theme` namespace in theme.css: `--text-ui` → `ui`. The
 * `--text-ui--line-height` companion collapses onto `ui`; `--radius-*: initial` resets are skipped.
 * The classifier is built from these at start-up so it follows the theme: a role colour or a named
 * radius is counted from the day it is declared, not from the day someone edits this file.
 */
function themeNames(prefix) {
  const names = new Set()
  for (const m of THEME_CSS.matchAll(
    new RegExp(`--${prefix}-([a-z0-9-]+?)(?:--[a-z-]+)?\\s*:`, 'g'),
  )) {
    names.add(m[1])
  }
  return [...names]
}

/** Utilities theme.css defines with `@utility` — durations and z-index are not v4 namespaces. */
const UTILITY_NAMES = [...THEME_CSS.matchAll(/@utility\s+([a-z0-9-]+)/g)].map((m) => m[1])

/**
 * The 12 mode-bound tokens M8b.3 retires (audit §5.4). Their namespaces stay in the classifier
 * after the declarations are deleted, so a `bg-chrome` that outlives `--color-chrome` is still
 * counted and still shows in the `legacy` column — the blindness `theme-tokens.test.ts` has by
 * design (it derives its namespaces from what is declared) must not be repeated here.
 */
const RETIRED_TOKENS = [
  'shell-bg',
  'shell-fg',
  'chrome',
  'chrome-alt',
  'chrome-line',
  'chrome-muted',
  'canvas-mat',
  'ink',
  'ink-alt',
  'ink-line',
  'ink-fg',
  'ink-muted',
]
const RETIRED = new RegExp(`-(?:${RETIRED_TOKENS.join('|')})(?:/\\d+)?$`)

const alt = (names) => names.map((n) => `|${n}`).join('')

const COLOUR_NAMESPACES = [
  ...new Set([
    ...themeNames('color').map((n) => n.split('-')[0]),
    ...RETIRED_TOKENS.map((n) => n.split('-')[0]),
  ]),
]
const TOKEN_NS = `(?:${COLOUR_NAMESPACES.join('|')})(?:-[a-z]+)*`
const PALETTE = '(?:white|black|transparent|current|inherit|[a-z]+-\\d{2,3})'
const COLOUR_VALUE = `(?:${TOKEN_NS}|${PALETTE})(?:/\\d+)?|\\[(?:#|rgb|oklch|hsl|var)[^\\]]*\\]`
const SPACING_NAMES = alt(themeNames('spacing'))
const ARBITRARY = '\\[[^\\]]+\\]'

/** Ordered: the first matching category wins, so colour outranks the width/style fallbacks. */
const CATEGORIES = [
  [
    'colour',
    new RegExp(
      `^(?:bg|text|border(?:-[tbrlxyse])?|outline|ring|ring-offset|fill|stroke|placeholder|accent|decoration|from|to|via|divide|shadow)-(${COLOUR_VALUE})$`,
    ),
  ],
  ['border-style', /^(?:border|outline)-(?:solid|dashed|dotted|double|none|hidden)$/],
  [
    'spacing',
    new RegExp(
      `^-?(?:p|px|py|pt|pr|pb|pl|m|mx|my|mt|mr|mb|ml|gap|gap-x|gap-y|space-x|space-y|inset|inset-x|inset-y|top|right|bottom|left)-(?:\\d+(?:\\.\\d+)?|px|auto|${ARBITRARY}${SPACING_NAMES})$`,
    ),
  ],
  [
    'size',
    new RegExp(
      `^(?:w|h|min-w|max-w|min-h|max-h|size)-(?:\\d+(?:\\.\\d+)?|px|auto|full|screen|fit|\\d+/\\d+|${ARBITRARY}${SPACING_NAMES})$`,
    ),
  ],
  [
    'radius',
    new RegExp(
      `^rounded(?:-(?:t|b|l|r|tl|tr|bl|br|s|e|ss|se|es|ee))?(?:-(?:none|xs|sm|md|lg|xl|2xl|3xl|full|${ARBITRARY}${alt(themeNames('radius'))}))?$`,
    ),
  ],
  [
    'shadow',
    new RegExp(
      `^shadow(?:-(?:2xs|xs|sm|md|lg|xl|2xl|none|inner|${ARBITRARY}${alt(themeNames('shadow'))}))?$`,
    ),
  ],
  [
    'font-size',
    new RegExp(`^text-(?:xs|sm|base|lg|xl|\\dxl|${ARBITRARY}${alt(themeNames('text'))})$`),
  ],
  [
    'font-weight',
    new RegExp(
      `^font-(?:thin|extralight|light|normal|medium|semibold|bold|extrabold|black${alt(themeNames('font-weight'))})$`,
    ),
  ],
  [
    'leading',
    new RegExp(
      `^leading-(?:none|tight|snug|normal|relaxed|loose|\\d+|${ARBITRARY}${alt(themeNames('leading'))})$`,
    ),
  ],
  [
    'tracking',
    new RegExp(
      `^tracking-(?:tighter|tight|normal|wide|wider|widest|${ARBITRARY}${alt(themeNames('tracking'))})$`,
    ),
  ],
  [
    'type-style',
    /^(?:uppercase|lowercase|capitalize|normal-case|italic|not-italic|tabular-nums|font-mono|font-serif|font-sans|underline|line-through|truncate|whitespace-[a-z-]+|text-(?:left|center|right))$/,
  ],
  [
    'border-width',
    /^(?:border|outline|ring|ring-offset|divide-[xy])(?:-[tbrlxyse])?(?:-(?:0|1|2|4|8|px|\[[^\]]+\]))?$/,
  ],
  [
    'motion',
    new RegExp(
      `^(?:transition(?:-(?:all|colors|opacity|shadow|transform|none))?|duration-\\d+|ease-(?:in|out|in-out|linear${alt(themeNames('ease'))})|delay-\\d+|animate-[a-z-]+${alt(UTILITY_NAMES.filter((n) => n.startsWith('duration-')))})$`,
    ),
  ],
  ['opacity', /^opacity-\d+$/],
  [
    'z-index',
    new RegExp(
      `^z-(?:\\d+|auto|${ARBITRARY}${alt(UTILITY_NAMES.filter((n) => n.startsWith('z-')).map((n) => n.slice(2)))})$`,
    ),
  ],
  ['effect', /^(?:backdrop-blur(?:-[a-z0-9]+)?|blur-[a-z0-9]+)$/],
  ['cursor', /^cursor-[a-z-]+$/],
]

/**
 * A chain of Tailwind variants (`dark:hover:`) in front of a utility. A fixed list, not `[a-z-]+:`,
 * so a CSS selector in a string (`button:not(…)`) is not mistaken for a variant.
 */
const VARIANT_NAMES =
  'dark|hover|focus|focus-visible|focus-within|active|disabled|enabled|placeholder|group-hover|group-focus|peer-checked|first|last|odd|even|checked|open|motion-reduce|motion-safe|print|before|after|sm|md|lg|xl|2xl'
const VARIANT_PREFIX = new RegExp(`^((?:(?:${VARIANT_NAMES}):)+)(?=[a-z[-])`)

function classify(raw) {
  const variants = VARIANT_PREFIX.exec(raw)?.[1] ?? ''
  const bare = raw.slice(variants.length)
  for (const [category, pattern] of CATEGORIES) {
    if (pattern.test(bare)) return { category, bare, variants }
  }
  return null
}

// ---------------------------------------------------------------------------------------------
// Inventory
// ---------------------------------------------------------------------------------------------

function inventory() {
  const files = walk(RENDERER)
  /** category → bare utility → [{ file, line, variants }] */
  const byCategory = new Map()
  /** variant prefix → count */
  const variantCounts = new Map()
  const literals = [] // { file, line, text }
  const pxLiterals = []
  const perFile = new Map()

  for (const file of files) {
    const source = stripComments(readFileSync(file, 'utf8'))
    const lines = source.split('\n')
    const isTsx = file.endsWith('.tsx')
    const isCss = file.endsWith('.css')

    lines.forEach((text, i) => {
      const line = i + 1
      for (const m of text.matchAll(
        /#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)|oklch\([^)]*\)|hsla?\([^)]*\)/g,
      )) {
        literals.push({ file, line, text: m[0] })
      }
      if (!isCss) {
        for (const m of text.matchAll(/['"`][^'"`]*?\b(\d+(?:\.\d+)?px)\b[^'"`]*?['"`]/g)) {
          pxLiterals.push({ file, line, text: m[1] })
        }
      }
      if (!isTsx) return
      // Split on everything that delimits a class inside a string or template literal — but not
      // on `:`, which joins a variant to its utility.
      for (const token of text.split(/[\s'"`{}$;=<>?]+/)) {
        if (token === '') continue
        const variants = VARIANT_PREFIX.exec(token)?.[1] ?? ''
        const f = perFile.get(file) ?? { colour: 0, legacy: 0, arbitrary: 0, dark: 0, total: 0 }
        perFile.set(file, f)
        // Variants are counted on every utility-shaped token, classified or not: a `dark:` on a
        // token this classifier does not know yet still moves the column the M8b.3 gate reads.
        for (const v of variants.split(':').filter(Boolean)) {
          variantCounts.set(v, (variantCounts.get(v) ?? 0) + 1)
        }
        if (variants.includes('dark:')) f.dark += 1
        const hit = classify(token)
        if (hit === null) continue
        const bucket = byCategory.get(hit.category) ?? new Map()
        byCategory.set(hit.category, bucket)
        const sites = bucket.get(hit.bare) ?? []
        sites.push({ file, line, variants: hit.variants })
        bucket.set(hit.bare, sites)
        f.total += 1
        if (hit.category === 'colour') {
          f.colour += 1
          if (RETIRED.test(hit.bare)) f.legacy += 1
        }
        if (hit.bare.includes('[')) f.arbitrary += 1
      }
    })
  }

  print('# Design inventory (generated by `scripts/design-inventory.mjs`)')
  print()
  print(`Scanned ${String(files.length)} files under \`src/renderer/src\`.`)
  print()

  const order = [
    'colour',
    'spacing',
    'size',
    'radius',
    'shadow',
    'font-size',
    'font-weight',
    'leading',
    'tracking',
    'type-style',
    'border-width',
    'border-style',
    'motion',
    'opacity',
    'z-index',
    'effect',
    'cursor',
  ]
  for (const category of order) {
    const bucket = byCategory.get(category)
    if (!bucket) continue
    const rows = [...bucket.entries()].toSorted((a, b) => b[1].length - a[1].length)
    const total = rows.reduce((n, [, s]) => n + s.length, 0)
    print(`## ${category} — ${String(rows.length)} distinct, ${String(total)} uses`)
    print()
    print('| utility | uses | sites |')
    print('| --- | --- | --- |')
    for (const [bare, sites] of rows) {
      const cites = [...new Set(sites.map((s) => `${short(s.file)}:${String(s.line)}`))]
      const shown =
        cites.slice(0, 8).join(', ') + (cites.length > 8 ? ` +${String(cites.length - 8)}` : '')
      print(`| \`${bare}\` | ${String(sites.length)} | ${shown} |`)
    }
    print()
  }

  print('## variants')
  print()
  print('| variant | uses |')
  print('| --- | --- |')
  for (const [v, n] of [...variantCounts.entries()].toSorted((a, b) => b[1] - a[1])) {
    print(`| \`${v}:\` | ${String(n)} |`)
  }
  print()

  print('## raw colour literals')
  print()
  for (const l of literals) print(`- \`${l.text}\` — ${short(l.file)}:${String(l.line)}`)
  print()
  print('## px literals inside strings')
  print()
  for (const l of pxLiterals) print(`- \`${l.text}\` — ${short(l.file)}:${String(l.line)}`)
  print()

  print('## per file')
  print()
  print(
    'The `legacy` column counts colour utilities on the 12 retired tokens; `dark:` counts every `dark:` variant in the file, whether or not the utility is classified.',
  )
  print()
  print('| file | utilities | colour | legacy | `dark:` | arbitrary |')
  print('| --- | --- | --- | --- | --- | --- |')
  const totals = { colour: 0, legacy: 0, arbitrary: 0, dark: 0 }
  for (const [file, f] of [...perFile.entries()].toSorted((a, b) => b[1].total - a[1].total)) {
    print(
      `| ${short(file)} | ${String(f.total)} | ${String(f.colour)} | ${String(f.legacy)} | ${String(f.dark)} | ${String(f.arbitrary)} |`,
    )
    for (const k of Object.keys(totals)) totals[k] += f[k]
  }
  print()
  print(
    `Totals: colour ${String(totals.colour)}, legacy ${String(totals.legacy)}, \`dark:\` ${String(totals.dark)}, arbitrary ${String(totals.arbitrary)}.`,
  )
}

// ---------------------------------------------------------------------------------------------
// Colour maths (sRGB / OKLCH / WCAG 2.1)
// ---------------------------------------------------------------------------------------------

function hexToRgb(hex) {
  let h = hex.slice(1)
  if (h.length === 3 || h.length === 4) h = [...h].map((c) => c + c).join('')
  const n = Number.parseInt(h.slice(0, 6), 16)
  const a = h.length === 8 ? Number.parseInt(h.slice(6, 8), 16) / 255 : 1
  return { r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255, a }
}

const toLinear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
const toGamma = (c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055)
const clamp01 = (c) => Math.min(1, Math.max(0, c))

function oklchToRgb(L, C, H, a = 1) {
  const h = (H * Math.PI) / 180
  const A = C * Math.cos(h)
  const B = C * Math.sin(h)
  const lp = L + 0.3963377774 * A + 0.2158037573 * B
  const mp = L - 0.1055613458 * A - 0.0638541728 * B
  const sp = L - 0.0894841775 * A - 1.291485548 * B
  const l = lp ** 3
  const m = mp ** 3
  const s = sp ** 3
  const lr = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s
  const lg = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s
  const lb = -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s
  return { r: clamp01(toGamma(lr)), g: clamp01(toGamma(lg)), b: clamp01(toGamma(lb)), a }
}

function rgbToOklch({ r, g, b }) {
  const lr = toLinear(r)
  const lg = toLinear(g)
  const lb = toLinear(b)
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb)
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb)
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb)
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s
  const C = Math.hypot(A, B)
  const H = ((Math.atan2(B, A) * 180) / Math.PI + 360) % 360
  return { L, C, H }
}

function parseColour(text) {
  const t = text.trim()
  if (t.startsWith('#')) return hexToRgb(t)
  const m = /^oklch\(\s*([\d.]+)(%?)\s+([\d.]+)\s+([\d.]+|none)\s*(?:\/\s*([\d.]+)(%?))?\)$/.exec(t)
  if (m) {
    const L = Number(m[1]) / (m[2] === '%' ? 100 : 1)
    const H = m[4] === 'none' ? 0 : Number(m[4])
    const a = m[5] === undefined ? 1 : Number(m[5]) / (m[6] === '%' ? 100 : 1)
    return oklchToRgb(L, Number(m[3]), H, a)
  }
  throw new Error(`unparseable colour: ${text}`)
}

const toHex = ({ r, g, b }) =>
  '#' +
  [r, g, b]
    .map((c) =>
      Math.round(c * 255)
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')

const fmtOklch = (rgb) => {
  const { L, C, H } = rgbToOklch(rgb)
  return `oklch(${L.toFixed(3)} ${C.toFixed(3)} ${C < 0.0005 ? '—' : H.toFixed(1)})`
}

function luminance({ r, g, b }) {
  return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b)
}

function contrast(a, b) {
  const la = luminance(a)
  const lb = luminance(b)
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

function over(top, alpha, bottom) {
  const a = alpha * top.a
  return {
    r: top.r * a + bottom.r * (1 - a),
    g: top.g * a + bottom.g * (1 - a),
    b: top.b * a + bottom.b * (1 - a),
    a: 1,
  }
}

/** `--color-<name>: <value>` declarations from a CSS file, in order. */
function readColourVars(css) {
  const vars = new Map()
  for (const m of css.matchAll(/--color-([a-z0-9-]+)\s*:\s*([^;]+);/g)) {
    vars.set(m[1], parseColour(m[2]))
  }
  return vars
}

/**
 * Resolves a layer spec such as `chrome-muted/80 over shell-bg/95 over canvas`, right to left:
 * the last layer must be opaque (or an alias that resolves to one), each earlier layer is
 * composited over the result.
 */
function makeResolver(palette, aliases) {
  const resolve = (spec) => {
    const layers = spec.split(' over ').map((s) => s.trim())
    let colour = null
    for (let i = layers.length - 1; i >= 0; i -= 1) {
      const layer = layers[i]
      if (aliases.has(layer)) {
        const resolved = resolve(aliases.get(layer))
        colour = colour === null ? resolved : over(resolved, 1, colour)
        continue
      }
      const m = /^([a-z0-9-]+)(?:\/(\d+))?$/.exec(layer)
      if (!m || !palette.has(m[1])) throw new Error(`unknown colour "${layer}" in "${spec}"`)
      const base = palette.get(m[1])
      const alpha = m[2] === undefined ? 1 : Number(m[2]) / 100
      colour = colour === null ? { ...base, a: 1 } : over(base, alpha, colour)
    }
    return colour
  }
  return resolve
}

const THRESHOLD = { text: 4.5, ui: 3, state: null, disabled: null, decor: null }

function contrastTable(title, pairs, resolveLight, resolveDark, describePair, lastColumn) {
  const ratio = (resolve, [fg, bg]) => contrast(resolve(`${fg} over ${bg}`), resolve(bg))
  print(`## ${title}`)
  print()
  print(
    'Kinds: `text` needs 4.5:1 (WCAG 1.4.3, all chrome text is under 18.66px bold), `ui` needs 3:1 (1.4.11), `state` is a hover/pressed fill against its rest colour (no WCAG floor; reported because an invisible hover is a defect), `disabled` and `decor` are exempt and reported for completeness.',
  )
  print()
  print(`| # | kind | pair | light | dark | verdict | ${lastColumn} |`)
  print('| --- | --- | --- | --- | --- | --- | --- |')
  let failures = 0
  let worst = { ratio: Infinity }
  pairs.forEach((pair, i) => {
    const rl = ratio(resolveLight, pair.light)
    const rd = ratio(resolveDark, pair.dark)
    const floor = THRESHOLD[pair.kind]
    const failL = floor !== null && rl < floor
    const failD = floor !== null && rd < floor
    const verdict =
      floor === null
        ? '—'
        : failL && failD
          ? '**fail both**'
          : failL
            ? '**fail light**'
            : failD
              ? '**fail dark**'
              : 'pass'
    if (failL || failD) {
      failures += 1
      const r = Math.min(failL ? rl : Infinity, failD ? rd : Infinity)
      if (r < worst.ratio) worst = { ratio: r, n: i + 1 }
    }
    print(
      `| ${String(i + 1)} | ${pair.kind} | ${describePair(pair)} | ${rl.toFixed(2)} | ${rd.toFixed(2)} | ${verdict} | ${pair.sites} |`,
    )
  })
  print()
  print(
    `**${String(pairs.length)} pairs, ${String(failures)} failing in at least one mode.**` +
      (worst.n === undefined ? '' : ` Worst: #${String(worst.n)} at ${worst.ratio.toFixed(2)}:1.`),
  )
  print()
}

// ---------------------------------------------------------------------------------------------
// Current palette + the pairs the shipped renderer draws
// ---------------------------------------------------------------------------------------------

function currentPalette() {
  const palette = readColourVars(readFileSync(TAILWIND_THEME, 'utf8'))
  for (const [k, v] of readColourVars(readFileSync(THEME, 'utf8'))) palette.set(k, v)
  return palette
}

/** Composite grounds the chrome actually sits on; see the audit §3 for the derivations. */
const CURRENT_ALIASES = new Map([
  ['canvas.light', 'canvas-mat/25 over shell-bg'], // SlideCanvas.tsx:96
  ['canvas.dark', 'black/40 over ink'],
  ['panel.light', 'shell-bg/95 over canvas.light'], // PropertyPanel.tsx:165
  ['panel.dark', 'ink-alt/95 over canvas.dark'],
  ['scrim.light', 'black/40 over shell-bg'], // SettingsDialog.tsx:134, ExportPptxDialog.tsx:61
  ['scrim.dark', 'black/40 over ink'],
  ['hud.light', 'black/70 over white'], // pills over a white slide — SlideCanvas.tsx:137
  ['hud.dark', 'black/70 over ink-alt'],
  ['present', 'black/70 over black'], // PresentControls.tsx:47 over the black stage
  ['arrange.light', 'white/95 over white'], // ArrangeBar.tsx:145 floats over the slide
  ['arrange.dark', 'ink-alt/95 over ink-alt'],
])

const p = (kind, light, dark, sites) => ({ kind, light, dark, sites })

const CURRENT_PAIRS = [
  // -- body text on each ground ------------------------------------------------------------
  p('text', ['shell-fg', 'shell-bg'], ['ink-fg', 'ink'], 'AppShell:163'),
  p(
    'text',
    ['shell-fg', 'white'],
    ['ink-fg', 'ink-alt'],
    'AppShell:170, FormatBar:16/45, DesignModeToggle:47, StatusBar:182, ChatPanel:141/257, SlideContextMenu:169, BudgetTab:279',
  ),
  p(
    'text',
    ['shell-fg', 'chrome'],
    ['ink-fg', 'ink'],
    'SettingsDialog:151/175/200/222/253/267, AuthTab:167/193/221/245/251, BudgetTab:184/228/252/285, ChatPanel:187',
  ),
  p('text', ['shell-fg', 'chrome-alt'], ['ink-fg', 'ink-alt'], 'AuthTab:136/176'),
  p('text', ['shell-fg', 'white'], ['ink-fg', 'ink'], 'PropertyPanel:334 (field)'),
  p('text', ['shell-fg', 'panel.light'], ['ink-fg', 'panel.dark'], 'PropertyPanel:363/371/379'),
  p('text', ['shell-fg', 'canvas.light'], ['ink-fg', 'canvas.dark'], 'SlideCanvas:157'),
  p('text', ['chrome-muted', 'canvas.light'], ['ink-muted', 'canvas.dark'], 'SlideCanvas:158'),
  p('text', ['shell-fg', 'arrange.light'], ['ink-fg', 'arrange.dark'], 'ArrangeBar:20'),
  p(
    'text',
    ['shell-fg', 'accent/10 over panel.light'],
    ['ink-fg', 'accent/10 over panel.dark'],
    'PropertyPanel:198',
  ),
  p(
    'text',
    ['shell-fg', 'accent/10 over chrome'],
    ['ink-fg', 'accent/10 over ink'],
    'ChatPanel:148',
  ),
  p('text', ['shell-fg', 'accent/5 over chrome'], ['ink-fg', 'accent/5 over ink'], 'ChatPanel:305'),
  p(
    'text',
    ['shell-fg', 'amber-500/10 over chrome'],
    ['ink-fg', 'amber-500/10 over ink'],
    'BudgetTab:242',
  ),
  // -- muted text --------------------------------------------------------------------------
  p(
    'text',
    ['chrome-muted', 'chrome'],
    ['ink-muted', 'ink'],
    'MenuTabStrip:17, ThumbnailRail:160/335/372, ChatPanel:103/125/165/176/212/215/249, StatusBar:162, SettingsDialog:176/206/247/256/269/272, AuthTab:171/210/225/262/269, BudgetTab:210/268/290/300',
  ),
  p(
    'text',
    ['chrome-muted', 'white'],
    ['ink-muted', 'ink-alt'],
    'ThumbnailPreview:81 (9px), ChatPanel:141 placeholder/258/272/281, ArrangeBar:147',
  ),
  p('text', ['chrome-muted', 'chrome-alt'], ['ink-muted', 'ink-alt'], 'AuthTab:132/140'),
  p(
    'text',
    ['chrome-muted', 'panel.light'],
    ['ink-muted', 'panel.dark'],
    'PropertyPanel:167/177/182/321/358, ColorControls:172',
  ),
  p(
    'text',
    ['chrome-muted/80', 'panel.light'],
    ['ink-muted/80', 'panel.dark'],
    'PropertyPanel:170',
  ),
  p(
    'text',
    ['chrome-muted', 'chrome-line/40 over white'],
    ['ink-muted', 'ink-line/60 over ink-alt'],
    'ChatPanel:289',
  ),
  p('text', ['chrome-muted', 'chrome-line'], ['ink-muted', 'ink-line'], 'DesignModeToggle:57'),
  // -- accent as text ----------------------------------------------------------------------
  p(
    'text',
    ['accent', 'white'],
    ['ink-fg', 'ink-alt'],
    'MenuTabStrip:13 (dark falls back to ink-fg)',
  ),
  p(
    'text',
    ['accent', 'chrome'],
    ['accent', 'ink'],
    'ThumbnailRail:160 selected number, :372 hover',
  ),
  p('text', ['accent', 'white'], ['accent', 'ink-alt'], 'StatusBar:182 hover:text-accent'),
  p(
    'text',
    ['white', 'accent'],
    ['white', 'accent'],
    'DesignModeToggle:57, ChatPanel:198/225/313, SettingsDialog:213, AuthTab:199, SlideContextMenu:169 hover, SelectionOverlay:778/820',
  ),
  // -- semantic text -----------------------------------------------------------------------
  p(
    'text',
    ['white', 'amber-600'],
    ['white', 'amber-600'],
    'DesignNotice:57, SelectionOverlay:821',
  ),
  p('text', ['white', 'red-600'], ['white', 'red-600'], 'BudgetTab:259'),
  p(
    'text',
    ['red-600', 'chrome'],
    ['red-400', 'ink'],
    'StatusBar:64/94, AuthTab:148, BudgetTab:215/295',
  ),
  p('text', ['amber-600', 'chrome'], ['amber-500', 'ink'], 'StatusBar:64/96, BudgetTab:203/221'),
  p(
    'text',
    ['amber-900', 'amber-500/10 over chrome'],
    ['amber-200', 'amber-500/10 over ink'],
    'AuthTab:157',
  ),
  p('text', ['red-800', 'red-50'], ['red-200', 'red-950'], 'ChatPanel:235'),
  // -- HUD / present -----------------------------------------------------------------------
  p(
    'text',
    ['white', 'hud.light'],
    ['white', 'hud.dark'],
    'SlideCanvas:137, SelectionOverlay:834/889/907',
  ),
  p('text', ['white', 'present'], ['white', 'present'], 'PresentControls:47/77'),
  p('text', ['white/90', 'present'], ['white/90', 'present'], 'PresentControls:69'),
  // -- PPTX dialog (no dark treatment at all) ----------------------------------------------
  p('text', ['neutral-900', 'white'], ['neutral-900', 'white'], 'ExportPptxDialog:72/95'),
  p('text', ['neutral-500', 'white'], ['neutral-500', 'white'], 'ExportPptxDialog:75/96'),
  p('text', ['neutral-600', 'white'], ['neutral-600', 'white'], 'ExportPptxDialog:111'),
  p('text', ['white', 'neutral-900'], ['white', 'neutral-900'], 'ExportPptxDialog:118'),
  p('text', ['amber-800', 'amber-50'], ['amber-800', 'amber-50'], 'ExportPptxDialog:102'),
  // -- UI components: borders that identify a control (1.4.11) ------------------------------
  p(
    'ui',
    ['chrome-line', 'white'],
    ['ink-line', 'ink-alt'],
    'FormatBar:45 select, DesignModeToggle:47, StatusBar:182, ChatPanel:141 composer, BudgetTab:279, ColorControls:182',
  ),
  p(
    'ui',
    ['chrome-line', 'chrome'],
    ['ink-line', 'ink'],
    'ThumbnailRail:168/372, ChatPanel:165/187, AuthTab:128/193/245/251, BudgetTab:252/285, SettingsDialog:222',
  ),
  p(
    'ui',
    ['chrome-line', 'panel.light'],
    ['ink-line', 'panel.dark'],
    'PropertyPanel:334/363/371/379, ColorControls:96/182/190',
  ),
  p('ui', ['chrome-line', 'arrange.light'], ['ink-line', 'arrange.dark'], 'ArrangeBar:145'),
  p(
    'ui',
    ['chrome-line', 'canvas.light'],
    ['ink-line', 'canvas.dark'],
    'SlideCanvas:123 slide outline',
  ),
  p('ui', ['neutral-200', 'white'], ['neutral-200', 'white'], 'ExportPptxDialog:84'),
  // -- field fills against their panel (1.4.11: is the field identifiable at all?) ---------
  p('ui', ['chrome', 'chrome'], ['ink', 'ink'], 'AuthTab:193/245 field fill = panel fill'),
  p('ui', ['white', 'chrome'], ['ink-alt', 'ink'], 'ChatPanel:141, BudgetTab:279 field fill'),
  p('ui', ['white', 'panel.light'], ['ink', 'panel.dark'], 'PropertyPanel:334 field fill'),
  // -- accent as a UI colour (rings, focus, indicators, handles) ----------------------------
  p(
    'ui',
    ['accent', 'chrome'],
    ['accent', 'ink'],
    'ThumbnailRail:159 focus ring, :167 selected ring, :148 drop indicator, SettingsDialog:175 tab underline',
  ),
  p(
    'ui',
    ['accent', 'white'],
    ['accent', 'ink-alt'],
    'DesignModeToggle:47 focus outline, ChatPanel:141 focus border',
  ),
  p('ui', ['accent', 'white'], ['accent', 'ink'], 'PropertyPanel:334 focus border'),
  p(
    'ui',
    ['accent/60 over panel.light', 'panel.light'],
    ['accent/60 over panel.dark', 'panel.dark'],
    'PropertyPanel:198 border',
  ),
  p(
    'ui',
    ['accent/50 over chrome', 'chrome'],
    ['accent/50 over ink', 'ink'],
    'ChatPanel:148 border',
  ),
  p(
    'ui',
    ['accent/40 over chrome', 'chrome'],
    ['accent/40 over ink', 'ink'],
    'ChatPanel:305 border',
  ),
  p(
    'ui',
    ['accent', 'white'],
    ['accent', 'white'],
    'SelectionOverlay:849/867 handle border on white fill',
  ),
  p(
    'ui',
    ['chrome-muted', 'white'],
    ['chrome-muted', 'ink-alt'],
    'DesignModeToggle:49 ✦ glyph, no dark variant',
  ),
  p('ui', ['accent', 'white'], ['accent', 'ink-alt'], 'DesignModeToggle:49 ✦ glyph when enabled'),
  p(
    'ui',
    ['chrome-muted', 'accent/10 over chrome'],
    ['ink-muted', 'accent/10 over ink'],
    'ChatPanel:156 chip ×',
  ),
  // -- semantic UI -------------------------------------------------------------------------
  p(
    'ui',
    ['amber-500/50 over chrome', 'chrome'],
    ['amber-500/50 over ink', 'ink'],
    'AuthTab:157 border',
  ),
  p(
    'ui',
    ['amber-500/60 over chrome', 'chrome'],
    ['amber-500/60 over ink', 'ink'],
    'BudgetTab:242 border',
  ),
  p('ui', ['red-300', 'chrome'], ['red-800', 'ink'], 'ChatPanel:235 border'),
  p(
    'ui',
    ['amber-500', 'white'],
    ['amber-500', 'white'],
    'SelectionOverlay:814 editing frame on a white slide',
  ),
  p(
    'ui',
    ['fuchsia-500', 'white'],
    ['fuchsia-500', 'white'],
    'SelectionOverlay:790 smart guide on a white slide',
  ),
  // -- hover / pressed fills against the rest colour ----------------------------------------
  p(
    'state',
    ['chrome-alt', 'white'],
    ['ink-alt', 'ink-alt'],
    'FormatBar:16 hover on the toolbar row',
  ),
  p('state', ['chrome-alt', 'arrange.light'], ['ink-alt', 'arrange.dark'], 'ArrangeBar:20 hover'),
  p('state', ['chrome-alt', 'white'], ['ink-line', 'ink-alt'], 'DesignModeToggle:47 hover'),
  p('state', ['chrome-line', 'white'], ['chrome-line', 'white'], 'FormatBar:16 active (no dark)'),
  p(
    'state',
    ['chrome-line/40 over chrome', 'chrome'],
    ['chrome', 'chrome'],
    'ChatPanel:187 hover (no dark)',
  ),
  p(
    'state',
    ['white/15 over present', 'present'],
    ['white/15 over present', 'present'],
    'PresentControls:56/65/77 hover',
  ),
  p('state', ['neutral-50', 'white'], ['neutral-50', 'white'], 'ExportPptxDialog:84 hover'),
  p('state', ['neutral-100', 'white'], ['neutral-100', 'white'], 'ExportPptxDialog:111 hover'),
  // -- disabled (exempt) -------------------------------------------------------------------
  p(
    'disabled',
    ['shell-fg/40', 'arrange.light'],
    ['ink-fg/40', 'arrange.dark'],
    'ArrangeBar:20 disabled:opacity-40',
  ),
  p(
    'disabled',
    ['shell-fg/50', 'white'],
    ['ink-fg/50', 'ink'],
    'PropertyPanel:334 disabled:opacity-50',
  ),
  p(
    'disabled',
    ['white', 'accent/50 over chrome'],
    ['white', 'accent/50 over ink'],
    'AuthTab:199 disabled:opacity-50',
  ),
  p(
    'disabled',
    ['white', 'accent/40 over chrome'],
    ['white', 'accent/40 over ink'],
    'ChatPanel:198 disabled:opacity-40',
  ),
  p(
    'disabled',
    ['white/30', 'present'],
    ['white/30', 'present'],
    'PresentControls:56 disabled:opacity-30',
  ),
  p(
    'disabled',
    ['chrome-muted', 'white'],
    ['ink-muted', 'ink-alt'],
    'SlideContextMenu:169 disabled',
  ),
  // -- decorative (aria-hidden) -------------------------------------------------------------
  p(
    'decor',
    ['chrome-line', 'white'],
    ['ink-line', 'ink-alt'],
    'FormatBar:41, ArrangeBar:150/164 dividers',
  ),
  p(
    'decor',
    ['chrome-line', 'chrome'],
    ['ink-line', 'ink'],
    'StatusBar:55/167/174 dividers, :132 budget track',
  ),
  p(
    'decor',
    ['accent', 'chrome-line'],
    ['accent', 'ink-line'],
    'StatusBar:134 budget fill vs track',
  ),
  p(
    'decor',
    ['chrome-line', 'scrim.light'],
    ['ink-line', 'scrim.dark'],
    'SettingsDialog:146 dialog border',
  ),
]

// ---------------------------------------------------------------------------------------------
// Proposed (canonical) palette — audit §5. Values are the ones the document publishes.
// ---------------------------------------------------------------------------------------------

const PROPOSED_LIGHT = `
  --color-surface: oklch(0.985 0.002 286);
  --color-surface-raised: oklch(1 0 0);
  --color-surface-sunken: oklch(0.955 0.003 286);
  --color-field: oklch(1 0 0);
  --color-hover: oklch(0.945 0.003 286);
  --color-pressed: oklch(0.905 0.004 286);
  --color-canvas: oklch(0.885 0 0);
  --color-line: oklch(0.905 0.004 286);
  --color-line-strong: oklch(0.600 0.008 286);
  --color-text: oklch(0.222 0.004 286);
  --color-text-muted: oklch(0.485 0.006 286);
  --color-accent: oklch(0.554 0.176 34.8);
  --color-accent-soft: oklch(0.955 0.020 34.8);
  --color-on-fill: oklch(1 0 0);
  --color-focus: oklch(0.600 0.180 34.8);
  --color-danger: oklch(0.505 0.213 27.5);
  --color-danger-soft: oklch(0.971 0.013 17.4);
  --color-warning: oklch(0.473 0.137 46.2);
  --color-warning-soft: oklch(0.987 0.022 95.3);
  --color-success: oklch(0.448 0.119 151.3);
  --color-success-soft: oklch(0.982 0.018 155.8);
  --color-edit: oklch(0.546 0.245 262.9);
  --color-guide: oklch(0.600 0.118 184.7);
  --color-hud: oklch(0 0 0 / 0.7);
  --color-hud-strong: oklch(0 0 0 / 0.85);
  --color-hud-fg: oklch(1 0 0);
  --color-scrim: oklch(0 0 0 / 0.4);
`

const PROPOSED_DARK = `
  --color-surface: oklch(0.241 0.006 286);
  --color-surface-raised: oklch(0.271 0.009 286);
  --color-surface-sunken: oklch(0.215 0.006 286);
  --color-field: oklch(0.215 0.006 286);
  --color-hover: oklch(0.332 0.012 286);
  --color-pressed: oklch(0.390 0.013 286);
  --color-canvas: oklch(0.170 0 0);
  --color-line: oklch(0.332 0.012 286);
  --color-line-strong: oklch(0.560 0.014 286);
  --color-text: oklch(0.926 0.005 286);
  --color-text-muted: oklch(0.709 0.014 286);
  --color-accent: oklch(0.670 0.176 34.8);
  --color-accent-soft: oklch(0.330 0.055 34.8);
  --color-on-fill: oklch(0.180 0.006 286);
  --color-danger: oklch(0.704 0.191 22.2);
  --color-danger-soft: oklch(0.258 0.092 26.0);
  --color-warning: oklch(0.769 0.188 70.1);
  --color-warning-soft: oklch(0.279 0.077 45.6);
  --color-success: oklch(0.792 0.209 151.7);
  --color-success-soft: oklch(0.266 0.065 152.9);
  --color-edit: oklch(0.707 0.165 254.6);
  --color-guide: oklch(0.777 0.152 181.9);
  --color-hud-fg: oklch(1 0 0);
`

const q = (kind, fg, bg, sites) => p(kind, [fg, bg], [fg, bg], sites)

const PROPOSED_PAIRS = [
  q('text', 'text', 'surface', 'body on rail / chat / status bar / dialogs'),
  q('text', 'text', 'surface-raised', 'body on toolbar row, menus, bubbles'),
  q('text', 'text', 'surface-sunken', 'body on cards / code'),
  q('text', 'text', 'field', 'input values'),
  q('text', 'text', 'hover', 'button label on hover fill'),
  q('text', 'text', 'pressed', 'button label on pressed fill'),
  q('text', 'text', 'canvas', 'empty-state title on the mat'),
  q('text', 'text', 'accent-soft', 'label on a tinted chip'),
  q('text', 'text-muted', 'surface', 'captions, headings, status text'),
  q('text', 'text-muted', 'surface-raised', 'placeholders, bubble labels'),
  q('text', 'text-muted', 'surface-sunken', 'card captions'),
  q('text', 'text-muted', 'field', 'placeholder text'),
  q('text', 'text-muted', 'hover', 'muted label on hover fill'),
  q('text', 'text-muted', 'canvas', 'empty-state caption on the mat'),
  q('text', 'accent', 'surface', 'selected slide number, links'),
  q('text', 'accent', 'surface-raised', 'Home tab label'),
  q(
    'ui',
    'accent',
    'accent-soft',
    'accent icon or border on the tint (never accent text — rule R4)',
  ),
  q('text', 'on-fill', 'accent', 'filled buttons, user bubble, overlay labels'),
  q('text', 'on-fill', 'warning', 'DesignNotice, editing label'),
  q('text', 'on-fill', 'success', 'filled success chip'),
  q('text', 'on-fill', 'edit', 'editing-frame label'),
  q('text', 'danger', 'surface', 'error lines'),
  q('text', 'danger', 'surface-raised', 'error lines on raised'),
  q('text', 'danger', 'danger-soft', 'error bubble text'),
  q('text', 'on-fill', 'danger', 'destructive filled button'),
  q('text', 'warning', 'surface', 'budget warn, skills fallback'),
  q('text', 'warning', 'surface-raised', 'warning on raised'),
  q('text', 'warning', 'warning-soft', 'warning notice text'),
  q('text', 'success', 'surface', 'saved / ok lines'),
  q('text', 'success', 'success-soft', 'success notice text'),
  q('text', 'hud-fg', 'hud over surface-raised', 'zoom pill, overlay dimension label'),
  q('text', 'hud-fg', 'hud over canvas', 'HUD over the mat'),
  q('text', 'hud-fg', 'hud-strong over surface-raised', 'HUD pill on hover'),
  q('text', 'hud-fg/70', 'hud over surface-raised', 'secondary HUD text (breadcrumb parents)'),
  q('text', 'text', 'danger-soft', 'Notice body on a danger tint'),
  q('text', 'text', 'warning-soft', 'Notice body on a warning tint'),
  q('text', 'text', 'success-soft', 'Notice body on a success tint'),
  q('ui', 'line-strong', 'surface', 'control border on panels'),
  q('ui', 'line-strong', 'surface-raised', 'control border on the toolbar row'),
  q('ui', 'line-strong', 'field', 'input border vs its own fill'),
  q('ui', 'line-strong', 'surface-sunken', 'control border in a card'),
  q('ui', 'focus', 'surface', 'focus ring on panels'),
  q('ui', 'focus', 'surface-raised', 'focus ring on the toolbar row'),
  q('ui', 'focus', 'field', 'focus ring on inputs'),
  q('ui', 'focus', 'canvas', 'focus ring on the canvas'),
  q('ui', 'accent', 'surface', 'selected ring, tab underline, drop indicator'),
  q('ui', 'accent', 'surface-raised', 'handles / selection box over a white slide'),
  q('ui', 'accent', 'field', 'accent border on a field'),
  q('ui', 'edit', 'surface-raised', 'editing frame over a white slide'),
  q('ui', 'guide', 'surface-raised', 'smart guide over a white slide'),
  q('ui', 'danger', 'surface', 'danger border / icon'),
  q('ui', 'warning', 'surface', 'warning border / icon'),
  q('ui', 'success', 'surface', 'success border / icon'),
  q(
    'state',
    'field',
    'surface',
    'field fill vs panel — the line-strong border identifies the field (pairs 30–33)',
  ),
  q('state', 'field', 'surface-raised', 'field fill vs toolbar row — identified by its border'),
  q('state', 'hover', 'surface', 'hover fill on a panel'),
  q('state', 'hover', 'surface-raised', 'hover fill on the toolbar row'),
  q('state', 'pressed', 'hover', 'pressed vs hover'),
  q('state', 'surface-sunken', 'surface', 'well vs panel'),
  q('state', 'surface-raised', 'surface', 'raised vs panel'),
  q('decor', 'line', 'surface', 'hairline on a panel'),
  q('decor', 'line', 'surface-raised', 'hairline on the toolbar row'),
  q('decor', 'line', 'canvas', 'slide outline on the mat'),
]

/** `--color-<name>: <value>` as written, for the declared-vs-rendered table. */
const declaredColourText = (css) =>
  new Map([...css.matchAll(/--color-([a-z0-9-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]))

function proposedReport() {
  const light = readColourVars(PROPOSED_LIGHT)
  const dark = new Map(light)
  for (const [k, v] of readColourVars(PROPOSED_DARK)) dark.set(k, v)
  const lightText = declaredColourText(PROPOSED_LIGHT)
  const darkText = declaredColourText(PROPOSED_DARK)
  print('# Canonical token set — declared values, rendered sRGB, measured contrast')
  print()
  print(
    'The declared column is the string theme.css must carry (M8b.2 compares against it byte for byte). The hex column is what the browser paints — a few Tailwind-derived semantic steps sit just outside sRGB and are clipped, so a hex round-tripped back to OKLCH will not equal the declaration at three decimals.',
  )
  print()
  print('| token | light (declared) | hex | dark (declared) | hex |')
  print('| --- | --- | --- | --- | --- |')
  const hex = (c) => (c.a < 1 ? '—' : toHex(c))
  for (const name of light.keys()) {
    const d = darkText.get(name)
    print(
      `| \`${name}\` | \`${lightText.get(name)}\` | ${hex(light.get(name))} | ${d === undefined ? '(same)' : `\`${d}\``} | ${d === undefined ? '' : hex(dark.get(name))} |`,
    )
  }
  print()
  contrastTable(
    'Proposed pairs',
    PROPOSED_PAIRS,
    makeResolver(light, new Map()),
    makeResolver(dark, new Map()),
    (pair) => `\`${pair.light[0]}\` on \`${pair.light[1]}\``,
    'role',
  )
}

// ---------------------------------------------------------------------------------------------

const mode = process.argv[2] ?? '--inventory'
if (mode === '--contrast') {
  const palette = currentPalette()
  print('# Current palette')
  print()
  print('| token | hex | oklch |')
  print('| --- | --- | --- |')
  for (const [name, value] of readColourVars(readFileSync(THEME, 'utf8'))) {
    print(`| \`${name}\` | ${toHex(value)} | ${fmtOklch(value)} |`)
  }
  print()
  print('Composite grounds used below (opaque results):')
  print()
  const resolve = makeResolver(palette, CURRENT_ALIASES)
  for (const [alias, spec] of CURRENT_ALIASES) {
    print(`- \`${alias}\` = ${spec} → ${toHex(resolve(alias))}`)
  }
  print()
  contrastTable(
    'Measured contrast — shipped renderer',
    CURRENT_PAIRS,
    resolve,
    resolve,
    (pair) =>
      pair.light.join(' / ') === pair.dark.join(' / ')
        ? `\`${pair.light.join('` on `')}\` (no dark variant)`
        : `\`${pair.light.join('` on `')}\` · dark \`${pair.dark.join('` on `')}\``,
    'sites',
  )
} else if (mode === '--proposed') {
  proposedReport()
} else {
  inventory()
}

process.stdout.write(out.join('\n') + '\n')
