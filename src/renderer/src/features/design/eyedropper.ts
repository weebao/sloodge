/**
 * The eyedropper seam for M3.8 (roadmap: "eyedropper via the `EyeDropper` API (Chromium ships it)
 * sampling anywhere in the app window; writes hex back to source"). The Chromium `EyeDropper` API is
 * the one edge in the colour path that cannot be exercised under happy-dom or driven headless — its
 * `.open()` returns a `Promise` only when a *user* clicks a pixel — so it lives behind a tiny
 * injectable interface. The panel depends on `ColorPicker`, not on `window.EyeDropper`, so a test
 * (and the recorded demo) can pass a fake that resolves a known hex, and the real implementation is
 * one thin, feature-detected adapter tested only for its detection and its cancel-to-`null` contract.
 */

/** The injectable colour source. `pickColor` resolves the sampled sRGB hex, or `null` if cancelled. */
export interface ColorPicker {
  /** Open the picker and resolve the sampled `#rrggbb`, or `null` when the user cancels (Escape). */
  pickColor: () => Promise<string | null>
}

/** The shape of a `EyeDropper` result — the API returns `{ sRGBHex: '#rrggbb' }`. */
interface EyeDropperResult {
  readonly sRGBHex: string
}

interface EyeDropperInstance {
  open: (options?: { signal?: AbortSignal }) => Promise<EyeDropperResult>
}

type EyeDropperCtor = new () => EyeDropperInstance

/**
 * The narrow view of the host we need — just the optional `EyeDropper` constructor. Typing the seam
 * against this (rather than the DOM `Window`) keeps the module compilable under the DOM-free `lib`
 * the test/node tsconfig uses, and lets a test pass a plain fake object.
 */
export interface EyeDropperHost {
  readonly EyeDropper?: unknown
}

/** The default host — the real `window` in a browser/Electron renderer. */
function defaultHost(): EyeDropperHost {
  return globalThis as unknown as EyeDropperHost
}

function readCtor(host: EyeDropperHost): EyeDropperCtor | undefined {
  const ctor = host.EyeDropper
  return typeof ctor === 'function' ? (ctor as EyeDropperCtor) : undefined
}

/**
 * Whether the running window exposes the `EyeDropper` API. Electron's Chromium ships it, but the panel
 * feature-detects rather than assuming, so the eyedropper button is hidden (not broken) anywhere the
 * API is absent — happy-dom tests, an older runtime, a stripped build.
 */
export function hasEyeDropper(host: EyeDropperHost = defaultHost()): boolean {
  return readCtor(host) !== undefined
}

/**
 * The real `ColorPicker`, backed by `window.EyeDropper`. `pickColor` resolves the sampled hex, or
 * `null` both when the API is unavailable and when the user dismisses the picker (which rejects with
 * an `AbortError`) — either way the caller writes nothing.
 */
export function createEyeDropperPicker(host: EyeDropperHost = defaultHost()): ColorPicker {
  return {
    pickColor: async (): Promise<string | null> => {
      const Ctor = readCtor(host)
      if (Ctor === undefined) return null
      try {
        const result = await new Ctor().open()
        return result.sRGBHex
      } catch {
        // The user pressed Escape (AbortError) or the pick otherwise failed: sample nothing.
        return null
      }
    },
  }
}
