/**
 * The other half of R6's guard (see `focus-ring.test.tsx`): the three class names the primitives
 * carry are compiled through the **installed** Tailwind against the real `theme.css`, and the rule
 * they produce is checked to be `:focus-visible`-scoped and to paint `var(--color-focus)`.
 *
 * Why this is not redundant with `--check`'s reachability gate: that gate asks whether
 * `outline-focus` emits *anything*. This asks what it emits — a ring painted with some other token,
 * or drawn unconditionally rather than on `:focus-visible`, would satisfy the first and fail here.
 *
 * Mutations: change `--color-focus` in the theme to a different name → the `var()` assertion reds;
 * drop `--color-focus` from the role block → nothing emits and the presence assertion reds.
 */

import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = process.cwd()
const THEME = join(ROOT, 'src', 'renderer', 'src', 'styles', 'theme.css')
const TAILWIND = join(ROOT, 'node_modules', 'tailwindcss')

const load = (path: string): { path: string; base: string; content: string } => ({
  path,
  base: dirname(path),
  content: readFileSync(path, 'utf8'),
})

async function build(candidates: readonly string[]): Promise<string> {
  const { compile } = await import('tailwindcss')
  const compiled = await compile(readFileSync(THEME, 'utf8'), {
    base: dirname(THEME),
    loadStylesheet: async (id: string, base: string) => {
      if (id === 'tailwindcss') return load(join(TAILWIND, 'index.css'))
      if (id.startsWith('tailwindcss/'))
        return load(join(TAILWIND, id.slice('tailwindcss/'.length)))
      return load(resolve(base, id))
    },
  })
  return compiled.build([...candidates])
}

describe('the focus ring compiles to a :focus-visible outline in --color-focus', () => {
  it('emits all three parts, only under :focus-visible', async () => {
    const css = await build([
      'focus-visible:outline-2',
      'focus-visible:outline-focus',
      'focus-visible:outline-offset-2',
    ])
    // One rule per class, each gated on the pseudo-class — a ring drawn at rest is a defect, not a
    // stylistic difference, and it is what a bare `outline-2` would produce.
    for (const part of ['outline-2', 'outline-focus', 'outline-offset-2']) {
      const rule = new RegExp(String.raw`\.focus-visible\\:${part}(?::focus-visible|:where)`)
      expect(css, `${part} did not emit a :focus-visible rule`).toMatch(rule)
    }
    expect(css).toContain('outline-color: var(--color-focus)')
    expect(css).toContain('outline-width: 2px')
    expect(css).toContain('outline-offset: 2px')
  })
})
