import { APP_LIST_FONTS_CHANNEL, type SystemFontsResponse } from '../shared/ipc-contract'
import { isValidFontFamilyName } from '../shared/fonts/family'

/**
 * The renderer's end of installed-font enumeration (M3.10), as a plain function over an injected
 * `invoke` — same shape and same reason as `presentBridge.ts`.
 *
 * The response is re-validated here even though main already validated it. That is not ceremony:
 * this is the last checkpoint before OS-authored strings become React children and, shortly after,
 * CSS in a slide. `family.ts` explains why those strings deserve the suspicion; re-checking at the
 * boundary costs one pass over a few hundred short strings and means the renderer never has to
 * wonder whether the list it holds was validated.
 *
 * A malformed response degrades to an empty list rather than throwing, matching how
 * `presentBridge.ts` reads a bad answer as `false`: a font list that cannot be trusted is a font
 * list we do not show, and the dropdown still offers the system group — which is the only group
 * that survives export anyway. A broken enumerator must not break the property panel.
 */

export type FontsInvoke = (channel: string, payload: unknown) => Promise<unknown>

export type FontsBridge = {
  /** Installed family names, already allow-list-validated. Never rejects. */
  listSystemFonts: () => Promise<SystemFontsResponse>
}

const EMPTY: SystemFontsResponse = { families: [], source: 'none' }

export function createFontsBridge(invoke: FontsInvoke): FontsBridge {
  return {
    listSystemFonts: async () => {
      let response: unknown
      try {
        response = await invoke(APP_LIST_FONTS_CHANNEL, {})
      } catch {
        return EMPTY
      }
      if (response === null || typeof response !== 'object') return EMPTY
      const { families, source } = response as Partial<SystemFontsResponse>
      if (!Array.isArray(families)) return EMPTY
      return {
        families: families.filter((name) => isValidFontFamilyName(name)),
        source: source === 'powershell' || source === 'fc-list' ? source : 'none',
      }
    },
  }
}
