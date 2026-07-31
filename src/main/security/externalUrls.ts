/**
 * Policy for URLs that leave the app via `shell.openExternal`.
 *
 * `setWindowOpenHandler` receives attacker-influenced URLs the moment any
 * renderer content can create a link (AI-generated slide HTML will). Passing
 * them to `shell.openExternal` unfiltered is an arbitrary-protocol launch:
 * `file:`, `smb:`, or an OS-registered custom scheme can execute local
 * handlers. Only web and mail URLs may escape to the OS browser.
 *
 * Nothing here imports `electron`, so the policy is unit-testable in plain
 * Node; `index.ts` owns the wiring.
 */

const ALLOWED_SCHEMES = new Set(['https:', 'http:', 'mailto:'])

/**
 * Returns the *normalized* href to hand to `shell.openExternal`, or null if
 * the URL is not allowed out. Returning the parsed form (not the raw string)
 * means the bytes we validated are the bytes the OS receives — a raw string
 * can differ from what the parser saw (e.g. embedded tabs are stripped during
 * parsing), and check-then-use across two parsers is how allow-lists leak.
 */
export function toSafeExternalUrl(rawUrl: string): string | null {
  let parsed: URL
  try {
    parsed = new URL(rawUrl)
  } catch {
    return null
  }
  return ALLOWED_SCHEMES.has(parsed.protocol) ? parsed.href : null
}

/**
 * In-window navigation policy for `will-navigate`. The app is a single page:
 * the only legitimate in-window navigation is a full reload of the document
 * the window was loaded with (`location.reload()` emits `will-navigate`;
 * same-document `#` routing does not). `appUrl` is that document's URL — the
 * Vite dev-server URL in dev, the packaged index.html `file:` URL in prod.
 *
 * For http(s) app URLs the target must match scheme + origin exactly (the
 * scheme check also shuts out `blob:` URLs, whose `origin` getter inherits
 * the string of the origin that minted them). `file:` origins are opaque
 * (`"null"`), so prod compares the pathname of the exact shipped document.
 */
export function isAllowedNavigation(rawUrl: string, appUrl: string | undefined): boolean {
  if (appUrl === undefined || appUrl === '') {
    return false
  }
  let target: URL
  let app: URL
  try {
    target = new URL(rawUrl)
    app = new URL(appUrl)
  } catch {
    return false
  }
  if (target.protocol !== app.protocol) {
    return false
  }
  if (app.protocol === 'http:' || app.protocol === 'https:') {
    return target.origin === app.origin
  }
  if (app.protocol === 'file:') {
    // The host must match too: `file://evil.example/<same path>` shares the
    // pathname but is a UNC/SMB path on Windows — attacker-hosted HTML.
    return target.host === app.host && target.pathname === app.pathname
  }
  return false
}
