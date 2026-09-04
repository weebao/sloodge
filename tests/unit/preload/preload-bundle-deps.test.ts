import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')

/**
 * The preload runs **sandboxed** (`sandbox: true` in `src/main/index.ts`), and a sandboxed preload
 * cannot `require` anything but `electron`. Anything else it pulls in makes the *whole preload* fail
 * to load, which does not throw anywhere visible: `contextBridge.exposeInMainWorld` simply never
 * runs, `window.sloodge` comes up `undefined`, and the renderer silently takes its no-Electron
 * fallback — no `slide://` protocol, no agent, no export. Every unit test still passes, because none
 * of them cross a real preload boundary.
 *
 * This is not hypothetical. M3.10's font bridge imported a validator from `slide-contract.ts` to
 * reuse its forbidden-token list; that module imports `parse5` and the zod deck schema, so the
 * preload bundle grew `require("parse5")` and `require("zod")` and the app came up with no bridge at
 * all. It was caught by running the built app, not by the suite — hence this test.
 *
 * ## Two halves, and which one actually protects you
 *
 * The bundle half below is the stronger evidence — it reads the `require` calls that really survive
 * into `out/preload` — but it can only run after a build, and **no CI job builds before it tests**:
 * `.github/workflows/test.yml` is install → lint → test, and `release.yml` runs `pnpm test` before
 * `pnpm pack:win:release`. So on every machine that is not a developer's, the source-graph half is
 * the only protection, and it has to stand on its own. That is why the edge patterns below cover
 * every shape that costs a `require` rather than just the common one, and why the scanner is
 * exercised against fixtures at the bottom of this file: a guard whose own blind spots are untested
 * is a guard that reports green for the bug it was written to catch.
 */

interface SourceTree {
  readonly exists: (file: string) => boolean
  readonly read: (file: string) => string
}

/**
 * Every import shape that costs a runtime `require`, and none that does not.
 *
 * `import type` / `export type` are erased before the bundler runs, so a type-only edge neither
 * costs a `require` nor drags the target's own dependencies in — following one would report
 * `document/types.ts -> zod` for a module the preload never loads.
 */
