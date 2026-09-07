import { describe, expect, it } from 'vitest'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { REAL_FILESYSTEM_TESTS } from '../../../vitest.win32.config'

/**
 * **The guard on the win32 simulation's escape hatch.** `vitest.win32.config.ts` explains what the
 * simulation is for and why tests doing real filesystem I/O cannot be part of it.
 *
 * An exclusion list is the kind of escape hatch that quietly grows until it covers a real bug, so
 * this file pins what a test's SOURCE can pin: nothing may be excluded that could have been
 * simulated (which would hide a genuine posix-literal failure), and a test that visibly uses the
 * filesystem may not be omitted. That second direction is only a fast first line — a regex over
 * source cannot see a write hidden behind a src helper — so the proof that the run leaves nothing
 * new in the repo root is `tests/support/win32-litter-guard.ts`, which reads the disk before and
 * after (its docblock names the two routes that compare does not see).
 */

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

/**
 * Does this test visibly reach the REAL filesystem?
 *
 * A suite that only `vi.mock`s `node:fs` is pure logic — `vault.test.ts` is the case in point — and
 * belongs in the simulation, where it catches posix-literal assertions. Only unmocked use counts.
 * "Visibly" means an import of `fs` in any spelling (`node:` or bare, with or without `/promises`),
 * or a `tmpdir()` path, which a test only builds in order to write there. A write behind a src
 * helper on a hard-coded path is invisible here; the litter guard catches it on disk.
 */
const FS_USE =
  /from ['"](node:)?fs(\/promises)?['"]|require\(['"](node:)?fs(\/promises)?['"]\)|tmpdir\(/
const FS_MOCKED = /vi\.mock\(['"](node:)?fs(\/promises)?['"]/
const touchesRealFilesystem = (source: string): boolean =>
  FS_USE.test(source) && !FS_MOCKED.test(source)

/** Every unit test file in the repo, as repo-relative posix paths. */
function allTestFiles(dir = path.join(REPO_ROOT, 'tests', 'unit')): string[] {
  const found: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) found.push(...allTestFiles(full))
    else if (/\.test\.tsx?$/.test(entry.name)) {
      found.push(path.relative(REPO_ROOT, full).split(path.sep).join('/'))
    }
  }
  return found
}

describe('win32 path simulation — the exclusion list', () => {
  it('is not empty, and does not silently cover the whole suite', () => {
    // A list that grew to include everything would make `pnpm test:win-paths` vacuously green.
    //
    // The ceiling is a fraction of the suite, not a constant. It was `< 30`, and two branches
    // carrying one honest entry each — M4.5's and M3.10's — took the list from 28 to 30, so the
    // second to rebase reds on a number that says nothing about either of them. That is a pin
    // measuring the wrong thing: "covers the whole suite" is a ratio, and a constant one commit
    // under it turns every unrelated merge into a false red and invites someone to bump it by one,
    // which is how a vacuity guard dies. A quarter keeps the simulation running on at least three
    // files in four, and no plausible batch of real-I/O tests crosses it by accident.
    //
    // Stated exactly: **the ceiling loosened (30 -> 51 today), the guarantee did not.** This is a
    // canary, not the guard. The two assertions below pin the set itself in both directions —
    // nothing may be listed that does not really touch the filesystem, and nothing that visibly
    // does may be omitted — so what may be excluded is determined there, and no number here can
    // widen it.
    expect(REAL_FILESYSTEM_TESTS.length).toBeGreaterThan(0)
    expect(REAL_FILESYSTEM_TESTS.length).toBeLessThan(allTestFiles().length / 4)
  })

  it('names only files that exist', () => {
    for (const relative of REAL_FILESYSTEM_TESTS) {
      expect(existsSync(path.join(REPO_ROOT, relative)), `${relative} is listed but missing`).toBe(
        true,
      )
    }
  })

  it('excludes only tests that really touch the filesystem', () => {
    // The load-bearing one. A test with no filesystem access CAN be simulated, so if it fails the
    // win32 run that failure is a real posix-literal bug and belongs fixed, not excluded.
    for (const relative of REAL_FILESYSTEM_TESTS) {
      const source = readFileSync(path.join(REPO_ROOT, relative), 'utf8')
      expect(
        touchesRealFilesystem(source),
        `${relative} is excluded from the win32 simulation but does no real filesystem I/O — ` +
          `if it fails that run, it is a genuine path bug and must be fixed rather than excluded`,
      ).toBe(true)
    }
  })

  it('lists every test that visibly touches the real filesystem', () => {
    // The other direction, and the one that bites silently. A test writing to `os.tmpdir()` without
    // asserting on the path PASSES the simulation while quietly littering: win32 rewrites `/tmp/x`
    // as `\\tmp\\x`, which Linux treats as a *relative* path, so the files land in the repo root
    // with backslashes in their names. Three such tests slipped the first exclusion list — which had
    // been derived from observed failures rather than from actual filesystem use — and dumped 377
    // files into the working tree. This check names the offending file; the litter guard is the
    // one that cannot be bypassed.
    const missing = allTestFiles().filter(
      (relative) =>
        !REAL_FILESYSTEM_TESTS.includes(relative) &&
        touchesRealFilesystem(readFileSync(path.join(REPO_ROOT, relative), 'utf8')),
    )
    expect(
      missing,
      'these tests use the real filesystem but are not excluded from the win32 simulation, so ' +
        '`pnpm test:win-paths` would scatter backslash-named files through the repo root',
    ).toEqual([])
  })

  it('stays sorted and free of duplicates', () => {
    expect(REAL_FILESYSTEM_TESTS).toEqual([...new Set(REAL_FILESYSTEM_TESTS)])
    expect(REAL_FILESYSTEM_TESTS).toEqual([...REAL_FILESYSTEM_TESTS].toSorted())
  })

  it('is reachable through a package script, so it can actually be run', () => {
    const pkg = JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')) as {
      readonly scripts?: Readonly<Record<string, string>>
    }
    const script = pkg.scripts?.['test:win-paths']
    expect(script, 'package.json must expose the win32 simulation as test:win-paths').toBeDefined()
    expect(script).toContain('vitest.win32.config.ts')
  })
})
