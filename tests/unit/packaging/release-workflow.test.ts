import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * **Release-workflow contract.** `.github/workflows/release.yml` builds the Windows installer from
 * a clean checkout when a `v*` tag is pushed. Two separate things are being defended here, and only
 * one of them is about the workflow working.
 *
 * 1. **Provenance.** A preview release was once hand-built from a stale worktree: the artifact
 *    predated a merged milestone, so an entire export format silently did nothing in the shipped
 *    build, and nothing anywhere reported a problem. Building from the tag removes that class.
 *
 * 2. **The CI budget.** 70-testing-ci.md §6.1 says GitHub Actions runs unit tests only — never
 *    compilation, never packaging — because Actions minutes are limited and this is the user's
 *    explicit rule. A packaging workflow is a standing temptation to "just also run it on PRs to
 *    make sure it still works", and that one edit would silently multiply the bill by every PR
 *    push forever, on a runner that bills at 2x. So the trigger set is asserted **exhaustively**:
 *    the only trigger allowed to exist is `push.tags`. Adding `pull_request`, `schedule`,
 *    `workflow_dispatch`, or a `branches` filter reds this file. That is the point of it.
 *
 * There is no YAML parser in this dependency tree, and adding one to guard a file we own is a poor
 * trade. The small structural reader below is in the same spirit as `build-config.test.ts`, which
 * hand-models electron-builder's file matcher rather than restating config back to itself: it walks
 * indentation into a key tree, so the assertions are about *structure* — "which keys exist under
 * `on`" — rather than about whether some substring happens to appear in the file.
 */

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const WORKFLOW_PATH = path.join(REPO_ROOT, '.github', 'workflows', 'release.yml')

/** The package.json script the workflow is required to call instead of its own command line. */
const PACK_SCRIPT = 'pack:win:release'

const pkg = JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')) as {
  readonly scripts?: Readonly<Record<string, string>>
}

/* -------------------------------------------------------------------------- */
/* Minimal structural YAML reader                                             */
/* -------------------------------------------------------------------------- */

interface YamlBlock {
  /** `key: value` pairs at this level. */
  readonly scalars: ReadonlyMap<string, string>
  /** `key:` followed by an indented block. */
  readonly blocks: ReadonlyMap<string, YamlBlock>
  /** `- item` entries at this level. */
  readonly sequence: readonly string[]
}

interface SourceLine {
  readonly indent: number
  readonly text: string
}

const EMPTY_BLOCK: YamlBlock = { scalars: new Map(), blocks: new Map(), sequence: [] }

/** Drops blank lines and whole-line comments, and records each surviving line's indentation. */
function readLines(source: string): readonly SourceLine[] {
  const lines: SourceLine[] = []
  for (const raw of source.split('\n')) {
    const trimmed = raw.trim()
    if (trimmed === '' || trimmed.startsWith('#')) continue
    lines.push({ indent: raw.length - raw.trimStart().length, text: trimmed })
  }
  return lines
}

/**
 * Parses a mapping at `indent`, returning it with the index of the first unconsumed line.
 *
 * Lines deeper than `indent` that are not the direct child of a key just parsed are skipped rather
 * than interpreted — that is what keeps block scalars (`run: |`, `path: |`) from being mistaken for
 * structure. This reader only has to be correct for the paths the assertions below actually walk.
 */
function parseBlock(
  lines: readonly SourceLine[],
  start: number,
  indent: number,
): readonly [YamlBlock, number] {
  const scalars = new Map<string, string>()
  const blocks = new Map<string, YamlBlock>()
  const sequence: string[] = []
  let i = start

  while (i < lines.length) {
    const line = lines[i]
    if (line === undefined || line.indent < indent) break
    if (line.indent > indent) {
      i += 1
      continue
    }
    if (line.text.startsWith('- ')) {
      sequence.push(line.text.slice(2).trim())
      i += 1
      continue
    }
    const match = /^([A-Za-z0-9_.-]+):\s*(.*)$/.exec(line.text)
    if (match === null) {
      i += 1
      continue
    }
    const key = match[1] ?? ''
    const value = (match[2] ?? '').trim()
    i += 1
    if (value !== '' && value !== '|' && value !== '>') {
      scalars.set(key, value)
      continue
    }
    const next = lines[i]
    if (next !== undefined && next.indent > indent) {
      const [child, consumed] = parseBlock(lines, i, next.indent)
      blocks.set(key, child)
      i = consumed
    } else {
      blocks.set(key, EMPTY_BLOCK)
    }
  }

  return [{ scalars, blocks, sequence }, i]
}

function parseWorkflow(source: string): YamlBlock {
  const [block] = parseBlock(readLines(source), 0, 0)
  return block
}

/** Every key present at a level, whether it held a scalar or a nested block. */
function keysOf(block: YamlBlock): readonly string[] {
  return [...block.scalars.keys(), ...block.blocks.keys()].toSorted()
}

const workflowSource = existsSync(WORKFLOW_PATH) ? readFileSync(WORKFLOW_PATH, 'utf8') : ''
const workflow = parseWorkflow(workflowSource)

/* -------------------------------------------------------------------------- */

describe('release workflow', () => {
  it('exists', () => {
    expect(
      existsSync(WORKFLOW_PATH),
      '.github/workflows/release.yml is missing — releases have no reproducible build path',
    ).toBe(true)
  })

  it('parses into the structure the rest of this suite asserts on', () => {
    // Guards the reader itself: if `on:`/`jobs:` stopped resolving, every assertion below would
    // pass vacuously against empty maps.
    expect(keysOf(workflow)).toEqual(expect.arrayContaining(['jobs', 'name', 'on', 'permissions']))
  })
})

