import { beforeAll, describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { parseAst, transformWithEsbuild } from 'vite'

/**
 * No regex literal over archive input may open with an unanchored, unbounded repeat that has
 * pattern after it to fail on (M4.6 review round 5).
 *
 * `rewrite.ts` re-opened a self-closing `<a:t .../>` with `openTag.replace(/\s*\/>$/, '>')`. The
 * pattern is unanchored at the start and begins with a greedy `\s*`, so the engine tries it at every
 * offset and backtracks through the whitespace run each time: quadratic in the tag's whitespace,
 * which `parseXml` accepts without bound and the 16 MB part cap lets reach ~8M characters. Measured
 * 245 / 985 / 3922 ms at 20k / 40k / 80k, synchronous in main. The fix is a slice and `trimEnd()`.
 *
 * This pins the *shape* rather than the clock — vitest timings flake under load here — by reading
 * every regex literal out of the modules that see archive input and refusing the one that
 * backtracks: not anchored at `^`, opening with an unbounded repeat (`*`, `+`, `{n,}`) of a class
 * (`\s`, `.`, `[…]`, `\p{…}`), a literal space or tab, or a flat group (`(\s|\t)`, `(?:\s)`), with
 * more pattern after it. `/\s+/g` alone is fine — nothing follows the run, so a match never
 * backtracks — and so is `/^…$/`, which is tried once.
 *
 * **It is a heuristic for that shape, not a linearity proof.** Blind spots, so that a green run is
 * not mistaken for an audit: `new RegExp(string)` and string-built `replace` patterns are
 * identifiers, not literals, and are never seen (`tokenPattern` in slide-contract.ts is one — it is
 * literal-led and was timed by hand at ≤ 5 ms on 1 MiB hostile inputs); nested groups
 * (`((\s)|\t)*x`), an alternation whose first branch is anchored (`^a|\s*x`), any repeat that is not
 * the first atom (`a\s*b\s*c`), and flags (`y`) all pass. Conversely it names some linear patterns
 * (`\d+(?:)`): the answer there is to anchor or restructure, never to widen the allow. New regexes
 * in these modules are still read by a reviewer.
 */

/** Modules whose regexes run over a part, an attribute value or a run of archive prose. */
const ARCHIVE_INPUT_MODULES = [
  'src/shared/import',
  'src/main/import/pptx-import.ts',
  'src/main/export/pptx-roundtrip.ts',
  'src/shared/document/slide-contract.ts',
  'src/shared/document/slide-text.ts',
]

const LEADING_UNBOUNDED_REPEAT =
  /^(?:\\[sSdDwWtnrfv]|\\p\{[^}]*\}|\.| |\[(?:\\.|[^\]])*\]|\((?:\?:)?[^()]*\))(?:[*+]|\{\d*,\})./

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

describe('no regex literal over archive input opens with an unanchored unbounded repeat', () => {
  const files = ARCHIVE_INPUT_MODULES.flatMap((path) => sourceFiles(join(process.cwd(), path)))
  let literals: RegexLiteral[] = []

  beforeAll(async () => {
    literals = (await Promise.all(files.map(regexLiterals))).flat()
  })

  it('finds the regex literals (the walk is not vacuous)', () => {
    expect(files.length).toBeGreaterThan(8)
    expect(literals.length).toBeGreaterThan(10)
  })

  it('none opens with an unbounded repeat that later pattern can make backtrack', () => {
    const offenders = literals
      .filter(({ body }) => !body.startsWith('^') && LEADING_UNBOUNDED_REPEAT.test(body))
      .map(({ file, line, body }) => `${file}:${String(line)} /${body}/`)
    expect(offenders).toEqual([])
  })

  it('would name the pattern that hung main, and its respellings', () => {
    for (const body of [
      String.raw`\s*\/>$`,
      String.raw`(\s|\t)*x$`,
      String.raw`(?:\s)*\/>$`,
      String.raw` *x`,
      String.raw`\t*x`,
      String.raw`\s{0,}x`,
      String.raw`\s{1,}x`,
      String.raw`[ \t]+x`,
      String.raw`\p{L}+x`,
      String.raw`.*x`,
    ]) {
      expect(LEADING_UNBOUNDED_REPEAT.test(body), body).toBe(true)
    }
    for (const body of [
      String.raw`\s+`,
      String.raw`^\d+$`,
      String.raw`\s{0,3}x`,
      String.raw`a\s*b`,
    ]) {
      expect(LEADING_UNBOUNDED_REPEAT.test(body), body).toBe(false)
    }
  })
})
