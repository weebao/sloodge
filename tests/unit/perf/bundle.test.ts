/**
 * The harness must refuse a bundle older than its source.
 *
 * `perf:isolation` is a pass/fail claim about process containment and `perf:run` is the evidence
 * every M8 milestone is argued from, and both drive `out/`, which nothing rebuilds for them. A
 * mutated `src/` with an unrebuilt `out/` produced a clean `CONTAINED 110 of 110` — a false
 * certification indistinguishable from an honest one (M8.2 round 3). These tests pin the refusal
 * and its wiring into `launchApp`, which is the only door to the app.
 *
 * Real files with real mtimes: the guard is a statement about what is on disk.
 */

import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { launchApp } from '../../../perf/harness/app'
import { assertBundleBuiltFromSource, StaleBundleError } from '../../../perf/harness/bundle'

const BUILT_AT = new Date('2026-09-01T12:00:00Z')
const BEFORE_BUILD = new Date('2026-09-01T11:00:00Z')
const AFTER_BUILD = new Date('2026-09-01T13:00:00Z')

let root = ''

/** A repo with `src/` (plus the build config) older than a complete `out/`. */
async function buildFixture(): Promise<void> {
  await mkdir(join(root, 'src', 'main'), { recursive: true })
  await mkdir(join(root, 'out', 'main'), { recursive: true })
  await mkdir(join(root, 'out', 'preload'), { recursive: true })
  await mkdir(join(root, 'out', 'renderer'), { recursive: true })

  const files = [
    [join('src', 'main', 'index.ts'), BEFORE_BUILD],
    [join('src', 'shared.ts'), BEFORE_BUILD],
    ['electron.vite.config.ts', BEFORE_BUILD],
    [join('out', 'main', 'index.js'), BUILT_AT],
    [join('out', 'preload', 'index.cjs'), BUILT_AT],
    [join('out', 'renderer', 'index.html'), BUILT_AT],
  ] as const

  await Promise.all(
    files.map(async ([path, at]) => {
      const absolute = join(root, path)
      await writeFile(absolute, '//')
      await utimes(absolute, at, at)
    }),
  )
}

async function touch(path: string, at: Date): Promise<void> {
  await utimes(join(root, path), at, at)
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'sloodge-bundle-'))
  await buildFixture()
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('assertBundleBuiltFromSource', () => {
  it('accepts a bundle built after every source file', async () => {
    await expect(assertBundleBuiltFromSource(root)).resolves.toBeUndefined()
  })

  it('refuses a bundle older than a source file, naming both paths', async () => {
    await touch(join('src', 'main', 'index.ts'), AFTER_BUILD)

    await expect(assertBundleBuiltFromSource(root)).rejects.toThrow(StaleBundleError)
    await expect(assertBundleBuiltFromSource(root)).rejects.toThrow(
      /out[/\\]main[/\\]index\.js.*src[/\\]main[/\\]index\.ts/s,
    )
  })

  it('sees a source file nested anywhere under src/', async () => {
    await mkdir(join(root, 'src', 'renderer', 'src', 'features'), { recursive: true })
    const nested = join('src', 'renderer', 'src', 'features', 'SlideCanvas.tsx')
    await writeFile(join(root, nested), '//')
    await touch(nested, AFTER_BUILD)

    await expect(assertBundleBuiltFromSource(root)).rejects.toThrow(/SlideCanvas\.tsx/)
  })

  it('refuses when the build config is newer than the bundle', async () => {
    await touch('electron.vite.config.ts', AFTER_BUILD)

    await expect(assertBundleBuiltFromSource(root)).rejects.toThrow(/electron\.vite\.config\.ts/)
  })

  /**
   * A failed `electron-vite build` can leave one bundle rewritten and the others as they were, so
   * the build is dated by its *oldest* artifact, not its newest.
   */
  it('refuses when only one of the three artifacts was rebuilt', async () => {
    await touch(join('out', 'main', 'index.js'), AFTER_BUILD)
    await touch(join('src', 'main', 'index.ts'), new Date('2026-09-01T12:30:00Z'))

    await expect(assertBundleBuiltFromSource(root)).rejects.toThrow(
      /out[/\\](preload[/\\]index\.cjs|renderer[/\\]index\.html)/,
    )
  })

  it('refuses when the app was never built at all', async () => {
    await rm(join(root, 'out'), { recursive: true, force: true })

    await expect(assertBundleBuiltFromSource(root)).rejects.toThrow(/pnpm build/)
  })
})

describe('launchApp', () => {
  it('refuses a stale bundle before it spawns anything', async () => {
    await touch(join('src', 'main', 'index.ts'), AFTER_BUILD)

    // Ports and display are junk on purpose: reaching them would mean the guard did not run.
    await expect(
      launchApp({ repoRoot: root, cdpPort: 0, inspectPort: 0, display: ':0' }),
    ).rejects.toThrow(StaleBundleError)
  })
})
