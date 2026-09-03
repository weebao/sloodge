/**
 * §8's automatic fallback and its status indicator (M2.5) — the two pieces M2.4 deferred, shipped
 * together because a session that silently restarts itself with a different prompt shape and shows
 * nothing is worse than the loud non-healing state M2.4 shipped.
 *
 * The restart is driven with a scripted fake init transcript, the pattern M2.4's skills tests
 * established: no key, no subprocess, no network — just the `system:init` messages a broken
 * workspace would produce, and the assertion that the session repairs itself **exactly once**.
 */

import { describe, expect, it, vi } from 'vitest'
import { AgentSession } from '../../../src/main/agent/session'
import type {
  AgentQueryFn,
  AgentQueryHandle,
  AgentQueryOptions,
} from '../../../src/main/agent/query-contract'
import {
  composeFallbackSystemPrompt,
  readSkillBodies,
  stripFrontmatter,
  type SkillFs,
} from '../../../src/main/agent/skills'
import type { AgentEvent } from '../../../src/shared/agent/types'

const OPTIONS: AgentQueryOptions = {
  credential: { kind: 'api-key', value: 'sk-ant-test' },
  model: 'claude-opus-5',
  cwd: '/workspace',
  configDir: '/config',
}

const ALL_SKILLS = ['slide-deck', 'svg-animation', 'interactive-graph']

const initWith = (skills: readonly string[]): Record<string, unknown> => ({
  type: 'system',
  subtype: 'init',
  session_id: 's1',
  model: 'claude-opus-5',
  skills,
})

function fakeHandle(messages: readonly unknown[]): AgentQueryHandle {
  async function* gen(): AsyncGenerator<unknown, void, unknown> {
    yield* messages
  }
  const handle = gen() as AgentQueryHandle
  handle.interrupt = async () => undefined
  handle.setModel = async () => undefined
  return handle
}

/**
 * A `queryFn` that answers each successive `query()` with the next scripted init transcript. The
 * first call is the broken workspace; the second is whatever the restarted session sees.
 */
function scriptedQueries(scripts: readonly (readonly unknown[])[]): {
  queryFn: AgentQueryFn
  calls: Parameters<AgentQueryFn>[0][]
} {
  const calls: Parameters<AgentQueryFn>[0][] = []
  const queryFn: AgentQueryFn = (params) => {
    calls.push(params)
    // Past the end of the script, keep answering with the last one — a looping implementation must
    // reveal itself as a growing `calls` array, not stall on an exhausted script.
    return fakeHandle(scripts[Math.min(calls.length - 1, scripts.length - 1)] ?? [])
  }
  return { queryFn, calls }
}

const FALLBACK_PROMPT = '## Skill: slide-deck\n\nUse a 1280x720 canvas.'

/** An in-memory bundle for `readSkillBodies`; anything not listed reads as missing. */
const fs = (files: Record<string, string>): Pick<SkillFs, 'readFile'> => ({
  readFile: async (file) => {
    const value = files[file]
    if (value === undefined) throw new Error('ENOENT')
    return value
  },
})

