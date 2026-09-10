#!/usr/bin/env node
// Budget watchdog: demote on a usage limit, wait, promote back when it lifts.
//
// `policy.mjs` is the state machine a human or an agent drives by hand. This is the part that
// runs unattended, because the failure it exists for happens when nobody is looking: a usage
// limit kills every in-flight agent at once and the orchestrator finds out only when it next
// tries to spawn one. By then the reset notice is buried in a transcript nobody will re-read.
//
// Design constraints that are not obvious:
//
//   * Transcripts are huge (the live one is 21 MB and grows). Re-reading them every tick is not
//     affordable, so each file is scanned incrementally from a persisted byte offset.
//   * The orchestrator must never receive transcript content. Only the matched notice and its
//     request id leave this process.
//   * The literal "hit your session limit" appears in transcripts for two very different
//     reasons: the CLI printing a real 429, and an agent *writing prose about* a 429. On the
//     live transcript that is 79 real events against 54 false ones. The strict form below
//     requires the API's own trailer (`error type rate_limit, HTTP 429, request id req_...`),
//     which prose does not carry, and the request id doubles as the dedupe key.
//   * One limit produces a BURST of request ids (every live agent 429s within seconds). Without
//     a cooldown, a single burst would walk the ladder fable -> opus -> sonnet in one tick and
//     spend two rungs of runway on one event.

import {
  readFileSync,
  writeFileSync,
  appendFileSync,
  mkdtempSync,
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  openSync,
  readSync,
  closeSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, resolve, join, basename } from 'node:path'
import { homedir } from 'node:os'
import { execFileSync } from 'node:child_process'

// ---------------------------------------------------------------- tier ladder (mirrors policy.mjs)

const TIERS = {
  fable: { agentModel: 'fable', slash: '/model fable', next: 'opus', label: 'Fable 5.1' },
  opus: { agentModel: 'opus', slash: '/model opus', next: 'sonnet', label: 'Opus 5' },
  sonnet: { agentModel: 'sonnet', slash: '/model sonnet', next: null, label: 'Sonnet 5' },
}
const BASELINE = 'fable'

// ---------------------------------------------------------------- args

const argv = process.argv.slice(2)
const flag = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 && argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')
    ? argv[i + 1]
    : fallback
}
const has = (name) => argv.includes(`--${name}`)

const REPO = resolve(flag('repo', '/home/baoro/stuff/random/sloodge'))
const STATE = resolve(flag('state', join(REPO, '.claude/model-policy.json')))
const WD_STATE = resolve(flag('wd-state', join(REPO, '.claude/model-watchdog.json')))
const SETTINGS = resolve(flag('settings', join(homedir(), '.claude/settings.json')))
const INTERVAL = Number(flag('interval', '20')) * 1000
const COOLDOWN = Number(flag('cooldown', '180')) * 1000
const PROBE_EVERY = Number(flag('probe-every', '300')) * 1000
const CLAUDE_BIN = flag('claude-bin', join(homedir(), '.local/bin/claude'))

// The CLI's own project-directory slug: every non-alphanumeric run becomes a dash.
const slug = (p) => p.replace(/[^A-Za-z0-9]/g, '-')
const PROJECT = slug(REPO)
const TRANSCRIPT_DIR = join(homedir(), '.claude/projects', PROJECT)
const TASK_ROOT = join('/tmp', `claude-${process.getuid?.() ?? 1000}`, PROJECT)

// ---------------------------------------------------------------- detection

