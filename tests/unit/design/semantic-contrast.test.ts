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
 * hex in `theme.css` rather than trusted from a comment (danger-dark 6.99:1, warning-dark 7.25:1
 * on `ink` as shipped). The usage: a `text-danger` or `text-warning` utility in the renderer carries
 * its `dark:` twin on the same line — under this theme's mode-bound naming (`chrome-*` / `ink-*`,
 * ui-design-direction.md §5.1) that twin is the only way a value swaps with the mode. Mutation:
 * drop `dark:text-danger-dark` from StatusBar.tsx and the usage test reds naming the line; set
 * `--color-danger-dark` to the light value and the contrast test reds with the ratio.
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

function themeHex(css: string): ReadonlyMap<string, string> {
  const block = /@theme\s*\{([\s\S]*?)\}/.exec(css)?.[1] ?? ''
  return new Map(
    [...block.matchAll(/--color-([a-z0-9-]+)\s*:\s*(#[0-9a-f]{6})\b/g)].map((m) => [m[1]!, m[2]!]),
  )
}

/** WCAG 2.x relative luminance of `#rrggbb`. */
function luminance(hex: string): number {
  const channel = (i: number): number => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5)
}

function contrast(a: string, b: string): number {
  const [la, lb] = [luminance(a), luminance(b)]
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

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
  const hex = themeHex(readFileSync(THEME_FILE, 'utf8'))

  it.each(PAIRS)('%s on %s clears 4.5:1', (fg, bg) => {
    const ratio = contrast(hex.get(fg)!, hex.get(bg)!)
    expect(
      ratio,
      `${fg} ${hex.get(fg)} on ${bg} ${hex.get(bg)} = ${ratio.toFixed(2)}:1`,
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
