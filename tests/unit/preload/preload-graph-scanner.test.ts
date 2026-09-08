import { describe, expect, it } from 'vitest'
import { sep } from 'node:path'
import { scanPreloadGraph, type SourceTree } from '../../support/preload-graph'

/**
 * The scanner itself lives in `tests/support/preload-graph.ts`, and its docblock argues why it
 * parses rather than pattern-matches. This file is its fixture coverage; the two suites that read
 * the real `src/` tree with it are in `preload-bundle-deps.test.ts` beside it.
 *
 * **Why it is a file of its own.** Those other suites do real filesystem I/O, so they are excluded
 * from the win32 simulation (`vitest.win32.config.ts`). While these cases shared their file they
 * shared the exclusion, and `pnpm test:win-paths` skipped them — which is why `join(dirname(…), …)`
 * over a virtual tree of posix-literal keys stayed green on every developer machine and reduced the
 * `v0.0.1-preview.3` release job to ten `<unresolved>` failures on `windows-latest`. Touching no
 * filesystem, this file is not on that list, so the simulation now runs it. Keep it that way: if a
 * case here ever needs `fs`, it belongs in the other file, not on the exclusion list.
 */

/**
 * The scanner's own coverage, over fixtures rather than over the repo.
 *
 * Each case is one shape that costs a runtime `require`, and each was confirmed red by planting it
 * in real preload-reachable source and watching this file fail. They are here because the only way
 * to know a guard catches the bug is to hand it the bug — and because the two shapes that escaped
 * the regex era (the re-export chain, and `require()`) are now the two most explicitly pinned.
 */
