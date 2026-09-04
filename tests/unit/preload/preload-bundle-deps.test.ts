import { describe, expect, it } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')

/** Resolve a relative import specifier to the source file it names, or `null` if it names none. */
function resolveLocal(fromFile: string, spec: string): string | null {
  const base = join(dirname(fromFile), spec)
  for (const candidate of [base + '.ts', base + '.tsx', join(base, 'index.ts')]) {
    if (existsSync(candidate)) return candidate
  }
  return null
}

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
 * The guard is over the built artifact rather than the import graph on purpose: bundlers inline
 * most things, and what actually matters is the `require` calls that survive into `out/preload`.
 */
describe('the preload bundle', () => {
  const bundle = join(ROOT, 'out/preload/index.cjs')

  it.runIf(existsSync(bundle))('requires nothing but electron', () => {
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
  /**
   * Value imports only. `import type` is erased before the bundler runs, so a type-only edge
   * neither costs a `require` nor drags the target's own dependencies in — following one would
   * report `document/types.ts -> zod` for a module the preload never actually loads.
   */
  const VALUE_IMPORT = /^\s*import\s+(?!type\s)[^'"]*from\s+['"]([^'"]+)['"]/gm

  it('never reaches a module that imports a runtime package other than electron', () => {
    const seen = new Set<string>()
    const offenders: string[] = []
    const queue = [join(ROOT, 'src/preload/index.ts')]

    while (queue.length > 0) {
      const file = queue.pop()!
      if (seen.has(file)) continue
      seen.add(file)
      const source = readFileSync(file, 'utf8')

      for (const match of source.matchAll(VALUE_IMPORT)) {
        const spec = match[1]!
        if (spec.startsWith('.')) {
          const next = resolveLocal(file, spec)
          if (next !== null) queue.push(next)
        } else if (spec !== 'electron') {
          offenders.push(`${file.slice(ROOT.length + 1)} -> ${spec}`)
        }
      }
    }

    expect(offenders).toEqual([])
    // A guard that walked nothing would pass vacuously.
    expect(seen.size).toBeGreaterThan(5)
  })
})
