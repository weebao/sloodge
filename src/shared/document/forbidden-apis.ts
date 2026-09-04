/**
 * The runtime APIs a slide may not contain (SL-S04) — kept in a leaf module of its own, importing
 * nothing.
 *
 * It lives here rather than in `slide-contract.ts` because of who needs to read it. The contract
 * validator is one consumer; the other is anything that *writes* into slide source and wants to
 * refuse a value that would trip SL-S04 before committing it, which today means the installed-font
 * allow-list in `src/shared/fonts/family.ts`.
 *
 * `slide-contract.ts` imports `parse5` and the zod deck schema. The preload bundle is built for a
 * **sandboxed** preload, which cannot `require` an external module: importing this list from there,
 * transitively, made the whole preload fail to load and `window.sloodge` come up `undefined` — no
 * slide protocol, no agent, no export, in the packaged app only. A dependency-free leaf is what
 * keeps that from happening again.
 *
 * These are matched against the slide source with **all whitespace stripped** and lowercased, so a
 * value containing `Local Storage` counts as `localStorage`.
 */
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
