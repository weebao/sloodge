#!/usr/bin/env node
// Model-escalation state machine + in-flight agent roster for the sloodge build loop.
//
// Two jobs, and the second is the one that was missing the first time a limit actually hit.
//
// 1. Which tier are we on, and is the human's half of the switch still outstanding. The
//    orchestrator cannot change its own model — `modelSelection.overrideMainLoopModel` lives
//    inside the CLI and is reachable only from `/model`, which a human types.
// 2. What was in flight when the limit hit. A usage limit kills EVERY running subagent at once,
//    and resuming a dead agent re-runs it on its original (exhausted) model. Recovery is to
//    respawn fresh agents on the new tier at the same worktrees — which is only possible if the
//    briefs survived. Holding the roster on disk means it survives a context compaction too.

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { dirname, resolve, basename, join } from 'node:path'
import { homedir } from 'node:os'
import { execFileSync } from 'node:child_process'

const REPO = resolve(new URL('../../..', import.meta.url).pathname)
const STATE = resolve(REPO, '.claude/model-policy.json')

/**
 * Tier order is the CLI's own runway ladder, not a preference. Decompiled from the bundled
 * CLI 2.1.263 at byte ~199961390:
 *   if (t.includes("fable")) return { lever: "model", text: "try /model opus · more runway" }
 *   if (t.includes("opus"))  return { lever: "model", text: "try /model sonnet · ~2x runway" }
 * `sonnet` is the rung below `opus` and is deliberately NOT this project's policy — it is
 * recorded so a future agent extends the ladder rather than inventing a new bottom.
 */
const TIERS = {
  fable: { agentModel: 'fable', slash: '/model fable', next: 'opus', label: 'Fable 5.1' },
  opus: { agentModel: 'opus', slash: '/model opus', next: 'sonnet', label: 'Opus 5' },
  sonnet: { agentModel: 'sonnet', slash: '/model sonnet', next: null, label: 'Sonnet 5' },
}

const BASELINE = 'fable'
const EMPTY = {
  tier: BASELINE,
  since: null,
  reason: 'default',
  ackByUser: true,
  history: [],
  inflight: [],
}

const readState = () =>
  existsSync(STATE) ? { ...EMPTY, ...JSON.parse(readFileSync(STATE, 'utf8')) } : { ...EMPTY }

function writeState(s) {
  mkdirSync(dirname(STATE), { recursive: true })
  writeFileSync(STATE, JSON.stringify(s, null, 2) + '\n')
}

// The persisted default in ~/.claude/settings.json is what a NEW session starts on. It is not the
// current session's model — `/model` overrides it in-session without writing it back — so this is
// reported as context, never as the answer to "what am I running on".
function persistedDefault() {
  try {
    return (
      JSON.parse(readFileSync(resolve(homedir(), '.claude/settings.json'), 'utf8')).model ??
      '(unset)'
    )
  } catch {
    return '(unreadable)'
  }
}

// The notice carries its own reset time, e.g. "resets 5:50am (America/Los_Angeles)". Parsing it is
// what makes "go back to the baseline when the limit resets" mechanical instead of a thing the
// orchestrator has to remember across a context compaction.
function parseResetTime(line, diedAt) {
  const m = /resets\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i.exec(line)
  if (!m) return null
  let hour = Number(m[1]) % 12
  if (m[3].toLowerCase() === 'pm') hour += 12
  const at = new Date(diedAt)
  at.setHours(hour, Number(m[2] ?? 0), 0, 0)
  // A reset quoted as earlier in the day than the death is the next day's.
  if (at.getTime() < diedAt.getTime()) at.setDate(at.getDate() + 1)
  return at
}

