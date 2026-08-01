import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  BUNDLED_SKILL_FILES,
  BUNDLED_SKILL_NAMES,
  type BundledSkillName,
} from '../../../src/main/agent/skills'
import { validateSlideContract } from '../../../src/shared/document/slide-contract'
import type { SlideCapability } from '../../../src/shared/document/types'

/**
 * **Drift guard.** The bundled skills tell the model how to write a slide; `slide-contract.ts` is
 * what rejects the slide it writes. Those two are separate artifacts that can silently disagree — the
 * skills were authored against an offline harness (`node render.mjs`, write a file, run a browser),
 * while the shipped agent has no `Bash`, no `Write`, and a Tier-1 linter the harness never had. Every
 * disagreement costs the user a rejected slide and the agent a wasted turn, with nothing in the build
 * to notice. This file is that noticing.
 *
 * Two directions are checked:
 *
 * 1. **Environment drift** — a skill must not instruct anything the agent's tool surface can't do
 *    (§7 denies Bash/Write/Edit/WebFetch/WebSearch), and must not reference the experiment harness
 *    or a developer's absolute paths, which do not exist on a user's machine.
 * 2. **Contract drift** — every full-document HTML example inside a SKILL.md is run through the real
 *    validator with the capabilities it declares. An example that fails is an example the model will
 *    copy into a slide that gets rejected.
 */

const SKILLS_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'resources',
  'skills',
)

function read(name: BundledSkillName, file: string): string {
  return readFileSync(path.join(SKILLS_DIR, name, file), 'utf8')
}

/**
 * Full-document HTML examples in a SKILL.md, paired with the `capabilities` the skill **instructs
 * the model to pass to `create_slide`** — read out of the prose immediately before the fence, which
 * is the same sentence the model reads.
 *
 * Reading the instruction rather than a marker inside the HTML is the whole point. Capabilities
 * reach the validator only as the `create_slide` tool argument (`slide-tools.ts`: `args.capabilities
 * ?? ['static']`); nothing parses the HTML for them. An earlier version of this guard took them from
 * an `<!-- capabilities: … -->` comment in the example, which made the test pass while the skill
 * taught a mechanism production ignores — the animated and interactive skeletons would have been
 * created as `['static']` and rejected by SL-H01 on every attempt. So the capabilities used here must
 * come from the instruction, or the test proves nothing about what the model will actually send.
 *
 * Fragments — the icon `<svg>` wrapper, a one-line snippet — are skipped: the validator judges whole
 * documents, and a fragment would fail for reasons that say nothing about drift.
 */
function slideExamples(markdown: string): { capabilities: SlideCapability[]; html: string }[] {
  const out: { capabilities: SlideCapability[]; html: string }[] = []
  const fence = /```html\n([\s\S]*?)```/g
  let match: RegExpExecArray | null
  while ((match = fence.exec(markdown)) !== null) {
    const html = match[1] ?? ''
    if (!html.includes('class="slide"')) continue
    // The nearest `create_slide` … `capabilities: [...]` instruction preceding this example.
    const before = markdown.slice(0, match.index)
    const instructions = [
      ...before.matchAll(/mcp__slides__create_slide[^\n]*?`capabilities: (\[[^\]]*\])`/g),
    ]
    const declared = instructions.at(-1)?.[1]
    expect(
      declared,
      'a full-slide example must be introduced by a create_slide call naming its capabilities',
    ).toBeDefined()
    out.push({ capabilities: JSON.parse(declared ?? '[]') as SlideCapability[], html })
  }
  return out
}