const EDGE_PATTERNS: readonly RegExp[] = [
  // `import x from 'p'` and — the shape `slide-contract.ts` uses today — `export { x } from 'p'`,
  // `export * from 'p'`.
  /^[ \t]*(?:import|export)[ \t]+(?!type\s)[^'"]*?from[ \t]*['"]([^'"]+)['"]/gm,
  // Side-effect import: no bindings, still a `require`.
  /^[ \t]*import[ \t]+['"]([^'"]+)['"]/gm,
  // `await import('p')`. Not line-anchored — it is an expression, so it appears mid-statement.
  /\bimport[ \t]*\([ \t]*['"]([^'"]+)['"]/g,
]

function importEdges(source: string): string[] {
  const specs: string[] = []
  for (const pattern of EDGE_PATTERNS) {
    for (const match of source.matchAll(pattern)) specs.push(match[1]!)
  }
  return specs
}

/** Resolve a relative specifier to the source file it names, or `null` if it names none. */
function resolveLocal(tree: SourceTree, fromFile: string, spec: string): string | null {
  const base = join(dirname(fromFile), spec)
  // `./x.js` is how a NodeNext-style specifier names `x.ts`; this repo writes them unsuffixed, but
  // a guard that silently stopped walking at the first `.js` specifier would be worse than one that
  // never met one.
  const stem = base.endsWith('.js') ? base.slice(0, -3) : base
  for (const candidate of [`${stem}.ts`, `${stem}.tsx`, join(stem, 'index.ts'), base]) {
    if (tree.exists(candidate)) return candidate
  }
  return null
}

interface Offender {
  readonly file: string
  readonly spec: string
}

/** Walk the value-import graph from `entry`, collecting every edge to a non-`electron` package. */
function scanPreloadGraph(
  entry: string,
  tree: SourceTree,
): { offenders: Offender[]; visited: string[] } {
  const seen = new Set<string>()
  const offenders: Offender[] = []
  const queue = [entry]

  while (queue.length > 0) {
    const file = queue.pop()!
    if (seen.has(file)) continue
    seen.add(file)

    for (const spec of importEdges(tree.read(file))) {
      if (spec.startsWith('.')) {
        const next = resolveLocal(tree, file, spec)
        if (next !== null) queue.push(next)
      } else if (spec !== 'electron') {
        offenders.push({ file, spec })
      }
    }
  }

  return { offenders, visited: [...seen] }
}

const DISK: SourceTree = {
  exists: (file) => existsSync(file) && statSync(file).isFile(),
  read: (file) => readFileSync(file, 'utf8'),
}

describe('the preload bundle', () => {
  const bundle = join(ROOT, 'out/preload/index.cjs')

  it('requires nothing but electron', (ctx) => {
    if (!existsSync(bundle)) {
      // A loud, named skip rather than `it.runIf`: this half is the one that reads the real
      // artifact, no CI job builds before testing, and a guard that vanishes without saying so
      // invites a green run to be read as coverage it is not. Set PRELOAD_BUNDLE_REQUIRED=1 (after
      // `pnpm build`) to make its absence a failure instead.
      if (process.env['PRELOAD_BUNDLE_REQUIRED'] === '1') {
        expect.fail('out/preload/index.cjs is missing — run `pnpm build` before this suite')
      }
      ctx.skip('out/preload/index.cjs not built — run `pnpm build` to check the real artifact')
      return
    }

    const source = readFileSync(bundle, 'utf8')
    const required = [...source.matchAll(/require\(["']([^"']+)["']\)/g)].map((m) => m[1]!)
    const external = [...new Set(required)].filter(
      (id) => !id.startsWith('.') && !id.startsWith('/'),
    )
    expect(external.toSorted()).toEqual(['electron'])
  })
})

/**
 * The source-level half of the same rule, which — unlike the bundle check — runs whether or not the
 * app has been built. `src/preload` may reach into `src/shared`, but nothing it reaches may import a
 * package that would have to be `require`d at runtime.
 */
describe('the preload source graph', () => {
  it('never reaches a module that imports a runtime package other than electron', () => {
    const { offenders, visited } = scanPreloadGraph(join(ROOT, 'src/preload/index.ts'), DISK)

    expect(offenders.map((o) => `${o.file.slice(ROOT.length + 1)} -> ${o.spec}`)).toEqual([])
    // A guard that walked nothing would pass vacuously.
    expect(visited.length).toBeGreaterThan(5)
  })
})

/**
 * The scanner's own coverage, over fixtures rather than over the repo.
 *
 * Each case is one shape that a previous version of this guard waved through while the app it
 * protects would have failed to load. They are here because the only way to know a guard fails on
 * the bug is to hand it the bug.
 */
describe('the preload source-graph scanner', () => {
  const ENTRY = '/preload/index.ts'

  function specsFor(files: Record<string, string>): string[] {
    const tree: SourceTree = { exists: (file) => file in files, read: (file) => files[file] ?? '' }
    return scanPreloadGraph(ENTRY, tree).offenders.map((offender) => offender.spec)
  }

  it('allows electron and relative edges, and reports nothing for a clean graph', () => {
    expect(
      specsFor({
        [ENTRY]: "import { contextBridge } from 'electron'\nimport { a } from './a'\n",
        '/preload/a.ts': 'export const a = 1\n',
      }),
    ).toEqual([])
  })

  it('catches a direct package import', () => {
    expect(specsFor({ [ENTRY]: "import { z } from 'zod'\n" })).toEqual(['zod'])
  })

  it('catches one two modules deep', () => {
    expect(
      specsFor({
        [ENTRY]: "import { a } from './a'\n",
        '/preload/a.ts': "import { b } from './b'\n",
        '/preload/b.ts': "import { parse } from 'parse5'\n",
      }),
    ).toEqual(['parse5'])
  })

  it('catches a re-export chain — the shape slide-contract.ts uses today', () => {
    expect(
      specsFor({
        [ENTRY]: "export { TOKENS } from './a'\n",
        '/preload/a.ts': "export * from './b'\n",
        '/preload/b.ts': "import { z } from 'zod'\nexport const TOKENS = z\n",
      }),
    ).toEqual(['zod'])
  })

  it('catches a bare side-effect import', () => {
    expect(
      specsFor({
        [ENTRY]: "import './a'\n",
        '/preload/a.ts': "import 'zod'\n",
      }),
    ).toEqual(['zod'])
  })

  it('catches a dynamic import', () => {
    expect(
      specsFor({
        [ENTRY]: "async function load() {\n  const { z } = await import('zod')\n  return z\n}\n",
      }),
    ).toEqual(['zod'])
  })

  it('follows a dynamic import of a local module', () => {
    expect(
      specsFor({
        [ENTRY]: "const later = () => import('./a')\n",
        '/preload/a.ts': "import { z } from 'zod'\n",
      }),
    ).toEqual(['zod'])
  })

  it('ignores type-only edges, which are erased before the bundler runs', () => {
    expect(
      specsFor({
        [ENTRY]: "import type { A } from 'zod'\nexport type { B } from 'parse5'\n",
      }),
    ).toEqual([])
  })

  it('follows a .js-suffixed specifier to its .ts source', () => {
    expect(
      specsFor({
        [ENTRY]: "import { a } from './a.js'\n",
        '/preload/a.ts': "import { z } from 'zod'\n",
      }),
    ).toEqual(['zod'])
  })
})