describe('§8 fallback restart', () => {
  it('restarts once with skills: [] and the SKILL.md bodies when init reports skills missing', async () => {
    const emitted: AgentEvent[] = []
    const { queryFn, calls } = scriptedQueries([[initWith(['slide-deck'])], [initWith([])]])
    const session = new AgentSession({
      queryFn,
      options: OPTIONS,
      emit: (e) => emitted.push(e),
      log: () => {},
      loadFallbackPrompt: async () => FALLBACK_PROMPT,
    })
    session.send('make a title slide')

    await vi.waitFor(() => expect(calls).toHaveLength(2))
    // The replacement carries §8's shape: the inlined bodies, on the same session options.
    expect(calls[1]?.options.skillFallbackPrompt).toBe(FALLBACK_PROMPT)
    expect(calls[0]?.options.skillFallbackPrompt).toBeUndefined()
    await session.close()
  })

  it('reports `skills: fallback` once repaired, and stops nagging in chat', async () => {
    const emitted: AgentEvent[] = []
    const { queryFn } = scriptedQueries([[initWith(['slide-deck'])], [initWith([])]])
    const session = new AgentSession({
      queryFn,
      options: OPTIONS,
      emit: (e) => emitted.push(e),
      log: () => {},
      loadFallbackPrompt: async () => FALLBACK_PROMPT,
    })
    session.send('hello')

    await vi.waitFor(() =>
      expect(emitted.some((e) => e.type === 'skills-status' && e.status === 'fallback')).toBe(true),
    )
    // The restart *fixed* the problem. A chat notice about a repaired condition trains the user to
    // ignore notices; the quiet status line is what §8 asks for.
    expect(emitted.some((e) => e.type === 'skills-degraded')).toBe(false)
    expect(session.skillStatus).toEqual({ known: true, mode: 'fallback', loaded: [], missing: [] })
    await session.close()
  })

  it('does NOT restart a second time when the fallback session also reports no skills', async () => {
    // The restart-once guard is load-bearing, not decorative: a fallback session runs with
    // `skills: []`, so its own init reports all three missing *by design*. Without the guard this
    // session would ask to be restarted again, forever, spawning a CLI subprocess per round.
    const { queryFn, calls } = scriptedQueries([[initWith([])], [initWith([])], [initWith([])]])
    const session = new AgentSession({
      queryFn,
      options: OPTIONS,
      emit: () => {},
      log: () => {},
      loadFallbackPrompt: async () => FALLBACK_PROMPT,
    })
    session.send('hello')

    await vi.waitFor(() => expect(calls).toHaveLength(2))
    // Give a looping implementation every chance to spawn a third.
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(calls).toHaveLength(2)
    await session.close()
  })

  it('does not restart again even if the runtime re-inits the fallback session', async () => {
    const { queryFn, calls } = scriptedQueries([
      [initWith([])],
      [initWith([]), initWith([]), initWith([])],
    ])
    const emitted: AgentEvent[] = []
    const session = new AgentSession({
      queryFn,
      options: OPTIONS,
      emit: (e) => emitted.push(e),
      log: () => {},
      loadFallbackPrompt: async () => FALLBACK_PROMPT,
    })
    session.send('hello')

    await vi.waitFor(() => expect(emitted.filter((e) => e.type === 'ready').length).toBe(4))
    expect(calls).toHaveLength(2)
    // Four inits, one status line. The first generation restarted instead of reporting; the second
    // reported once and then stayed quiet through two more inits — announced per session *shape*,
    // not per init, which is M2.4's "announce once" rule surviving the restart.
    expect(emitted.filter((e) => e.type === 'skills-status')).toEqual([
      { type: 'skills-status', status: 'fallback' },
    ])
    await session.close()
  })

  it('replays the in-flight turn into the replacement — the send that triggered it is not swallowed', async () => {
    const { queryFn, calls } = scriptedQueries([[initWith([])], [initWith([])]])
    const session = new AgentSession({
      queryFn,
      options: OPTIONS,
      emit: () => {},
      log: () => {},
      loadFallbackPrompt: async () => FALLBACK_PROMPT,
    })
    session.send('make a title slide')

    await vi.waitFor(() => expect(calls).toHaveLength(2))
    // By the time `system:init` arrives the SDK has already consumed the user's message off the old
    // bridge, so the replacement must be re-fed it or the turn vanishes.
    const replayed: string[] = []
    const stream = calls[1]?.prompt
    expect(stream).toBeDefined()
    for await (const message of stream as AsyncIterable<{ message: { content: string } }>) {
      replayed.push(message.message.content)
      break
    }
    expect(replayed).toEqual(['make a title slide'])
    await session.close()
  })

  it('hands the replacement the same absolute cap — admission bounds the session, not the ceiling', async () => {
    // The SDK ceiling is a per-query backstop (§10, `AgentSession.setBudgetCap`); it is never a
    // decaying remainder, because a remainder is what round 3 mistook for a lowered cap on every
    // send. The restart happens at init with the first turn replayed, so the cap in force is the
    // right number for the replacement too.
    const { queryFn, calls } = scriptedQueries([
      [initWith([]), { type: 'result', subtype: 'success', total_cost_usd: 0.5 }],
      [initWith([])],
    ])
    const session = new AgentSession({
      queryFn,
      options: { ...OPTIONS, maxBudgetUsd: 2 },
      emit: () => {},
      log: () => {},
      // Deferred so the first query's `result` is folded before the restart, proving the cap handed
      // to the replacement is not decremented by spend.
      loadFallbackPrompt: () =>
        new Promise((resolve) => setTimeout(() => resolve(FALLBACK_PROMPT), 10)),
    })
    session.send('hello')

    await vi.waitFor(() => expect(calls).toHaveLength(2))
    expect(calls[1]?.options.maxBudgetUsd).toBe(2)
    await session.close()
  })

  it('keeps M2.4s loud notice when the fallback cannot be built', async () => {
    const emitted: AgentEvent[] = []
    const { queryFn, calls } = scriptedQueries([[initWith(['slide-deck'])]])
    const session = new AgentSession({
      queryFn,
      options: OPTIONS,
      emit: (e) => emitted.push(e),
      log: () => {},
      // The bundle is unreadable too: there is nothing to restart *into*, so a second identical
      // session would just be a wasted subprocess.
      loadFallbackPrompt: async () => null,
    })
    session.send('hello')

    await vi.waitFor(() => expect(emitted.some((e) => e.type === 'skills-degraded')).toBe(true))
    expect(emitted.some((e) => e.type === 'skills-status' && e.status === 'unavailable')).toBe(true)
    expect(calls).toHaveLength(1)
    await session.close()
  })

  it('treats a throwing fallback loader as unrepairable rather than crashing the session', async () => {
    const emitted: AgentEvent[] = []
    const { queryFn } = scriptedQueries([[initWith([])]])
    const session = new AgentSession({
      queryFn,
      options: OPTIONS,
      emit: (e) => emitted.push(e),
      log: () => {},
      loadFallbackPrompt: async () => {
        throw new Error('EACCES')
      },
    })
    session.send('hello')

    await vi.waitFor(() => expect(emitted.some((e) => e.type === 'skills-degraded')).toBe(true))
    // The loader's failure is logged, never shown as an error. (The scripted query then ends its
    // stream with the turn unanswered, and main's own "stopped before replying" close follows —
    // that one is about the query, not the loader.)
    expect(emitted.some((e) => e.type === 'error' && /EACCES/.test(e.message))).toBe(false)
    await session.close()
  })

  it('drops the superseded query’s events so one turn never ends twice', async () => {
    const emitted: AgentEvent[] = []
    // The outgoing query keeps talking after the restart swaps it out.
    const { queryFn } = scriptedQueries([
      [
        initWith([]),
        { type: 'result', subtype: 'success', total_cost_usd: 0.01 },
        { type: 'result', subtype: 'success', total_cost_usd: 0.01 },
      ],
      [initWith([])],
    ])
    const session = new AgentSession({
      queryFn,
      options: OPTIONS,
      emit: (e) => emitted.push(e),
      log: () => {},
      loadFallbackPrompt: async () => FALLBACK_PROMPT,
    })
    session.send('hello')

    await vi.waitFor(() =>
      expect(emitted.some((e) => e.type === 'skills-status' && e.status === 'fallback')).toBe(true),
    )
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(emitted.filter((e) => e.type === 'turn-end').length).toBeLessThanOrEqual(1)
    await session.close()
  })

  it('a healthy session never reads the bundle', async () => {
    const loadFallbackPrompt = vi.fn(async () => FALLBACK_PROMPT)
    const { queryFn, calls } = scriptedQueries([[initWith(ALL_SKILLS)]])
    const session = new AgentSession({
      queryFn,
      options: OPTIONS,
      emit: () => {},
      log: () => {},
      loadFallbackPrompt,
    })
    session.send('hello')

    await vi.waitFor(() => expect(calls).toHaveLength(1))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(loadFallbackPrompt).not.toHaveBeenCalled()
    await session.close()
  })
})