function show(s) {
  const t = TIERS[s.tier]
  console.log(`tier              ${s.tier}  (${t.label})`)
  console.log(`subagent model    model: "${t.agentModel}"   <- pass this on every Agent spawn`)
  console.log(
    `orchestrator      ${s.ackByUser ? 'in sync' : `PENDING - user must type ${t.slash}`}`,
  )
  console.log(`since             ${s.since ?? '(never switched)'}`)
  console.log(`reason            ${s.reason}`)
  console.log(`in flight         ${s.inflight.length} registered`)
  console.log(`new-session default (~/.claude/settings.json "model"): ${persistedDefault()}`)
  if (s.ackByUser) return

  // `from` and `direction` are recorded at transition time. Deriving the previous tier by
  // guessing "the other one" was wrong the moment a third rung existed, and it produced
  // "Hit the fable quota reset limit on Opus 5" on a restore.
  const from = s.from ? TIERS[s.from].label : '(unknown)'
  const head =
    s.direction === 'restore'
      ? `${t.label} is available again (${s.reason}); moving back off ${from}.`
      : `Hit the ${s.reason}; escalating off ${from}.`
  console.log('')
  console.log('Say this to the user, once, then keep working:')
  console.log(`  ${head}`)
  console.log(`  Subagents are already on ${t.label}; type ${t.slash} to move this session too.`)
}

function roster(s, { respawn = false } = {}) {
  if (s.inflight.length === 0) {
    console.log('nothing registered in flight')
    return
  }
  const t = TIERS[s.tier]
  if (respawn) {
    console.log(`RESPAWN CHECKLIST - spawn each as a FRESH agent with model: "${t.agentModel}".`)
    console.log('Do NOT SendMessage the dead agent: a resume keeps its original (exhausted) model.')
    console.log('')
  }
  for (const a of s.inflight) {
    console.log(`- ${a.task}`)
    console.log(
      `    id ${a.id}   spawned on ${a.model}${a.model === t.agentModel ? '' : '   <- MODEL STALE'}`,
    )
    if (a.brief) console.log(`    brief     ${a.brief}`)
    if (a.worktree) console.log(`    worktree  ${a.worktree}`)
    if (a.verdict) console.log(`    verdict   ${a.verdict}`)
  }
}

const [cmd, ...rest] = process.argv.slice(2)
const flag = (name, fallback = null) => {
  const i = rest.indexOf(`--${name}`)
  return i >= 0 && rest[i + 1] !== undefined ? rest[i + 1] : fallback
}
const reasonOf = () => flag('reason', 'unstated')

const state = readState()

