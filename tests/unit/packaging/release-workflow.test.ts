import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
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
 * The reader **fails closed**: anything it cannot model throws, so a trigger spelled in a syntax it
 * does not understand becomes red rather than invisible. `parseBlock`'s docblock explains why that
 * is load-bearing; the `fails closed` describe block at the bottom pins it.
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
  /** Index of this line in the unfiltered source, so block scalars can be read back verbatim. */
  readonly rawIndex: number
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

/**
 * Drops blank lines and whole-line comments for *structural* parsing, recording each surviving
 * line's indentation and its index in the original source.
 *
 * That index is what lets block scalar bodies be reconstructed from the RAW lines instead of these
 * filtered ones. Without it, a `run:` body silently lost its comments and blank lines, so the
 * guard-execution harness only happened to be byte-faithful for a step that contained neither —
 * fidelity by luck rather than by construction. Comments in a shell script are harmless to execute,
 * but "the body we run is not the body that ships" is not a property to leave to chance.
 */
function readLines(source: string): readonly SourceLine[] {
  const lines: SourceLine[] = []
  const raw = source.split('\n')
  for (const [index, line] of raw.entries()) {
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#')) continue
    lines.push({
      indent: line.length - line.trimStart().length,
      text: trimmed,
      rawIndex: index,
    })
  }
  return lines
}

/**
 * Reconstructs a block scalar body from the original source, preserving comments and interior
 * blank lines exactly as they ship, dedented by the body's own indentation.
 */
