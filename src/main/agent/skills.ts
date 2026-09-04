/**
 * Bundled agent skills (M2.4) — the three adversarially-validated slide skills that carry Sloodge's
 * craft knowledge, and the code that puts them where the SDK can find them.
 *
 * ## Why a filesystem copy at all
 *
 * Skills are **filesystem-only**: there is no programmatic registration API (50-agent-integration.md
 * §8). The SDK discovers them from a settings source, and Sloodge loads exactly one —
 * `settingSources: ['project']`, which reads `<cwd>/.claude/…`. So a skill exists for the agent iff
 * it is on disk under the app-owned workspace. `materializeSkills` is that copy: bundle →
 * `<cwd>/.claude/skills/<name>/SKILL.md`.
 *
 * ## Why this does not weaken the §5 isolation
 *
 * Bundling ours must not open the door to the user's ambient `~/.claude` skills. Two independent
 * levers keep it shut, and both are asserted in tests:
 *
 * 1. `settingSources: ['project']` (client.ts) never loads the `user` layer, so `~/.claude/skills`
 *    is not discovered in the first place. The cwd we point at is under `userData`, is not a git
 *    repo, and gets a Sloodge-written `.claude/settings.json` — so the project layer is fully known.
 * 2. `skills: [...BUNDLED_SKILL_NAMES]` is a **context filter**: even if a fourth skill somehow
 *    appeared in the workspace, it is not in the list and is not loaded. Belt and braces, in the same
 *    spirit as the SL-S01 linter plus the slide CSP.
 *
 * ## Dev vs packaged
 *
 * `resolveBundledSkillsDir` is the whole dev/packaged story and is pure, so it is unit-tested rather
 * than discovered at release time:
 *
 * - **dev** — `electron-vite` runs from the repo, so `app.getAppPath()` is the project root and the
 *   sources sit at `<root>/resources/skills`.
 * - **packaged** — electron-builder's `extraResources` (package.json `build.extraResources`) copies
 *   `resources/skills` to `<resourcesPath>/skills`, *outside* `app.asar`. Outside matters: the copy
 *   below reads them with plain `fs`, and while Electron's patched `fs` can read from inside an
 *   archive, keeping them out of it means no asar special-casing and a packaged app whose skills can
 *   be inspected (and hot-fixed) without repacking.
 *
 * Everything here takes its filesystem as a parameter, so the whole materialization runs in a unit
 * test against an in-memory fake with no `electron`, no temp dirs, and no real I/O.
 */

import nodeFs from 'node:fs/promises'
import path from 'node:path'

/**
 * The skills that ship with the app, in load order. This array is also the `skills` context filter
 * passed to the SDK (client.ts), so it is the single place that decides which skills exist for the
 * agent — adding a directory under `resources/skills` is not enough on its own.
 */
export const BUNDLED_SKILL_NAMES = ['slide-deck', 'svg-animation', 'interactive-graph'] as const

export type BundledSkillName = (typeof BUNDLED_SKILL_NAMES)[number]

/**
 * Every file each skill needs, relative to its own directory. Listed explicitly rather than globbed:
 * a directory walk in the packaged app would silently ship whatever happened to be next to the
 * skills, and the reference file (`icons.md`) is load-bearing — slide-deck's hard rule 3 tells the
 * model to `Read` it, so a copy that missed it would degrade output with no error anywhere.
 */
export const BUNDLED_SKILL_FILES: Readonly<Record<BundledSkillName, readonly string[]>> = {
  'slide-deck': ['SKILL.md', 'icons.md'],
  'svg-animation': ['SKILL.md'],
  'interactive-graph': ['SKILL.md'],
}

/**
 * The `.claude/settings.json` Sloodge writes into the workspace. `settingSources: ['project']` loads
 * this file, so leaving it absent would let the *directory* be a project layer we never authored.
 * Writing a known-empty permissions object makes the one settings layer the agent sees fully ours
 * (§5): no allow rules, no deny rules, nothing inherited.
 */
export const WORKSPACE_SETTINGS_JSON = `${JSON.stringify({ permissions: { allow: [], deny: [] } }, null, 2)}\n`

/** The minimal filesystem surface `materializeSkills` needs, so tests supply a fake. */
export type SkillFs = {
  readFile: (file: string) => Promise<string>
  writeFile: (file: string, data: string) => Promise<void>
  mkdir: (dir: string) => Promise<void>
}

/** The real filesystem, adapting `node:fs/promises` to the narrow `SkillFs` seam. */
export const nodeSkillFs: SkillFs = {
  readFile: (file) => nodeFs.readFile(file, 'utf8'),
  writeFile: (file, data) => nodeFs.writeFile(file, data, 'utf8'),
  mkdir: async (dir) => {
    await nodeFs.mkdir(dir, { recursive: true })
  },
}

export type ResolveSkillsDirEnv = {
  readonly isPackaged: boolean
  /** `app.getAppPath()` — the repo root in dev. */
  readonly appPath: string
  /** `process.resourcesPath` — the packaged `Resources` dir. */
  readonly resourcesPath: string
}

