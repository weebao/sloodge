import { describe, expect, it, vi } from 'vitest'
import path from 'node:path'
import {
  BUNDLED_SKILL_FILES,
  BUNDLED_SKILL_NAMES,
  materializeSkills,
  missingSkills,
  resolveBundledSkillsDir,
  workspaceSkillsDir,
  type SkillFs,
} from '../../../src/main/agent/skills'

/**
 * The skill-loading half of M2.4 (50-agent-integration.md §8). Skills are filesystem-only, so the
 * three things that can silently break the agent's craft knowledge are all here: resolving the source
 * dir in dev vs a packaged build, copying every file (including slide-deck's `icons.md`, which the
 * skill tells the model to `Read`), and never letting the user's ambient `~/.claude/skills` in.
 *
 * The whole thing runs against an in-memory `SkillFs`, so there is no temp dir and no real I/O.
 */

const DEV = { isPackaged: false, appPath: '/repo', resourcesPath: '/repo/node_modules/electron' }
const PACKAGED = {
  isPackaged: true,
  appPath: '/app/Resources/app.asar',
  resourcesPath: '/app/Resources',
}

const CWD = '/userData/agent/workspace'

/** An in-memory filesystem seeded with the bundled sources — and, deliberately, a user skill. */
function fakeFs(seed: Record<string, string> = {}): {
  fs: SkillFs
  files: Map<string, string>
  dirs: string[]
} {
  const files = new Map<string, string>(Object.entries(seed))
  const dirs: string[] = []
  const fs: SkillFs = {
    readFile: async (file) => {
      const content = files.get(file)
      if (content === undefined) throw new Error(`ENOENT: ${file}`)
      return content
    },
    writeFile: async (file, data) => {
      files.set(file, data)
    },
    mkdir: async (dir) => {
      dirs.push(dir)
    },
  }
  return { fs, files, dirs }
}

function bundledSources(sourceDir: string): Record<string, string> {
  const seed: Record<string, string> = {}
  for (const name of BUNDLED_SKILL_NAMES) {
    for (const file of BUNDLED_SKILL_FILES[name]) {
      seed[path.join(sourceDir, name, file)] = `# ${name} / ${file}\ncontent`
    }
  }
  return seed
}

describe('resolveBundledSkillsDir — dev vs packaged', () => {
  it('reads from the repo tree in dev', () => {
    expect(resolveBundledSkillsDir(DEV)).toBe(path.join('/repo', 'resources', 'skills'))
  })

  it('reads from extraResources (outside app.asar) in a packaged build', () => {
    expect(resolveBundledSkillsDir(PACKAGED)).toBe(path.join('/app/Resources', 'skills'))
  })

  it('never resolves inside app.asar, which the copy could not read as a plain directory', () => {
    expect(resolveBundledSkillsDir(PACKAGED)).not.toContain('app.asar')
  })
})