function blockScalarBody(rawLines: readonly string[], ownerRawIndex: number, ownerIndent: number) {
  const body: string[] = []
  for (let i = ownerRawIndex + 1; i < rawLines.length; i += 1) {
    const line = rawLines[i] ?? ''
    if (line.trim() === '') {
      body.push('')
      continue
    }
    if (line.length - line.trimStart().length <= ownerIndent) break
    body.push(line)
  }
  while (body.length > 0 && body[body.length - 1] === '') body.pop()
  const indents = body
    .filter((line) => line.trim() !== '')
    .map((line) => line.length - line.trimStart().length)
  const base = indents.length === 0 ? 0 : Math.min(...indents)
  return body.map((line) => (line.trim() === '' ? '' : line.slice(base))).join('\n')
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
  rawLines: readonly string[],
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
        const itemLines = [{ indent: itemIndent, text: rest, rawIndex: line.rawIndex }, ...deeper]
        const [item] = parseBlock(itemLines, 0, itemIndent, rawLines)
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
      // Read the body from the RAW source, not the comment-stripped lines, so what the harness
      // executes is byte-for-byte what the runner executes.
      scalars.set(key, blockScalarBody(rawLines, line.rawIndex, line.indent))
      const [, afterBody] = takeDeeper(i, line.indent)
      i = afterBody
      continue
    }
    if (value !== '') {
      scalars.set(key, value)
      continue
    }
    const next = lines[i]
    if (next !== undefined && next.indent > indent) {
      const [child, consumed] = parseBlock(lines, i, next.indent, rawLines)
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

/** Parses a whole YAML document, giving the reader both the structural and the raw lines. */
function parseYaml(source: string): YamlBlock {
  return parseBlock(readLines(source), 0, 0, source.split('\n'))[0]
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
  parsed ??= parseYaml(workflowSource)
  return parsed
}

/** A `defaults.run.shell` override at whatever scope `block` is, if one is declared. */
function defaultsShell(block: YamlBlock | undefined): string | undefined {
  return block?.blocks.get('defaults')?.blocks.get('run')?.scalars.get('shell')
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

  it('lets no workflow package outside a tag trigger', () => {
    // The budget rule from the other direction, and deliberately NOT written as "test.yml must not
    // package". Naming the two files that exist today would leave a third one — added next month,
    // by someone who never read §6.5 — completely unguarded. So: enumerate every workflow, and
    // whichever ones package must be tag-triggered only. That holds for files nobody has written yet.
    const dir = path.join(REPO_ROOT, '.github', 'workflows')
    const files = readdirSync(dir).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
    expect(
      files.length,
      'no workflow files found — the guard would pass vacuously',
    ).toBeGreaterThan(0)

    const packagers: string[] = []
    for (const file of files) {
      const source = readFileSync(path.join(dir, file), 'utf8')
      // Comments stripped so prose *about* packaging does not count as packaging.
      const code = source.replace(/^\s*#.*$/gm, '')
      if (!/electron-builder|pnpm (run |exec )?pack|pack:win/.test(code)) continue
      packagers.push(file)
      const triggers = keysOf(parseYaml(source).blocks.get('on') ?? EMPTY_BLOCK)
      expect(
        triggers,
        `${file} runs a packaging command, so it must be triggered by tag pushes only`,
      ).toEqual(['push'])
    }

    // And the one that does package is the one we think it is.
    expect(packagers).toEqual(['release.yml'])
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

describe('the tag/version guard, executed', () => {
  /**
   * Asserting that a step exists, precedes the build and contains a few substrings does not test a
   * guard: `continue-on-error: true`, an inverted comparison, a step-level env escape hatch and a
   * deleted `-<suffix>` arm all survive that, and every one of them is actionlint-valid. So this
   * block extracts the step's real `run:` body and EXECUTES it under bash against a matrix of
   * (package version, tag) pairs, asserting the exit status. A guard that is only ever read is not
   * tested; one that is run is.
   */
  const guardStep = (): YamlBlock => {
    const step = allSteps().find((entry) => entry.scalars.get('name') === TAG_VERSION_STEP)
    if (step === undefined) throw new Error(`no "${TAG_VERSION_STEP}" step in release.yml`)
    return step
  }

  // By bare name, `bash` on a Windows host with WSL resolves to `System32\\bash.exe` (the WSL
  // launcher) whenever that precedes Git's bin on PATH, and every case below then fails for a
  // reason unrelated to the guard. The runner image has Git's bin first and no WSL at all, so this
  // only matters on developer machines — but there it turned 11 tests red.
  const gitBash = path.join(
    process.env['ProgramFiles'] ?? 'C:\\Program Files',
    'Git',
    'bin',
    'bash.exe',
  )
  const bash = process.platform === 'win32' && existsSync(gitBash) ? gitBash : 'bash'

  /**
   * Runs the guard's shell in a scratch dir whose package.json carries `version`, returning the
   * exit status. `GITHUB_ENV` points at a real file, as it does on a runner — the step appends the
   * artifact-name slug to it, and under `set -u` an unset `GITHUB_ENV` would abort the script for
   * reasons that have nothing to do with the tag.
   */
  const runGuard = (version: string, tag: string | undefined): number => {
    const script = guardStep().scalars.get('run') ?? ''
    const dir = mkdtempSync(path.join(tmpdir(), 'sloodge-tag-guard-'))
    try {
      writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'sloodge', version }))
      const githubEnv = path.join(dir, 'github_env')
      writeFileSync(githubEnv, '')
      const env: NodeJS.ProcessEnv = { ...process.env, GITHUB_ENV: githubEnv }
      if (tag === undefined) delete env['GITHUB_REF_NAME']
      else env['GITHUB_REF_NAME'] = tag
      execFileSync(bash, ['-c', script], { cwd: dir, env, stdio: 'pipe' })
      return 0
    } catch (error) {
      const status = (error as { status?: unknown }).status
      if (typeof status === 'number') return status
      // NOT a rejection by the guard — bash never ran (ENOENT, or EAGAIN under fork pressure).
      // Reporting that as a non-zero exit would make every "rejects ..." case pass for the wrong
      // reason, and would turn a flaky machine into a green suite. Fail loudly and say why.
      throw new Error(
        'could not execute the tag/version guard under bash — this is a harness failure, ' +
          'not a guard result',
        { cause: error },
      )
    } finally {
      // A throw here would REPLACE the return or the error above, and a scratch dir that resists
      // removal (a scanner holding a handle on Windows) is not what this test measures.
      try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 3 })
      } catch {
        // left in tmpdir; the exit status wins
      }
    }
  }

  it.each([
    { version: '0.0.1', tag: 'v0.0.1', why: 'exact match' },
    { version: '0.0.1', tag: 'v0.0.1-preview', why: 'documented pre-release suffix' },
    { version: '0.0.0', tag: 'v0.0.0-preview', why: 'the suffix form already on origin' },
    { version: '1.2.3', tag: 'v1.2.3-rc.1', why: 'a dotted suffix' },
  ])('accepts $tag against $version ($why)', ({ version, tag }) => {
    expect(runGuard(version, tag)).toBe(0)
  })

  it.each([
    { version: '0.0.1', tag: 'v0.0.2', why: 'plain mismatch' },
    { version: '0.0.1', tag: 'v0.0.10', why: 'prefix extension, not a suffix' },
    { version: '0.0.1', tag: '0.0.1', why: 'missing the v prefix' },
    { version: '0.0.1', tag: 'v0.0.1x', why: 'trailing junk without the - separator' },
    { version: '0.0.1', tag: 'release-0.0.1', why: 'unrelated tag shape' },
    { version: '0.0.0', tag: 'v0.0.1-preview', why: 'the exact collision seen on origin' },
    { version: '0.0.1', tag: 'v0.0.1-', why: 'empty suffix — a trailing dash is a typo' },
  ])('rejects $tag against $version ($why)', ({ version, tag }) => {
    expect(runGuard(version, tag)).not.toBe(0)
  })

  it('fails rather than passing when the tag variable is absent entirely', () => {
    // With no GITHUB_REF_NAME the ordinary mismatch branch exits 1 anyway, so this case holds with
    // or without `set -u`. The strict-mode flags are pinned separately, below.
    expect(runGuard('0.0.1', undefined)).not.toBe(0)
  })

  it('runs under bash strict mode', () => {
    // Pinned explicitly because the assertion above does NOT depend on it: deleting
    // `set -euo pipefail` left the whole file green. Strict mode still matters — an unset variable
    // or a failing `node` invocation must abort rather than sail on to the success echo.
    expect(guardStep().scalars.get('run')).toContain('set -euo pipefail')
  })

  it('declares shell: bash, which is what makes executing the body here meaningful', () => {
    // The harness runs the body under bash. If the step did not itself declare `shell: bash`,
    // everything proven here would be about a shell the runner never uses. On windows-latest the
    // default is pwsh, and `shell: cmd` is actionlint-valid and exits with the errorlevel of the
    // LAST command — the guard's last line is an `echo`, so it would be silently always-green.
    expect(
      guardStep().scalars.get('shell'),
      'the tag/version guard must declare `shell: bash` — the default on windows-latest is pwsh',
    ).toBe('bash')
  })

  it('is not overridden by a defaults.run.shell at workflow or job level', () => {
    // Deleting `shell: bash` AND adding `defaults: {run: {shell: pwsh}}` is a two-line change that
    // would otherwise pass. Assert no defaults block redirects the shell anywhere in the file.
    expect(
      defaultsShell(getWorkflow()),
      'workflow-level defaults.run.shell must not be set',
    ).toBeUndefined()
    for (const [name, job] of getWorkflow().blocks.get('jobs')?.blocks ?? new Map()) {
      expect(defaultsShell(job), `job "${name}" must not set defaults.run.shell`).toBeUndefined()
    }
  })

  it('is not neutered by continue-on-error', () => {
    // A step that fails but does not fail the job is decoration. This is the key the old
    // substring-only test never looked at, while its comment claimed otherwise.
    expect(
      guardStep().scalars.get('continue-on-error'),
      'the tag/version guard must not set continue-on-error — it has to fail the job',
    ).toBeUndefined()
  })

  it('is not bypassable by any step-level conditional', () => {
    // `if:` on the guard step would let a releaser skip it from the workflow rather than fix the
    // version, which is the same hole in a different spelling.
    expect(guardStep().scalars.get('if')).toBeUndefined()
  })

  it('reads the tag from the runner, with no env block at ANY scope overriding it', () => {
    // Executing the `run:` body proves the logic, but not that the step is fed real inputs: an
    // `env: { GITHUB_REF_NAME: ... }` would pin the comparison to a constant and the matrix above
    // would never notice, because it supplies the variable itself.
    //
    // Checking only the guard step is not enough — that was the earlier gap. GitHub resolves `env`
    // at workflow, job AND step scope, so the identical override one level up would have sailed
    // through. Walk every env block in the file instead, which also covers steps nobody has
    // written yet, in the same spirit as the packaging guard above.
    const offenders: string[] = []
    const visit = (block: YamlBlock, where: string): void => {
      const env = block.blocks.get('env')
      if (
        env?.scalars.has('GITHUB_REF_NAME') === true ||
        env?.blocks.has('GITHUB_REF_NAME') === true
      ) {
        offenders.push(where)
      }
      for (const [key, child] of block.blocks) {
        if (key === 'env') continue
        visit(child, `${where}.${key}`)
      }
      for (const [index, item] of block.items.entries()) visit(item, `${where}[${index}]`)
    }
    visit(getWorkflow(), 'workflow')

    expect(
      offenders,
      'GITHUB_REF_NAME must come from the runner. An env override at workflow, job or step scope ' +
        'would pin the tag/version guard to a constant and neuter it silently.',
    ).toEqual([])
    expect(guardStep().scalars.get('run')).toContain('GITHUB_REF_NAME')
  })
})