// Anchored on the API's own error trailer. `[^"\\]` keeps the match inside a single JSON string
// value so a match can never run across transcript records.
const LIMIT_RE =
  /hit your session limit[^"\\]{0,160}?error type rate_limit, HTTP 429, request id (req_[A-Za-z0-9]+)/g

// The notice carries its reset time as a wall clock with no date, e.g. "resets 10pm" or
// "resets 5:50am". Resolving it against when the notice was seen is what makes promotion
// mechanical rather than something a human has to remember.
export function parseResetTime(text, seenAt) {
  const m = /resets\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i.exec(text)
  if (!m) return null
  let hour = Number(m[1]) % 12
  if (m[3].toLowerCase() === 'pm') hour += 12
  const at = new Date(seenAt)
  at.setHours(hour, Number(m[2] ?? 0), 0, 0)
  if (at.getTime() < seenAt.getTime()) at.setDate(at.getDate() + 1)
  return at
}

export function findLimitEvents(chunk, seenAt) {
  const out = []
  LIMIT_RE.lastIndex = 0
  let m
  while ((m = LIMIT_RE.exec(chunk)) !== null) {
    out.push({ requestId: m[1], notice: m[0], resetsAt: parseResetTime(m[0], seenAt) })
  }
  return out
}

// ---------------------------------------------------------------- state

const readJson = (p, fallback) => {
  try {
    return JSON.parse(readFileSync(p, 'utf8'))
  } catch {
    return fallback
  }
}
const writeJson = (p, v) => {
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, JSON.stringify(v, null, 2) + '\n')
}

const WD_EMPTY = {
  offsets: {},
  seen: [],
  mode: 'watch',
  promoteAt: null,
  lastEscalation: 0,
  lastProbe: 0,
}
const loadWd = () => ({ ...WD_EMPTY, ...readJson(WD_STATE, {}) })

const POLICY_EMPTY = {
  tier: BASELINE,
  since: null,
  reason: 'default',
  ackByUser: true,
  history: [],
  inflight: [],
}
const loadPolicy = () => ({ ...POLICY_EMPTY, ...readJson(STATE, {}) })

// The persisted default only governs NEW sessions and freshly spawned agents; it cannot retarget
// a session already running. Writing it is still worth doing — it is the half of the switch that
// does not need a human to type anything.
function setPersistedModel(tier) {
  const s = readJson(SETTINGS, null)
  if (!s) return `cannot read ${SETTINGS}`
  const suffix = /\[[^\]]+\]$/.exec(String(s.model ?? ''))?.[0] ?? ''
  const next = TIERS[tier].agentModel + suffix
  if (s.model === next) return null
  writeJson(SETTINGS, { ...s, model: next })
  return null
}

// ---------------------------------------------------------------- scanning

function sources() {
  const files = []
  try {
    for (const f of readdirSync(TRANSCRIPT_DIR)) {
      if (f.endsWith('.jsonl')) files.push(join(TRANSCRIPT_DIR, f))
    }
  } catch {}
  try {
    for (const sess of readdirSync(TASK_ROOT)) {
      const d = join(TASK_ROOT, sess, 'tasks')
      let entries
      try {
        entries = readdirSync(d)
      } catch {
        continue
      }
      for (const f of entries) if (f.endsWith('.output')) files.push(join(d, f))
    }
  } catch {}
  return files
}

// 8 KB of overlap so a notice split across two ticks is still seen whole. The notice is ~130
// bytes, so this is three orders of magnitude of headroom.
const OVERLAP = 8192

function readTail(path, from, to) {
  const len = to - from
  if (len <= 0) return ''
  const buf = Buffer.allocUnsafe(len)
  const fd = openSync(path, 'r')
  try {
    readSync(fd, buf, 0, len, from)
  } finally {
    closeSync(fd)
  }
  return buf.toString('latin1')
}

export function scanFiles(wd, paths, { stat = statSync, read = readTail } = {}) {
  const seen = new Set(wd.seen)
  const fresh = []
  for (const path of paths) {
    let st
    try {
      st = stat(path)
    } catch {
      continue
    }
    // A file seen for the first time is baselined and NOT back-scanned: a watchdog started today
    // must not replay a 21 MB transcript's worth of old limits as if they were happening now.
    // The offset has to be RECORDED here. Leaving it unset and re-deriving the baseline as
    // "current size" each tick means the file ispermanently baselined and never scanned at all.
    if (!(path in wd.offsets)) {
      wd.offsets[path] = st.size
      continue
    }
    const prev = wd.offsets[path]
    if (st.size === prev) continue
    const from = st.size < prev ? 0 : Math.max(0, prev - OVERLAP)
    let chunk
    try {
      chunk = read(path, from, st.size)
    } catch {
      continue
    }
    wd.offsets[path] = st.size
    for (const ev of findLimitEvents(chunk, st.mtime)) {
      if (seen.has(ev.requestId)) continue
      seen.add(ev.requestId)
      fresh.push({ ...ev, source: basename(path) })
    }
  }
  // Bounded so the state file cannot grow without limit across a long-lived session.
  wd.seen = [...seen].slice(-4000)
  return fresh
}

