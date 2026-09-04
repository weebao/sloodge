/**
 * Refuse to measure a bundle that is not the source under review.
 *
 * Everything in `perf/` drives `out/`, never `src/`: `perf:run` and `perf:isolation` launch the
 * built app. Nothing in the build makes that fresh — and `pnpm build` is `pnpm typecheck &&
 * electron-vite build`, so a build that fails typecheck leaves the *previous* bundle in place and
 * exits non-zero somewhere the operator may not be watching. The result is an instrument that
 * cheerfully certifies code that was never built: the isolation probe, whose whole output is a
 * pass/fail claim about process containment, reported `CONTAINED 110 of 110` against a tree whose
 * `slideDocumentHost` had been mutated to break exactly that (M8.2 round 3).
 *
 * So the harness compares mtimes before it launches anything: if any build artifact is older than
 * the newest file under `src/` (or the build config), it names both paths and refuses. A stale
 * bundle is now a loud failure rather than a silent pass, which is the only difference that
 * matters — an assertion tool that can assert against the wrong code is worse than no tool.
 *
 * mtimes, not content hashes: the question is "was this built after the source was last touched",
 * and a rebuild that produces identical bytes is still the answer "yes". Over-refusal (a `git
 * checkout` restamps mtimes) costs a rebuild; under-refusal costs a false certification.
 */

import { readdir, stat } from 'node:fs/promises'
import { join, relative } from 'node:path'

/**
 * What `electron-vite build` writes, one per bundle. Every build rewrites all three, so the oldest
 * of them dates the build — a partial or failed build shows up as one of these lagging.
 */
const BUILD_ARTIFACTS = [
  join('out', 'main', 'index.js'),
  join('out', 'preload', 'index.cjs'),
  join('out', 'renderer', 'index.html'),
]

/** Everything the bundles are built from. */
const SOURCE_ROOTS = ['src', 'electron.vite.config.ts']

export class StaleBundleError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'StaleBundleError'
  }
}

type FileTime = { readonly path: string; readonly mtimeMs: number }

async function newestSource(repoRoot: string): Promise<FileTime | null> {
  let newest: FileTime | null = null
  for (const root of SOURCE_ROOTS) {
    const absolute = join(repoRoot, root)
    const rootStat = await stat(absolute).catch(() => null)
    if (rootStat === null) continue

    const files = rootStat.isDirectory()
      ? (await readdir(absolute, { withFileTypes: true, recursive: true }))
          .filter((entry) => entry.isFile())
          .map((entry) => join(entry.parentPath, entry.name))
      : [absolute]

    for (const file of files) {
      const info = await stat(file).catch(() => null)
      if (info === null) continue
      if (newest === null || info.mtimeMs > newest.mtimeMs) {
        newest = { path: relative(repoRoot, file), mtimeMs: info.mtimeMs }
      }
    }
  }
  return newest
}

/** The oldest of the three, or `null` if any is absent — an app that was never fully built. */
async function oldestArtifact(repoRoot: string): Promise<FileTime | null> {
  let oldest: FileTime | null = null
  for (const artifact of BUILD_ARTIFACTS) {
    const info = await stat(join(repoRoot, artifact)).catch(() => null)
    if (info === null) return null
    if (oldest === null || info.mtimeMs < oldest.mtimeMs) {
      oldest = { path: artifact, mtimeMs: info.mtimeMs }
    }
  }
  return oldest
}

const REBUILD_HINT =
  'Run `pnpm build` and check that it succeeded: it is `pnpm typecheck && electron-vite build`, ' +
  'so a type error leaves the previous bundle in place and every measurement then describes code ' +
  'that is not in the tree.'

/**
 * Throw unless every build artifact is newer than every source file.
 *
 * Called by `launchApp`, so it covers `perf:run` and `perf:isolation` alike and any harness written
 * later — the guard belongs at the launch, not in each CLI's preamble, because the defect is
 * "measured the wrong bundle", not "forgot a flag".
 */
export async function assertBundleBuiltFromSource(repoRoot: string): Promise<void> {
  const artifact = await oldestArtifact(repoRoot)
  if (artifact === null) {
    throw new StaleBundleError(
      `The perf harness drives the built app, and ${BUILD_ARTIFACTS.join(', ')} are not all ` +
        `present under ${repoRoot}. ${REBUILD_HINT}`,
    )
  }

  const source = await newestSource(repoRoot)
  if (source === null || source.mtimeMs <= artifact.mtimeMs) return

  throw new StaleBundleError(
    `Refusing to measure a stale bundle: ${artifact.path} was built at ` +
      `${new Date(artifact.mtimeMs).toISOString()}, but ${source.path} changed at ` +
      `${new Date(source.mtimeMs).toISOString()}. ${REBUILD_HINT}`,
  )
}