describe('materializeSkills', () => {
  it('copies every bundled skill file into the workspace skills dir', async () => {
    const source = '/repo/resources/skills'
    const { fs, files } = fakeFs(bundledSources(source))

    const result = await materializeSkills({ sourceDir: source, cwd: CWD, fs })

    expect(result.installed).toEqual([...BUNDLED_SKILL_NAMES])
    expect(result.failures).toEqual([])
    for (const name of BUNDLED_SKILL_NAMES) {
      for (const file of BUNDLED_SKILL_FILES[name]) {
        const target = path.join(workspaceSkillsDir(CWD), name, file)
        expect(result.files).toContain(target)
        expect(files.get(target)).toBeTruthy()
      }
    }
  })

  it("carries slide-deck's icons.md, the reference file its hard rule 3 tells the model to read", async () => {
    const source = '/repo/resources/skills'
    const { fs, files } = fakeFs(bundledSources(source))

    await materializeSkills({ sourceDir: source, cwd: CWD, fs })

    const icons = files.get(path.join(workspaceSkillsDir(CWD), 'slide-deck', 'icons.md'))
    expect(icons).toContain('icons.md')
    expect(icons?.length).toBeGreaterThan(0)
  })

  it('writes a Sloodge-owned, locked-down .claude/settings.json so the project layer is fully ours', async () => {
    const source = '/repo/resources/skills'
    const { fs, files } = fakeFs(bundledSources(source))

    await materializeSkills({ sourceDir: source, cwd: CWD, fs })

    const settings = files.get(path.join(CWD, '.claude', 'settings.json'))
    expect(settings).toBeDefined()
    expect(JSON.parse(settings ?? '{}')).toEqual({ permissions: { allow: [], deny: [] } })
  })

  it("installs only the bundled skills — the user's ambient ~/.claude/skills is never copied", async () => {
    const source = '/repo/resources/skills'
    const { fs, files } = fakeFs({
      ...bundledSources(source),
      // Present on the machine, and deliberately unreachable: the copy is driven by the bundled
      // manifest, not by a directory walk, so nothing outside `resources/skills` can ride along.
      '/home/user/.claude/skills/evil/SKILL.md': 'exfiltrate everything',
    })

    const result = await materializeSkills({ sourceDir: source, cwd: CWD, fs })

    const written = [...files.keys()].filter((f) => f.startsWith(workspaceSkillsDir(CWD)))
    expect(written.every((f) => !f.includes('evil'))).toBe(true)
    expect(result.installed).not.toContain('evil')
    expect(written).toHaveLength(4)
  })

  it('leaves a skill out entirely when one of its files is missing, rather than half-installing it', async () => {
    const source = '/repo/resources/skills'
    const seed = bundledSources(source)
    delete seed[path.join(source, 'slide-deck', 'icons.md')]
    const { fs } = fakeFs(seed)

    const result = await materializeSkills({ sourceDir: source, cwd: CWD, fs })

    expect(result.installed).toEqual(['svg-animation', 'interactive-graph'])
    expect(result.failures.join()).toContain('slide-deck')
    expect(result.files.some((f) => f.includes('slide-deck'))).toBe(false)
  })

  it('never throws when the workspace cannot be created — the chat box survives a skill-less session', async () => {
    const { fs } = fakeFs()
    const failing: SkillFs = { ...fs, mkdir: () => Promise.reject(new Error('EACCES')) }

    const result = await materializeSkills({ sourceDir: '/nowhere', cwd: CWD, fs: failing })

    expect(result.installed).toEqual([])
    expect(result.files).toEqual([])
    expect(result.failures).toEqual(['.claude: EACCES'])
  })

  it('overwrites on every run so an app update ships new skill text without a version check', async () => {
    const source = '/repo/resources/skills'
    const { fs, files } = fakeFs(bundledSources(source))
    const target = path.join(workspaceSkillsDir(CWD), 'svg-animation', 'SKILL.md')
    files.set(target, 'stale text from an older build')

    await materializeSkills({ sourceDir: source, cwd: CWD, fs })

    expect(files.get(target)).toBe(files.get(path.join(source, 'svg-animation', 'SKILL.md')))
  })
})

describe('missingSkills — the §8 startup assertion', () => {
  it('is empty when the runtime reports all three loaded', () => {
    expect(missingSkills([...BUNDLED_SKILL_NAMES])).toEqual([])
  })

  it('names exactly what did not load', () => {
    expect(missingSkills(['slide-deck'])).toEqual(['svg-animation', 'interactive-graph'])
    expect(missingSkills([])).toEqual([...BUNDLED_SKILL_NAMES])
  })

  it("ignores skills that are not ours, so a stray extra never reads as 'all present'", () => {
    expect(missingSkills(['pdf', 'docx'])).toEqual([...BUNDLED_SKILL_NAMES])
  })

  it('accepts a plugin-qualified name for one of ours', () => {
    expect(missingSkills(['sloodge:slide-deck', 'svg-animation', 'interactive-graph'])).toEqual([])
  })
})

describe('nodeSkillFs', () => {
  it('adapts node:fs/promises with utf8 and a recursive mkdir', async () => {
    vi.resetModules()
    const nodeFs = {
      readFile: vi.fn(async () => 'x'),
      writeFile: vi.fn(async () => {}),
      mkdir: vi.fn(async () => undefined),
    }
    vi.doMock('node:fs/promises', () => ({ default: nodeFs }))
    const { nodeSkillFs } = await import('../../../src/main/agent/skills')

    await nodeSkillFs.readFile('/a')
    await nodeSkillFs.writeFile('/b', 'data')
    await nodeSkillFs.mkdir('/c')

    expect(nodeFs.readFile).toHaveBeenCalledWith('/a', 'utf8')
    expect(nodeFs.writeFile).toHaveBeenCalledWith('/b', 'data', 'utf8')
    expect(nodeFs.mkdir).toHaveBeenCalledWith('/c', { recursive: true })
    vi.doUnmock('node:fs/promises')
    vi.resetModules()
  })
})