const scan = (wd) => scanFiles(wd, sources())

// ---------------------------------------------------------------- probe

// The only honest test that a limit has lifted is to spend one token against it. A reset time is
// a promise, not an observation, and it has been wrong before (the window slides).
/**
 * Every way the CLI says "not this model, not now".
 *
 * `hit your session limit … rate_limit … HTTP 429` is the ACCOUNT-wide refusal, and it is what the
 * detector above keys on. A model-specific refusal is a different sentence entirely — measured
 * 2026-09-09, verbatim:
 *
 *   You've reached your Fable limit. Switch to another model, or manage usage credits at
 *   claude.ai/settings/usage?from=cc_cli_limit_message, to continue.
 *
 * No `rate_limit`, no `429`, no reset time. The first version of this probe matched only the
 * account-wide wording, so it read a live model limit as an unrecognised error — the right verdict
 * for the wrong reason, and only because a non-TTY run exits 1. Under a TTY the same refusal exits
 * **0**, so the probe would have returned "available" and promoted onto an exhausted model.
 */
const REFUSED =
  /hit your session limit|rate_limit|reached your [A-Za-z. ]*limit|cc_cli_limit_message/i

/**
 * Three outcomes, not two. "Still limited" and "the probe itself is broken" both used to return
 * `{ ok: false }`, so a missing binary, a failed auth or a changed CLI surface was indistinguishable
 * from a limit — the watchdog would wait for a reset that was never coming and never say why.
 */
function probe(tier) {
  const run = () =>
    execFileSync(CLAUDE_BIN, ['--print', '--model', TIERS[tier].agentModel, 'ok'], {
      encoding: 'utf8',
      timeout: 120_000,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        PATH: `${homedir()}/.nvm/versions/node/v24.18.1/bin:${process.env.PATH}`,
      },
    })
  let blob
  try {
    blob = run()
  } catch (err) {
    // The refusal arrives on stdout with status 1 when there is no TTY, so the text matters more
    // than the exit code — check it on both paths rather than trusting either.
    blob = `${err.stdout ?? ''}${err.stderr ?? ''}${err.message ?? ''}`
    if (!REFUSED.test(blob)) return { ok: false, broken: blob.slice(0, 200) }
  }
  if (REFUSED.test(blob)) return { ok: false, resetsAt: parseResetTime(blob, new Date()) }
  return { ok: true }
}

// ---------------------------------------------------------------- events out
//
// Every line printed here becomes one notification in the orchestrator's conversation, so the
// budget is a handful per limit episode. Idle ticks print nothing at all: silence is the normal
// state, and a heartbeat would drown the signal it exists to carry.

const emit = (...parts) => {
  process.stdout.write(parts.join(' ') + '\n')
}
const stamp = () => new Date().toLocaleTimeString()

function announceEscalation(from, to, resetsAt, count) {
  emit(
    `[watchdog ${stamp()}] ESCALATED ${TIERS[from].label} -> ${TIERS[to].label}`,
    `(${count} agent${count === 1 ? '' : 's'} 429'd).`,
    `ACTION: pass model: "${TIERS[to].agentModel}" on every Agent spawn from now on,`,
    `and RESPAWN any dead agent fresh (a resume keeps its exhausted model).`,
    resetsAt
      ? `Promotion back to ${TIERS[BASELINE].label} is armed for ${resetsAt.toLocaleTimeString()}.`
      : 'No reset time stated; will probe periodically.',
  )
}

