import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
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
 * This test derives the token set from the `@theme` blocks themselves and the namespaces to police
 * from those tokens' first segment, so a new token or a new namespace is covered without editing
 * this file. Mutation check: change any utility under `src/renderer/src` to a colour token that is
 * not in `theme.css` (e.g. `bg-ink` → `bg-ink-bg`) and this test reds, naming the file and line.
 *
 * **Retired-token clause (M8b.2, audit §5.4).** Deriving the policed namespaces from the surviving
 * declarations makes the test blind to the one change M8b.3's last PR performs: delete the fourteen
 * legacy `shell-*` / `chrome-*` / `ink-*` / `canvas-mat` / `*-dark` declarations and the namespaces
 * go with them, so every orphaned utility stops being looked at and the run stays green with
 * hundreds of dead references in the tree. So the policed set is the declared namespaces **union**
 * the retired ones, while the accepted set stays the declared tokens only: a `bg-chrome` left behind
 * after `--color-chrome` is gone is policed and unresolved, which is the failure this clause exists
 * to produce. Mutation: delete those fourteen declarations with the renderer untouched and this test
 * reds at every surviving `.tsx` reference (recorded in the M8b.2 PR body).
 */

const RENDERER_ROOT = join(process.cwd(), 'src', 'renderer', 'src')
const THEME_FILE = join(RENDERER_ROOT, 'styles', 'theme.css')
const GENERATOR = join(process.cwd(), 'scripts', 'design-inventory.mjs')

/** Tailwind utility families that take a colour. Anything else (`w-`, `h-`, `p-`) is not a colour. */
const COLOUR_UTILITIES =
  'bg|text|border|outline|ring|inset-ring|fill|stroke|from|to|via|decoration|placeholder|caret|accent|shadow|inset-shadow|divide'

/**
 * Bodies of every `@theme { … }` / `@theme static { … }` block, matched brace-aware.
 *
 * The single-block, non-greedy version this replaces read only the *first* `@theme {` and stopped at
 * the first `}` inside it. Once M8b.2 added the role block as a second `@theme static { … }` — which
 * contains a nested `@keyframes` — that parser saw neither the role tokens nor anything past the
 * keyframes' first brace, and would have passed while policing nothing it was supposed to police.
 */
function themeBlocks(css: string): readonly string[] {
  const out: string[] = []
  const opener = /@theme(?:\s+static)?\s*\{/g
  for (const m of css.matchAll(opener)) {
    let depth = 1
    let i = m.index + m[0].length
    const start = i
    for (; i < css.length && depth > 0; i += 1) {
      if (css[i] === '{') depth += 1
      else if (css[i] === '}') depth -= 1
    }
    out.push(css.slice(start, i - 1))
  }
  return out
}

/** Names declared as `--color-<name>` across every `@theme` block. */
function themeColourTokens(css: string): ReadonlySet<string> {
  return new Set(
    themeBlocks(css).flatMap((block) =>
      [...block.matchAll(/--color-([a-z0-9-]+)\s*:/g)].map((m) => m[1]!),
    ),
  )
}

/**
 * Namespaces of the fourteen tokens M8b.3's last PR deletes. Policed whether or not they are still
 * declared — see the retired-token clause in the header.
 */
const RETIRED_NAMESPACES: readonly string[] = [
  'shell',
  'chrome',
  'ink',
  'canvas',
  'danger',
  'warning',
]

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
  const namespaces = new Set([...[...tokens].map((t) => t.split('-')[0]!), ...RETIRED_NAMESPACES])

  it('reads the declared token set from theme.css', () => {
    expect(tokens.has('ink')).toBe(true)
    expect(tokens.has('accent-soft')).toBe(true)
    // Pinned by hand: this is what catches a typo in a token *declaration* (`--color-surfce`),
    // which every other assertion here would happily police as a new namespace.
    expect(namespaces).toEqual(
      new Set([
        'shell',
        'chrome',
        'canvas',
        'ink',
        'surface',
        'field',
        'hover',
        'pressed',
        'line',
        'text',
        'accent',
        'on',
        'focus',
        'danger',
        'warning',
        'success',
        'edit',
        'guide',
        'hud',
        'scrim',
      ]),
    )
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

/**
 * The canonical block is `--emit-theme`'s output, and this is what says so.
 *
 * `--check`'s byte-equality covers the 49 **colour** declarations and nothing else, so every other
 * line of the generated region was unpinned: the `@theme static` keyword, the ten `--*: initial`
 * resets, the eight `@utility` bodies and every spacing / radius / shadow / type / motion value.
 * Five corruptions of the shipped block were demonstrated in review round 1 to leave `--check
 * --require-landed` at `RESULT: pass` exit 0 with the whole suite, oxlint and Prettier green:
 * dropping `static`, `--spacing-control` 1.75rem → 4rem, `--radius-overlay` 0.5rem → 2rem,
 * `@utility duration-fast` emitting `var(--duration-slow)`, and `--ease-out` replaced by an ease-in
 * curve.
 *
 * The first is the one that matters and it is not hypothetical. `static` is what makes Tailwind emit
 * the whole block rather than only the tokens some utility happens to reference; with it removed and
 * a fresh `pnpm build`, `--color-hud`, `--color-hud-strong` and `--color-hud-fg` are absent from the
 * built CSS entirely, and `--color-canvas` / `--color-guide` survive only inside the dark media
 * block, so `var(--color-canvas)` resolves to nothing in light mode. `static` reads as a redundant
 * keyword; normalising it away is a plausible edit, and until this assertion existed no gate saw it.
 *
 * The generator is therefore the source of truth for the block: to change a value, change
 * `PROPOSED_LIGHT` / `PROPOSED_DARK` / the scale constants in the script and re-run `--emit-theme`
 * (audit §5.8). Editing `theme.css` alone reds here.
 */
describe('canonical role block', () => {
  it('is the generator output, verbatim', () => {
    const emitted = execFileSync(process.execPath, [GENERATOR, '--emit-theme'], {
      encoding: 'utf8',
      cwd: process.cwd(),
    })
    const css = readFileSync(THEME_FILE, 'utf8')
    if (!css.includes(emitted)) {
      // Diff the block against the same span of theme.css rather than reporting the bare
      // `toContain` failure, whose output names neither the divergent line nor the value.
      const want = emitted.split('\n')
      const have = css.split('\n')
      const at = have.indexOf(want[0]!)
      expect(
        at,
        'theme.css does not carry the generated block header at all',
      ).toBeGreaterThanOrEqual(0)
      expect(have.slice(at, at + want.length)).toEqual(want)
    }
    expect(css).toContain(emitted)
  })
})
