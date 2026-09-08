/**
 * The `app:listFonts` handler (M3.10) — the electron-wiring half; the decision half is
 * `./enumerate.ts` and the validation half is `src/shared/fonts/family.ts`.
 *
 * ## The response is schema-checked on the way out, not just on the way in
 *
 * Unusually for this codebase, main validates its *own* response here. The reason is where the data
 * comes from: `families` is the parsed stdout of a subprocess reading font files nobody in this
 * project wrote. `normalizeFontFamilies` is what makes it safe, and the schema is the assertion that
 * it actually ran — a future refactor that returns raw enumerator output would fail here rather than
 * shipping unvalidated OS strings into slide CSS. It costs one pass over a few hundred short strings
 * per app session.
 *
 * ## Caching
 *
 * `src/main/agent/vault.ts` sets this codebase's stance that a cache needs a stated justification.
 * The justification here is cost and stability: the Windows enumeration spawns PowerShell and loads
 * `System.Drawing`, which is hundreds of milliseconds warm and — this is the part that bit us —
 * tens of seconds cold, and the answer changes only when the user installs a font, something that
 * cannot happen mid-session without an app restart being a perfectly reasonable way to see it. The
 * cache lives in the installer's closure rather than at module scope so each `installFontsIpc()` in
 * a test starts cold.
 *
 * Concurrent opens share one in-flight promise: two panels opening the dropdown at once must not
 * spawn PowerShell twice.
 *
 * ## Only a success is kept — and why that was a live bug, not a precaution
 *
 * `enumerateSystemFonts` **never rejects**. Its whole contract is to degrade a missing tool, a
 * non-zero exit or a timeout into a resolved `{ families: [], source: 'none' }`, so the `catch`
 * below — which drops the memo on a rejection — could not fire for any of the failures that
 * actually happen. A cold-start timeout resolved `none`, `inFlight` held that promise, and every
 * later dropdown open in the session was answered from the memo without ever re-spawning
 * PowerShell. One slow first open and the user was on system fonts only until they restarted.
 *
 * That silently disabled a retry the renderer had already written. `FontFamilyControl`'s
 * `loadFromBridge` clears its own module-scope memo on exactly this result, and its comment says it
 * is doing so because "`src/main/fonts/install.ts` goes out of its way not to memoise a rejection
 * for exactly this reason". Main did not, in fact, do that for the case that mattered, so the
 * renderer's retry reached this handler and got the poisoned answer back. Both layers now agree:
 * an answer of "we could not enumerate" is not an answer, and is not kept.
 *
 * `none` is the only result treated as retryable, and it is the exact value the enumerator's own
 * catch produces. A real machine that legitimately has no extra families still reports its source
 * (`powershell`/`fc-list`) with an empty list, and that is a success — it is memoised.
 */

import { ipcMain } from 'electron'
import { z } from 'zod'

import { APP_LIST_FONTS_CHANNEL, type SystemFontsResponse } from '../../shared/ipc-contract'
import { MAX_SYSTEM_FONT_FAMILIES, isValidFontFamilyName } from '../../shared/fonts/family'
import { enumerateSystemFonts, type EnumeratedFonts } from './enumerate'

/**
 * Built from `isValidFontFamilyName` rather than restating its character class, so the schema and
 * the allow-list cannot drift apart into two different definitions of a safe name.
 */
const systemFontsResponseSchema = z.object({
  families: z.array(z.string().refine(isValidFontFamilyName)).max(MAX_SYSTEM_FONT_FAMILIES),
  source: z.enum(['powershell', 'fc-list', 'none']),
})

export type FontEnumerator = (platform?: NodeJS.Platform) => Promise<EnumeratedFonts>

export function installFontsIpc(enumerate: FontEnumerator = enumerateSystemFonts): void {
  let inFlight: Promise<SystemFontsResponse> | null = null

  ipcMain.handle(APP_LIST_FONTS_CHANNEL, async (): Promise<SystemFontsResponse> => {
    inFlight ??= enumerate().then((result) => systemFontsResponseSchema.parse(result))
    try {
      const response = await inFlight
      // Not an answer, so not kept: the next open re-spawns. Clearing unconditionally is safe
      // because `??=` means every open still in flight is awaiting this same promise — when it
      // settles they all resume in adjacent microtasks, so none of them can have installed a newer
      // attempt for this one to discard. (A draft guarded against that with a `started` capture; no
      // mutation could make the guard matter, because nothing driven by an IPC message interleaves
      // between two microtasks, so it was untested code defending an unreachable state.)
      if (response.source === 'none') inFlight = null
      return response
    } catch (error) {
      // A rejected promise must not be cached either, or one transient failure would mean an empty
      // font list for the rest of the session. Unreachable via `enumerateSystemFonts`, which never
      // rejects; reachable when the schema refuses a response, and via an injected enumerator.
      inFlight = null
      throw error
    }
  })
}