function announcePromotion(from, to) {
  emit(
    `[watchdog ${stamp()}] PROMOTED ${TIERS[from].label} -> ${TIERS[to].label}: the limit has lifted (verified by a live probe).`,
    `ACTION: pass model: "${TIERS[to].agentModel}" on new Agent spawns.`,
    `Do NOT restart healthy agents already running on ${TIERS[from].label} just to move them.`,
  )
}

// ---------------------------------------------------------------- tick

function tick() {
  const wd = loadWd()
  const policy = loadPolicy()
  const now = Date.now()
  let dirty = false

  const fresh = scan(wd)
  dirty = true // scan always advances offsets

  if (fresh.length > 0 && now - wd.lastEscalation > COOLDOWN) {
    const from = policy.tier
    const to = TIERS[from].next
    const resets =
      fresh
        .map((e) => e.resetsAt)
        .filter(Boolean)
        .sort((a, b) => b - a)[0] ?? null

    if (to) {
      const at = new Date().toISOString()
      writeJson(STATE, {
        ...policy,
        tier: to,
        from,
        direction: 'escalate',
        since: at,
        reason: `usage limit on ${TIERS[from].label}`,
        ackByUser: false,
        history: [...policy.history, { from, to, at, reason: 'watchdog: usage limit' }],
      })
      const warn = setPersistedModel(to)
      announceEscalation(from, to, resets, fresh.length)
      if (warn) emit(`[watchdog ${stamp()}] WARN ${warn}`)
    } else {
      emit(
        `[watchdog ${stamp()}] LIMIT on ${TIERS[from].label}, which is the bottom of the ladder.`,
        `No cheaper tier is in policy. Work must wait for the reset.`,
      )
    }
    wd.lastEscalation = now
    wd.mode = 'wait-to-promote'
    wd.promoteAt = resets ? resets.getTime() : now + 60 * 60 * 1000
  }

  if (wd.mode === 'wait-to-promote') {
    const current = loadPolicy().tier
    if (current === BASELINE) {
      wd.mode = 'watch'
      wd.promoteAt = null
    } else if (now >= (wd.promoteAt ?? Infinity) && now - wd.lastProbe > PROBE_EVERY) {
      wd.lastProbe = now
      const r = probe(BASELINE)
      if (r.ok) {
        const p = loadPolicy()
        const at = new Date().toISOString()
        writeJson(STATE, {
          ...p,
          tier: BASELINE,
          from: p.tier,
          direction: 'restore',
          since: at,
          reason: 'watchdog: limit lifted, verified by probe',
          ackByUser: false,
          history: [...p.history, { from: p.tier, to: BASELINE, at, reason: 'watchdog: probe ok' }],
        })
        setPersistedModel(BASELINE)
        announcePromotion(p.tier, BASELINE)
        wd.mode = 'watch'
        wd.promoteAt = null
      } else {
        // A broken probe is not a limit, and staying quiet about it means waiting forever for a
        // reset that is not coming. Said once per episode, not every five minutes.
        if (r.broken !== undefined && wd.brokenSaid !== true) {
          emit(
            `[watchdog ${stamp()}] PROBE FAILED — cannot tell whether ${TIERS[BASELINE].label} is`,
            `available, so the tier stays put. This is not a limit:`,
            r.broken.replace(/\s+/g, ' ').trim(),
          )
          wd.brokenSaid = true
        }
        if (r.broken === undefined) wd.brokenSaid = false
        // Still limited. The window slid; believe the new notice over the old one.
        wd.promoteAt = r.resetsAt ? r.resetsAt.getTime() : now + PROBE_EVERY
      }
    }
  }

  if (dirty) writeJson(WD_STATE, wd)
}

// ---------------------------------------------------------------- self-test
//
// The thing this script must never do is fire on an agent talking about a limit. That is not a
// hypothetical: the live transcript contains 54 such lines against 79 real ones. So the test
// asserts the rejection, not just the acceptance — a detector that only proves it can say yes
// cannot tell you it knows how to say no.

