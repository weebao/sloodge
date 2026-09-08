import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseAst, transformWithEsbuild } from 'vite'
import {
  scanPreloadGraph,
  specifierOf,
  STRIP_TYPES,
  type SourceTree,
} from '../../support/preload-graph'

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
 * The scanner both halves below drive lives in `tests/support/preload-graph.ts`, and its own fixture
 * coverage in `preload-graph-scanner.test.ts` beside this file. That is a deliberate split, not
 * tidying: this file reads real files, so it is on `vitest.win32.config.ts`'s `REAL_FILESYSTEM_TESTS`
 * list, and the fixture cases inherited that exclusion for as long as they lived here — which is how
 * a posix-only assumption in them reached a Windows release runner unchallenged. Anything added here
 * inherits the exclusion too; anything that does not need `fs` belongs in the other file.
 */

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

/** Every identifier named anywhere under `node`. */
function identifiersIn(node: unknown, into: Set<string>): void {
  if (Array.isArray(node)) {
    for (const child of node) identifiersIn(child, into)
    return
  }
  if (typeof node !== 'object' || node === null) return
  const record = node as Record<string, unknown> & { type?: string; name?: unknown }
  if (record.type === 'Identifier' && typeof record.name === 'string') {
    into.add(record.name)
    return
  }
  for (const key of Object.keys(record)) if (key !== 'type') identifiersIn(record[key], into)
}

interface ModuleBindings {
  /** Names the module declares itself, at the top level, spelled the way esbuild spells them —
   * which is not always the way the source does. Ask `declaresUnderAnyName`, never `.has`, when the
   * question is whether a name is *absent*. */
  readonly declared: ReadonlySet<string>
  /** Names it takes from another module, by `import … from` or `export … from`, keyed by that
   * module's specifier. */
  readonly fromModule: ReadonlyMap<string, ReadonlySet<string>>
  /** Every identifier it names anywhere, so a name it never mentions reads as absent. */
  readonly mentioned: ReadonlySet<string>
  /** The specifiers it re-exports wholesale with `export * from`, which mention no names at all. */
  readonly reExportsAll: ReadonlySet<string>
  /** How often each identifier is named outside the `import`/`export … from` statements. */
  readonly used: ReadonlyMap<string, number>
}

/** Where each name in `source` comes from, read off the AST for the reason argued above. */
async function moduleBindings(file: string, source: string): Promise<ModuleBindings> {
  const ast = parseAst((await transformWithEsbuild(source, file, STRIP_TYPES)).code)
  const declared = new Set<string>()
  const mentioned = new Set<string>()
  const fromModule = new Map<string, Set<string>>()
  const reExportsAll = new Set<string>()
  const used = new Map<string, number>()

  // `id` only, never `params` or `body`: a parameter shadowing a name does not redeclare it.
  const declarationsIn = (node: unknown): void => {
    if (typeof node !== 'object' || node === null) return
    const record = node as Record<string, unknown> & { type?: string }
    switch (record['type']) {
      case 'FunctionDeclaration':
      case 'ClassDeclaration':
        identifiersIn(record['id'], declared)
        break
      case 'VariableDeclaration':
        for (const one of (record['declarations'] as unknown[] | undefined) ?? []) {
          identifiersIn((one as Record<string, unknown>)['id'], declared)
        }
        break
      // The `export` wrapper is not itself a binding; what it wraps is.
      case 'ExportNamedDeclaration':
      case 'ExportDefaultDeclaration':
        declarationsIn(record['declaration'])
        break
    }
  }

  for (const node of (ast as { body?: unknown[] }).body ?? []) {
    declarationsIn(node)
    const record = node as Record<string, unknown>
    const spec = specifierOf(record['source'])
    if (spec === null) {
      identifierOccurrences(node, used)
      continue
    }
    if (record['type'] === 'ExportAllDeclaration') reExportsAll.add(spec)
    const names = fromModule.get(spec) ?? new Set<string>()
    fromModule.set(spec, names)
    identifiersIn(record['specifiers'], names)
  }
  identifiersIn(ast, mentioned)

  return { declared, mentioned, fromModule, reExportsAll, used }
}

/** `identifiersIn`, counting: the same walk, one tally per occurrence rather than a set. */
function identifierOccurrences(node: unknown, into: Map<string, number>): void {
  if (Array.isArray(node)) {
    for (const child of node) identifierOccurrences(child, into)
    return
  }
  if (typeof node !== 'object' || node === null) return
  const record = node as Record<string, unknown> & { type?: string; name?: unknown }
  if (record.type === 'Identifier' && typeof record.name === 'string') {
    into.set(record.name, (into.get(record.name) ?? 0) + 1)
    return
  }
  for (const key of Object.keys(record))
    if (key !== 'type') identifierOccurrences(record[key], into)
}

/**
 * Whether `declared` holds `name` under any spelling esbuild may have given it.
 *
 * ## Read this before adding an assertion over a `ModuleBindings`
 *
 * Every set above is read off esbuild's *output*, because that is the only form of a `.ts` file
 * rollup's parser will take. esbuild renames a top-level local that collides with a name it
 * introduces, and lowering `export { packForApiScan } from './forbidden-apis'` introduces exactly
 * that name — so a local `packForApiScan` beside it arrives here as `packForApiScan2`. The scheme is
 * a counter appended to the original spelling, `2` then `3` and on through the collisions, with the
 * original never rewritten: `scan99` becomes `scan992`, not `scan100`.
 *
 * Which way an assertion has to lean follows from that. Asking whether a name is **absent** cannot
 * go through `declared.has`, because shadowing the name is the very thing that renames it and the
 * check would pass on the drift it exists to forbid; ask this instead, and it reads the rename as
 * the declaration it is. Asking whether a name is **present** — the leaf check below — must stay on
 * `declared.has`, since a renamed near-miss is not the name that was wanted.
 */
