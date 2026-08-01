import { describe, expect, it } from 'vitest'
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveBundledSkillsDir } from '../../../src/main/agent/skills'

/**
 * **Packaging contract (M5.2).** `package.json`'s `build` block is declarative config that nothing
 * in the app imports, so every other test in this suite passes just as happily when it is wrong. The
 * failure mode is specific and expensive: the app builds, installs, launches — and then a feature is
 * simply missing at runtime, on a user's machine, with no error anywhere in the build log. M2.4 said
 * exactly this when it added `extraResources`/`asarUnpack` and marked itself PARTIAL.
 *
 * So this file asserts the config against the code that *depends* on it, never against a second copy
 * of the same literal:
 *
 * - the skills path is derived from `resolveBundledSkillsDir`, the function main actually calls;
 * - the `asarUnpack` globs are matched against the platform packages really present in
 *   `node_modules`, not against a hardcoded name;
 * - the `files` assertions run the **effective** pattern list for each platform through a model of
 *   electron-builder's own matching, rather than pattern-spotting individual strings.
 *
 * A test that restated the config back to itself would be green for any config, including a broken
 * one. These red when the config and reality disagree, which is the only interesting case.
 */

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

/**
 * The `@anthropic-ai` scope directory that the SDK's own binary lookup searches.
 *
 * The SDK resolves its CLI with `require.resolve('@anthropic-ai/claude-agent-sdk-<os>-<cpu>/claude[.exe]')`
 * anchored at `import.meta.url` of its own `sdk.mjs` — which Node reports as the **realpath**. Under
 * pnpm that is the virtual store, where the platform packages sit as *siblings* of the SDK; the
 * hoisted `node_modules/@anthropic-ai/` contains only `claude-agent-sdk` and resolution from there
 * fails outright. So "is the CLI installed" has to be asked at the realpath, exactly where the SDK
 * asks it, or the test answers a different question than the runtime does.
 */
function sdkScopeDir(): string {
  return path.dirname(
    realpathSync(path.join(REPO_ROOT, 'node_modules', '@anthropic-ai', 'claude-agent-sdk')),
  )
}

type PlatformBlock = {
  readonly target?: readonly { readonly target?: string }[]
  readonly files?: readonly string[]
}

type BuildConfig = {
  readonly appId?: string
  readonly productName?: string
  readonly asar?: boolean
  readonly asarUnpack?: readonly string[]
  readonly extraResources?: readonly { readonly from?: string; readonly to?: string }[]
  readonly files?: readonly string[]
  readonly directories?: { readonly output?: string }
  readonly win?: PlatformBlock
  readonly mac?: PlatformBlock
  readonly linux?: PlatformBlock
}

const pkg = JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')) as {
  readonly main?: string
  readonly version?: string
  readonly build?: BuildConfig
  readonly devDependencies?: Record<string, string>
}

const build = pkg.build ?? {}

/** electron-builder's three platform config keys, and which CLI variant each one actually runs. */
const PLATFORM_KEYS = ['win', 'mac', 'linux'] as const
type PlatformKey = (typeof PLATFORM_KEYS)[number]
const NATIVE_CLI_OS: Record<PlatformKey, string> = { win: 'win32', mac: 'darwin', linux: 'linux' }
const CLI_OSES = ['win32', 'darwin', 'linux'] as const

/**
 * The `**`/`*` subset of glob syntax these patterns use, compiled to a RegExp. `**` crosses
 * separators, `*` does not — the distinction matters: `@anthropic-ai/*` would NOT match a nested
 * `node_modules` path, and a pattern that silently stopped matching is the bug being guarded against.
 *
 * A leading `**\/` compiles to `(?:.*\/)?` — **zero** or more segments, matching minimatch. Getting
 * that wrong is not academic: with `.*\/` (one or more) the patterns are tested against paths that
 * need a fake prefix, and `!resources/**` then swallows a `resources/app.asar/node_modules/...`
 * path that electron-builder never sees. `files` globs match paths relative to the app **source**
 * dir, so the paths asserted here are repo-relative too.
 */