/**
 * Where the read-only skill sources live, in dev and in a packaged build. See the module docstring.
 *
 * The packaged branch is pinned to `package.json`'s `build` block, which M2.4 populated with only
 * what the agent needs — `extraResources` (this path) and `asarUnpack` for the Claude CLI binary,
 * which cannot execute from inside an archive. M5.2 owns the rest of that block (appId, productName,
 * per-platform targets, icons, signing/notarization, publish) and **must not drop these two keys**:
 * without `extraResources` a packaged app has no skills and this function resolves to a directory
 * that does not exist. `skills-contract.test.ts` asserts the two stay in agreement.
 */
export function resolveBundledSkillsDir(env: ResolveSkillsDirEnv): string {
  return env.isPackaged
    ? path.join(env.resourcesPath, 'skills')
    : path.join(env.appPath, 'resources', 'skills')
}

/** `<cwd>/.claude` — the one settings layer the agent loads (§5). */
export function workspaceClaudeDir(cwd: string): string {
  return path.join(cwd, '.claude')
}

/** `<cwd>/.claude/skills` — where the SDK discovers project skills. */
export function workspaceSkillsDir(cwd: string): string {
  return path.join(workspaceClaudeDir(cwd), 'skills')
}

export type MaterializeSkillsResult = {
  /** Skills whose every file copied successfully — these are the ones the agent can actually load. */
  readonly installed: readonly BundledSkillName[]
  /** Workspace-relative paths written, in copy order. Useful for logs and for asserting the set. */
  readonly files: readonly string[]
  /** `<name>/<file>: <reason>` for anything that failed to copy. Empty on a healthy install. */
  readonly failures: readonly string[]
}

/**
 * Copy the bundled skills into the deck workspace and write the workspace's own settings file.
 *
 * **Never throws.** It runs on the path to creating a session, and a missing or unreadable skill file
 * must degrade the agent (it runs without its craft knowledge, and says so — see `missingSkills`),
 * not prevent the user from chatting at all. Failures come back in `failures` for the caller to log; a skill missing any of its
 * files is left out of `installed` entirely rather than half-installed, because a `SKILL.md` whose
 * `icons.md` did not arrive tells the model to read a file that is not there.
 *
 * The copy is unconditional (last write wins) so an app update ships new skill text without a version
 * check — the files are a few KB and this happens once per session creation.
 */
