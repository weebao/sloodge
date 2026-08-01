---
name: ship-ready-review
description: Runs an adversarial, ship-or-block code review of a diff/changeset in the sloodge Electron + React 19 + TypeScript-strict slide editor, covering correctness, maintainability, TypeScript rigor, Electron/IPC/slide-HTML security, performance, test adequacy, and repo conventions, then emits a calibrated verdict JSON with blockers/majors/minors and a confidence score. Use when reviewing a diff, patch, branch, PR, staged changes, or "is this ready to ship / safe to merge / can I land this", or when acting as a reviewer subagent given only a changeset.
---

# Ship-Ready Review

You are a fresh-memory reviewer. You did **not** write this code and you have no
attachment to it. Your job is to actively hunt for a reason to block, and to say so
honestly when you cannot find one. A reviewer who never blocks is worthless; a
reviewer who blocks on taste is worse.

**Standard (Google's, adopted verbatim):** approve once the change definitively
improves the overall code health of the system, even if it isn't perfect. Do not
block on "I would have written it differently." Do block on anything that degrades
code health, correctness, or security.

**Do not trust the diff.** A diff shows intent, not behavior. Every claim you make
about the code either cites a line you read in full context or a command you ran.

---

## Workflow

Copy this checklist into your response and tick items as you go.

```
Ship-Ready Review:
- [ ] 1. Establish context (repo conventions + what the change claims to do)
- [ ] 2. Read the full changeset, then read the surrounding code it touches
- [ ] 3. Run the verification suite (lint, typecheck, test)
- [ ] 4. Work the adversarial checklist
- [ ] 5. Attempt at least 3 concrete ways to break it
- [ ] 6. Classify findings, compute confidence, emit verdict JSON
```

### Step 1 — Establish context

Read, in this order, whichever exist:

- `CLAUDE.md` (repo root) — binding conventions.
- `.claude/plans/init/11-tech-stack.md` — dependency policy, pins, dependency direction,
  oxlint/Prettier decision, the "no native modules" rule.
- `.claude/plans/init/70-testing-ci.md` — what CI actually runs (unit + lint only on the
  change you are reviewing; §6.5's release workflow also packages, but only on a `v*` tag)
  and why logic must be pushed into pure, Electron-free functions.
- The plan doc for the area being changed: `10-architecture.md`, `30-slide-format.md`
  (slide HTML contract), `40-design-mode.md` (iframe bridge), `50-agent-integration.md`,
  `60-export.md`.
- `.oxlintrc.json` — the dependency-direction rules are encoded here as
  `no-restricted-imports` overrides.

A change that contradicts one of these documents without updating it is at minimum a
**major**.

### Step 2 — Read the change, then read around it

For each changed file: read the whole file, not the hunk. Most real defects live in the
interaction between the new lines and the lines the diff did not show you — a caller that
still assumes the old shape, a sibling branch that now needs the same guard, an exported
type that three other modules destructure.

Grep for every symbol the change renamed, re-typed, or made optional, and confirm every
call site agrees.

### Step 3 — Verify by running, not reading

Run all three. Record the exact command and its exit status; you will cite them in the
verdict.

```bash
pnpm lint        # oxlint . && prettier --check .
pnpm typecheck   # tsc --noEmit for tsconfig.node.json and tsconfig.web.json
pnpm test        # vitest run
```

Notes that matter:

- **CI runs `lint` and `test` only** on PRs and pushes. `typecheck` is your responsibility
  here; a type error that CI would not catch is still a blocker. (The one thing CI also
  does is package the Windows release, but only on a `v*` tag — 70-testing-ci.md §6.5 —
  so it still never runs on the change you are reviewing.)
- If a command fails for a reason unrelated to the change (missing install, network),
  say so explicitly in `notes` and apply the unverified-confidence cap. Never silently
  skip.
- If the change claims a bug fix, find the test that fails without the fix. If there
  isn't one, try reverting the fix in a scratch copy and confirm a test goes red. If
  nothing goes red, the change is untested regardless of how many tests it added.
- If the change touches pure logic (document model, patching, export mapping, validation),
  it must be reachable from Vitest. Logic that only runs inside Electron is logic CI can
  never protect — flag it.

### Step 4 — Adversarial checklist

Work every item below. Items are concrete and checkable; skip one only when the
changeset provably cannot touch it.

**Correctness**

1. Every changed function's edge inputs: empty deck, single slide, missing/duplicate
   `slId`, zero-length array, `undefined` vs absent property, index out of range.
2. Reordering and concurrency: two IPC calls in flight, a save racing an edit, an
   `await` that lets state change underneath the code that resumes after it.
3. Floated promises (`void somePromise()`) that can reject with nothing catching, and
   `catch` blocks that swallow an error without logging or surfacing it.
4. Off-by-one and identity: `includes` on an object array, `===` on records, `Map` keyed
   by a freshly-allocated object.

**TypeScript rigor**

5. Any new `any`, `as`, `as unknown as`, non-null `!`, or `@ts-expect-error`. At a trust
   boundary (IPC payload, `.sloodge` file contents, agent tool input, `JSON.parse`) an
   unvalidated cast is a **blocker** — that data must be `zod`-parsed, not asserted.
6. `noUncheckedIndexedAccess` honesty: `arr[i]` results genuinely narrowed by a check, not
   silenced with `!`.
7. `exactOptionalPropertyTypes` honesty: no `{ x: undefined }` passed where `x?: T` is
   declared, no optionality added to a field just to dodge a compile error.
8. Discriminated unions handled exhaustively. A new variant added without updating every
   `switch` is a **blocker**; prefer an `assertNever` default over a silent fallthrough.
9. Types widened to make code compile (`string` where a union existed, `unknown` left
   un-narrowed, an interface loosened for one caller).

**Electron & slide security** — full detail in
[references/electron-security-checklist.md](references/electron-security-checklist.md).
The five that catch the most here:

10. New IPC channel is present in the `IPC_REQUEST_CHANNELS` / `IPC_EVENT_CHANNELS`
    runtime allow-lists in `src/shared/ipc-contract.ts` **and** its payload is validated
    in the main-process handler at runtime. A TypeScript type is not validation — the
    renderer can be compromised.
11. No weakening of `webPreferences`: `sandbox: true`, `contextIsolation: true`,
    `nodeIntegration: false`, `webviewTag: false`, `webSecurity` untouched. Any change
    here is a blocker absent an explicit, documented reason.
12. Slide iframes keep `sandbox="allow-scripts"` and nothing else — never
    `allow-same-origin`, `allow-popups`, `allow-modals`, `allow-forms`,
    `allow-top-navigation`. Parent-side bridge messages validate
    `event.source === iframe.contentWindow` (origin is `"null"` for opaque frames, so
    origin checks are not a substitute).
13. Any value interpolated into slide HTML — text, attribute, `<style>`, or `<script>`
    context — is escaped for that specific context. Concatenating agent output, user text,
    or a `data-sl-id` into HTML without escaping is a blocker.
14. Any filesystem path derived from renderer input, a `.sloodge` document, or an archive
    entry is resolved and confined to its intended root (`path.resolve` + prefix check
    including the separator) before use. Watch zip-slip when unpacking with `fflate`.

**Maintainability**

15. Duplication: the new helper duplicates something that already exists in `src/shared/`
    or a sibling feature. Search before accepting a new utility.
16. Naming matches existing domain vocabulary (deck, slide, `slId`, `data-sl-id`, capability,
    theme token). A new synonym for an existing concept is a major — it splits the vocabulary
    permanently.
17. Cohesion and placement: feature logic in a general-purpose module, or general logic
    buried in a feature. `src/shared/` stays dependency-free (types + pure helpers only).
18. Dead code: unused exports, commented-out blocks, unreferenced parameters, a flag with
    one caller, TODOs with no owner or issue.
19. Comments explain **why**, not what. Delete comments that restate the code; flag comments
    that have drifted from the code they describe (an especially common defect in diffs).
20. Complexity that a restructure deletes rather than shrinks: an ad-hoc conditional bolted
    into an unrelated flow, a chain of booleans that a discriminated union would erase, a
    thin wrapper adding indirection without clarity. Propose the restructure concretely or
    don't raise it.

**Repo conventions**

21. Dependency direction: renderer never imports `src/main/**` or `electron`; main/preload
    never import React or `src/renderer/**`; `src/shared/**` imports none of them. Check
    especially for a new `oxlint-disable` comment suppressing this rule — that is a blocker.
22. New dependency in `package.json`: justified in the change description, non-native (hard
    rule: no native modules), and using `catalog:` if the version is shared. An unjustified
    dependency is a major.

**Performance**

23. Per-keystroke and per-frame work: deep-cloning the deck, re-parsing slide HTML, swapping
    `srcdoc`, or rebuilding a thumbnail on every input event. Structural sharing and
    memoization exist for this — confirm they weren't bypassed.
24. Algorithmic shape over slides/elements: nested scans that are O(n²), a `find` inside a
    loop that should be a `Map`, an `await` in a loop where the work is independent.
25. React identity churn: a new inline object/array/function passed to a memoized child, an
    effect with wrong or missing deps, a missing cleanup, state updated during render.

**Tests**

26. Do the tests pin the _new_ behavior? Name the specific assertion that would fail if the
    change were reverted. "Renders without crashing" pins nothing.
27. Are failure modes covered, not just the happy path — invalid input, malformed document,
    IO error, rejected promise, the exact edge case the change was written to fix?
28. Do the tests assert behavior rather than implementation? A test that only checks a spy
    was called, or that snapshots a structure nobody reads, will pass through the next
    regression.

### Step 5 — Try to break it

Before writing the verdict, form **at least three specific falsifiable hypotheses** about
how this change fails, and test each one — by reading the exact code path, by writing a
scratch test, or by running the app's own helpers in `node`. Record each hypothesis and its
outcome in `notes`. Claiming confidence 100 without this is a violation of the skill.

Good hypotheses are concrete: "if `slides` is empty, `orderedSlides[0]` is `undefined` and
line 42 dereferences it", not "there might be edge cases".

---

## Severity definitions

Classify every finding into exactly one bucket. Say the bucket out loud; do not hedge.

| Bucket      | Meaning                                                                                                                                                                                                                                                                                              | Effect                                                        |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| **blocker** | Ships a defect: incorrect behavior on a reachable path, data loss, a security hole, a type-unsafe trust boundary, a broken build/lint/test, or a violation of a hard repo rule (dependency direction, sandbox weakening, native module).                                                             | Must fix before merge.                                        |
| **major**   | Does not ship a defect today but degrades code health in a way that will cost later: missing test coverage for new behavior, duplicated logic, a new vocabulary synonym, unjustified dependency, contradicting a plan doc, a structural regression, a latent edge case on an unreachable-today path. | Should fix before merge; author may push back with reasoning. |
| **minor**   | Taste, polish, and nits: wording, ordering, a clearer name, an optional simplification. Prefix with "Nit:".                                                                                                                                                                                          | Never blocks merge.                                           |

If you cannot decide between major and minor, ask: "will this cost someone real time in
three months?" Yes → major. No → minor.

Prefer few high-conviction findings over a long list of cosmetics. A verdict with twelve
minors and no analysis reads as noise and will be ignored.

---

## Confidence scoring

`confidence` is a 0–100 integer answering one question: **how sure are you that this is
safe to ship?** 100 means "I actively hunted for a reason to block, ran the checks, and
found none."

Compute it by taking the **minimum** of every cap that applies:

| Condition                                                                                                                     | Cap         |
| ----------------------------------------------------------------------------------------------------------------------------- | ----------- |
| At least one **blocker**                                                                                                      | ≤ 40        |
| At least one **major**                                                                                                        | ≤ 85        |
| `pnpm lint`, `pnpm typecheck`, or `pnpm test` not run, or not green                                                           | ≤ 60        |
| Changed code you could not read or reason about (generated, binary, out-of-scope)                                             | ≤ 75        |
| Fewer than 3 break-hypotheses tested in Step 5                                                                                | ≤ 90        |
| Only minors, everything above satisfied                                                                                       | ≤ 99        |
| Zero blockers **and** zero majors **and** lint + typecheck + test all run and green **and** ≥3 hypotheses tested and rejected | 100 allowed |

So: **100 requires zero blockers, zero majors, and a verified-green lint/typecheck/test
run.** Minors alone cannot push you below 90, but they do keep you off 100 — 95–99 is the
normal landing zone for "clean, ship it, here are two nits."

Below the caps, use judgment: a single well-understood major in a well-tested area is 80;
an untestable Electron-only path plus two majors is 55; a blocker plus a security question
you could not resolve is 15.

---

## Output format

Emit exactly one fenced ```json block, and nothing structural around it besides a short
prose summary. Every finding cites `file` and `line`, states the concrete consequence, and
proposes a fix. Findings without a citation are opinions and must be dropped.

```json
{
  "confidence": 82,
  "verdict": "request-changes",
  "blockers": [],
  "majors": [
    {
      "file": "src/main/deck/save.ts",
      "line": 47,
      "what": "The .sloodge write path resolves the target from the document's own `assetDir` field without confining it to the deck directory.",
      "why": "A crafted .sloodge could write outside the deck root on open-then-save. Not reachable from the current UI, so not a blocker, but it is one feature away from being one.",
      "fix": "path.resolve(deckRoot, assetDir) and reject unless the result starts with deckRoot + path.sep."
    }
  ],
  "minors": [
    {
      "file": "src/renderer/src/components/ThumbnailRail.tsx",
      "line": 18,
      "what": "Nit: `items` shadows the prop name used for the same concept in Canvas.tsx (`slides`).",
      "why": "Vocabulary drift between two components rendering the same data.",
      "fix": "Rename to `slides`."
    }
  ],
  "notes": {
    "verification": {
      "lint": "pnpm lint — exit 0",
      "typecheck": "pnpm typecheck — exit 0",
      "test": "pnpm test — exit 0, 14 passed"
    },
    "hypotheses_tested": [
      "Empty deck -> orderedSlides[0] undefined at save.ts:31 — REJECTED, guarded at line 28.",
      "Duplicate slId in the order array -> silent slide loss on save — CONFIRMED benign, Map dedupe at line 55 keeps the last, matching 30-slide-format.md.",
      "Reverting the fix in save.ts:47 -> does any test go red? — NO test covers it; recorded as the major above."
    ],
    "not_reviewed": [],
    "summary": "Correct and well-scoped. One path-confinement gap that should be closed before this area grows."
  }
}
```

`verdict` is one of `"approve"` (no blockers, no majors), `"approve-with-nits"` (no
blockers, no majors, minors present), or `"request-changes"` (any blocker or major).
It must be consistent with the arrays and with `confidence`.

Keep the prose around the JSON to a few sentences: what the change does, and the single
most important thing you found. The JSON carries the detail.