function globToRegExp(pattern: string): RegExp {
  let out = '^'
  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i]
    if (char === '*' && pattern[i + 1] === '*') {
      if (pattern[i + 2] === '/') {
        out += '(?:.*/)?'
        i += 2
      } else {
        out += '.*'
        i += 1
      }
    } else if (char === '*') {
      out += '[^/]*'
    } else if ('\\^$.|?+()[]{}'.includes(char ?? '')) {
      out += `\\${char}`
    } else {
      out += char
    }
  }
  return new RegExp(`${out}$`)
}

/** `a-{x,y}-b` → `['a-x-b', 'a-y-b']`. One alternation group is all these patterns use. */
function expandBraces(pattern: string): string[] {
  const brace = /\{([^}]+)\}/.exec(pattern)
  if (brace === null) return [pattern]
  return (brace[1] ?? '').split(',').map((alt) => pattern.replace(/\{[^}]+\}/, alt))
}

/**
 * The pattern list that actually filters **app source** for a platform.
 *
 * This is the platform's own `files` and nothing else, which is not what the source reads like:
 * `fileMatcher.js:250-253` adds `config.files` and then `customBuildOptions.files` to the same
 * `FileMatcher`, so they look like they merge. They do merge for the *node_modules* matcher
 * (`getNodeModuleFileMatcher`, :209-210) — but the app-source matcher observably ends up with only
 * the platform list whenever a platform block is present. `release/builder-debug.yml` shows it
 * directly: with both set, `firstOrDefaultFilePatterns` carries the platform entries and none of the
 * top-level ones, while `nodeModuleFilePatterns` carries both.
 *
 * Measured on real `electron-builder --win --dir` runs, counting entries in the produced asar:
 *
 * | shape                          | asar     | src | tests | docs | foreign CLI |
 * | ------------------------------ | -------- | --- | ----- | ---- | ----------- |
 * | top-level only                 | 37.7 MB  |   0 |     0 |    0 |           3 |
 * | top-level + platform           | 427.9 MB | 151 |   131 |   34 |           0 |
 * | platform only, full list       | 37.7 MB  |   0 |     0 |    0 |           0 |
 * | both carrying the full list    | 401.9 MB |   0 |     0 |    0 |           0 |
 *
 * So the only shape that is both source-clean and CLI-correct is "every platform carries the full
 * list, and there is no top-level `files`". That is why the exclusions are duplicated three times
 * rather than hoisted — the hoisted shape was tried and measured, and it ships the source tree.
 */
function effectiveFiles(platform: PlatformKey): readonly string[] {
  return build[platform]?.files ?? []
}

/**
 * Would `file` end up inside the package under `patterns`?
 *
 * Models electron-builder's ordering: later patterns win, and a list containing only negations gets
 * an implicit `**\/*` prepended (`fileMatcher.js:285-287`, `containsOnlyIgnore`). Modelling the order
 * rather than just "is it mentioned" is what lets this catch a platform block that *re-includes*
 * `src/**` after the top-level list excluded it.
 */
function isPackagedFile(file: string, patterns: readonly string[]): boolean {
  let included = patterns.every((pattern) => pattern.startsWith('!'))
  for (const pattern of patterns) {
    const negated = pattern.startsWith('!')
    const body = negated ? pattern.slice(1) : pattern
    if (expandBraces(body).some((glob) => globToRegExp(glob).test(file))) included = !negated
  }
  return included
}

/**
 * Every platform whose file set must hold up — all three, not just the two we ship artifacts for.
 * A platform with no `files` block of its own falls through to electron-builder's default `**\/*`
 * and packages the entire repo; `linux` was exactly that, and `pnpm pack:dir` on the Linux dev box
 * produced a 63.7 MB asar carrying 184 `src/`, 145 `tests/` and 36 `docs/` entries plus a foreign
 * 254 MB `claude.exe`. Iterating the full set here (rather than the two named by hand, as an
 * earlier revision did) is what makes a missing block fail instead of going unchecked.
 */
function platformsUnderTest(): readonly PlatformKey[] {
  return PLATFORM_KEYS
}

/** Where one platform's CLI sits relative to the app source dir, which is what `files` matches. */
function cliPath(variant: string): string {
  return `node_modules/@anthropic-ai/claude-agent-sdk-${variant}/claude`
}