describe('stripFrontmatter', () => {
  it('drops the YAML block, keeping the prose', () => {
    const source =
      '---\nname: slide-deck\ndescription: Craft slides.\n---\n\n# Slide deck\n\nRule 1.'
    expect(stripFrontmatter(source)).toBe('# Slide deck\n\nRule 1.')
  })

  it('returns a body with no frontmatter unchanged', () => {
    // Losing a whole skill body over a missing `---` would turn a cosmetic problem into a silent
    // quality regression.
    expect(stripFrontmatter('# Slide deck\n\nRule 1.')).toBe('# Slide deck\n\nRule 1.')
  })

  it('returns an unterminated block unchanged rather than swallowing the file', () => {
    expect(stripFrontmatter('---\nname: x\n\n# Body')).toContain('# Body')
  })

  it('tolerates a BOM', () => {
    expect(stripFrontmatter('﻿---\nname: x\n---\nBody')).toBe('Body')
  })
})

describe('composeFallbackSystemPrompt', () => {
  it('names each skill and includes every body', () => {
    const prompt = composeFallbackSystemPrompt([
      { name: 'slide-deck', body: 'Rule 1.' },
      { name: 'svg-animation', body: 'Rule 2.' },
    ])
    expect(prompt).toContain('## Skill: slide-deck')
    expect(prompt).toContain('Rule 1.')
    expect(prompt).toContain('## Skill: svg-animation')
    expect(prompt).toContain('Rule 2.')
    expect(prompt).toContain('skill loading was unavailable')
  })

  it('is null when nothing usable could be read, so no pointless restart happens', () => {
    expect(composeFallbackSystemPrompt([])).toBeNull()
    expect(composeFallbackSystemPrompt([{ name: 'slide-deck', body: '   ' }])).toBeNull()
  })
})

describe('readSkillBodies', () => {
  it('reads all three bodies with frontmatter stripped', async () => {
    const bodies = await readSkillBodies({
      sourceDir: '/bundle',
      fs: fs({
        '/bundle/slide-deck/SKILL.md': '---\nname: slide-deck\n---\nA',
        '/bundle/svg-animation/SKILL.md': '---\nname: svg-animation\n---\nB',
        '/bundle/interactive-graph/SKILL.md': '---\nname: interactive-graph\n---\nC',
      }),
    })
    expect(bodies.map((b) => b.name)).toEqual(ALL_SKILLS)
    expect(bodies.map((b) => b.body)).toEqual(['A', 'B', 'C'])
  })

  it('omits what it cannot read instead of throwing', async () => {
    // This runs on the path to repairing an already-degraded session; a read failure must not cost
    // the user their chat box.
    const bodies = await readSkillBodies({
      sourceDir: '/bundle',
      fs: fs({ '/bundle/slide-deck/SKILL.md': 'A' }),
    })
    expect(bodies).toEqual([{ name: 'slide-deck', body: 'A' }])
  })

  it('returns nothing when the bundle is entirely unreadable', async () => {
    expect(await readSkillBodies({ sourceDir: '/bundle', fs: fs({}) })).toEqual([])
  })
})
