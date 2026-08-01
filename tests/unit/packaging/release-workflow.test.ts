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
 *
 * The reader **fails closed**: anything it cannot model throws. That is not fastidiousness, it is
 * the fix for a real hole. The first revision skipped lines its regex missed, and review found that
 * `"pull_request":`, `'workflow_dispatch':`, and `? pull_request` / `:` are all triggers GitHub
 * honours yet the reader silently ignored — so the suite stayed green while the budget rule was
 * being abandoned. See the `fails closed` describe block at the bottom, which pins that property.
 */

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const WORKFLOW_PATH = path.join(REPO_ROOT, '.github', 'workflows', 'release.yml')

/** The package.json script the workflow is required to call instead of its own command line. */
const PACK_SCRIPT = 'pack:win:release'

/** The step name that ties the tag being built to the version stamped into the artifacts. */
const TAG_VERSION_STEP = 'Verify tag matches package version'

const pkg = JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')) as {
  readonly scripts?: Readonly<Record<string, string>>
}

/* -------------------------------------------------------------------------- */
/* Minimal structural YAML reader                                             */
/* -------------------------------------------------------------------------- */

interface YamlBlock {
  /** `key: value` pairs at this level. Block scalars (`run: |`) hold their joined body text. */
  readonly scalars: ReadonlyMap<string, string>
  /** `key:` followed by an indented block. */
  readonly blocks: ReadonlyMap<string, YamlBlock>
  /** `- item` entries at this level whose item is a plain scalar. */
  readonly sequence: readonly string[]
  /** `- item` entries at this level whose item is a mapping (e.g. a workflow step). */
  readonly items: readonly YamlBlock[]
}

interface SourceLine {
  readonly indent: number
  readonly text: string
}

const EMPTY_BLOCK: YamlBlock = {
  scalars: new Map(),
  blocks: new Map(),
  sequence: [],
  items: [],
}

/** A `key:` in any of the three spellings YAML accepts: bare, "double-quoted", 'single-quoted'. */
const KEY_RE = /^(?:"([^"]*)"|'([^']*)'|([A-Za-z0-9_.-]+)):(?:\s+(.*))?$/
/** Block scalar introducers, including the chomping/keep modifiers. */
const BLOCK_SCALAR_RE = /^[|>][+-]?$/

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
 * **This reader fails closed.** Any line it cannot model throws, rather than being skipped. That
 * property is the whole point: an earlier revision skipped unmatched lines, and a review found
 * three legal YAML spellings — `"pull_request":`, `'workflow_dispatch':`, and the explicit-key form
 * `? pull_request` / `:` — that GitHub honours as real triggers (actionlint resolves all three and
 * rejects them only when the event name is bogus) but that the reader silently ignored, leaving the
 * budget guard GREEN while the budget was being abandoned. A structural reader that skips what it
 * does not understand cannot be a guard, so every unmodelled syntax must become red, not invisible.
 *
 * Block scalar bodies (`run: |`, `path: |`) are consumed as opaque text rather than parsed, which
 * is both more accurate and what keeps shell script lines from tripping the throw.
 */
