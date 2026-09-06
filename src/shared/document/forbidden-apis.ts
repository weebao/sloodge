/**
 * The runtime APIs a slide may not contain (SL-S04), and the normalisation they are matched under —
 * kept in a leaf module of its own, importing nothing.
 *
 * ## Do not give this module a dependency
 *
 * Not a style preference; it is load-bearing, and it is the reason the module exists at all. This
 * file is reachable from the **preload** bundle, which Electron builds `sandbox: true`. A sandboxed
 * preload cannot `require` an external module, and the failure is silent: the preload does not throw
 * anywhere visible, `contextBridge.exposeInMainWorld` simply never runs, `window.sloodge` comes up
 * `undefined`, and the renderer takes its no-Electron fallback — no slide protocol, no agent, no
 * export, in the packaged app only, with the entire unit suite still green.
 *
 * That is not hypothetical: M3.10's font bridge first read this list from `slide-contract.ts`, which
 * imports `parse5` and the zod deck schema, and the built app came up with no bridge at all. So the
 * list lives here, with no imports, and both consumers reach *in*:
 *
 *   - `slide-contract.ts` (the validator), which may import whatever it likes;
 *   - `shared/fonts/family.ts` (a writer that refuses a value which would trip SL-S04 before
 *     committing it), which is on the preload's import graph and may not.
 *
 * If a later branch wants the tokens in `slide-contract.ts` instead — an `export const` there is the
 * obvious shape and two sibling milestones each proposed it — that re-creates the bug the moment any
 * preload-reachable module consumes it. Add to this file; do not move it back.
 * `tests/unit/preload/preload-bundle-deps.test.ts` is what notices if someone does.
 *
 * ## Rebasing M3.10 onto M3.11 — aim at the end state; do not trust the conflict list
 *
 * M3.11 lands first and does exactly the thing above: it declares `FORBIDDEN_API_TOKENS`,
 * `packForApiScan` and `findForbiddenApiTokens` in `slide-contract.ts`, and
 * `shared/design/text-edit.ts` imports all three from there. Both branches rewrite the same regions
 * of that file, so the rebase conflicts — and the tempting resolution, take M3.11's side because it
 * is the newer file, puts preload-reachable `family.ts` back on a `parse5` + `zod` import and
 * silently kills `window.sloodge` in the packaged app.
 *
 * **The end state, which is the durable part of this note:**
 *
 *   1. `slide-contract.ts` declares neither `packForApiScan` nor `findForbiddenApiTokens`. It
 *      imports from `'./forbidden-apis'` every name it still calls locally — `export … from` binds
 *      nothing — and re-exports all three, so M3.11's importers keep compiling unchanged.
 *   2. `shared/design/text-edit.ts` takes the three from `'../document/forbidden-apis'` rather than
 *      through `slide-contract.ts`, so it stops carrying a parse5 dependency it never uses.
 *
 * **Neither step is reachable from a conflict resolution.** Both are applied by hand once the
 * rebase has finished. Step 2 never even conflicts — M3.10 does not touch `text-edit.ts`, so git
 * never asks — and nothing catches skipping it: reverting that import leaves `tsc` at 0 and this
 * file's bundle guard at 20/20, because `text-edit.ts` is renderer-only and off the preload graph.
 * It is architectural hygiene, not a greenness requirement. Step 1 is the load-bearing one, and
 * until this round nothing checked it either — see below.
 *
 * What the conflicts themselves offer:
 *
 *   - The **first** `slide-contract.ts` conflict cannot be resolved to the end state, because the
 *     end state does not exist yet: at M3.10's first commit this leaf exports only
 *     `FORBIDDEN_API_TOKENS`. `packForApiScan` arrives two commits later, `findForbiddenApiTokens`
 *     two after that. Take M3.10's side of the hunk and leave M3.11's local copies alone — they go
 *     at the end, not here.
 *   - The **second** is the SL-S04 call site, and there "keep ours" is right: M3.11's factored
 *     `findForbiddenApiTokens(source)` is what the end state wants anyway.
 *   - "Keep ours" is **not** a general rule, and specifically not on an import line. The r5 run met
 *     a third conflict there, and resolving that one this way is precisely what leaves M3.11's local
 *     copies standing — green, silent, and wrong. Whatever the import lines end up as, step 1
 *     overwrites them.
 *   - The **`.claude/plans/init/80-roadmap.md`** conflicts — one per M3.10 commit that adds a row —
 *     are number collisions rather than text merges: both branches number their next milestone
 *     `M3.13`. Keep every row, renumber M3.10's past M3.11's, and retarget the two cross-references
 *     that name one by number: `PropertyPanel.tsx`'s refusal comment, and the read-bug row's own
 *     pointer at the prose row.
 *
 * **Why "resolve every conflict" is not the recipe.** Do exactly that and stop, and M3.11's
 * `packForApiScan`/`findForbiddenApiTokens` are still sitting in `slide-contract.ts` beside this
 * leaf's — the duplicated predicate the note on `packForApiScan` below exists to forbid, reinstated
 * by the merge. Measured in that state, before this round added the check below: `pnpm typecheck`
 * exits 0, 188 test files pass, and `PRELOAD_BUNDLE_REQUIRED=1` gives 20/20. **Nothing goes red.**
 * A recipe that hands back a green tree with the bug in it manufactures confidence rather than
 * earning it, so the drift is no longer left to whoever reviews the merge: the `SL-S04 scan` block
 * in `tests/unit/preload/preload-bundle-deps.test.ts` fails if `slide-contract.ts` declares either
 * name instead of taking it from here.
 *
 * ## Re-execute this against the real head; do not trust the run below
 *
 * Last executed 2026-09-06 against `main` at `6c24af3`, with M3.11 merged. `git rebase --onto
 * 6c24af3 4d06206` over M3.10's **eight** commits gave **four** conflicts — `slide-contract.ts` on
 * commits 1 and 3, the roadmap on commits 6 and 7 — and that is the merge this file now sits on.
 * One detail the earlier run under-described: the roadmap conflict on commit 7 is not purely a
 * number collision, because round 5 also *rewrote* the SL-S04 row it collides on, so the incoming
 * row's text wins there rather than the one already renumbered by commit 6.
 *
 * The same run measured "every conflict resolved" once more. It was the loud variant this time —
 * the import line auto-merged to name `findForbiddenApiTokens` beside M3.11's local one, TS2440 —
 * and the `SL-S04 scan` block failed there naming both copies. The 2026-09-04 run against `0a64c87`
 * met the silent variant of the same state, where `tsc` reports nothing at all and the block was
 * the only red in 4,512 tests; which variant a rebase lands in depends on how the third conflict
 * resolves, and the block reds in both.
 *
 * **The conflict list is the one thing here with no shelf life.** The same rebase one head earlier,
 * against `9c6db42`, produced a *third* `slide-contract.ts` conflict, on a commit that applied clean
 * above — which hunks collide depends both on M3.11's head and on how you resolved the previous
 * conflict, so a resolution that differs from the one described here will not even meet the same
 * conflicts. Re-run the rebase against the actual merge-time head and read the conflicts it gives
 * you, rather than expecting these. The end state is what you are aiming at; the route is not
 * stable, and the test is what tells you whether you arrived.
 *
 * Then `pnpm typecheck` (CI runs unit tests only) and
 * `pnpm vitest run tests/unit/preload/preload-bundle-deps.test.ts`, which is what catches a bad
 * resolution.
 */

