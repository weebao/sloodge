/**
 * Where the credential actually goes (M2.7, round 2).
 *
 * `ANTHROPIC_BASE_URL` decides the host the bearer token is transmitted to. The CLI resolves the
 * firstParty endpoint as `process.env.ANTHROPIC_BASE_URL || BASE_API_URL` and builds the client with
 * `authToken: <the pasted CLAUDE_CODE_OAUTH_TOKEN>` — there is no host allow-list gating whether the
 * token is sent. A stale value left over from a LiteLLM proxy, an observability shim, or a corporate
 * gateway therefore receives a long-lived Claude subscription token.
 *
 * ## Why this is surfaced rather than stripped
 *
 * Stripping is the obvious reflex and it is wrong here. Corporate-gateway routing is a deployment
 * shape 50-agent-integration.md §4 explicitly plans for, and silently deleting the variable would
 * turn a working enterprise setup into an opaque connection failure with **no way to re-enable it
 * from Sloodge's UI** — trading a visible risk for an invisible breakage.
 *
 * The actual defect the review found was not the passthrough; it was that the passthrough was
 * *invisible* while the Auth tab promised, at the exact moment of credential entry, that credentials
 * "never leave this machine except as requests to Anthropic". That sentence was false under a custom
 * base URL. So: the override is now read in main, reported to the renderer, shown as a warning above
 * both credential inputs, and the copy tells the truth.
 *
 * Pure and shared, so the "is this the default endpoint" decision is unit-tested rather than
 * eyeballed, and both sides agree on what counts as custom.
 */

/** The default first-party API host. A base URL equal to this is not an override. */
export const DEFAULT_API_BASE_URL = 'https://api.anthropic.com'

/**
 * Where requests will go, as the renderer is allowed to see it.
 *
 * `url` is a host origin, never a full URL with credentials or a path — see `describeEndpoint`. It is
 * safe to render.
 */
export type EndpointInfo = {
  /** True when an `ANTHROPIC_BASE_URL` override is in effect. */
  readonly custom: boolean
  /** The origin requests are routed to, or `null` when the default applies. */
  readonly host: string | null
}

export const DEFAULT_ENDPOINT: EndpointInfo = { custom: false, host: null }

/**
 * Classify an `ANTHROPIC_BASE_URL` value.
 *
 * Deliberately reduces to an **origin**: a base URL can legitimately carry userinfo
 * (`https://user:pass@proxy/`), and echoing that back into the renderer would leak a credential
 * through the very channel this milestone exists to keep clean. Anything unparseable is reported as
 * custom with no host — "we cannot tell you where this goes" is the honest answer, and it is the
 * safe default because it still triggers the warning.
 */
export function describeEndpoint(baseUrl: string | undefined | null): EndpointInfo {
  if (baseUrl === undefined || baseUrl === null) return DEFAULT_ENDPOINT
  const trimmed = baseUrl.trim()
  if (trimmed === '') return DEFAULT_ENDPOINT

  let origin: string | null
  try {
    origin = new URL(trimmed).origin
  } catch {
    // Unparseable but present: the CLI will still use it, so the user must still be warned.
    return { custom: true, host: null }
  }
  // `new URL()` on a userinfo URL keeps the credentials out of `.origin`, which is why we report
  // origin rather than href.
  if (origin === DEFAULT_API_BASE_URL) return DEFAULT_ENDPOINT
  return { custom: true, host: origin }
}

/** The warning shown above the credential inputs. Pure, so the wording is asserted in tests. */
export function describeEndpointWarning(endpoint: EndpointInfo): string | null {
  if (!endpoint.custom) return null
  const where = endpoint.host ?? 'a custom endpoint'
  return `Requests are routed to ${where}, not Anthropic's API. Credentials you save here will be sent there.`
}
