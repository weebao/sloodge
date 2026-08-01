/**
 * The auth model shared by main and renderer (M2.7).
 *
 * Sloodge accepts two credentials, both pasted by the user and both stored in the M2.1 `safeStorage`
 * vault:
 *
 * 1. **Subscription token** (preferred) — minted by `claude setup-token`, which the CLI documents as
 *    "Set up a long-lived authentication token (requires Claude subscription)". Injected into the
 *    agent subprocess as `CLAUDE_CODE_OAUTH_TOKEN`, so a Pro/Max subscriber never handles an API key
 *    and is never billed per-token.
 * 2. **API key** (fallback) — for console/org keys and CI.
 *
 * **Why a pasted token rather than a browser sign-in.** The Agent SDK exposes no supported
 * programmatic login, and the most-scrutinized third-party Electron wrapper (t3code) deliberately
 * does not implement one — it has the user authenticate out of band and consumes the result. A token
 * mint is the same out-of-band step with strictly better properties for us: the secret lands in *our*
 * encrypted vault instead of ambient machine state, so there is nothing to isolate, nothing to
 * clobber, and no platform-specific credential-store behaviour to get wrong.
 *
 * Everything here is pure and total. **No value in this module is ever a plaintext secret** — the
 * renderer-facing types are the masked projection the M2.1 rule requires (50-agent-integration.md §4:
 * the credential never crosses IPC toward the renderer).
 */

import type { ApiKeyStatus } from './types'

/**
 * Which credential the agent subprocess will actually use next. A single value rather than two
 * booleans: the subprocess can only be in one of these states, and the UI must never imply a stored
 * key is "active" while the subscription token is driving the session.
 */
export type AuthMode = 'not-configured' | 'api-key' | 'subscription'

/**
 * The complete, masked auth picture the renderer is allowed to see.
 *
 * Both slots reuse `ApiKeyStatus` (`{ configured, last4 }`) on purpose — one masking rule, one shape
 * to audit, and no way for a new field to accidentally carry plaintext.
 */
export type AuthStatus = {
  readonly mode: AuthMode
  readonly apiKey: ApiKeyStatus
  readonly subscription: ApiKeyStatus
}

export const UNCONFIGURED: ApiKeyStatus = { configured: false, last4: null }

export const NOT_CONFIGURED: AuthStatus = {
  mode: 'not-configured',
  apiKey: UNCONFIGURED,
  subscription: UNCONFIGURED,
}

/**
 * Resolve the effective mode from the two independent vault slots.
 *
 * **The subscription token wins when both are stored.** Note this is the *opposite* of the CLI's own
 * precedence, where `ANTHROPIC_API_KEY` outranks `CLAUDE_CODE_OAUTH_TOKEN` — which is exactly why
 * `buildAuthEnv` must *delete* `ANTHROPIC_API_KEY` rather than merely not set it. Rationale for the
 * inversion: pasting a subscription token is a deliberate "bill this to my plan, not my card" choice,
 * and a key left over from before must not silently keep charging the user's console account.
 * Clearing the token falls back to the key, which is why the two are cleared independently.
 */
export function deriveAuthStatus(apiKey: ApiKeyStatus, subscription: ApiKeyStatus): AuthStatus {
  const mode: AuthMode = subscription.configured
    ? 'subscription'
    : apiKey.configured
      ? 'api-key'
      : 'not-configured'
  return { mode, apiKey, subscription }
}

/** True when the agent has a usable credential — the chat composer's enable/disable gate. */
export function isAuthenticated(status: AuthStatus): boolean {
  return status.mode !== 'not-configured'
}

/**
 * The one-line summary the Auth tab and the chat gate show. Lives here rather than in the component
 * so the "can never leak a secret" property is unit-testable: the only credential-derived value it
 * can emit is `last4`.
 */
export function describeAuthStatus(status: AuthStatus): string {
  switch (status.mode) {
    case 'subscription':
      return `Using your Claude subscription ${maskedSuffix(status.subscription)}`.trimEnd()
    case 'api-key':
      return `API key configured ${maskedSuffix(status.apiKey)}`.trimEnd()
    case 'not-configured':
      return 'Not configured'
  }
}

/** `••••aXY9`, or empty when the store has no last-4 to show. Never returns more than four chars. */
export function maskedSuffix(status: ApiKeyStatus): string {
  const last4 = status.last4
  if (last4 === null || last4 === '') return ''
  return `••••${last4.slice(-4)}`
}

/**
 * The exact command the user runs to mint a subscription token. Centralised so the Auth tab, the
 * docs, and the tests cannot drift apart.
 */
export const SETUP_TOKEN_COMMAND = 'claude setup-token'
