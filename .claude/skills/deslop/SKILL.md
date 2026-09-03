---
name: deslop
description: Remove AI-generated code slop from a branch diff in the sloodge repo — obvious or redundant comments, defensive code on trusted internal paths, `as any`/type hacks, premature abstractions, backwards-compat shims, and scope creep — while keeping behaviour identical and never touching security boundaries or the design-rationale comments that are this repo's house style. Use after a builder finishes and before the ship-ready-review, when code feels over-engineered, or when the user says deslop / clean up / simplify.
---

# Deslop — remove AI code slop from a branch

Adapted for sloodge from [rohitg00/pro-workflow `skills/deslop`](https://github.com/rohitg00/pro-workflow/blob/main/skills/deslop/SKILL.md). Runs on the diff against `main`, applies minimal edits, and proves behaviour is unchanged with the repo's full gate.

## Commands

```bash
export PATH="/home/linuxbrew/.linuxbrew/bin:$HOME/.nvm/versions/node/v24.18.1/bin:$HOME/.local/bin:$PATH"
git fetch origin main
git diff origin/main...HEAD --stat
git diff origin/main...HEAD
```

## Workflow

1. Read the whole diff. Note which files are source, which are tests, which are docs.
2. Identify slop using the focus areas below. For each candidate, decide against the guardrails **before** editing.
3. Apply minimal, focused edits. No rewrites, no renames for taste, no reformatting beyond what Prettier does.
4. Re-run `git diff origin/main...HEAD` and confirm only slop was removed.
5. Run the full gate — all four, not a subset:
   ```bash
   pnpm exec oxlint src tests   # zero warnings, not just zero errors
   pnpm exec prettier --check src tests .claude
   pnpm typecheck
   pnpm test
   ```
6. If you deleted a guard, re-run the mutation that its test was built to catch and confirm the test still reds without it — if it does not, you removed a real guard, restore it.
7. Summarise: patterns found with `file:line`, edits applied, one line on what was cleaned.

## Focus areas (what IS slop here)

- Comments that restate the line below them (`// increment counter`), or that narrate a change instead of explaining a decision (`// updated to use X`, `// removed Y`).
- `try/catch` around trusted internal calls that cannot throw, or that swallow an error into a log and continue.
- `as any`, `as unknown as T`, `!` non-null assertions, or `@ts-expect-error` used only to bypass a type the code could satisfy.
- One-use helpers, factories, or generic parameters introduced for a single call site.
- Deep nesting that early returns would flatten.
- Backwards-compatibility shims in a repo with no external consumers: renamed `_unused` params kept alive, re-exports of moved symbols, dead branches for a format that never shipped.
- Work beyond the brief: features, refactors, or "improvements" to code the milestone did not ask to touch. Added docstrings or type annotations on unchanged code.
- Logging or `console.*` left from debugging.
- Tests that assert an implementation detail already covered by a behavioural test, or a test that cannot fail (no mutation reds it).

## Guardrails (what is NOT slop here — do not touch)

- **Design-rationale comments are house style.** This repo deliberately documents _why_: the byte-span source-map invariants, why a guard is shaped the way it is, what a prior review round found. A comment that explains a non-obvious decision or names the failure it prevents stays, even if long. Only delete a comment if the code would be equally clear without it to someone who has never seen the repo.
- **Security boundaries are never "defensive code".** `sanitizeXmlText`, `SafePptxDeck`, the `buildAuthEnv` allow-list, `archive.ts` ZIP hardening, `slide-contract.ts` validators, the `packForApiScan` scan, `event.source` checks on the postMessage bridge, IPC input validation, URL-scheme allow-lists. If a check sits on an untrusted-input path (slide HTML, an imported file, a chat message, an env var, an IPC payload), it stays. When unsure, grep the tests: if a test names it as a guard, it is one.
- **Guards with a mutation proof stay.** If the ship-ready-review verdict or a test comment records "removing X reds N tests", X is load-bearing.
- **Three similar lines beat a premature abstraction** — do not _add_ helpers while removing slop either.
- Behaviour stays identical unless you are fixing a clear bug, and then say so explicitly in the summary.
- Verify a symbol is unused (`grep -rn` across `src tests`) before deleting it; an export can be consumed only by a test.
- Do not change the test count downward without naming each removed test and why it was redundant.

## Output

- Slop patterns found, each with `file:line`
- Edits applied
- Gate results (lint / prettier / typecheck / test counts before → after)
- One-line summary
