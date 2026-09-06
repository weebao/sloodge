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
 * ## `slide-contract.ts` re-exports the scan; it does not declare it
 *
 * M3.11 landed first with its own `FORBIDDEN_API_TOKENS`, `packForApiScan` and
 * `findForbiddenApiTokens` in `slide-contract.ts`, and rebasing M3.10 onto it left both sets
 * standing — the duplicated predicate the note on `packForApiScan` below exists to forbid, put back
 * by a merge. Nothing noticed. Measured in that state: `pnpm typecheck` exits 0, 188 test files
 * pass, `PRELOAD_BUNDLE_REQUIRED=1` gives 20/20. So the invariant is checked, not kept by review:
 * the `SL-S04 scan` block in `tests/unit/preload/preload-bundle-deps.test.ts` fails if
 * `slide-contract.ts` declares any of the three names under any spelling, takes one from anywhere
 * but here, or `export *`s from anywhere but here.
 *
 * The shape it holds `slide-contract.ts` to: import from `'./forbidden-apis'` every name it calls
 * itself — `export … from` binds nothing — and re-export all three, so importers written against
 * it keep compiling; `shared/design/text-edit.ts` takes the three from here directly rather than
 * through a module that pulls in parse5. If a merge ever puts a second copy back, `pnpm typecheck`
 * (CI runs unit tests only) and `pnpm vitest run tests/unit/preload/preload-bundle-deps.test.ts`
 * are what say so.
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