describe('electron-builder identity and targets', () => {
  it('declares the app identity a Windows installer and a macOS bundle both need', () => {
    expect(build.appId).toBe('dev.sloodge.app')
    expect(build.productName).toBe('Sloodge')
  })

  it('builds the M9.1 target matrix: NSIS + zip on Windows, dmg + zip on macOS', () => {
    expect((build.win?.target ?? []).map((t) => t.target).toSorted()).toEqual(['nsis', 'zip'])
    expect((build.mac?.target ?? []).map((t) => t.target).toSorted()).toEqual(['dmg', 'zip'])
  })

  it('writes artifacts to the gitignored release/ dir', () => {
    expect(build.directories?.output).toBe('release')
    expect(readFileSync(path.join(REPO_ROOT, '.gitignore'), 'utf8')).toMatch(/^release\/$/m)
  })

  it('pins electron-builder exactly, like the rest of the build spine', () => {
    // Caret here would let a minor bump silently change installer layout between two builds of the
    // same commit (11-tech-stack.md §2.2 pin policy).
    expect(pkg.devDependencies?.['electron-builder']).toMatch(/^\d+\.\d+\.\d+$/)
  })
})

describe('what must survive into the packaged app', () => {
  it('ships resources/skills to exactly where resolveBundledSkillsDir looks in a packaged build', () => {
    // Derived from the resolver, not restated: rename `to` and this reds, which is M2.4's warning
    // ("without extraResources a packaged app has no skills") turned into a failing test.
    const skills = (build.extraResources ?? []).find((r) => r.from === 'resources/skills')
    expect(skills, 'build.extraResources must copy resources/skills').toBeDefined()

    const resourcesPath = path.join(path.sep, 'app', 'Resources')
    expect(resolveBundledSkillsDir({ isPackaged: true, appPath: '/unused', resourcesPath })).toBe(
      path.join(resourcesPath, skills?.to ?? ''),
    )
  })

  it('ships every file the bundled skills actually reference', () => {
    // extraResources copies a directory wholesale, so the guard that matters is that the sources are
    // present in the repo under the `from` path — a skill file deleted upstream would otherwise only
    // surface as a degraded agent at runtime.
    for (const file of [
      'slide-deck/SKILL.md',
      'slide-deck/icons.md',
      'svg-animation/SKILL.md',
      'interactive-graph/SKILL.md',
    ]) {
      expect(existsSync(path.join(REPO_ROOT, 'resources', 'skills', file)), file).toBe(true)
    }
  })

  it('keeps the SDK and its CLI on the SAME side of the asar boundary, as siblings', () => {
    // The load-bearing, silent-failure invariant. The SDK spawns its CLI via
    // `require.resolve('@anthropic-ai/claude-agent-sdk-<os>-<cpu>/claude[.exe]')` anchored at
    // sdk.mjs's own realpath, with no PATH fallback — so the variant package must resolve as a
    // *sibling directory* of `claude-agent-sdk`. `asarUnpack` is what decides that: an unpacked
    // package lands under `app.asar.unpacked/`, a packed one stays inside `app.asar`. Unpack the
    // CLI but not the SDK (or vice versa) and they end up in different trees — the app still
    // launches, every other test still passes, and the agent can simply never start.
    expect(build.asar).toBe(true)
    const patterns = (build.asarUnpack ?? []).map(globToRegExp)

    // Read the real installed set from pnpm's store layout rather than a hardcoded list, so a
    // variant that appears (or is renamed upstream) is covered automatically.
    const sdkPackages = readdirSync(sdkScopeDir()).filter((dir) =>
      dir.startsWith('claude-agent-sdk'),
    )
    expect(sdkPackages, 'expected the Agent SDK to be installed').toContain('claude-agent-sdk')
    expect(
      sdkPackages.some((dir) => dir !== 'claude-agent-sdk'),
      'expected at least one platform CLI variant beside the SDK',
    ).toBe(true)

    const unpacked = (dir: string): boolean =>
      patterns.some((re) => re.test(`node_modules/@anthropic-ai/${dir}/claude`))

    // Every one of them, base package and variants alike, must land on the same side.
    for (const dir of sdkPackages) {
      expect(unpacked(dir), `${dir} would be trapped inside app.asar, away from its siblings`).toBe(
        true,
      )
    }
  })

  it('installs the win32 Claude CLI even off a Windows host, so --win is not silently CLI-less', () => {
    // pnpm installs only the host's variant of an `os`-guarded optionalDependency unless
    // `supportedArchitectures` names the others. Without it, `electron-builder --win` on this
    // Linux dev box produces an installer with no claude.exe and a dead chat panel, and NOTHING
    // in the build fails. `current` covers whichever host runs this, so the assertion holds on
    // Linux, Windows and macOS alike.
    const cli = path.join(sdkScopeDir(), 'claude-agent-sdk-win32-x64', 'claude.exe')
    expect(
      existsSync(cli),
      `${cli} missing — check supportedArchitectures in pnpm-workspace.yaml`,
    ).toBe(true)
  })

  it('gives every platform exactly its own Claude CLI and none of the foreign ones', () => {
    // `supportedArchitectures` deliberately installs the win32 CLI on a Linux box so `--win` can
    // pack it. The cost is that several variants sit in node_modules at once, and electron-builder
    // does NOT filter them by their own `os`/`cpu` fields — a measured 275MB of Linux binary rode
    // along inside the Windows app until these per-platform exclusions were added.
    for (const platform of PLATFORM_KEYS) {
      expect(
        build[platform]?.files,
        `build.${platform} must carry a files list dropping the foreign CLI variants`,
      ).toBeDefined()

      for (const os of CLI_OSES) {
        const native = os === NATIVE_CLI_OS[platform]
        expect(
          isPackagedFile(cliPath(`${os}-x64`), effectiveFiles(platform)),
          native
            ? `${platform} would drop its OWN ${os} CLI — the agent could never start`
            : `${platform} would ship the foreign ${os} CLI — hundreds of MB of dead weight`,
        ).toBe(native)
      }
    }
  })

  it('keeps the built main/renderer/preload output for every platform', () => {
    // An over-eager exclusion, or a `main` pointing outside `out/`, would ship an app with no code.
    expect(pkg.main).toMatch(/^\.\/out\//)
    for (const platform of platformsUnderTest()) {
      for (const kept of [
        'out/main/index.js',
        'out/renderer/index.html',
        'out/preload/index.cjs',
      ]) {
        expect(isPackagedFile(kept, effectiveFiles(platform)), `${platform} drops ${kept}`).toBe(
          true,
        )
      }
    }
  })

  it('excludes the source tree from EVERY platform, not just the ones we ship', () => {
    for (const platform of platformsUnderTest()) {
      expect(
        build[platform]?.files,
        `build.${platform} has no files list — it falls through to electron-builder's default ` +
          `**/* and packages the whole repo, which is exactly what "pnpm pack:dir" used to do`,
      ).toBeDefined()

      for (const dropped of [
        'src/main/index.ts',
        'tests/unit/packaging/build-config.test.ts',
        'docs/media/m41-present.gif',
        '.claude/plans/init/80-roadmap.md',
        'tsconfig.json',
        'pnpm-workspace.yaml',
      ]) {
        expect(
          isPackagedFile(dropped, effectiveFiles(platform)),
          `${dropped} would be shipped to users on ${platform}`,
        ).toBe(false)
      }
    }
  })

  it('keeps the exclusions on the platform blocks, where they measurably work', () => {
    // Not a style preference. Hoisting the shared list to a top-level `files` is the obvious
    // refactor — it was built and measured, and it does NOT filter app source once platform blocks
    // exist: 427.9MB with 151 `src/`, 131 `tests/` and 34 `docs/` entries, because the app-source
    // matcher takes the platform list while the top-level list is routed to the node_modules
    // matcher (`release/builder-debug.yml` shows both lists side by side). See `effectiveFiles`.
    expect(
      build.files,
      'a top-level files does NOT filter app source once platform blocks exist — measured at ' +
        '427.9MB with 151 src entries. Keep the full list on each platform instead.',
    ).toBeUndefined()
  })

  it('has no platform block this suite does not know to check', () => {
    // `platformsUnderTest` is only as good as `PLATFORM_KEYS`. If electron-builder ever grows a
    // fourth platform and someone adds a `files` list under it, this fails loudly rather than
    // letting the new block go unchecked — the exact blindness the previous revision shipped with.
    const known = new Set<string>(PLATFORM_KEYS)
    const unchecked = Object.entries(build)
      .filter(
        ([key, value]) =>
          !known.has(key) &&
          typeof value === 'object' &&
          value !== null &&
          Array.isArray((value as { files?: unknown }).files),
      )
      .map(([key]) => key)
    expect(unchecked, 'add these to PLATFORM_KEYS so their file sets are checked').toEqual([])
  })
})
