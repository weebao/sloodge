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
 * `System.Drawing`, which is hundreds of milliseconds, and the answer changes only when the user
 * installs a font — something that cannot happen mid-session without an app restart being a
 * perfectly reasonable way to see it. The cache lives in the installer's closure rather than at
 * module scope so each `installFontsIpc()` in a test starts cold.
 *
 * Concurrent opens share one in-flight promise: two panels opening the dropdown at once must not
 * spawn PowerShell twice.
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
      return await inFlight
    } catch (error) {
      // A rejected promise must not be cached, or one transient failure would mean an empty font
      // list for the rest of the session.
      inFlight = null
      throw error
    }
  })
}