function parseBlock(
  lines: readonly SourceLine[],
  start: number,
  indent: number,
): readonly [YamlBlock, number] {
  const scalars = new Map<string, string>()
  const blocks = new Map<string, YamlBlock>()
  const sequence: string[] = []
  const items: YamlBlock[] = []
  let i = start

  /** Collects every line indented deeper than `outer`, starting at `from`. */
  const takeDeeper = (from: number, outer: number): readonly [SourceLine[], number] => {
    const taken: SourceLine[] = []
    let j = from
    while (j < lines.length) {
      const candidate = lines[j]
      if (candidate === undefined || candidate.indent <= outer) break
      taken.push(candidate)
      j += 1
    }
    return [taken, j]
  }

  while (i < lines.length) {
    const line = lines[i]
    if (line === undefined || line.indent < indent) break
    if (line.indent > indent) {
      throw new Error(
        `unexpected indentation at "${line.text}" (indent ${line.indent}, expected ${indent})`,
      )
    }

    if (line.text === '-' || line.text.startsWith('- ')) {
      const rest = line.text === '-' ? '' : line.text.slice(2).trim()
      const [deeper, afterDeeper] = takeDeeper(i + 1, line.indent)
      const itemIndent = line.indent + 2
      if (rest !== '' && KEY_RE.test(rest)) {
        const itemLines = [{ indent: itemIndent, text: rest }, ...deeper]
        const [item] = parseBlock(itemLines, 0, itemIndent)
        items.push(item)
      } else if (deeper.length === 0) {
        sequence.push(rest)
      } else {
        throw new Error(`unmodelled sequence item: ${line.text}`)
      }
      i = afterDeeper
      continue
    }

    const match = KEY_RE.exec(line.text)
    if (match === null) {
      throw new Error(
        `unparsed YAML line at indent ${line.indent}: ${line.text} — the reader must model ` +
          `every line or it cannot be trusted as a guard`,
      )
    }
    const key = match[1] ?? match[2] ?? match[3] ?? ''
    const value = (match[4] ?? '').trim()
    i += 1

    if (BLOCK_SCALAR_RE.test(value)) {
      const [body, afterBody] = takeDeeper(i, line.indent)
      scalars.set(key, body.map((entry) => entry.text).join('\n'))
      i = afterBody
      continue
    }
    if (value !== '') {
      scalars.set(key, value)
      continue
    }
    const next = lines[i]
    if (next !== undefined && next.indent > indent) {
      const [child, consumed] = parseBlock(lines, i, next.indent)
      blocks.set(key, child)
      i = consumed
    } else {
      // A key with neither a value nor an indented body — e.g. a bare `pull_request:` trigger.
      // Recording it is what makes the exhaustive trigger assertion red.
      blocks.set(key, EMPTY_BLOCK)
    }
  }

  return [{ scalars, blocks, sequence, items }, i]
}

/** Every key present at a level, whether it held a scalar or a nested block. */
function keysOf(block: YamlBlock): readonly string[] {
  return [...block.scalars.keys(), ...block.blocks.keys()].toSorted()
}

const workflowSource = existsSync(WORKFLOW_PATH) ? readFileSync(WORKFLOW_PATH, 'utf8') : ''

/**
 * Parsed lazily and memoized so a throw surfaces as a normal test failure with its message intact,
 * rather than as a module-load error that obscures which assertion was being made.
 */
let parsed: YamlBlock | undefined
function getWorkflow(): YamlBlock {
  parsed ??= parseBlock(readLines(workflowSource), 0, 0)[0]
  return parsed
}

/** Every step across every job, as parsed mappings. */
function allSteps(): readonly YamlBlock[] {
  return [...(getWorkflow().blocks.get('jobs')?.blocks.values() ?? [])].flatMap(
    (job) => job.blocks.get('steps')?.items ?? [],
  )
}

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
    expect(keysOf(getWorkflow())).toEqual(
      expect.arrayContaining(['jobs', 'name', 'on', 'permissions']),
    )
  })
})