describe('release workflow — CI budget guard', () => {
  /**
   * The load-bearing test. 70-testing-ci.md §6.1: unit tests only, never packaging. This workflow
   * is allowed to exist as the single exception *because* it cannot fire during development.
   */
  it('is triggered by tag pushes and by nothing else whatsoever', () => {
    const on = workflow.blocks.get('on')
    expect(on, "workflow has no `on:` block — can't verify the budget guard").toBeDefined()

    expect(
      keysOf(on ?? EMPTY_BLOCK),
      'release.yml must have exactly one trigger: `push` (tags only). Any other trigger — ' +
        'pull_request, schedule, workflow_dispatch — makes packaging run outside a release and ' +
        'burns the Actions budget this repo deliberately protects (70-testing-ci.md §6.1). If you ' +
        'are here because you added one, that is what this test is for.',
    ).toEqual(['push'])
  })

  it('restricts the push trigger to tags, never to a branch', () => {
    const push = workflow.blocks.get('on')?.blocks.get('push')
    expect(push, '`on.push` must be a block containing `tags`').toBeDefined()

    expect(
      keysOf(push ?? EMPTY_BLOCK),
      '`on.push` must name `tags` and nothing else — a `branches` filter would run a full Windows ' +
        'packaging build on every push to that branch',
    ).toEqual(['tags'])

    expect(push?.blocks.get('tags')?.sequence ?? []).toContain("'v*'")
  })

  it('caps its own cost with an explicit job timeout', () => {
    const jobs = workflow.blocks.get('jobs') ?? EMPTY_BLOCK
    expect(jobs.blocks.size).toBeGreaterThan(0)
    for (const [name, job] of jobs.blocks) {
      const timeout = job.scalars.get('timeout-minutes')
      expect(
        timeout,
        `job "${name}" has no timeout-minutes — a hung run bills until GitHub's cap`,
      ).toBeDefined()
      expect(Number(timeout)).toBeLessThanOrEqual(60)
    }
  })

  it('keeps packaging out of the unit-test workflow', () => {
    // The budget rule from the other direction: test.yml runs on every PR, so it must never grow a
    // packaging or build step.
    const testWorkflow = readFileSync(
      path.join(REPO_ROOT, '.github', 'workflows', 'test.yml'),
      'utf8',
    )
    expect(testWorkflow).not.toMatch(/electron-builder|pnpm (run )?pack/)
  })
})

describe('release workflow — build correctness', () => {
  it('builds on a Windows runner, because NSIS cannot be produced on Linux', () => {
    // electron-builder EXECUTES the freshly built installer to emit its uninstaller, which needs
    // Wine and does not work on this project's WSL2 box (docs/windows-smoke-runbook.md §8.1). A
    // native Windows runner is the whole reason this workflow retires the manual procedure.
    const jobs = workflow.blocks.get('jobs') ?? EMPTY_BLOCK
    expect(jobs.blocks.size).toBeGreaterThan(0)
    for (const [name, job] of jobs.blocks) {
      expect(job.scalars.get('runs-on'), `job "${name}" must run on windows-latest`).toBe(
        'windows-latest',
      )
    }
  })

  it('packages via the real package.json script, not a duplicated command line', () => {
    // The M5.2 `build` block is the single source of truth for targets and artifact names, and
    // build-config.test.ts guards it. A hardcoded `electron-builder --win nsis zip` in the workflow
    // would be a second copy that drifts from it silently — the exact failure mode that produced
    // the throwaway Windows-host builder config this workflow replaces (runbook §8.2).
    expect(workflowSource).toContain(`pnpm ${PACK_SCRIPT}`)
    expect(
      workflowSource.replace(/^\s*#.*$/gm, ''),
      'the workflow must call the pack script, not invoke electron-builder directly',
    ).not.toMatch(/electron-builder/)
  })

  it('has that script, and it targets Windows without auto-publishing', () => {
    const script = pkg.scripts?.[PACK_SCRIPT]
    expect(
      script,
      `package.json is missing the "${PACK_SCRIPT}" script the workflow calls`,
    ).toBeDefined()
    expect(script).toContain('electron-builder')
    expect(script).toContain('--win')
    // Without this, electron-builder detects the CI tag build and tries to publish a GitHub
    // release itself, competing with the workflow's own upload step.
    expect(script, `${PACK_SCRIPT} must pass --publish never`).toContain('--publish never')
    // Targets come from `build.win.target` (nsis + zip), never from the command line.
    expect(script).not.toMatch(/--win\s+(nsis|zip)/)
  })

  it('does not skip the Electron binary download, unlike the unit-test workflow', () => {
    // test.yml sets ELECTRON_SKIP_BINARY_DOWNLOAD=1 because unit tests never launch Electron.
    // Packaging must pack the real win32 binary, so the same flag here would break the artifact.
    expect(workflowSource.replace(/^\s*#.*$/gm, '')).not.toContain('ELECTRON_SKIP_BINARY_DOWNLOAD')
  })

  it('installs from the frozen lockfile, so the build is reproducible from the tag', () => {
    expect(workflowSource).toContain('pnpm install --frozen-lockfile')
  })

  it('grants release-write permission at the job level, not workflow-wide', () => {
    expect(workflow.blocks.get('permissions')?.scalars.get('contents')).toBe('read')
    const jobs = workflow.blocks.get('jobs') ?? EMPTY_BLOCK
    const writers = [...jobs.blocks.values()].filter(
      (job) => job.blocks.get('permissions')?.scalars.get('contents') === 'write',
    )
    expect(
      writers.length,
      'the packaging job needs job-scoped `contents: write` to attach artifacts',
    ).toBeGreaterThan(0)
  })
})
