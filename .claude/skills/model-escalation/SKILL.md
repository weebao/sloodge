---
name: model-escalation
description: Decide which Claude model the sloodge build loop runs subagents on, and how to react to a usage limit — default every Agent spawn to Fable 5.1, escalate both subagents and the session to Opus 5 when a limit is hit, and drop back to Fable when it resets. Use when spawning subagents or reviewers, when choosing a model, when a usage-limit or grace-window notice appears, when a subagent fails with a credit/quota error, or when the user says switch models / limit reset / back to Fable.
---

# Model escalation for the sloodge build loop

Paths below are relative to the repo root (`/home/baoro/stuff/random/sloodge`).
Node is on nvm — prefix with `export PATH="$HOME/.nvm/versions/node/v24.18.1/bin:$PATH"` if `node` is not found.

## The policy

| Tier               | Subagents        | This session      | When                 |
| ------------------ | ---------------- | ----------------- | -------------------- |
| **baseline**       | `model: "fable"` | user's own choice | normal operation     |
| **escalated**      | `model: "opus"`  | `/model opus`     | a usage limit is hit |
| **baseline again** | `model: "fable"` | `/model fable`    | the limit resets     |

The ladder is not a preference — it is the CLI's own runway advice. Decompiled from the bundled
CLI 2.1.263 (byte ≈199,961,390):

```js
if (t.includes('fable')) return { lever: 'model', text: 'try /model opus · more runway' }
if (t.includes('opus')) return { lever: 'model', text: 'try /model sonnet · ~2× runway' }
```

Gated on `plan === "pro"` and `rateLimitType === "seven_day"`. `sonnet` is the rung below `opus`;
it is **not** part of this project's policy, but the driver knows about it so a future agent
extends the ladder rather than inventing a new bottom.

## Run it (agent path)

The tier and the in-flight roster are durable state, because a limit kills every running subagent
at once and the recovery spans turns (and survives a context compaction).

```bash
node .claude/skills/model-escalation/policy.mjs status
```

```
tier              fable  (Fable 5.1)
subagent model    model: "fable"   <- pass this on every Agent spawn
orchestrator      in sync
since             (never switched)
reason            default
in flight         0 registered
new-session default (~/.claude/settings.json "model"): claude-fable-5-1[1m]
```

**Register every agent as you spawn it.** This is the step that makes recovery mechanical instead
of a reconstruction from memory:

```bash
node .claude/skills/model-escalation/policy.mjs register \
  --id a0481c051970a01a7 --task "review M3.10 PR#58 r8" \
  --brief .claude/briefs/reviewer-common.md \
  --verdict .claude/reviews/m3.10-font-dropdown.r8.json
node .claude/skills/model-escalation/policy.mjs done --id a0481c051970a01a7   # when it finishes
```

When agents die, find out what happened — the orchestrator must never read task transcripts
itself (they are full JSONL and would blow its context), so the grep happens in the script and
only ids come back:

```bash
node .claude/skills/model-escalation/policy.mjs scan --tasks <session tasks dir> --minutes 900
```

```
usage-limit terminations in the last 900 min (7):
  a0481c051970a01a7  <- review M3.10 PR#58 r8
      died    9/6/2026, 1:55:11 AM
      resets  9/6/2026, 5:50:00 AM  ALREADY PASSED
  ...
Every stated reset time has passed: the exhausted tier is available again.
Run `restore --reason "..."` so the NEXT spawns go back to the baseline model.
```

Then escalate — which prints the respawn checklist:

```bash
node .claude/skills/model-escalation/policy.mjs escalate --reason "seven_day usage limit on Fable"
```

```
RESPAWN CHECKLIST - spawn each as a FRESH agent with model: "opus".
Do NOT SendMessage the dead agent: a resume keeps its original (exhausted) model.

- review M3.10 PR#58 r8
    id a0481c051970a01a7   spawned on fable   <- MODEL STALE
    brief     .claude/briefs/reviewer-common.md
    verdict   .claude/reviews/m3.10-font-dropdown.r8.json
```

On a reset, `restore`; after the user types the slash command, `ack` to stop the reminder:

```bash
node .claude/skills/model-escalation/policy.mjs restore --reason "weekly limit reset"
node .claude/skills/model-escalation/policy.mjs ack
node .claude/skills/model-escalation/policy.mjs roster --respawn
```

`escalate` and `restore` print the exact sentence to say to the user. Say it **once**, then keep
working — the subagent half of the switch is already in effect and does not wait on them.

State lives in `.claude/model-policy.json` (gitignored), with a `history` of every transition and
the `inflight` roster. Exit codes: `0` fine, `1` already at the bottom rung, `2` bad usage.

## The recovery loop, in order

1. `scan --tasks <dir> --minutes 900` — who died, and has the stated reset already passed?
2. If the reset has **not** passed: `escalate`, then respawn every listed agent as a **fresh** agent
   on the new model, reusing its `brief`/`worktree`/`verdict` paths. Say the one-line ask to the user.