describe.each(BUNDLED_SKILL_NAMES)('bundled skill: %s', (name) => {
  const skill = read(name, 'SKILL.md')

  it('is present, non-empty, and declares the frontmatter the SDK indexes', () => {
    expect(skill.length).toBeGreaterThan(500)
    expect(skill.startsWith('---\n')).toBe(true)
    expect(skill).toContain(`name: ${name}`)
    expect(/\ndescription: \S/.test(skill)).toBe(true)
  })

  it('ships every file it references', () => {
    for (const file of BUNDLED_SKILL_FILES[name]) {
      expect(read(name, file).length).toBeGreaterThan(0)
    }
  })

  it('instructs only tools the agent actually has (§7 denies Bash/Write/Edit/web tools)', () => {
    // The same seven names client.ts denies — not a sample. A skill that reintroduced "use Write to
    // save the slide" (drift class #2) has to red this.
    for (const denied of ['Bash', 'Write', 'Edit', 'WebSearch', 'WebFetch', 'Agent', 'Task']) {
      expect(skill).not.toContain(denied)
    }
    // The validated originals told the model to shell out to the eval harness; the shipped agent
    // cannot, and would loop failing. Persisting and screenshotting go through the slide tools.
    expect(skill).not.toContain('render.mjs')
    expect(skill).not.toContain('export PATH')
    expect(skill).not.toContain('/home/')
    expect(skill).not.toContain('experiments/')
    expect(skill).toContain('mcp__slides__update_slide')
    expect(skill).toContain('mcp__slides__screenshot_slide')
  })

  it('teaches capabilities as the create_slide ARGUMENT, the only thing production reads', () => {
    expect(skill).toContain('argument to `mcp__slides__create_slide`')
    expect(skill).toContain('not** part of the HTML')
    // The inert-comment convention this replaced: a marker in the HTML that nothing parses.
    expect(skill).not.toContain('<!-- capabilities')
  })

  it('warns that capabilities cannot be changed after creation, with a recovery that works', () => {
    // `update_slide` validates against the slide's *existing* capabilities and cannot change them,
    // and there is no delete tool — so "fix it with update_slide" and "recreate it" are both dead
    // ends. The only real escape is asking the user to delete the slide.
    expect(skill).toContain('Capabilities are fixed at creation')
    expect(skill).toContain('ask the user to delete that slide')
  })

  it('restates the Tier-1 rules a slide is actually judged against', () => {
    for (const rule of ['SL-G01', 'SL-G03', 'SL-G05', 'SL-S01', 'SL-S04', 'SL-H01', 'SL-I02']) {
      expect(skill).toContain(rule)
    }
    expect(skill).toContain('capabilities')
  })

  it('has at least one full-slide example', () => {
    expect(slideExamples(skill).length).toBeGreaterThan(0)
  })

  it.each(slideExamples(skill).map((example, index) => [index, example] as const))(
    'example %i passes the real Tier-1 validator with the capabilities the skill instructs',
    (_index, example) => {
      const result = validateSlideContract(example.html, example.capabilities)
      expect(result.issues.filter((issue) => issue.severity === 'error')).toEqual([])
      expect(result.ok).toBe(true)
    },
  )

  it.each(slideExamples(skill).map((example, index) => [index, example] as const))(
    'example %i is judged against the instructed capabilities, not the ["static"] default',
    (_index, example) => {
      // `create_slide` defaults to `['static']` when the argument is omitted. For a skill whose
      // slides animate or run script, that default *must* fail — otherwise the instruction to pass
      // `capabilities` is decorative and this suite could not tell the two apart.
      const asDefault = validateSlideContract(example.html, ['static'])
      const isStaticSkill =
        example.capabilities.length === 1 && example.capabilities[0] === 'static'
      expect(asDefault.ok).toBe(isStaticSkill)
      if (!isStaticSkill) {
        expect(asDefault.issues.map((issue) => issue.rule)).toContain('SL-H01')
      }
    },
  )
})

describe('packaging — the skills must survive the build, not just `pnpm dev`', () => {
  const pkg = JSON.parse(
    readFileSync(path.join(SKILLS_DIR, '..', '..', 'package.json'), 'utf8'),
  ) as {
    build?: { extraResources?: { from?: string; to?: string }[]; asarUnpack?: string[] }
  }

  it('copies resources/skills to <resourcesPath>/skills, matching resolveBundledSkillsDir', () => {
    expect(pkg.build?.extraResources).toContainEqual({ from: 'resources/skills', to: 'skills' })
  })

  it('keeps the Claude CLI binary outside app.asar — a binary cannot execute from an archive', () => {
    expect(pkg.build?.asarUnpack).toContain('**/node_modules/@anthropic-ai/claude-agent-sdk/**')
  })
})

describe('skill ↔ contract agreement', () => {
  it('the animation skill declares an animation capability in its example, not "static"', () => {
    const [example] = slideExamples(read('svg-animation', 'SKILL.md'))
    expect(example?.capabilities).toContain('css-animation')
  })

  it('the interactive skill declares interactive-js and carries exactly one of each testing hook', () => {
    const [example] = slideExamples(read('interactive-graph', 'SKILL.md'))
    expect(example?.capabilities).toContain('interactive-js')
    expect(example?.html.match(/data-hover-target/g)).toHaveLength(1)
    expect(example?.html.match(/data-click-target/g)).toHaveLength(1)
  })

  it('a static example that gained a script would be caught — the guard is not vacuous', () => {
    const [example] = slideExamples(read('slide-deck', 'SKILL.md'))
    const mutated = (example?.html ?? '').replace('</body>', '<script>1</script></body>')
    expect(validateSlideContract(mutated, ['static']).ok).toBe(false)
  })
})