describe('the preload source-graph scanner', () => {
  const ENTRY = '/preload/index.ts'

  async function specsFor(files: Record<string, string>, handed?: string[]): Promise<string[]> {
    const tree: SourceTree = {
      // The keys below are posix literals, but the scanner reaches them through `path.join`, which
      // spells `\` on Windows. A real filesystem there takes `/` and `\` for the same file; this
      // stand-in says so too, rather than pinning the resolver to posix — the resolver is shared
      // with the real-disk tree, where a win32 path is the right answer.
      //
      // `handed` records what the resolver actually spelled, so one case below can pin that it used
      // the HOST separator. Without that, this adapter would happily absorb a resolver quietly
      // rewritten to posix — which reds nothing here and breaks the real-disk tree on Windows.
      canonical: (file) => {
        handed?.push(file)
        return file.replaceAll('\\', '/')
      },
      exists: (file) => file in files,
      read: (file) => files[file] ?? '',
    }
    const { offenders } = await scanPreloadGraph(ENTRY, tree)
    return offenders.map((offender) => offender.spec)
  }

  it('allows electron and relative edges, and reports nothing for a clean graph', async () => {
    expect(
      await specsFor({
        [ENTRY]: "import { contextBridge } from 'electron'\nimport { a } from './a'\n",
        '/preload/a.ts': 'export const a = 1\n',
      }),
    ).toEqual([])
  })

  it('spells its candidates with the host separator, so a posix-pinned resolver cannot hide here', async () => {
    // The adapter above folds `\` to `/`, which is what lets the fixtures stay posix literals. That
    // fold is also blind by construction: a `resolveLocal` rewritten to `posix.join`/`posix.dirname`
    // leaves every test in this file green under BOTH `pnpm test` and `pnpm test:win-paths`, while
    // breaking the real-disk tree on a Windows runner — `posix.dirname('C:\\repo\\src\\preload\\index.ts')`
    // is `.`, so every edge resolves to nothing. That is the same shape as the release-blocking
    // defect this file was split out to catch, one layer down, so it is pinned rather than trusted.
    const handed: string[] = []
    await specsFor({ [ENTRY]: "import './a'\n", '/preload/a.ts': 'export const a = 1\n' }, handed)
    expect(handed.length).toBeGreaterThan(0)
    expect(
      handed.some((name) => name.includes(sep)),
      handed.join(', '),
    ).toBe(true)
  })

  it('catches a direct package import', async () => {
    expect(await specsFor({ [ENTRY]: "import { z } from 'zod'\n" })).toEqual(['zod'])
  })

  it('catches one two modules deep', async () => {
    expect(
      await specsFor({
        [ENTRY]: "import { a } from './a'\n",
        '/preload/a.ts': "import { b } from './b'\n",
        '/preload/b.ts': "import { parse } from 'parse5'\n",
      }),
    ).toEqual(['parse5'])
  })

  it('catches a re-export chain — the shape slide-contract.ts uses today', async () => {
    expect(
      await specsFor({
        [ENTRY]: "export { TOKENS } from './a'\n",
        '/preload/a.ts': "export * from './b'\n",
        '/preload/b.ts': "import { z } from 'zod'\nexport const TOKENS = z\n",
      }),
    ).toEqual(['zod'])
  })

  it('catches a bare side-effect import', async () => {
    expect(
      await specsFor({
        [ENTRY]: "import './a'\n",
        '/preload/a.ts': "import 'zod'\n",
      }),
    ).toEqual(['zod'])
  })

  it('catches a dynamic import', async () => {
    expect(
      await specsFor({
        [ENTRY]: "async function load() {\n  const { z } = await import('zod')\n  return z\n}\n",
      }),
    ).toEqual(['zod'])
  })

  it('follows a dynamic import of a local module', async () => {
    expect(
      await specsFor({
        [ENTRY]: "const later = () => import('./a')\n",
        '/preload/a.ts': "import { z } from 'zod'\n",
      }),
    ).toEqual(['zod'])
  })

  it('catches a CommonJS require, wherever in the module body it hides', async () => {
    // The shape the regex era missed: it type-checks, it lints clean, and it emits a bare
    // `require("zod")` into a bundle that cannot service one.
    expect(
      await specsFor({
        [ENTRY]: "import { a } from './a'\nexport const b = a\n",
        '/preload/a.ts':
          'export function a(flag: boolean): unknown {\n' +
          "  if (flag) { return require('zod') }\n" +
          '  return null\n' +
          '}\n',
      }),
    ).toEqual(['zod'])
  })

  it('catches `import x = require()`, which no import-shaped pattern would match', async () => {
    // `erasableSyntaxOnly` rejects this form in `src/`, so it is defence behind a compiler flag
    // rather than the front line — but the flag is one edit away and the parser costs nothing here.
    expect(await specsFor({ [ENTRY]: "import z = require('zod')\nexport const a = z\n" })).toEqual([
      'zod',
    ])
  })

  it('follows a require of a local module', async () => {
    expect(
      await specsFor({
        [ENTRY]: "export const a = require('./a')\n",
        '/preload/a.ts': "import { z } from 'zod'\n",
      }),
    ).toEqual(['zod'])
  })

  it('reports a require it cannot read rather than waving it through', async () => {
    // Not a real hazard in this repo, but the alternative is a scanner whose blind spot is silence.
    expect(
      await specsFor({ [ENTRY]: 'declare const name: string\nexport const a = require(name)\n' }),
    ).toEqual(['<computed specifier>'])
  })

  it('ignores type-only edges, which are erased before the bundler runs', async () => {
    expect(
      await specsFor({
        [ENTRY]: "import type { A } from 'zod'\nexport type { B } from 'parse5'\n",
      }),
    ).toEqual([])
  })

  it('still reports an import left holding only `type` specifiers', async () => {
    // `verbatimModuleSyntax` — which `tsconfig.base.json` turns on repo-wide — strips the specifier
    // and keeps the statement, so this emits `import {} from 'fflate'` and costs a real `require`.
    // Reading that off the compiler setting rather than off a rule of thumb is the point of parsing.
    expect(await specsFor({ [ENTRY]: "import { type C } from 'fflate'\n" })).toEqual(['fflate'])
  })

  it('still reports a value import whose bindings are never used', async () => {
    // `verbatimModuleSyntax` is what keeps this red: without it esbuild elides the unused binding
    // and the scanner would go quiet on an import the bundler would have kept.
    expect(await specsFor({ [ENTRY]: "import { z } from 'zod'\nexport const a = 1\n" })).toEqual([
      'zod',
    ])
  })

  it('follows a .js-suffixed specifier to its .ts source', async () => {
    expect(
      await specsFor({
        [ENTRY]: "import { a } from './a.js'\n",
        '/preload/a.ts': "import { z } from 'zod'\n",
      }),
    ).toEqual(['zod'])
  })

  it('follows the extensions and index files a .ts/.tsx pair does not cover', async () => {
    // `.mts`, `.cts` and `dir/index.tsx` are not in the repo today. That is exactly why they are
    // pinned: the failure mode of a missing candidate is not a wrong answer but silence — the
    // subtree behind it is never walked and the run stays green.
    expect(
      await specsFor({
        [ENTRY]: "import './a.js'\nimport './b'\nimport './widgets'\n",
        '/preload/a.mts': "import 'zod'\n",
        '/preload/b.cts': "import 'parse5'\n",
        '/preload/widgets/index.tsx': "import 'react-dom'\n",
      }),
      // Sorted by file: `a.mts`, then `b.cts`, then `widgets/index.tsx`.
    ).toEqual(['zod', 'parse5', 'react-dom'])
  })

  it('reports a relative specifier it cannot resolve rather than dropping it', async () => {
    expect(
      await specsFor({
        [ENTRY]: "import './gone'\nimport { a } from './a'\n",
        '/preload/a.ts': 'export const a = 1\n',
      }),
    ).toEqual(['./gone <unresolved>'])
  })

  it('names the module and not the parser when a file cannot be parsed as JS', async () => {
    await expect(
      specsFor({ [ENTRY]: "import './a.css'\n", '/preload/a.css': '.x { color: red }\n' }),
    ).rejects.toThrow('/preload/a.css could not be parsed')
  })
})
