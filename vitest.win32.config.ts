/**
 * Windows-path simulation run: `pnpm test:win-paths`.
 *
 * Identical to `vitest.config.ts` except that `node:path` resolves to `path.win32`, so every
 * `path.join` in `src/` and in the tests behaves as it does on `windows-latest`.
 *
 * **Why this exists.** M9.0's release job runs `pnpm test` on a Windows runner. A suite that has
 * only ever run on Linux can hide assertions comparing `path.join` output against forward-slash
 * literals, and that class reds the release job *before* packaging is reached. The
 * `core.autocrlf=true` clone used to validate the CRLF fix reproduces line endings faithfully but
 * is structurally blind to `path.sep`, so it could never have caught this. Validating "Windows on
 * Linux" needs BOTH.
 *
 * It is deliberately NOT part of `pnpm test`: this is a simulation, so a failure needs a human to
 * judge whether the test or the production code is at fault. Run it when touching path handling,
 * and before cutting a release (docs/windows-smoke-runbook.md §8.6).
 */
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

const shim = fileURLToPath(new URL('./tests/support/path-win32.ts', import.meta.url))

/**
 * Tests excluded from the simulation because they perform **real filesystem I/O**.
 *
 * This is the simulation's one honest limit. Aliasing `path` to `path.win32` makes `path.join`
 * emit `\` separators, which a Linux kernel does not accept as separators — so a test that really
 * reads or writes files gets `ENOENT` on a backslash path, or silently creates a file whose *name*
 * contains a backslash and then finds an empty directory. Those failures say nothing about the
 * code; the same tests pass on a real Windows runner, where the separator is genuine.
 *
 * **Criterion for adding to this list — check it, do not assume.** A file belongs here only if its
 * win32 failures are filesystem artifacts: `ENOENT` on a path containing `\`, or an assertion that
 * fails *downstream* of a real read/write that went to the wrong place (an empty `readdir`, for
 * instance). A failure that is a direct string comparison — `expected '\a\b' to be '/a/b'` — is a
 * REAL bug in the posix-literal class this run exists to catch, and must be fixed, never excluded.
 * Every entry below was classified this way, one file at a time, before being listed.
 *
 * The list must also be COMPLETE, not merely correct. A test that writes to `os.tmpdir()` without
 * asserting on the path passes the simulation while silently littering: win32 turns `/tmp/x` into
 * `\tmp\x`, which Linux reads as a *relative* path, so the files land in the repo root with
 * backslashes in their names. Three such tests were found exactly that way — they passed, and
 * dumped 377 files into the working tree.
 *
 * Two checks hold the list to that. `tests/unit/packaging/win32-path-simulation.test.ts` reads each
 * test's source: every entry must really touch the filesystem (so a pure-logic test cannot be
 * parked here to silence a genuine failure), and a test that visibly imports `fs` or builds a
 * `tmpdir()` path must be listed. A source regex cannot see a write hidden behind a src helper —
 * two such tests walked past the first version of it — so the `globalSetup` below is the check
 * that actually proves the run left nothing behind: it snapshots the repo root and fails the run
 * on any new entry. "Touches the filesystem" means it uses `fs` for real — a suite that only
 * `vi.mock`s it, like `vault.test.ts`, is pure logic and belongs in the run.
 *
 * A test that lands on main AFTER a branch is cut can trip both checks on rebase — `pnpm test` reds
 * naming the unlisted file, and the simulation dies with `ENOENT` on its `\`-path. That is the
 * guard doing its job, not a regression: classify the new test by the criterion above and list it.
 */
export const REAL_FILESYSTEM_TESTS = [
  'tests/unit/agent/sdk-cost-contract.test.ts',
  'tests/unit/agent/skills-contract.test.ts',
  'tests/unit/canvas/host-csp.test.ts',
  'tests/unit/canvas/sandbox-invariant.test.ts',
  'tests/unit/design/semantic-contrast.test.ts',
  'tests/unit/design/theme-tokens.test.ts',
  'tests/unit/document/store-extraction-deadline.test.ts',
  'tests/unit/document/store.test.ts',
  'tests/unit/export/export-ipc.test.ts',
  'tests/unit/export/html-export-ipc.test.ts',
  'tests/unit/export/pptx-boundary.test.ts',
  'tests/unit/export/pptx-fixture-generate.test.ts',
  'tests/unit/export/pptx-rebuild-only.test.ts',
  'tests/unit/export/pptx/fidelity-corpus.test.ts',
  'tests/unit/export/pptx/fidelity-renderer.test.ts',
  'tests/unit/export/write.test.ts',
  'tests/unit/import/open-deck.test.ts',
  'tests/unit/import/pptx-import.test.ts',
  'tests/unit/import/pptx-roundtrip-identity.test.ts',
  'tests/unit/import/pptx-roundtrip-reparse.test.ts',
  'tests/unit/import/regex-linearity.test.ts',
  'tests/unit/import/rewrite.test.ts',
  'tests/unit/import/slide-text-boundary.test.ts',
  'tests/unit/packaging/build-config.test.ts',
  'tests/unit/packaging/release-workflow.test.ts',
  'tests/unit/packaging/win32-path-simulation.test.ts',
  'tests/unit/perf/bundle.test.ts',
  'tests/unit/perf/diff.test.ts',
  'tests/unit/perf/run.test.ts',
  'tests/unit/preload/preload-bundle-deps.test.ts',
]

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: [
      { find: /^node:path$/, replacement: shim },
      { find: /^path$/, replacement: shim },
    ],
  },
  test: {
    include: ['tests/unit/**/*.test.ts', 'tests/unit/**/*.test.tsx'],
    exclude: [...REAL_FILESYSTEM_TESTS],
    globalSetup: ['./tests/support/win32-litter-guard.ts'],
    environment: 'node',
  },
})
