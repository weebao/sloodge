import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

/**
 * Every theme colour a Tailwind utility names must exist in `theme.css`.
 *
 * Tailwind v4 generates nothing for a utility whose colour token is undefined — no error, no
 * warning, just a missing declaration. That is how `dark:bg-ink-bg` shipped on the property panel
 * (M8b.0 audit): the token was never declared, so the fields kept their light `bg-white` under the
 * dark `text-ink-fg` and rendered at 1.24:1 — invisible in dark mode, green in every test.
 *
 * This test derives the token set from the `@theme` block itself and the namespaces to police from
 * those tokens' first segment, so a new token or a new namespace is covered without editing this
 * file. Mutation check: change any utility under `src/renderer/src` to a colour token that is not in
 * `theme.css` (e.g. `bg-ink` → `bg-ink-bg`) and this test reds, naming the file and line.
 */

const RENDERER_ROOT = join(process.cwd(), 'src', 'renderer', 'src')
const THEME_FILE = join(RENDERER_ROOT, 'styles', 'theme.css')

/** Tailwind utility families that take a colour. Anything else (`w-`, `h-`, `p-`) is not a colour. */
const COLOUR_UTILITIES =
  'bg|text|border|outline|ring|inset-ring|fill|stroke|from|to|via|decoration|placeholder|caret|accent|shadow|inset-shadow|divide'

/** Names declared as `--color-<name>` inside `@theme { … }`. */
function themeColourTokens(css: string): ReadonlySet<string> {
  const block = /@theme\s*\{([\s\S]*?)\}/.exec(css)?.[1] ?? ''
  return new Set([...block.matchAll(/--color-([a-z0-9-]+)\s*:/g)].map((m) => m[1]!))
}

/**
 * Colour tokens referenced by utilities in `source`, restricted to the given namespaces (the first
 * hyphen-segment of each declared token: `ink`, `chrome`, …). Variants (`dark:`, `hover:`), side and
 * offset segments (`border-b-`, `ring-offset-`) and opacity suffixes (`/50`) are stripped; the
 * returned name is exactly what must appear in the theme.
 *
 * Deliberately namespace-scoped: a typo in the namespace segment itself (`bg-inkk-fg`) is skipped,
 * because the same position holds Tailwind's own palette (`bg-white`, `text-red-950`) and we cannot
 * tell a misspelled namespace from a palette colour. Do not widen the pattern to fix that; it would
 * flag every palette class instead.
 */
function referencedColourTokens(
  source: string,
  namespaces: ReadonlySet<string>,
): readonly { token: string; line: number }[] {
  const ns = [...namespaces].join('|')
  const pattern = new RegExp(
    `(?:^|[\\s'"\`{}(),])(?:[a-z-]+:)*(?:${COLOUR_UTILITIES})(?:-(?:[tbrlxyse]|offset))?-((?:${ns})(?:-[a-z0-9]+)*)(?:/\\d+)?(?=$|[\\s'"\`{}(),])`,
    'g',
  )
  const out: { token: string; line: number }[] = []
  source.split('\n').forEach((text, i) => {
    for (const m of text.matchAll(pattern)) out.push({ token: m[1]!, line: i + 1 })
  })
  return out
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

describe('theme colour tokens', () => {
  const tokens = themeColourTokens(readFileSync(THEME_FILE, 'utf8'))
  const namespaces = new Set([...tokens].map((t) => t.split('-')[0]!))

  it('reads the declared token set from theme.css', () => {
    expect(tokens.has('ink')).toBe(true)
    expect(tokens.has('accent-soft')).toBe(true)
    expect(namespaces).toEqual(new Set(['shell', 'chrome', 'accent', 'canvas', 'ink']))
  })

  it('extracts tokens through variants and opacity, and only from colour utilities', () => {
    const refs = referencedColourTokens(
      `className="dark:bg-ink-bg text-shell-fg hover:border-accent/50 dark:border-b-ink-alt ring-offset-chrome inset-ring-ink inset-shadow-ink-alt w-7 h-ink"`,
      namespaces,
    )
    expect(refs.map((r) => r.token)).toEqual([
      'ink-bg',
      'shell-fg',
      'accent',
      'ink-alt',
      'chrome',
      'ink',
      'ink-alt',
    ])
  })

  it('every colour utility under src/renderer/src names a declared token', () => {
    const unresolved: string[] = []
    for (const file of sourceFiles(RENDERER_ROOT)) {
      for (const ref of referencedColourTokens(readFileSync(file, 'utf8'), namespaces)) {
        if (!tokens.has(ref.token)) {
          unresolved.push(`${relative(process.cwd(), file)}:${ref.line} → ${ref.token}`)
        }
      }
    }
    expect(unresolved).toEqual([])
  })
})