function selfTest() {
  const REAL =
    "You've hit your session limit · resets 10pm (America/Los_Angeles) (error type rate_limit, HTTP 429, request id req_011CeoFjxgzzjhJUjghAHn63)"
  // Every one of these is a real line lifted from the live transcript's 54 false positives, or
  // the shape of one. The load-bearing cases are the last two: an agent QUOTING the notice
  // without the API trailer, with a request id close enough to be swept up by a looser pattern.
  // Fixtures that merely lack the phrase prove nothing — they are rejected by any pattern at
  // all, so they cannot tell a working anchor from a missing one.
  const PROSE = [
    'the `rate_limit` / HTTP 429 is the trigger; `model sent to the API` names the tier',
    'it said hit your session limit but you didnt continue',
    'resets 10pm. Checking the actual state before deciding',
    'stopped at the usage limit after confirming the gate was green; begin fresh.',
    'hit your session limit \u00b7 resets 10pm (America/Los_Angeles) -- that was request id req_011CeoFjxgzzjhJUjghAHn63 from the earlier run',
    'agents died: you have hit your session limit \u00b7 resets 5:50am, see req_011CemuRbCLp9EZmTa1C9EJo in the log',
  ]
  let fails = 0
  const ok = (name, cond) => {
    if (!cond) {
      console.error(`FAIL ${name}`)
      fails += 1
    } else console.log(`ok   ${name}`)
  }

  const hits = findLimitEvents(REAL, new Date('2026-09-07T21:00:00'))
  ok('accepts a real notice', hits.length === 1)
  ok('extracts the request id', hits[0]?.requestId === 'req_011CeoFjxgzzjhJUjghAHn63')
  ok('resolves the reset time to 22:00', hits[0]?.resetsAt?.getHours() === 22)

  for (const [i, p] of PROSE.entries()) {
    ok(`rejects prose #${i + 1}`, findLimitEvents(p, new Date()).length === 0)
  }

  // A reset quoted earlier than the sighting belongs to tomorrow.
  const rolled = parseResetTime('resets 5:50am', new Date('2026-09-07T21:00:00'))
  ok(
    'rolls a past-looking reset to the next day',
    rolled.getDate() === 8 && rolled.getHours() === 5,
  )

  // Two notices in one chunk are two events, and a repeat of one id is still one.
  const two = findLimitEvents(
    REAL + ' ... ' + REAL.replace('req_011CeoFjxgzzjhJUjghAHn63', 'req_ZZZ'),
    new Date(),
  )
  ok('finds both notices in one chunk', two.length === 2)

  // The probe's refusal matcher, against the two sentences the CLI actually emits. The
  // model-specific one shares no token with the account-wide one — not `rate_limit`, not `429` —
  // and matching only the latter is what let a live model limit read as an unrecognised error.
  const REAL_MODEL_LIMIT =
    "You've reached your Fable limit. Switch to another model, or manage usage credits at " +
    'claude.ai/settings/usage?from=cc_cli_limit_message, to continue.'
  ok('the matcher knows the model-specific refusal', REFUSED.test(REAL_MODEL_LIMIT))
  ok('the matcher knows the account-wide refusal', REFUSED.test(REAL))
  ok('the matcher does not fire on a normal reply', !REFUSED.test('ok'))
  ok(
    'the matcher does not fire on prose about limits',
    !REFUSED.test('the run stopped at the usage cap; see the roadmap row'),
  )

  // A chunk holding one real notice plus two trailer-less quotes of it must yield exactly one
  // event. This is the whole precision claim stated as a number.
  const MIXED = PROSE.slice(4).join(' ') + ' ' + REAL + ' ' + PROSE[4]
  ok(
    'one real notice among quotes yields exactly 1',
    findLimitEvents(MIXED, new Date()).length === 1,
  )

  // The ladder must not contain a cycle or a dangling rung.
  let t = BASELINE
  const walked = []
  while (t) {
    ok(`ladder rung ${t} is defined`, Boolean(TIERS[t]))
    walked.push(t)
    t = TIERS[t].next
    if (walked.length > 5) break
  }
  ok('ladder terminates', walked.length === 3 && walked[2] === 'sonnet')

  // --- functional: the incremental tail against real files on disk -------------------------
  //
  // The unit assertions above all run on a string handed straight to the matcher. They would
  // stay green if the scanner never opened a file at all, which was in fact the first version's
  // bug: it baselined a newly-seen file without recording the offset, so every later tick
  // re-derived the baseline as the current size and the file was never read.
  const dir = mkdtempSync(join(tmpdir(), 'wd-test-'))
  const f = join(dir, 'session.jsonl')
  writeFileSync(f, 'nothing interesting yet\n')
  const wd = { ...WD_EMPTY }

  ok('first sight of a file yields no events', scanFiles(wd, [f]).length === 0)
  ok('first sight RECORDS the offset', wd.offsets[f] === statSync(f).size)

  appendFileSync(f, REAL + '\n')
  const first = scanFiles(wd, [f])
  ok('an appended notice is detected', first.length === 1)
  ok(
    'the detected event carries its request id',
    first[0]?.requestId === 'req_011CeoFjxgzzjhJUjghAHn63',
  )

  ok('an unchanged file yields nothing', scanFiles(wd, [f]).length === 0)

  appendFileSync(f, REAL + '\n')
  ok('the same request id never fires twice', scanFiles(wd, [f]).length === 0)

  appendFileSync(f, REAL.replace('req_011CeoFjxgzzjhJUjghAHn63', 'req_011CnewOne') + '\n')
  ok('a genuinely new request id does fire', scanFiles(wd, [f]).length === 1)

  // A notice split across two ticks: this is the only assertion that can see the re-read
  // overlap. Without it, OVERLAP could be 0 and everything above would still pass.
  const g = join(dir, 'split.jsonl')
  // A request id not used anywhere above: reusing one would make this pass or fail on the
  // dedupe set rather than on the overlap, which is the thing under test.
  const SPLIT = REAL.replace('req_011CeoFjxgzzjhJUjghAHn63', 'req_011CsplitAcrossTicks')
  const cut = 60
  writeFileSync(g, 'x\n')
  scanFiles(wd, [g])
  appendFileSync(g, SPLIT.slice(0, cut))
  ok('half a notice is not an event', scanFiles(wd, [g]).length === 0)
  appendFileSync(g, SPLIT.slice(cut) + '\n')
  ok('a notice split across two ticks is still caught', scanFiles(wd, [g]).length === 1)

  // Truncation/rotation must reset rather than read past the end.
  writeFileSync(f, 'rotated\n')
  ok('a truncated file does not throw', Array.isArray(scanFiles(wd, [f])))

  console.log(fails === 0 ? '\nall green' : `\n${fails} FAILED`)
  process.exit(fails === 0 ? 0 : 1)
}

