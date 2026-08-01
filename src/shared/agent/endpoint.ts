/**
 * Where the credential actually goes (M2.7, rounds 2–3).
 *
 * Two things can redirect a credential-bearing request, at different layers:
 *
 * - **`ANTHROPIC_BASE_URL`** (application layer) — the CLI resolves the firstParty endpoint as
 *   `process.env.ANTHROPIC_BASE_URL || BASE_API_URL` and attaches the bearer token with no host
 *   allow-list, so a stale proxy value receives a long-lived subscription token.
 * - **`ANTHROPIC_UNIX_SOCKET`** (transport layer, *below* the URL) — it rewrites every
 *   `forAnthropicAPI` fetch to a local socket before any URL or proxy handling, and the
 *   bearer-enable check short-circuits to `true` under it, so the socket case *enables* the token
 *   rather than suppressing it. The resolved base URL is irrelevant.
 *
 * ## The disclosure is derived from the env we actually build
 *
 * Round 2 read `process.env.ANTHROPIC_BASE_URL` directly, which meant the UI's claim and the child's
 * behaviour were two independent readings that could drift — and did: the socket variable was a
 * redirect the disclosure could not see. `describeAgentEndpoint` now takes the **built subprocess
 * environment**, so the sentence shown to the user is computed from the same bytes handed to the
 * child. Anything the allow-list excludes cannot redirect the request *and* cannot be missing from
 * the warning, because it is not in the environment at all.
 *
 * Pure and shared, so both sides agree on what counts as custom.
 */

/** The default first-party API host. A base URL equal to this is not an override. */
export const DEFAULT_API_BASE_URL = 'https://api.anthropic.com'

/** How the request leaves the machine. */
export type EndpointTransport = 'network' | 'unix-socket'

/**
 * Where requests will go, as the renderer is allowed to see it.
 *
 * `host` is an origin, never a full URL with credentials or a path — see `describeEndpoint`. It is
 * safe to render.
 */
export type EndpointInfo = {
  /** True when anything redirects requests away from Anthropic's default HTTPS endpoint. */
  readonly custom: boolean
  /** The origin requests are routed to, or `null` when the default applies or it cannot be named. */
  readonly host: string | null
  /** `unix-socket` when a local socket intercepts the request below the URL layer. */
  readonly transport: EndpointTransport
}

export const DEFAULT_ENDPOINT: EndpointInfo = {
  custom: false,
  host: null,
  transport: 'network',
}

/**
 * Classify an `ANTHROPIC_BASE_URL` value.
 *
 * Deliberately reduces to an **origin**: a base URL can legitimately carry userinfo
 * (`https://user:pass@proxy/`), and echoing that into the renderer would leak a credential through
 * the very channel this milestone exists to keep clean. Anything unparseable is reported as custom
 * with no host — "we cannot tell you where this goes" is the honest answer, and it still warns.
 */
export function describeEndpoint(baseUrl: string | undefined | null): EndpointInfo {
  if (baseUrl === undefined || baseUrl === null) return DEFAULT_ENDPOINT
  const trimmed = baseUrl.trim()
  if (trimmed === '') return DEFAULT_ENDPOINT

  let origin: string
  try {
    origin = new URL(trimmed).origin
  } catch {
    // Unparseable but present: the CLI will still use it, so the user must still be warned.
    return { custom: true, host: null, transport: 'network' }
  }
  // Opaque-origin schemes (`file:`, `data:`, `javascript:`, `http+unix:`) make `URL.origin` return
  // the *string* "null". Rendering "routed to null" reads as a bug rather than a warning, so it is
  // normalised to "host unknown" — the warning still fires.
  if (origin === 'null') return { custom: true, host: null, transport: 'network' }
  // `new URL()` keeps userinfo out of `.origin`, which is why we report origin rather than href.
  if (origin === DEFAULT_API_BASE_URL) return DEFAULT_ENDPOINT
  return { custom: true, host: origin, transport: 'network' }
}

/**
 * Classify the endpoint from the **built subprocess environment** — the authoritative disclosure.
 *
 * Transport wins over the URL: when a socket is in play the base URL is not consulted by the CLI, so
 * reporting the URL would be actively misleading.
 */
export function describeAgentEndpoint(
  env: Readonly<Record<string, string | undefined>>,
): EndpointInfo {
  const socket = env['ANTHROPIC_UNIX_SOCKET']
  if (typeof socket === 'string' && socket.trim() !== '') {
    // Reachable only if a future allow-list entry admits it; today the allow-list excludes it, so
    // this branch is the guard that keeps the UI honest if that ever changes.
    return { custom: true, host: null, transport: 'unix-socket' }
  }
  return describeEndpoint(env['ANTHROPIC_BASE_URL'])
}

/** The warning shown above the credential inputs. Pure, so the wording is asserted in tests. */
export function describeEndpointWarning(endpoint: EndpointInfo): string | null {
  if (!endpoint.custom) return null
  if (endpoint.transport === 'unix-socket') {
    return 'Requests are routed through a local socket, not Anthropic’s API. Credentials you save here will be sent there.'
  }
  const where = endpoint.host ?? 'a custom endpoint'
  return `Requests are routed to ${where}, not Anthropic’s API. Credentials you save here will be sent there.`
}
