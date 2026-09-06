#!/usr/bin/env node
// Model-escalation state machine for the sloodge build loop.
//
// The orchestrator cannot change its own model — `modelSelection.overrideMainLoopModel` lives
// inside the CLI and is reachable only from `/model`, which a human types. So the one piece of
// state that actually has to survive across turns is "which tier are we on, and is the human's
// half of the switch still outstanding". That is what this file is: a durable tier plus the
// exact sentence to hand the user. Everything else the agent can read off its own system prompt.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { homedir } from 'node:os'

const REPO = resolve(new URL('../../..', import.meta.url).pathname)
const STATE = resolve(REPO, '.claude/model-policy.json')

/**
 * Tier order is the CLI's own runway ladder, not a preference. Decompiled from the bundled
 * CLI 2.1.263 at byte 199_961_xxx:
 *   if (t.includes("fable")) return { lever: "model", text: "try /model opus · more runway" }
 *   if (t.includes("opus"))  return { lever: "model", text: "try /model sonnet · ~2x runway" }
 * `sonnet` is the rung below `opus` and is deliberately NOT part of this project's policy — it is
 * recorded here so a future agent knows the ladder continues rather than inventing a new bottom.
 */
const TIERS = {
  fable: { agentModel: 'fable', slash: '/model fable', next: 'opus', label: 'Fable 5.1' },
  opus: { agentModel: 'opus', slash: '/model opus', next: 'sonnet', label: 'Opus 5' },
  sonnet: { agentModel: 'sonnet', slash: '/model sonnet', next: null, label: 'Sonnet 5' },
}

const BASELINE = 'fable'

function readState() {
  if (!existsSync(STATE))
    return { tier: BASELINE, since: null, reason: 'default', ackByUser: true, history: [] }
  return JSON.parse(readFileSync(STATE, 'utf8'))
}

function writeState(s) {
  mkdirSync(dirname(STATE), { recursive: true })
  writeFileSync(STATE, JSON.stringify(s, null, 2) + '\n')
}

// The persisted default in ~/.claude/settings.json is what a NEW session starts on. It is not the
// current session's model — `/model` overrides it in-session without writing it back — so this is
// reported as context, never as the answer to "what am I running on".
function persistedDefault() {
  try {
    const raw = JSON.parse(readFileSync(resolve(homedir(), '.claude/settings.json'), 'utf8'))
    return raw.model ?? '(unset)'
  } catch {
    return '(unreadable)'
  }
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

const [cmd, ...rest] = process.argv.slice(2)
const reasonOf = () => {
  const i = rest.indexOf('--reason')
  return i >= 0 ? rest[i + 1] : 'unstated'
}

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
    break
  }

  case 'restore': {
    if (state.tier === BASELINE) {
      console.log(`already on ${BASELINE}; nothing to restore`)
      show(state)
      break
    }
    const s = {
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

  default:
    console.error(
      'usage: node .claude/skills/model-escalation/policy.mjs <status|escalate|restore|ack> [--reason "<text>"]',
    )
    process.exit(2)
}