function declaresUnderAnyName(declared: ReadonlySet<string>, name: string): boolean {
  return [...declared].some((id) => id.startsWith(name) && /^\d*$/.test(id.slice(name.length)))
}

/**
 * Every exported name of SL-S04's rule that `slide-contract.ts` re-exports rather than declares.
 *
 * `foldForScan` and `forbiddenBreakPoints` joined the first three when M4.5's matcher followed the
 * token list into the leaf: `tokenPattern` calls `packForApiScan` and `TOKEN_PATTERNS` maps
 * `FORBIDDEN_API_TOKENS`, so the matcher could not stay in `slide-contract.ts` without importing
 * back the names the count below pins. They are in this list for the same reason the other three
 * are — a second copy of the matcher in `slide-contract.ts` costs the preload nothing and would
 * otherwise go unseen.
 *
 * Overlap with `tests/unit/import/slide-text-boundary.test.ts`, stated because it is partial rather
 * than total. That file's definer pin already reds on a `function`/`const` copy of the matcher
 * anywhere in `src/`, and its own docblock names the shape it cannot see: a copy hung off an object
 * as a method. Measured — `const scan = { forbiddenBreakPoints() {…} }` in `slide-contract.ts`,
 * called once: the definer pin stays 6/6 green, and the count below reds with
 * `forbiddenBreakPoints: 2`. The two names are here for that shape.
 */
const SCAN_NAMES = [
  'FORBIDDEN_API_TOKENS',
  'packForApiScan',
  'findForbiddenApiTokens',
  'foldForScan',
  'forbiddenBreakPoints',
]

/**
 * The other half of "the leaf is the single definition of SL-S04's scan" — the half the two checks
 * above are structurally unable to see.
 *
 * They catch the leaf being *bypassed*: a preload-reachable module reaching parse5 through
 * `slide-contract.ts`. Neither can catch it being *duplicated*, because a second `packForApiScan`
 * living in `slide-contract.ts` costs the preload nothing — `family.ts` still imports the leaf and
 * the bundle still requires only `electron`. That is not a hypothesis: in the real M3.11
 * reconciliation, with both copies in the tree and before this block existed, `tsc` exits 0, 188
 * test files pass, and this file's bundle half is 20/20 unskipped. Nothing anywhere goes red.
 *
 * It is also the state a rebase lands in by default, since M3.11 declares all three names in
 * `slide-contract.ts` and resolving the conflicts does not delete them — so this cannot be a rule
 * kept by review, which is the argument `forbidden-apis.ts` already makes about itself. Two
 * implementations of the scan drift, the narrower one belongs to a writer, and the drift ships as a
 * slide the app writes and then rejects.
 */
describe('the SL-S04 scan', () => {
  it('is imported into slide-contract.ts from the leaf, never redeclared there', async () => {
    const file = join(ROOT, 'src/shared/document/slide-contract.ts')
    const { declared, fromModule, mentioned, reExportsAll, used } = await moduleBindings(
      file,
      DISK.read(file),
    )
    const fromLeaf = fromModule.get('./forbidden-apis') ?? new Set<string>()

    expect(SCAN_NAMES.filter((name) => declaresUnderAnyName(declared, name))).toEqual([])
    expect(SCAN_NAMES.filter((name) => mentioned.has(name) && !fromLeaf.has(name))).toEqual([])
    // Both lines above read names, and `export * from` states none — so a third module holding the
    // second copy would satisfy them by saying nothing. No such re-export exists anywhere in `src`;
    // this keeps the pair total over what the module puts its name to.
    expect([...reExportsAll].filter((spec) => spec !== './forbidden-apis')).toEqual([])
    // `declared` reads module scope only, so a faithful copy nested inside the validator body, or
    // hung off an object as a method, is invisible to it — both reproduced with tsc silent (round
    // 7). Neither is invisible to a count: outside the import and re-export lines, slide-contract.ts
    // names `findForbiddenApiTokens` exactly once (the SL-S04 call) and `packForApiScan` exactly
    // once (M4.5's `cssPacked`, which is not part of the matcher and stayed behind when the matcher
    // moved to the leaf). A second legitimate call site would move this pin, deliberately.
    expect(Object.fromEntries(SCAN_NAMES.map((name) => [name, used.get(name) ?? 0]))).toEqual({
      FORBIDDEN_API_TOKENS: 0,
      packForApiScan: 1,
      findForbiddenApiTokens: 1,
      foldForScan: 0,
      forbiddenBreakPoints: 0,
    })
  })

  // Without this, renaming a function in the leaf would empty the guard above rather than fail it.
  it('is what the leaf exports, so the names above are not stale', async () => {
    const leaf = join(ROOT, 'src/shared/document/forbidden-apis.ts')
    const { declared } = await moduleBindings(leaf, DISK.read(leaf))

    expect(SCAN_NAMES.filter((name) => !declared.has(name))).toEqual([])
  })
})
