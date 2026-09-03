import { describe, expect, it } from 'vitest'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { REAL_FILESYSTEM_TESTS } from '../../../vitest.win32.config'

/**
 * **The Windows-path simulation, and the guard on its escape hatch.**
 *
 * M9.0's release job runs `pnpm test` on `windows-latest`. Round-3 review found 14 assertions
 * comparing `path.join` output against forward-slash literals, which would have reddened the
 * release job before packaging was ever reached. The deeper finding was about method: the
 * `core.autocrlf=true` clone used to validate the CRLF blocker reproduces line endings but is
 * *structurally* blind to `path.sep`, so no amount of care with that tool could have caught this.
 * `pnpm test:win-paths` is the missing half — it aliases `node:path` to `path.win32`.
 *
 * That simulation has one honest limit: tests doing real filesystem I/O cannot work with `\`
 * separators on a Linux kernel, so they are excluded. An exclusion list is exactly the kind of
 * escape hatch that quietly grows until it covers a real bug, so this file pins it:
 *
 * - every excluded file must exist (no stale entries left behind after a rename);
 * - every excluded file must actually touch the filesystem, so a pure-logic test — the kind that
 *   *can* be simulated, and whose failure would be a genuine posix-literal bug — cannot be parked
 *   in the list to make the run green;
 * - the list stays sorted and duplicate-free, so it reads as a reviewed set rather than an
 *   accumulation.
 */

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

/**
 * Does this test reach the REAL filesystem?
 *
 * A suite that only `vi.mock`s `node:fs` is pure logic — `vault.test.ts` is the case in point — and
 * belongs in the simulation, where it catches posix-literal assertions. Only unmocked use counts.
 */
const FS_USE = /from 'node:fs|require\('node:fs|readFileSync|writeFileSync|mkdtempSync/
const FS_MOCKED = /vi\.mock\('node:fs/
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
    expect(REAL_FILESYSTEM_TESTS.length).toBeGreaterThan(0)
    expect(REAL_FILESYSTEM_TESTS.length).toBeLessThan(30)
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

  it('lists EVERY test that touches the real filesystem, so the run cannot litter the repo', () => {
    // The other direction, and the one that bites silently. A test writing to `os.tmpdir()` without
    // asserting on the path PASSES the simulation while quietly littering: win32 rewrites `/tmp/x`
    // as `\\tmp\\x`, which Linux treats as a *relative* path, so the files land in the repo root
    // with backslashes in their names. Three such tests slipped the first exclusion list — which had
    // been derived from observed failures rather than from actual filesystem use — and dumped 377
    // files into the working tree.
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