describe('release workflow — the reader fails closed', () => {
  /**
   * Pins the fail-closed property of `parseBlock` itself (see its docblock for why it must hold):
   * unmodelled syntax has to become red, never invisible.
   */
  it('sees a double-quoted trigger key', () => {
    expect(keysOf(parseYaml('on:\n  "pull_request":\n  push:\n'))).toEqual(['on'])
    expect(
      keysOf(parseYaml('on:\n  "pull_request":\n  push:\n').blocks.get('on') ?? EMPTY_BLOCK),
    ).toEqual(['pull_request', 'push'])
  })

  it('sees a single-quoted trigger key', () => {
    expect(
      keysOf(parseYaml("on:\n  'workflow_dispatch':\n  push:\n").blocks.get('on') ?? EMPTY_BLOCK),
    ).toEqual(['push', 'workflow_dispatch'])
  })

  it('throws on YAML explicit-key syntax rather than ignoring it', () => {
    expect(() => parseYaml('on:\n  ? pull_request\n  :\n  push:\n')).toThrow(/unparsed YAML line/)
  })

  it('throws on any line it cannot model, rather than skipping it', () => {
    expect(() => parseYaml('on:\n  @not-yaml\n')).toThrow(/unparsed YAML line/)
  })

  it('treats a block scalar body as opaque text, not as structure', () => {
    // Without this, the shell script inside `run: |` would trip the throw above.
    const block = parseYaml('run: |\n  set -euo pipefail\n  echo hi\n')
    expect(block.scalars.get('run')).toBe('set -euo pipefail\necho hi')
  })

  it('preserves comments and interior blank lines inside a block scalar', () => {
    // The harness EXECUTES an extracted `run:` body, so "what we run" must be "what ships".
    // Assembling bodies from the comment-stripped line list is byte-faithful only for a step that
    // happens to contain neither comments nor blank lines, so they are read back from the raw
    // source instead and this pins it.
    const block = parseYaml('run: |\n  one\n  # a comment\n\n  two\n')
    expect(block.scalars.get('run')).toBe('one\n# a comment\n\ntwo')
  })
})