describe('release workflow — CI budget guard', () => {
  /**
   * The load-bearing test. 70-testing-ci.md §6.1: unit tests only, never packaging. This workflow
   * is allowed to exist as the single exception *because* it cannot fire during development.
   */
  it('is triggered by tag pushes and by nothing else whatsoever', () => {
    const on = getWorkflow().blocks.get('on')
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
    const push = getWorkflow().blocks.get('on')?.blocks.get('push')
    expect(push, '`on.push` must be a block containing `tags`').toBeDefined()

    expect(
      keysOf(push ?? EMPTY_BLOCK),
      '`on.push` must name `tags` and nothing else — a `branches` filter would run a full Windows ' +
        'packaging build on every push to that branch',
    ).toEqual(['tags'])

    expect(push?.blocks.get('tags')?.sequence ?? []).toContain("'v*'")
  })

  it('caps its own cost with an explicit job timeout', () => {
    const jobs = getWorkflow().blocks.get('jobs') ?? EMPTY_BLOCK
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
    const jobs = getWorkflow().blocks.get('jobs') ?? EMPTY_BLOCK
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
    expect(getWorkflow().blocks.get('permissions')?.scalars.get('contents')).toBe('read')
    const jobs = getWorkflow().blocks.get('jobs') ?? EMPTY_BLOCK
    const writers = [...jobs.blocks.values()].filter(
      (job) => job.blocks.get('permissions')?.scalars.get('contents') === 'write',
    )
    expect(
      writers.length,
      'the packaging job needs job-scoped `contents: write` to attach artifacts',
    ).toBeGreaterThan(0)
  })

  it('refuses to build a tag whose version disagrees with package.json', () => {
    // `build.nsis.artifactName` interpolates package.json's version, so without this step ANY tag
    // produces `sloodge-<package version>-setup.exe`. Origin already carries v0.0.0-preview and
    // v0.0.1-preview, which today would yield identically named artifacts that `--clobber`
    // overwrites. Provenance has to cover the artifact's name, not just its source commit.
    const guard = allSteps().find((step) => step.scalars.get('name') === TAG_VERSION_STEP)
    expect(
      guard,
      `release.yml must have a "${TAG_VERSION_STEP}" step — otherwise a v0.0.2 tag silently ` +
        'ships an installer named and self-reporting some other version',
    ).toBeDefined()

    const script = guard?.scalars.get('run') ?? ''
    expect(script).toContain('package.json')
    expect(script).toContain('GITHUB_REF_NAME')
    // Must actually fail the job, not just warn.
    expect(script, 'the version guard must exit non-zero on a mismatch').toContain('exit 1')
  })

  it('runs the version guard before the expensive steps', () => {
    // A mismatch should cost seconds, not a 15-minute install-and-build.
    const names = allSteps().map((step) => step.scalars.get('name') ?? step.scalars.get('uses'))
    const guardAt = names.indexOf(TAG_VERSION_STEP)
    const packAt = names.indexOf('Build and package')
    expect(guardAt).toBeGreaterThanOrEqual(0)
    expect(packAt).toBeGreaterThan(guardAt)
  })
})

describe('release workflow — the reader fails closed', () => {
  /**
   * A guard is only as good as its parser. The first revision of this file SKIPPED lines its regex
   * did not match, and review found three legal spellings that GitHub honours as real triggers but
   * that the reader ignored, leaving the suite green while the budget rule was abandoned. These
   * tests pin the fail-closed property itself, so it cannot regress back into a silent skip.
   */
  const parse = (yaml: string): YamlBlock => parseBlock(readLines(yaml), 0, 0)[0]

  it('sees a double-quoted trigger key', () => {
    expect(keysOf(parse('on:\n  "pull_request":\n  push:\n'))).toEqual(['on'])
    expect(
      keysOf(parse('on:\n  "pull_request":\n  push:\n').blocks.get('on') ?? EMPTY_BLOCK),
    ).toEqual(['pull_request', 'push'])
  })

  it('sees a single-quoted trigger key', () => {
    expect(
      keysOf(parse("on:\n  'workflow_dispatch':\n  push:\n").blocks.get('on') ?? EMPTY_BLOCK),
    ).toEqual(['push', 'workflow_dispatch'])
  })

  it('throws on YAML explicit-key syntax rather than ignoring it', () => {
    expect(() => parse('on:\n  ? pull_request\n  :\n  push:\n')).toThrow(/unparsed YAML line/)
  })

  it('throws on any line it cannot model, rather than skipping it', () => {
    expect(() => parse('on:\n  @not-yaml\n')).toThrow(/unparsed YAML line/)
  })

  it('treats a block scalar body as opaque text, not as structure', () => {
    // Without this, the shell script inside `run: |` would trip the throw above.
    const block = parse('run: |\n  set -euo pipefail\n  echo hi\n')
    expect(block.scalars.get('run')).toBe('set -euo pipefail\necho hi')
  })
})
