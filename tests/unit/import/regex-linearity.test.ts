import { beforeAll, describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { parseAst, transformWithEsbuild } from 'vite'

/**
 * No regex over archive-sized input may be superlinear in that input (M4.6 review round 5).
 *
 * `rewrite.ts` re-opened a self-closing `<a:t .../>` with `openTag.replace(/\s*\/>$/, '>')`. The
 * pattern is unanchored at the start and begins with a greedy `\s*`, so the engine tries it at every
 * offset and backtracks through the whitespace run each time: quadratic in the tag's whitespace,
 * which `parseXml` accepts without bound and the 16 MB part cap lets reach ~8M characters. Measured
 * 245 / 985 / 3922 ms at 20k / 40k / 80k, synchronous in main. The fix is a slice and `trimEnd()`.
 *
 * This pins the *shape* rather than the clock — vitest timings flake under load here — by reading
 * every regex literal out of the modules that see archive input and refusing the shape that
 * backtracks: a pattern that is not anchored at `^`, opens with an unbounded quantifier over a class
 * (`\s*`, `.*`, `[…]+`), and has more pattern after it to fail on. `/\s+/g` alone is fine — nothing
 * follows the run, so a match never backtracks — and so is `/^…$/`, which is tried once.
 */

/** Modules whose regexes run over a part, an attribute value or a run of archive prose. */
const ARCHIVE_INPUT_MODULES = [
  'src/shared/import',
  'src/main/import/pptx-import.ts',
  'src/main/export/pptx-roundtrip.ts',
  'src/shared/document/slide-contract.ts',
  'src/shared/document/slide-text.ts',
]

const LEADING_UNBOUNDED_CLASS = /^(?:\\[sSdDwW]|\.|\[(?:\\.|[^\]])*\])[*+]./

function sourceFiles(path: string): string[] {
  if (!statSync(path).isDirectory()) return [path]
  return readdirSync(path).flatMap((entry) => sourceFiles(join(path, entry)))
}

type RegexLiteral = { file: string; body: string; line: number }

/**
 * Every regex literal in a module, found by parsing it rather than by pattern-matching its text.
 * esbuild strips the types (it leaves regex literals as written) and Rollup's parser yields the
 * ESTree, where a regex is a `Literal` carrying `regex.pattern`.
 */
async function regexLiterals(file: string): Promise<RegexLiteral[]> {
  const source = readFileSync(file, 'utf8')
  const { code } = await transformWithEsbuild(source, file, { loader: 'ts', target: 'esnext' })
  const out: RegexLiteral[] = []
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const child of node) visit(child)
      return
    }
    if (node === null || typeof node !== 'object') return
    const record = node as Record<string, unknown>
    const regex = record['regex']
    if (record['type'] === 'Literal' && typeof regex === 'object' && regex !== null) {
      const raw = typeof record['raw'] === 'string' ? record['raw'] : ''
      const at = source.indexOf(raw)
      out.push({
        file: relative(process.cwd(), file).split(sep).join('/'),
        body: String((regex as { pattern: string }).pattern),
        line: at < 0 ? 0 : source.slice(0, at).split('\n').length,
      })
      return
    }
    for (const value of Object.values(record)) visit(value)
  }
  visit(parseAst(code))
  return out
}

describe('regexes over archive input are linear', () => {
  const files = ARCHIVE_INPUT_MODULES.flatMap((path) => sourceFiles(join(process.cwd(), path)))
  let literals: RegexLiteral[] = []

  beforeAll(async () => {
    literals = (await Promise.all(files.map(regexLiterals))).flat()
  })

  it('finds the regex literals (the walk is not vacuous)', () => {
    expect(files.length).toBeGreaterThan(8)
    expect(literals.length).toBeGreaterThan(10)
  })

  it('none opens with an unbounded class quantifier that later pattern can make backtrack', () => {
    const offenders = literals
      .filter(({ body }) => !body.startsWith('^') && LEADING_UNBOUNDED_CLASS.test(body))
      .map(({ file, line, body }) => `${file}:${String(line)} /${body}/`)
    expect(offenders).toEqual([])
  })

  it('would name the pattern that hung main', () => {
    expect(LEADING_UNBOUNDED_CLASS.test(String.raw`\s*\/>$`)).toBe(true)
    expect(LEADING_UNBOUNDED_CLASS.test(String.raw`\s+`)).toBe(false)
    expect(LEADING_UNBOUNDED_CLASS.test(String.raw`^\d+$`)).toBe(false)
  })
})
