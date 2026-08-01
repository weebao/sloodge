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
 *   `node_modules`, not against a hardcoded name.
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

type BuildConfig = {
  readonly appId?: string
  readonly productName?: string
  readonly asar?: boolean
  readonly asarUnpack?: readonly string[]
  readonly extraResources?: readonly { readonly from?: string; readonly to?: string }[]
  readonly files?: readonly string[]
  readonly directories?: { readonly output?: string }
  readonly win?: {
    readonly target?: readonly { readonly target?: string }[]
    readonly files?: readonly string[]
  }
  readonly mac?: {
    readonly target?: readonly { readonly target?: string }[]
    readonly files?: readonly string[]
  }
}

const pkg = JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')) as {
  readonly main?: string
  readonly version?: string
  readonly build?: BuildConfig
  readonly devDependencies?: Record<string, string>
}

const build = pkg.build ?? {}

/**
 * The `**`/`*` subset of glob syntax that `asarUnpack` patterns use here, compiled to a RegExp so a
 * pattern can be tested against a real path. `**` crosses separators, `*` does not — the distinction
 * matters: `@anthropic-ai/*` would NOT match a nested `node_modules` path, and a pattern that
 * silently stopped matching is precisely the bug being guarded against.
 */
function globToRegExp(pattern: string): RegExp {
  let out = '^'
  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i]
    if (char === '*') {
      if (pattern[i + 1] === '*') {
        out += '.*'
        i += 1
      } else {
        out += '[^/]*'
      }
    } else if ('\\^$.|?+()[]{}'.includes(char ?? '')) {
      out += `\\${char}`
    } else {
      out += char
    }
  }
  return new RegExp(`${out}$`)
}

/**
 * Every platform's `files` list. There is deliberately **no** top-level `files`: electron-builder
 * treats a platform-specific `files` as an override of the parent array, not a merge, so a shared
 * base list plus a per-platform addition silently loses the base. Each platform therefore carries
 * the complete list, and `they stay in sync` below guards the duplication.
 */
function platformFiles(): readonly (readonly string[])[] {
  return [build.win?.files ?? [], build.mac?.files ?? []]
}

/**
 * A realistic packaged path for one platform's CLI. `globToRegExp` renders a leading `**\/` as
 * `.*\/`, which needs a real preceding segment (minimatch would also match zero segments; the toy
 * matcher does not), so the `resources/app.asar` prefix is load-bearing for the assertions.
 */
function cliPath(variant: string): string {
  return `resources/app.asar/node_modules/@anthropic-ai/claude-agent-sdk-${variant}/claude`
}

