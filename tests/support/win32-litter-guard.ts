/**
 * Litter guard for the win32 path simulation (`vitest.win32.config.ts` explains the run).
 *
 * Under the simulation a test that writes to `os.tmpdir()` produces `\tmp\x`, which Linux reads as a
 * RELATIVE path, so the file lands in the repo root with backslashes in its name — and the test
 * passes. The first exclusion list let three such tests dump 377 files into the working tree; the
 * lexical check that followed (`win32-path-simulation.test.ts`) was then bypassed by a bare
 * `'fs/promises'` import and by a test that wrote through `writeExportAtomic` without importing fs
 * at all. Any check that reads test SOURCE has that shape of hole, so this one reads the DISK:
 * snapshot the repo root before the run, and fail the run on anything new in it afterwards.
 *
 * Every route to the disk ends the same way — a new entry in the directory vitest runs from — so
 * this holds regardless of how the write was spelled: `node:fs`, bare `fs`, a src helper, a mock
 * that fell through, or code that does not exist yet. It also refuses to start over strays left by
 * an earlier run: those are empty directories more often than not, which `git status` never shows.
 *
 * Two vitest facts shape the code. globalSetup is resolved by the same Vite pipeline as the tests,
 * so importing `node:path` here would hand this file the win32 shim — hence no `path` at all. And
 * `Vitest.close()` only LOGS a rejected teardown ("error during close") and exits 0 on it, so the
 * teardown sets `process.exitCode` itself; the throw is what puts the entries in the output.
 */
import { readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url)).replace(/\/$/, '')

const WATCHED = [...new Set([REPO_ROOT, process.cwd()])]

export default function setup(): () => void {
  const before = WATCHED.map((dir) => {
    const names = readdirSync(dir)
    const stale = names.filter((name) => name.includes('\\'))
    if (stale.length > 0) {
      throw new Error(
        `win32 simulation refused to start: ${dir} already holds backslash-named entries left by ` +
          'an earlier run (git status does not show empty directories). Delete them first, e.g. ' +
          "`ls -A | grep '\\\\' | xargs -d '\\n' rm -r`:\n" +
          stale.map((name) => `  ${dir}/${name}`).join('\n'),
      )
    }
    return { dir, names: new Set(names) }
  })

  return () => {
    const created = before.flatMap(({ dir, names }) =>
      readdirSync(dir)
        .filter((name) => !names.has(name))
        .map((name) => `  ${dir}/${name}`),
    )
    if (created.length === 0) return
    process.exitCode = 1
    throw new Error(
      'win32 simulation littered the repo root. A test in the run wrote to a path that win32 ' +
        'rendered relative (`\\tmp\\...`), so it belongs in REAL_FILESYSTEM_TESTS in ' +
        'vitest.win32.config.ts — see the criterion there. Remove these entries, then find the ' +
        "test with `git status` for files or `ls -A | grep '\\\\'` for empty directories:\n" +
        created.join('\n'),
    )
  }
}