switch (cmd) {
  case 'status':
    show(state)
    break

  case 'escalate': {
    const next = TIERS[state.tier].next
    if (!next) {
      console.error(
        `already at the bottom of the ladder (${state.tier}); no lower tier is in policy`,
      )
      process.exit(1)
    }
    const s = {
      ...state,
      tier: next,
      from: state.tier,
      direction: 'escalate',
      since: new Date().toISOString(),
      reason: reasonOf(),
      ackByUser: false,
      history: [
        ...state.history,
        { from: state.tier, to: next, at: new Date().toISOString(), reason: reasonOf() },
      ],
    }
    writeState(s)
    show(s)
    console.log('')
    roster(s, { respawn: true })
    break
  }

  case 'restore': {
    if (state.tier === BASELINE) {
      console.log(`already on ${BASELINE}; nothing to restore`)
      show(state)
      break
    }
    const s = {
      ...state,
      tier: BASELINE,
      from: state.tier,
      direction: 'restore',
      since: new Date().toISOString(),
      reason: reasonOf(),
      ackByUser: false,
      history: [
        ...state.history,
        { from: state.tier, to: BASELINE, at: new Date().toISOString(), reason: reasonOf() },
      ],
    }
    writeState(s)
    show(s)
    break
  }

  // Record that the human has typed the slash command, so `status` stops nagging.
  case 'ack':
    writeState({ ...state, ackByUser: true })
    show({ ...state, ackByUser: true })
    break

  case 'register': {
    const id = flag('id')
    const task = flag('task')
    if (!id || !task) {
      console.error('register needs --id and --task (optionally --brief, --worktree, --verdict)')
      process.exit(2)
    }
    const entry = {
      id,
      task,
      brief: flag('brief'),
      worktree: flag('worktree'),
      verdict: flag('verdict'),
      model: TIERS[state.tier].agentModel,
      at: new Date().toISOString(),
    }
    const s = { ...state, inflight: [...state.inflight.filter((a) => a.id !== id), entry] }
    writeState(s)
    console.log(`registered ${id}  (${s.inflight.length} in flight)`)
    break
  }

  case 'done': {
    const id = flag('id')
    if (!id) {
      console.error('done needs --id')
      process.exit(2)
    }
    const s = { ...state, inflight: state.inflight.filter((a) => a.id !== id) }
    writeState(s)
    console.log(`cleared ${id}  (${s.inflight.length} in flight)`)
    break
  }

  case 'roster':
    roster(state, { respawn: rest.includes('--respawn') })
    break

  // Grep the session's task transcripts for a usage-limit termination. The orchestrator must not
  // read those files itself (they are full JSONL transcripts and would blow its context), so the
  // grep happens here and only the agent ids come back.
  case 'scan': {
    const dir = flag('tasks')
    if (!dir) {
      console.error('scan needs --tasks <session tasks dir>')
      process.exit(2)
    }
    const minutes = Number(flag('minutes', '180'))
    const cutoff = Date.now() - minutes * 60_000
    let files
    try {
      files = readdirSync(dir).filter((f) => f.endsWith('.output'))
    } catch (err) {
      console.error(`cannot read ${dir}: ${err.message}`)
      process.exit(2)
    }
    const hits = []
    for (const f of files) {
      const p = join(dir, f)
      let st
      try {
        st = statSync(p)
      } catch {
        continue
      }
      if (st.mtimeMs < cutoff) continue
      let line
      try {
        // -m1 -o so a match returns only the notice, never the surrounding transcript, which is
        // full JSONL and would be ruinous to hand back to the caller.
        line = execFileSync('grep', ['-m1', '-ao', 'You\'ve hit your session limit[^\\\\"]*', p], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        }).trim()
      } catch {
        // grep exits 1 on no match; that is the common case, not an error.
        continue
      }
      hits.push({
        id: basename(f, '.output'),
        diedAt: st.mtime,
        resetsAt: parseResetTime(line, st.mtime),
        line,
      })
    }

    if (hits.length === 0) {
      console.log(`no usage-limit terminations in the last ${minutes} min`)
      break
    }
    console.log(`usage-limit terminations in the last ${minutes} min (${hits.length}):`)
    const known = new Map(state.inflight.map((a) => [a.id, a]))
    let allReset = hits.length > 0
    for (const h of hits) {
      const label = known.has(h.id) ? `  <- ${known.get(h.id).task}` : '  (not registered)'
      console.log(`  ${h.id}${label}`)
      console.log(`      died    ${h.diedAt.toLocaleString()}`)
      if (h.resetsAt) {
        const past = h.resetsAt.getTime() <= Date.now()
        if (!past) allReset = false
        console.log(
          `      resets  ${h.resetsAt.toLocaleString()}  ${past ? 'ALREADY PASSED' : 'still in the future'}`,
        )
      } else {
        allReset = false
        console.log('      resets  (not stated in the notice)')
      }
    }
    console.log('')
    if (allReset) {
      console.log('Every stated reset time has passed: the exhausted tier is available again.')
      console.log('Run `restore --reason "..."` so the NEXT spawns go back to the baseline model.')
      console.log(
        'Do NOT kill agents already running on the escalated tier just to move them back;',
      )
      console.log('restarting healthy work to change its model destroys progress for no gain.')
      break
    }
    console.log(
      'Next: `escalate --reason "..."`, then respawn each as a FRESH agent on the new tier.',
    )
    break
  }

  default:
    console.error(
      'usage: node .claude/skills/model-escalation/policy.mjs <command>\n' +
        '  status                                   current tier + pending user action\n' +
        '  escalate --reason "..."                  move down a rung, print respawn checklist\n' +
        '  restore  --reason "..."                  return to the baseline tier\n' +
        '  ack                                      user has typed the slash command\n' +
        '  register --id X --task "..." [--brief P] [--worktree P] [--verdict P]\n' +
        '  done     --id X                          clear a finished agent\n' +
        '  roster   [--respawn]                     list in-flight agents\n' +
        '  scan     --tasks <dir> [--minutes N]     find usage-limit terminations',
    )
    process.exit(2)
}
