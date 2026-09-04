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
 * ## Rebasing M3.10 onto M3.11 — resolve the conflict THIS way
 *
 * M3.11 lands first and does exactly the thing above: it declares `export const
 * FORBIDDEN_API_TOKENS`, `packForApiScan` and `findForbiddenApiTokens` in `slide-contract.ts`, and
 * `shared/design/text-edit.ts` imports all three from there. The two branches rewrite the same three
 * regions of that file, so the rebase produces a real conflict — and the tempting resolution, take
 * M3.11's side because it is the newer file, puts preload-reachable `family.ts` back on a `parse5` +
 * `zod` import and silently kills `window.sloodge` in the packaged app. The only thing that goes red
 * is `preload-bundle-deps.test.ts`'s source-graph half — nothing else in the suite notices, which is
 * why that guard exists.
 *
 * Resolve by keeping this leaf and moving M3.11's additions into it:
 *
 *   1. `findForbiddenApiTokens` already lives here, so keep this side and drop M3.11's copy rather
 *      than merging the two.
 *   2. `slide-contract.ts` keeps `import { … } from './forbidden-apis'` — widened to every name it
 *      still calls locally, since `export … from` binds nothing — and re-exports all three, so
 *      M3.11's existing importers keep compiling unchanged.
 *   3. `shared/design/text-edit.ts` imports from `../document/forbidden-apis` directly rather than
 *      through `slide-contract.ts`, so it stops carrying a parse5 dependency it never uses.
 *
 * Two ways the shape of the rebase misleads, both found by executing it rather than reading it:
 *
 *   - The `slide-contract.ts` conflict fires on **three** of M3.10's five commits, not one, because
 *     M3.10 moved the tokens between that file and this one across its own review rounds. Resolve
 *     the first straight to the end state above and the later two resolve as "keep ours".
 *   - Step 3 **never conflicts at all**: M3.10 does not touch `text-edit.ts`, so git never asks
 *     about it. Apply it by hand or it is silently skipped, and the leaf's whole point with it.
 *
 * Last executed against M3.11 d672ed7 (round-4 review, 2026-09-04): typecheck 0, 4,384 tests green,
 * a preload requiring only `electron`. **That result has expired** — M3.11's history was rewritten
 * afterwards (head 9c6db42, of which d672ed7 is not an ancestor). The mechanics above are the
 * durable part; the greenness is not. Re-run the recipe against M3.11's head at merge time rather
 * than trusting this line.
 *
 * Then re-run `pnpm typecheck` (CI runs unit tests only) and
 * `pnpm vitest run tests/unit/preload/preload-bundle-deps.test.ts`, which is what actually catches a
 * bad resolution.
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