/** `a-{x,y}-b` → `['a-x-b', 'a-y-b']`. One alternation group is all these patterns use. */
function expandBraces(pattern: string): string[] {
  const brace = /\{([^}]+)\}/.exec(pattern)
  if (brace === null) return [pattern]
  return (brace[1] ?? '').split(',').map((alt) => pattern.replace(/\{[^}]+\}/, alt))
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

  it('keeps asar on — but unpacks every Agent SDK package present, not just a named one', () => {
    expect(build.asar).toBe(true)
    const patterns = (build.asarUnpack ?? []).map(globToRegExp)

    // The real installed set, including the per-platform binary packages — read from pnpm's store
    // layout rather than a hardcoded list, so a variant that appears (or is renamed upstream) is
    // covered automatically. `claude.exe` cannot be executed from inside an archive, so each of
    // these must match a pattern.
    const sdkPackages = readdirSync(sdkScopeDir())
      .filter((dir) => dir.startsWith('claude-agent-sdk'))
      .map((dir) => `@anthropic-ai/${dir}`)

    expect(sdkPackages.length, 'expected the Agent SDK to be installed').toBeGreaterThan(0)
    for (const name of new Set(sdkPackages)) {
      const packagedPath = `resources/app.asar/node_modules/${name}/anything`
      expect(
        patterns.some((re) => re.test(packagedPath)),
        `no asarUnpack pattern matches ${name} — it would be trapped inside app.asar`,
      ).toBe(true)
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

  it('ships only the target platform’s Claude CLI, not every variant in node_modules', () => {
    // `supportedArchitectures` deliberately installs the win32 CLI on a Linux box so `--win` can
    // pack it. The cost of that is that BOTH variants are then sitting in node_modules, and
    // electron-builder does NOT filter them by their `os`/`cpu` fields — a measured 275MB of Linux
    // binary rode along inside the Windows app until these per-platform exclusions were added.
    // Each variant is a real download a user pays for, so the guard is worth its keep.
    for (const [platform, patterns, drops, keeps] of [
      ['win', build.win?.files, ['darwin-arm64', 'linux-x64'], 'win32-x64'],
      ['mac', build.mac?.files, ['linux-x64', 'win32-x64'], 'darwin-arm64'],
    ] as const) {
      const pattern = (patterns ?? []).find((p) => p.includes('claude-agent-sdk-'))
      expect(pattern, `${platform}.files must drop the foreign CLI variants`).toBeDefined()
      expect(pattern?.startsWith('!'), 'must be an exclusion').toBe(true)

      const matchers = expandBraces((pattern ?? '').slice(1)).map(globToRegExp)
      for (const variant of drops) {
        expect(
          matchers.some((re) => re.test(cliPath(variant))),
          `${platform} build would ship the ${variant} CLI — hundreds of MB of dead weight`,
        ).toBe(true)
      }
      // …and must never swallow the one that platform actually executes.
      expect(
        matchers.some((re) => re.test(cliPath(keeps))),
        `${platform} build would drop its OWN CLI (${keeps}) — chat would be dead`,
      ).toBe(false)
    }
  })

  it('keeps win.files and mac.files in sync apart from their CLI-variant line', () => {
    // The duplication is forced by electron-builder's override semantics (see `platformFiles`);
    // this is what stops the two copies drifting once someone edits only one of them.
    const [win, mac] = platformFiles().map((patterns) =>
      patterns.filter((p) => !p.includes('claude-agent-sdk-')),
    )
    expect(win).toEqual(mac)
    expect(win?.length ?? 0).toBeGreaterThan(5)
    expect(
      build.files,
      'a top-level files would be silently overridden — keep it absent',
    ).toBeUndefined()
  })

  it('keeps the built main/renderer/preload output in every platform’s package', () => {
    // `files` is an exclusion list layered over the default `**/*`; an over-eager `!out` or a
    // `main` pointing outside it would ship an app with no code.
    expect(pkg.main).toMatch(/^\.\/out\//)
    for (const patterns of platformFiles()) {
      for (const pattern of patterns) {
        expect(pattern.startsWith('!'), `files entry ${pattern} must be an exclusion`).toBe(true)
        for (const kept of [
          'out/main/index.js',
          'out/renderer/index.html',
          'out/preload/index.cjs',
        ])
          for (const matcher of expandBraces(pattern.slice(1)).map(globToRegExp))
            expect(matcher.test(kept), `${pattern} would drop ${kept}`).toBe(false)
      }
    }
  })

  it('excludes the sources and test corpus that have no business in an installer', () => {
    // Regression: these exclusions once lived in a top-level `files`, and adding a per-platform
    // `win.files` silently REPLACED it rather than merging — electron-builder's platform config
    // overrides the parent array. The whole `src/`, `tests/` and `docs/media` tree (24MB of GIFs)
    // went back into app.asar with nothing failing. Asserting per platform is what catches that.
    for (const patterns of platformFiles()) {
      const excluded = patterns.flatMap((p) => expandBraces(p.slice(1))).map(globToRegExp)
      for (const dropped of [
        'src/main/index.ts',
        'tests/unit/packaging/build-config.test.ts',
        'docs/media/m41-present.gif',
        'tsconfig.json',
      ]) {
        expect(
          excluded.some((re) => re.test(dropped)),
          `${dropped} would be shipped to users`,
        ).toBe(true)
      }
    }
  })
})