/**
 * The normalisation SL-S04 matches under: **all whitespace stripped**, lowercased. So a value
 * containing `Local Storage` counts as `localStorage`, and spaces do not separate tokens.
 *
 * Shared rather than re-implemented by each caller, because the guard in `family.ts` is only correct
 * while its packing is *identical* to the validator's — a duplicated predicate drifts narrower than
 * the rule it mirrors, and the drift shows up as a slide the app happily writes and then rejects.
 */
export function packForApiScan(value: string): string {
  return value.replace(/\s+/g, '').toLowerCase()
}

export const FORBIDDEN_API_TOKENS: readonly string[] = [
  'fetch(',
  'XMLHttpRequest',
  'WebSocket',
  'EventSource',
  'sendBeacon',
  'localStorage',
  'indexedDB',
  'document.cookie',
  'alert(',
  'confirm(',
  'prompt(',
  'eval(',
  'new Function(',
]

/**
 * The forbidden tokens `value` contains, under SL-S04's own packing. Asked by the validator deciding
 * SL-S04 and by the writers that refuse to produce a slide it would then reject — see the note on
 * `packForApiScan` for why they share one scan instead of each carrying their own.
 */
export function findForbiddenApiTokens(value: string): string[] {
  const packed = packForApiScan(value)
  return FORBIDDEN_API_TOKENS.filter((token) => packed.includes(packForApiScan(token)))
}
