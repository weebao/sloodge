import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

/**
 * The semantic text tokens (`danger`, `warning`) are readable on the ground they sit on, in both
 * modes (M4.5, review round 4).
 *
 * The status bar's import notice was given `text-danger` / `text-warning` with light values only,
 * on a footer that is `dark:bg-ink`: 6.26:1 and 5.68:1 on `chrome`, but 2.52:1 and 2.77:1 on
 * `ink` — the one affordance that round existed to make visible, invisible to a dark-mode user.
 * The token guard next door could not see it: both tokens were declared, just not for that ground.
 *
 * Two halves. The values: every pair below clears WCAG's 4.5:1 for normal text, computed from the
 * value in `theme.css` rather than trusted from a comment (danger-dark 6.99:1, warning-dark 7.25:1
 * on `ink` as shipped). The usage: a `text-danger` or `text-warning` utility in the renderer carries
 * its `dark:` twin on the same line — under this theme's mode-bound naming (`chrome-*` / `ink-*`,
 * ui-design-direction.md §5.1) that twin is the only way a value swaps with the mode. Mutation:
 * drop `dark:text-danger-dark` from StatusBar.tsx and the usage test reds naming the line; set
 * `--color-danger-dark` to the light value and the contrast test reds with the ratio.
 *
 * **M8b.2 moved two of the four values under this test.** `danger` and `warning` are canonical role
 * names, so the role block took them over: they are now declared in a second `@theme static { … }`
 * block, in `oklch()`, with dark values that swap in `:root` (audit §5.9). The reader below
 * therefore spans every `@theme` block and parses `oklch()` as well as `#rrggbb` — dropping the two
 * light pairs instead would have retired the guard at the moment its subject changed notation. The
 * usage half is deliberately untouched: R1's carve-out keeps the `dark:` twins on `StatusBar.tsx`
 * until the §7-row-7 status-bar PR removes twins and assertion together, which is also the PR that
 * re-points this half at the 63-pair census.
 */

const RENDERER_ROOT = join(process.cwd(), 'src', 'renderer', 'src')
const THEME_FILE = join(RENDERER_ROOT, 'styles', 'theme.css')

/** Foreground token on the ground it is used against: light text on `chrome`, dark on `ink`. */
const PAIRS: readonly [fg: string, bg: string][] = [
  ['danger', 'chrome'],
  ['warning', 'chrome'],
  ['danger-dark', 'ink'],
  ['warning-dark', 'ink'],
]

type Rgb = readonly [r: number, g: number, b: number]

/**
 * `--color-<name>` declarations across every `@theme` / `@theme static` block, as sRGB in 0–1.
 *
 * Brace-aware and multi-block for the same reason `theme-tokens.test.ts` is: the role block is a
 * second `@theme static { … }` and contains a nested `@keyframes`, both of which the single
 * non-greedy `@theme\s*\{([\s\S]*?)\}` this replaces read straight past.
 */
function themeColours(css: string): ReadonlyMap<string, Rgb> {
  const out = new Map<string, Rgb>()
  for (const opener of css.matchAll(/@theme(?:\s+static)?\s*\{/g)) {
    let depth = 1
    let i = opener.index + opener[0].length
    const start = i
    for (; i < css.length && depth > 0; i += 1) {
      if (css[i] === '{') depth += 1
      else if (css[i] === '}') depth -= 1
    }
    for (const m of css.slice(start, i - 1).matchAll(/--color-([a-z0-9-]+)\s*:\s*([^;]+);/g)) {
      const rgb = parseColour(m[2]!.trim())
      if (rgb) out.set(m[1]!, rgb)
    }
  }
  return out
}

const clamp01 = (c: number): number => Math.min(1, Math.max(0, c))
const toGamma = (c: number): number => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055)

/**
 * `#rrggbb` or `oklch(L C H)`, the two notations `theme.css` uses. Out-of-gamut OKLCH is clamped
 * per channel, which is what the browser paints and what `scripts/design-inventory.mjs` measures.
 */
function parseColour(value: string): Rgb | null {
  const hex = /^#([0-9a-f]{6})$/.exec(value)
  if (hex) {
    const n = parseInt(hex[1]!, 16)
    return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]
  }
  const ok = /^oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\)$/.exec(value)
  if (!ok) return null
  const [L, C, H] = [Number(ok[1]), Number(ok[2]), Number(ok[3])]
  const h = (H * Math.PI) / 180
  const A = C * Math.cos(h)
  const B = C * Math.sin(h)
  const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3
  const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3
  const s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3
  return [
    clamp01(toGamma(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s)),
    clamp01(toGamma(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s)),
    clamp01(toGamma(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s)),
  ]
}

