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
