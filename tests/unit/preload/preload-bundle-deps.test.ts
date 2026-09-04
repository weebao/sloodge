import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseAst, transformWithEsbuild } from 'vite'

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
 * into `out/preload` — but it can only run after a build, and `.github/workflows/test.yml` is
 * install → lint → test with no build in it. So on the development path the source-graph half is the
 * only protection, and it has to stand on its own.
 *
 * ## Why the source half parses instead of matching patterns
 *
 * It used to be a list of regexes, one per import shape someone had thought of. Two consecutive
 * reviews found a shape missing from that list — a re-export chain in the first, a CommonJS
 * `require()` in the second — each of which sailed through the source half, through `tsc` and
 * through oxlint while the built preload grew a `require` it cannot service. A pattern list is only
 * as good as its author's imagination, and this guard is the only thing standing between a rename
 * and an app with no `window.sloodge`.
 *
 * So the scanner runs each module through the repo's own build toolchain instead: esbuild strips the
 * types exactly as `electron-vite` does, and rollup's parser — the one that actually decides what
 * ends up in `out/preload/index.cjs` — hands back the AST. Coverage is then a property of the
 * parser rather than of the patterns; every import form is just a node. `verbatimModuleSyntax`,
 * which `tsconfig.base.json` sets repo-wide, is what makes the erasure match the real build in both
 * directions: `import type` goes, an unused value import stays.
 *
 * A `require()` or `import()` whose argument is not a literal is reported rather than ignored: the
 * scanner cannot prove such an edge safe, and a guard that silently passes what it cannot read is
 * the failure mode this whole file exists to remove.
 */

interface SourceTree {
  readonly exists: (file: string) => boolean
  readonly read: (file: string) => string
}

/** A specifier the module names at runtime. `null` is one the parser found but could not read. */
type Edge = string | null

const STRIP_TYPES: Parameters<typeof transformWithEsbuild>[2] = {
  target: 'esnext',
  // `jsx: 'react'` keeps the output plain JS without the `react/jsx-runtime` import the automatic
  // runtime would inject — an import the module never wrote and the bundler would never see.
  tsconfigRaw: { compilerOptions: { verbatimModuleSyntax: true, jsx: 'react' } },
}

/** The string a specifier node names, or `null` for one the scanner cannot read. */
function specifierOf(node: unknown): Edge {
  if (typeof node !== 'object' || node === null) return null
  const record = node as { type?: string; value?: unknown }
  return record.type === 'Literal' && typeof record.value === 'string' ? record.value : null
}

/** Every specifier `source` names, found by parsing it the way the bundler will. */
async function importEdges(file: string, source: string): Promise<Edge[]> {
  const js = await transformWithEsbuild(source, file, STRIP_TYPES)
  const edges: Edge[] = []

  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const child of node) walk(child)
      return
    }
    if (typeof node !== 'object' || node === null) return
    const record = node as Record<string, unknown> & { type?: string }

    switch (record['type']) {
      // `import … from 'p'`, `import 'p'`, `export … from 'p'`, `export * from 'p'`.
      case 'ImportDeclaration':
      case 'ExportNamedDeclaration':
      case 'ExportAllDeclaration':
        if (record['source'] !== undefined && record['source'] !== null) {
          edges.push(specifierOf(record['source']))
        }
        break
      // `import('p')`, anywhere an expression may appear.
      case 'ImportExpression':
        edges.push(specifierOf(record['source']))
        break
      // `require('p')` — including the `import x = require('p')` esbuild lowers to it.
      case 'CallExpression': {
        const callee = record['callee'] as { type?: string; name?: string } | undefined
        if (callee?.type === 'Identifier' && callee.name === 'require') {
          edges.push(specifierOf((record['arguments'] as unknown[] | undefined)?.[0]))
        }
        break
      }
    }

    for (const key of Object.keys(record)) {
      if (key !== 'type') walk(record[key])
    }
  }

  walk(parseAst(js.code))
  return edges
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
async function scanPreloadGraph(
  entry: string,
  tree: SourceTree,
): Promise<{ offenders: Offender[]; visited: string[] }> {
  const seen = new Set<string>()
  const offenders: Offender[] = []

  // Recursive rather than a queue, so a module's children are parsed together instead of one at a
  // time down the chain. `seen` is checked and set before the first `await`, so two paths into the
  // same module cannot both walk it.
  const visit = async (file: string): Promise<void> => {
    if (seen.has(file)) return
    seen.add(file)

    const children: string[] = []
    for (const spec of await importEdges(file, tree.read(file))) {
      if (spec === null) {
        offenders.push({ file, spec: '<computed specifier>' })
      } else if (spec.startsWith('.')) {
        const target = resolveLocal(tree, file, spec)
        if (target !== null) children.push(target)
      } else if (spec !== 'electron') {
        offenders.push({ file, spec })
      }
    }
    await Promise.all(children.map(visit))
  }
  await visit(entry)

  // Sorted because the walk resolves concurrently: a report whose order depends on which parse
  // finished first would be a test that fails on a busy machine and nowhere else.
  offenders.sort((a, b) => `${a.file} ${a.spec}`.localeCompare(`${b.file} ${b.spec}`))
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
      // A named skip rather than `it.runIf`: this half is the one that reads the real artifact, and
      // a guard that vanishes without saying so invites a green run to be read as coverage it is
      // not. `.github/workflows/release.yml` builds before it tests and runs the suite with
      // PRELOAD_BUNDLE_REQUIRED=1, so on the path that ships an installer this half cannot skip.
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
  it('never reaches a module that imports a runtime package other than electron', async () => {
    const { offenders, visited } = await scanPreloadGraph(join(ROOT, 'src/preload/index.ts'), DISK)

    expect(offenders.map((o) => `${o.file.slice(ROOT.length + 1)} -> ${o.spec}`)).toEqual([])
    // A guard that walked nothing would pass vacuously.
    expect(visited.length).toBeGreaterThan(5)
  })
})

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

  async function specsFor(files: Record<string, string>): Promise<string[]> {
    const tree: SourceTree = { exists: (file) => file in files, read: (file) => files[file] ?? '' }
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
})