const toLinear = (c: number): number => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)

/** WCAG 2.x relative luminance. */
function luminance([r, g, b]: Rgb): number {
  return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b)
}

function contrast(a: Rgb, b: Rgb): number {
  const [la, lb] = [luminance(a), luminance(b)]
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

const show = (rgb: Rgb | undefined): string =>
  rgb === undefined
    ? '(not declared)'
    : '#' +
      rgb
        .map((c) =>
          Math.round(c * 255)
            .toString(16)
            .padStart(2, '0'),
        )
        .join('')

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full))
    else if (/\.(ts|tsx)$/.test(entry)) out.push(full)
  }
  return out
}

describe('semantic colour tokens', () => {
  const colours = themeColours(readFileSync(THEME_FILE, 'utf8'))

  it.each(PAIRS)('%s on %s clears 4.5:1', (fg, bg) => {
    // A token this cannot read is a failure, not a skip: a renamed or re-notated declaration is
    // exactly the change that would otherwise retire the pair silently.
    expect(colours.get(fg), `--color-${fg} is not readable from theme.css`).toBeDefined()
    expect(colours.get(bg), `--color-${bg} is not readable from theme.css`).toBeDefined()
    const ratio = contrast(colours.get(fg)!, colours.get(bg)!)
    expect(
      ratio,
      `${fg} ${show(colours.get(fg))} on ${bg} ${show(colours.get(bg))} = ${ratio.toFixed(2)}:1`,
    ).toBeGreaterThanOrEqual(4.5)
  })

  /**
   * M8b.1a: the six spellings audit §8 measured below AA, pinned so they cannot come back.
   *
   * A spelling pin rather than a computed ratio, because four of the six are not computable from
   * `theme.css`: they involve Tailwind's OKLCH palette (`amber-600`, four rows) or an alpha
   * composite over a translucent panel (`chrome-muted/80` over `shell-bg/95` over the mat). The
   * two hover rows ARE computable from declared tokens — review r1 derived 1.00 and 1.24 with this
   * file's own `themeHex`/`luminance` helpers — so they are pinned by spelling for consistency with
   * their four siblings, not from necessity. `--contrast` in
   * `scripts/design-inventory.mjs` resolves both, but it is a calculator over pair specs written
   * in that script, not a source scanner — measured during this change: with
   * `dark:hover:bg-ink-alt` put back in FormatBar.tsx it still printed the fixed 1.24, and the
   * whole suite stayed green. Nothing in `pnpm test` could see any of the six returning, which is
   * why this clause exists. M8b.4 generalises it to every file.
   *
   * Each row also pins its replacement present, so deleting the class outright reds too.
   *
   * The amber needles are the BARE `amber-600`, not `bg-`/`text-`-prefixed. Review r1 found the
   * prefixed form left a real mutation alive: swapping `text-white` for `text-amber-600` on the
   * badge in DesignNotice.tsx reintroduced a 3.19:1 pair and all 14 rows stayed green, because the
   * needle only looked for the background spelling. `grep -r amber-600 src/` is zero, so the bare
   * form has nothing legitimate to collide with.
   */
  const AA_REGRESSIONS: readonly [file: string, bad: string, measured: string, good: string][] = [
    [
      'features/format/FormatBar.tsx',
      'dark:hover:bg-ink-alt',
      '1.00:1 hover on the dark toolbar row',
      'dark:hover:bg-ink-line',
    ],
    [
      'features/design/ArrangeBar.tsx',
      'dark:hover:bg-ink-alt',
      '1.00:1 hover on the dark arrange bar',
      'dark:hover:bg-ink-line',
    ],
    ['features/statusbar/StatusBar.tsx', 'amber-600', '3.06:1 on chrome at 11px', 'text-amber-800'],
    ['features/settings/BudgetTab.tsx', 'amber-600', '3.06:1 on chrome at 12px', 'text-amber-800'],
    [
      'features/design/DesignNotice.tsx',
      'amber-600',
      '3.19:1 under white text at 11px',
      'bg-amber-800',
    ],
    [
      'features/design/SelectionOverlay.tsx',
      'amber-600',
      '3.19:1 under white text at 11px',
      'bg-amber-800',
    ],
    [
      'features/design/PropertyPanel.tsx',
      'text-chrome-muted/80',
      '3.70:1 on the property dock',
      'text-chrome-muted',
    ],
    [
      'features/design/PropertyPanel.tsx',
      'dark:text-ink-muted/80',
      '4.31:1 on the property dock',
      'dark:text-ink-muted',
    ],
  ]

  it.each(AA_REGRESSIONS)('%s no longer spells %s', (file, bad, measured, good) => {
    const src = readFileSync(join(RENDERER_ROOT, ...file.split('/')), 'utf8')
    expect(src, `${bad} measured ${measured}; use ${good}`).not.toContain(bad)
    // Non-vacuity: a pin on an absent string also passes when the whole class is deleted.
    expect(src, `${good} is gone from ${file}, so the pin above proves nothing`).toContain(good)
  })

  it('the Design Mode ✦ glyph carries its dark twin (2.36:1 on ink-alt without one)', () => {
    const file = join(RENDERER_ROOT, 'features', 'design', 'DesignModeToggle.tsx')
    const lines = readFileSync(file, 'utf8')
      .split('\n')
      .filter((l) => /(?<!dark:)text-chrome-muted(?![\w/-])/.test(l))
    expect(lines.length).toBeGreaterThan(0)
    for (const l of lines) {
      expect(l.trim(), 'text-chrome-muted with no dark twin is 2.36:1 on ink-alt').toContain(
        'dark:text-ink-muted',
      )
    }
  })

  /**
   * M8b.1c: no opaque `bg-accent` fill carries `text-white`.
   *
   * M8b.2 gave `accent` a lighter dark value (`oklch(0.67 0.176 34.8)` against light's
   * `oklch(0.554 …)`), which turned every hard-coded `text-white` on an opaque accent fill from
   * 5.19:1 into **3.23:1** — the worst text pair in the app and below AA. The fix is the
   * `on-fill` role token, which is white in light and `oklch(0.18 0.006 286)` in dark: 5.19:1
   * and 5.83:1. `Button.tsx:33` already spelt it; nine other sites did not.
   *
   * Why a scanner and not nine more `AA_REGRESSIONS` rows. Five of the files lose `text-white`
   * entirely, so a blanket spelling pin would work there — but `SelectionOverlay.tsx` keeps four
   * legitimate `text-white` uses (over `bg-black/70` HUD pills and the fixed `bg-amber-800`
   * editing frame, 7.13:1 and unaffected by the mode), so a file-level pin would either red on
   * innocent code or be scoped so narrowly it stops watching. The subject here is a *pair*, so
   * the guard looks for the pair.
   *
   * Two rules, because the defect is not always on one line. Class strings are split into
   * segments at every quote, backtick and `${`/`}` boundary, so the two arms of a ternary are
   * distinct segments:
   *
   *  1. a segment with an opaque `bg-accent` must not also spell `text-white` — this catches the
   *     eight single-line sites;
   *  2. a segment with an opaque `bg-accent` that names no foreground at all inherits one from
   *     its surroundings, so the neighbouring lines must not spell `text-white` — this catches
   *     `SelectionOverlay.tsx`, where the pre-fix `text-white` sat on the template literal's
   *     static head (line 921) and `bg-accent` in the interpolated `!isEditing` arm one line
   *     below. A single-line grep returned eight sites and missed the ninth.
   *
   * Rule 2 is why the fix moved the badge's foreground into each ternary arm rather than swapping
   * the shared one: `on-fill` on the amber arm would be 2.64:1 in dark.
   *
   * `bg-accent/5`, `/10`, `/20` and `bg-accent-soft` are excluded by the needle — they are tints,
   * not fills, the text over them is `shell-fg`/`ink-fg`, and swapping those would be wrong.
   *
   * Mutations run on this file: restoring `text-white` at ChatPanel.tsx:225 reds rule 1 naming
   * the file and line; restoring the pre-fix split shape at SelectionOverlay.tsx:921/922 reds
   * rule 2; deleting the `text-on-fill` from all ten paired sites reds the non-vacuity count.
   */
  it('no opaque bg-accent fill is painted with text-white (3.23:1 in dark)', () => {
    const OPAQUE_ACCENT = /(?<![\w-])bg-accent(?![\w/-])/
    const WHITE = /(?<![\w-])text-white(?![\w-])/
    const ON_FILL = /(?<![\w-])text-on-fill(?![\w-])/
    /** Quote, backtick and interpolation boundaries — one class string per segment. */
    const SEGMENTS = /[`'"]|\$\{|\}/
    // Any TEXT COLOUR the segment sets for itself. Not `text-sm` or `text-[13px]`, which are size.
    // Rule 2 below is about a fill that inherits its foreground; a fill naming its own must not be
    // judged by whatever happens to sit six lines away.
    // The `:` in the lookbehind is load-bearing. A VARIANT-prefixed foreground — `hover:text-ink-fg`,
    // `dark:text-ink-fg` — does not answer the RESTING colour, so it must not skip rule 2. Review r2
    // found both shapes escaping: with only `[\w-]` excluded they matched, the fill was skipped, and
    // an inherited `text-white` two lines up went unreported where the round-1 guard had caught it.
    const TW_PALETTE =
      'red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|slate|gray|zinc|neutral|stone'
    const OWN_FOREGROUND = new RegExp(
      `(?<![\\w:-])text-(?:white|black|on-fill|current|inherit|transparent` +
        `|ink[\\w-]*|shell[\\w-]*|chrome[\\w-]*|canvas[\\w-]*|text[\\w-]*|hud[\\w-]*|guide[\\w-]*` +
        `|accent[\\w-]*|danger[\\w-]*|warning[\\w-]*|success[\\w-]*` +
        `|(?:${TW_PALETTE})-\\d{2,3})(?![\\w-])`,
    )

    const offenders: string[] = []
    let fills = 0
    let paired = 0
    for (const file of sourceFiles(RENDERER_ROOT)) {
      const lines = readFileSync(file, 'utf8').split('\n')
      lines.forEach((line, i) => {
        for (const segment of line.split(SEGMENTS)) {
          if (!OPAQUE_ACCENT.test(segment)) continue
          fills += 1
          const where = `${relative(process.cwd(), file)}:${i + 1}`
          if (WHITE.test(segment)) {
            offenders.push(`${where} → text-white on an opaque bg-accent`)
            continue
          }
          if (ON_FILL.test(segment)) {
            paired += 1
            continue
          }
          // Rule 2, and only where it applies. A fill that names its OWN foreground is already
          // answered — judging it by a `text-white` six lines away reds on innocent code with a
          // message describing a check the code was not making. Review r1 found exactly that.
          if (OWN_FOREGROUND.test(segment)) continue
          // No foreground of its own: the colour comes from the surrounding markup. The ±6-line
          // window is the honest limit — a fill inheriting `text-white` from further away escapes.
          // Widening it WOULD trade that for false reds on unrelated siblings, but review r2 measured
          // that it costs nothing on this tree: ±20, ±40, ±100 and whole-file all stay green. So 6 is
          // not a measured optimum, just a conservative default; M8b.4 owns the real fix.
          const near = lines.slice(Math.max(0, i - 6), i + 7).join('\n')
          if (WHITE.test(near)) {
            offenders.push(`${where} → bg-accent inherits a text-white declared within 6 lines`)
          }
        }
      })
    }
    // Non-vacuity, both halves: the scanner must still find accent fills at all, and the ten
    // that exist must still name `on-fill` — otherwise a deleted class would pass this silently.
    expect(fills, 'no opaque bg-accent found; the scanner has lost its subject').toBeGreaterThan(0)
    expect(offenders, 'use text-on-fill: white is 3.23:1 on the dark accent').toEqual([])
    // A floor, not a census. It catches the swap being deleted wholesale, but it will also fall
    // LEGITIMATELY when M8b.3 migrates these call sites onto `<Button>`, which spells `text-on-fill`
    // once inside the primitive instead of ten times here. So it must not assert a cause it cannot
    // know: an M8b.3 agent reading "the swap has been undone" would be told something false.
    expect(
      paired,
      `only ${String(paired)} opaque bg-accent fills spell text-on-fill (was 10). Either the swap ` +
        'was reverted, or these sites moved onto <Button>, which spells it internally — check ' +
        'which before lowering this floor.',
    ).toBeGreaterThanOrEqual(10)
  })

  it('every text-danger / text-warning utility in the renderer carries its dark twin', () => {
    const unpaired: string[] = []
    let seen = 0
    for (const file of sourceFiles(RENDERER_ROOT)) {
      readFileSync(file, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          for (const m of line.matchAll(/(?<![\w:-])text-(danger|warning)(?![\w-])/g)) {
            seen += 1
            if (!line.includes(`dark:text-${m[1]!}-dark`)) {
              unpaired.push(`${relative(process.cwd(), file)}:${i + 1} → ${m[0]}`)
            }
          }
        })
    }
    // A pin that passes on the empty set is silent when the affordance it exists for is deleted.
    expect(seen).toBeGreaterThan(0)
    expect(unpaired).toEqual([])
  })
})
