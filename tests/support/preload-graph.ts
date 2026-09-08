import { dirname, join } from 'node:path'
import { parseAst, transformWithEsbuild } from 'vite'

/**
 * The preload import-graph scanner, shared by the two suites that drive it.
 *
 * `tests/unit/preload/preload-bundle-deps.test.ts` points it at the real `src/` tree;
 * `tests/unit/preload/preload-graph-scanner.test.ts` points it at fixtures. That split is not
 * cosmetic. The first reads real files, so it is on `vitest.win32.config.ts`'s
 * `REAL_FILESYSTEM_TESTS` list; while the scanner's own fixture coverage lived in the same file it
 * inherited that exclusion, and `pnpm test:win-paths` never ran a line of it. A posix separator
 * assumed inside the fixtures could therefore only ever surface on a real Windows runner — and it
 * did, on the `v0.0.1-preview.3` release job, after the tag was pushed and before an installer
 * existed. Keeping the fixture half in its own, unexcluded file is what puts that class back inside
 * the simulation.
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

export interface SourceTree {
  readonly exists: (file: string) => boolean
  readonly read: (file: string) => string
  /**
   * The name this tree files `file` under, however the caller spelled it.
   *
   * A tree backed by a real filesystem omits it: the OS already answers to every spelling its own
   * `path.join` produces, and on Windows that includes both separators. A **virtual** tree, whose
   * keys are literals, must supply it — otherwise `resolveLocal`'s `join` hands it a `\`-separated
   * name on a `\` host and every relative edge misses. Folding belongs here, in the adapter, and
   * not in the resolver: the resolver is shared with `DISK`, where a win32 path is the correct one.
   */
  readonly canonical?: (file: string) => string
}

/** A specifier the module names at runtime. `null` is one the parser found but could not read. */
type Edge = string | null

export const STRIP_TYPES: Parameters<typeof transformWithEsbuild>[2] = {
  target: 'esnext',
  // `jsx: 'react'` keeps the output plain JS without the `react/jsx-runtime` import the automatic
  // runtime would inject — an import the module never wrote and the bundler would never see.
  tsconfigRaw: { compilerOptions: { verbatimModuleSyntax: true, jsx: 'react' } },
}

/** The string a specifier node names, or `null` for one the scanner cannot read. */
export function specifierOf(node: unknown): Edge {
  if (typeof node !== 'object' || node === null) return null
  const record = node as { type?: string; value?: unknown }
  return record.type === 'Literal' && typeof record.value === 'string' ? record.value : null
}

/** Every specifier `source` names, found by parsing it the way the bundler will. */
async function importEdges(file: string, source: string): Promise<Edge[]> {
  // A non-JS asset in the graph (a `.css` import) fails with a bare `Expression expected`, which
  // names the parser rather than the file that reached it. Say which module could not be read.
  let ast: unknown
  try {
    ast = parseAst((await transformWithEsbuild(source, file, STRIP_TYPES)).code)
  } catch (cause) {
    throw new Error(`${file} could not be parsed as TS/JS — is it imported as an asset?`, { cause })
  }
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

  walk(ast)
  return edges
}

/** Resolve a relative specifier to the source file it names, or `null` if it names none. */
function resolveLocal(tree: SourceTree, fromFile: string, spec: string): string | null {
  const base = join(dirname(fromFile), spec)
  // `./x.js` is how a NodeNext-style specifier names `x.ts`; this repo writes them unsuffixed, but
  // a guard that silently stopped walking at the first `.js` specifier would be worse than one that
  // never met one.
  const stem = base.endsWith('.js') ? base.slice(0, -3) : base
  const candidates = [
    `${stem}.ts`,
    `${stem}.tsx`,
    `${stem}.mts`,
    `${stem}.cts`,
    join(stem, 'index.ts'),
    join(stem, 'index.tsx'),
    base,
  ]
  // `join` spells a path the way the host does, which is not always the way the tree names it —
  // so ask the tree, the only thing that knows. Identity for `DISK`; separator folding for a
  // virtual tree keyed by posix literals.
  const named = tree.canonical ?? ((file: string): string => file)
  return candidates.map(named).find((candidate) => tree.exists(candidate)) ?? null
}

export interface Offender {
  readonly file: string
  readonly spec: string
}

/** Walk the value-import graph from `entry`, collecting every edge to a non-`electron` package. */
export async function scanPreloadGraph(
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
        // A relative specifier that resolves to nothing is reported, never dropped: the subtree
        // behind it would otherwise go unscanned and the run would still be green — the silence this
        // file exists to remove.
        const target = resolveLocal(tree, file, spec)
        if (target === null) offenders.push({ file, spec: `${spec} <unresolved>` })
        else children.push(target)
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