export async function materializeSkills(params: {
  readonly sourceDir: string
  readonly cwd: string
  readonly fs: SkillFs
}): Promise<MaterializeSkillsResult> {
  const { sourceDir, cwd, fs } = params
  const installed: BundledSkillName[] = []
  const files: string[] = []
  const failures: string[] = []

  const skillsDir = workspaceSkillsDir(cwd)
  try {
    await fs.mkdir(skillsDir)
    await fs.writeFile(path.join(workspaceClaudeDir(cwd), 'settings.json'), WORKSPACE_SETTINGS_JSON)
  } catch (error) {
    // Without the skills dir nothing can be copied; report and let the session run skill-less.
    return { installed: [], files: [], failures: [`.claude: ${reason(error)}`] }
  }

  // Copied concurrently, but aggregated in `BUNDLED_SKILL_NAMES` order so `installed`/`files` are
  // deterministic regardless of how the filesystem interleaves.
  const copied = await Promise.all(
    BUNDLED_SKILL_NAMES.map(async (name) => {
      try {
        await fs.mkdir(path.join(skillsDir, name))
        const written = await Promise.all(
          BUNDLED_SKILL_FILES[name].map(async (file) => {
            const target = path.join(skillsDir, name, file)
            await fs.writeFile(target, await fs.readFile(path.join(sourceDir, name, file)))
            return target
          }),
        )
        return { name, written, error: null }
      } catch (error) {
        // Partial writes are possible here and deliberately not rolled back: `installed` is what the
        // agent is told about, and a skill absent from it is one the SDK's `skills` filter still
        // names — a stale half-copy on disk is inert, an unreported half-copy would not be.
        return { name, written: [], error: reason(error) }
      }
    }),
  )

  for (const entry of copied) {
    if (entry.error === null) {
      installed.push(entry.name)
      files.push(...entry.written)
    } else {
      failures.push(`${entry.name}: ${entry.error}`)
    }
  }

  return { installed, files, failures }
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/* -------------------------------------------------------------------------------------------- *
 * §8's fallback: the SKILL.md bodies as a system-prompt append
 *
 * When `system:init` reports that the filesystem skills did not load, `AgentSession` reopens the
 * query with `skills: []` and these bodies appended to `systemPrompt.append` (M2.5). §8 rejected
 * this shape as the *primary* design — ~3–4k tokens resident on every turn, including "make the
 * title bigger", where progressive disclosure would have loaded nothing — and kept it exactly here,
 * as the repair: "degraded on token cost, identical on output quality".
 * -------------------------------------------------------------------------------------------- */

/** One bundled skill's prose, with the YAML frontmatter already stripped. */
export type SkillBody = {
  readonly name: BundledSkillName
  readonly body: string
}

/**
 * Strip a SKILL.md's YAML frontmatter.
 *
 * The frontmatter is discovery metadata — `name` and the ~100-token `description` the runtime reads
 * at startup to decide whether to load the body. In fallback mode there is no discovery: the body is
 * already resident, so the frontmatter is not merely redundant, it is a block of YAML in the middle
 * of a system prompt describing a mechanism that is not in play. `name` survives as the section
 * heading `composeFallbackSystemPrompt` writes.
 *
 * A file with no frontmatter is returned unchanged rather than treated as an error: the delimiter is
 * a convention of the skill format, and losing the whole body over a missing `---` would turn a
 * cosmetic problem into a silent quality regression.
 */
export function stripFrontmatter(source: string): string {
  const normalized = source.replace(/^﻿/, '')
  if (!normalized.startsWith('---')) return normalized.trim()
  // The closing delimiter is a `---` on its own line; anything before the first newline is the
  // opening one. An unterminated block means the file is not really frontmatter-delimited.
  const end = normalized.indexOf('\n---', 3)
  if (end === -1) return normalized.trim()
  const afterDelimiter = normalized.indexOf('\n', end + 1)
  return afterDelimiter === -1 ? '' : normalized.slice(afterDelimiter + 1).trim()
}

/**
 * Build the `systemPrompt.append` addition for a fallback session.
 *
 * Each body gets a heading naming its skill, so the model can still tell the three apart and the
 * cross-references between them (slide-deck's hard rule 3 points at `icons.md`) still read as
 * instructions about a named thing. `icons.md` itself is deliberately *not* inlined: it stays on
 * disk in the workspace and `Read` is an allowed tool (client.ts), so the reference resolves the
 * same way it would with skills loaded — inlining it would add tokens to every turn to save one
 * tool call on the few turns that need icons.
 *
 * Returns `null` when no body could be read, so the caller can tell "repaired" from "still broken"
 * and keep the loud M2.4 notice for the second case rather than restarting into an identical
 * session.
 */
export function composeFallbackSystemPrompt(bodies: readonly SkillBody[]): string | null {
  const sections = bodies
    .filter((entry) => entry.body.trim().length > 0)
    .map((entry) => `## Skill: ${entry.name}\n\n${entry.body.trim()}`)
  if (sections.length === 0) return null
  return [
    'The following slide-craft instructions are always in effect. They are the same guidance the',
    'bundled Sloodge skills carry; they are inlined here because skill loading was unavailable for',
    'this session.',
    '',
    sections.join('\n\n'),
  ].join('\n')
}

/**
 * Read the three bundled `SKILL.md` bodies from the app bundle for the fallback prompt.
 *
 * **Never throws**, for the same reason `materializeSkills` does not: this runs on the path to
 * repairing an already-degraded session, and a read failure must leave the user with the loud
 * degradation notice, not a dead chat box. A skill whose file cannot be read is simply omitted; if
 * none can be read, `composeFallbackSystemPrompt` returns `null` and no restart happens.
 *
 * Read from `sourceDir` (the read-only bundle) rather than the materialized workspace copy on
 * purpose: if the workspace copy were readable and correct, the skills would very likely have
 * loaded. The bundle is the source the copy failed to reproduce.
 */
export async function readSkillBodies(params: {
  readonly sourceDir: string
  readonly fs: Pick<SkillFs, 'readFile'>
}): Promise<readonly SkillBody[]> {
  const { sourceDir, fs } = params
  const read = await Promise.all(
    BUNDLED_SKILL_NAMES.map(async (name) => {
      try {
        const raw = await fs.readFile(path.join(sourceDir, name, 'SKILL.md'))
        return { name, body: stripFrontmatter(raw) }
      } catch {
        return null
      }
    }),
  )
  return read.filter((entry): entry is SkillBody => entry !== null)
}

/**
 * Which of the bundled skills the running session did **not** load, given the `skills` array the SDK
 * reports on its `system:init` message (§8).
 *
 * A non-empty result drives three things (M2.5): the main-process log, `AgentSession`'s one-shot
 * restart into the system-prompt fallback above, and — if that restart is not possible — the
 * `skills-degraded` event the chat panel renders as a notice. Callers must interpret it in light of
 * the session's skill mode: a *fallback* session runs with `skills: []` on purpose, so "all three
 * missing" is the expected, healthy reading of its init and not a degradation to report again.
 */
export function missingSkills(loaded: readonly string[]): readonly BundledSkillName[] {
  const present = new Set(loaded.map(canonicalSkillName))
  return BUNDLED_SKILL_NAMES.filter((name) => !present.has(name))
}

/**
 * The SDK may report a skill plugin-qualified (`my-plugin:my-skill`); ours are unqualified, but
 * comparing the suffix keeps the check correct if a bundle ever ships as a plugin.
 */
function canonicalSkillName(name: string): string {
  const colon = name.lastIndexOf(':')
  return colon === -1 ? name : name.slice(colon + 1)
}