// ---------------------------------------------------------------- main

if (has('self-test')) {
  selfTest()
} else if (has('once')) {
  tick()
  const wd = loadWd()
  console.log(
    `mode=${wd.mode} tier=${loadPolicy().tier} tracked-files=${Object.keys(wd.offsets).length} seen=${wd.seen.length}` +
      (wd.promoteAt ? ` promoteAt=${new Date(wd.promoteAt).toLocaleString()}` : ''),
  )
} else {
  // Baseline every existing file on the first run so a fresh watchdog does not replay a
  // transcript's worth of history as if it were happening now.
  if (!existsSync(WD_STATE)) {
    const wd = { ...WD_EMPTY }
    for (const p of sources()) {
      try {
        wd.offsets[p] = statSync(p).size
      } catch {}
    }
    writeJson(WD_STATE, wd)
    emit(
      `[watchdog ${stamp()}] armed on ${Object.keys(wd.offsets).length} transcript/agent files; tier=${loadPolicy().tier}. Silent until a limit hits.`,
    )
  }
  const loop = () => {
    try {
      tick()
    } catch (err) {
      emit(`[watchdog ${stamp()}] ERROR ${String(err.message).slice(0, 200)}`)
    }
    setTimeout(loop, INTERVAL)
  }
  loop()
}
