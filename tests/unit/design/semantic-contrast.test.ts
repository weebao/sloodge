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