3. If the reset **has** passed: `restore`, and just respawn on the baseline model.
4. **Never kill healthy agents to change their model.** If work is already running on the escalated
   tier when the baseline frees up, let it finish; `restore` governs the _next_ spawns. Restarting
   working agents to move them back destroys progress for nothing.
5. `done --id X` as each finishes, so the roster stays honest.

## What you can and cannot switch

**Subagents — you control this.** Pass `model:` on every `Agent` spawn. Valid values are
`fable`, `opus`, `sonnet`, `haiku`. There is no settings key for a default subagent model —
probing the bundled CLI for `subagentModel` and `defaultSubagentModel` returns **0 hits** — so
an omitted `model:` silently inherits, and the policy is only enforced by passing it every time.

**This session — you do NOT control this.** The switch is `modelSelection.overrideMainLoopModel`,
reachable only from `/model`, which a human types. Editing `~/.claude/settings.json`'s `"model"`
key changes what the **next** session starts on, not this one. So:

- never claim you switched your own model;
- never edit the user's `~/.claude/settings.json` to try;
- print the one-line ask from `escalate`/`restore` and carry on.

`--fallback-model` exists but is `--print`-only, so it cannot help an interactive session.

## Detecting the limit

**The signal that actually fires is a subagent task-notification, not a message to you.** When the
limit hits, every running agent dies at once with:

```
Agent terminated early due to an API error: You've hit your session limit ·
resets 5:50am (America/Los_Angeles) (error type rate_limit, HTTP 429,
model sent to the API: claude-fable-5-1)
```

Three things to read off it: `rate_limit` / HTTP 429 is the trigger; `model sent to the API` names
the exhausted tier; and **`resets <time>` is what tells you when to `restore`** — `scan` parses it.
Note the exhausted tier is the _subagents'_ model, which need not be your own.

The CLI also injects these into your own conversation when _your_ budget is close:

```
[Usage limit approaching. Checkpoint now: finish the current step, then list up to 3 short
 bullets of the most impactful remaining work. Don't start subagents or long-running work.]

[Usage limit reached - grace window active. Wrap up: finish or checkpoint; don't start
 subagents or long work.]
```

Both say **don't start subagents**. Obey that literally: escalating the _tier_ is not permission to
fan out. Record the tier, finish or checkpoint what is in flight, and spawn after the window clears.

The user separately sees `Usage limit reached · continuing automatically at <time> · esc to cancel`
and, on reset, `Usage limit reset · continuing automatically`. If they paste one, that is a
`restore` signal. They can also run `/usage` and `/rate-limit-options`.

## Gotchas

- **Resuming a subagent keeps its original model.** `SendMessage` to an existing agent id does
  not re-read the tier. This has bitten twice: after Fable ran out, every resume went back to Fable
  and failed again. To escalate work already in flight, **spawn a fresh agent on the new model
  pointed at the same worktree**. Nothing is lost — worktree work is committed on disk, and the new
  agent re-orients with `git status` / `git log`.
- **A limit kills every running agent simultaneously**, so the roster is the whole recovery. Seven
  died at once on 2026-09-06 and their briefs had to be rebuilt from the orchestrator's context —
  which would have been unrecoverable after a compaction. Hence `register` at spawn time, and hence
  keeping shared briefs on disk (`.claude/briefs/`) rather than only in a prompt.
- **A dead agent's partial work is usually committed.** Check the worktree before assuming loss: the
  M4.5 rebase agent died mid-task and its reconciliation commit was on disk and reusable.
- **`subagent_type: "fork"` ignores `model:` entirely** — a fork always runs on the parent's model.
  A fork is therefore never a way to escalate.
- **Escalation is per-model quota, not one shared pool.** Fable being exhausted says nothing about
  Opus, which is the whole reason the ladder works.
- **`restore` from baseline is a no-op** and prints `already on fable; nothing to restore` — safe
  to call speculatively when you are unsure whether a reset already landed.
- **`/effort` is the second lever.** The same CLI function offers `try /effort medium` when the
  model ladder is exhausted. Out of policy here; mentioned so it is not rediscovered as new.

## Troubleshooting

| Symptom                                                 | Fix                                                                                         |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `node: command not found`                               | `export PATH="$HOME/.nvm/versions/node/v24.18.1/bin:$PATH"`                                 |
| `status` says `PENDING` long after the user switched    | They typed it; you never recorded it. Run `ack`.                                            |
| `already at the bottom of the ladder (sonnet)` (exit 1) | The model lever is spent. Switch to the effort lever or wait for the reset.                 |
| `new-session default` reads `(unreadable)`              | `~/.claude/settings.json` is absent or malformed. Cosmetic — the tier still works.          |
| Subagents keep coming back on the wrong model           | You omitted `model:` on the spawn. There is no default to fall back on; pass it explicitly. |
