/**
 * The Settings ▸ Auth tab (M2.7) — the one place in the app where a credential is entered.
 *
 * Two paths, subscription first:
 *
 * 1. **Claude subscription** — the user runs `claude setup-token` in their own terminal and pastes
 *    the resulting long-lived token here. We store it encrypted and inject it as
 *    `CLAUDE_CODE_OAUTH_TOKEN`, so a Pro/Max subscriber is billed against their plan and never
 *    handles an API key.
 * 2. **API key** — the fallback, for console/org keys.
 *
 * Both inputs are `type="password"`, both send their value main-ward only, and both read back a
 * masked status. Nothing in this component can display a stored credential — there is no bridge call
 * that returns one.
 *
 * Presentation (M8b.3 surface 4, ui-design-audit.md §4.8): the credential fields are the `Input`
 * primitive — `bg-field border-line-strong`, the fix for U1, where the field was painted the same
 * `chrome` as the panel around it (1.00:1) on the one control a user pastes a secret into. Save
 * token is `Button` `primary`, Save key `secondary`, the two Remove links `link` (accent, not muted
 * grey); the status card is a `surface-sunken` well; the error and the endpoint warning are
 * `Notice`s, whose `border-warning` closes U16 (`amber-500/50`, 1.45:1).
 */

import { useCallback, useEffect, useState, type ChangeEvent, type JSX } from 'react'
import {
  describeAuthStatus,
  maskedSuffix,
  SETUP_TOKEN_COMMAND,
  type AuthStatus,
} from '../../../../shared/agent/auth'
import { describeEndpointWarning } from '../../../../shared/agent/endpoint'
import { Button, Input, Notice, PanelHeading } from '../../components/ui'
import { getAgentBridge } from '../chat/agentClient'
import { useAuthStore } from '../../stores/authStore'

export type AuthTabProps = {
  status: AuthStatus
  /** Lets the dialog's dirty guard know a credential is half-typed. */
  onDirtyChange: (dirty: boolean) => void
}

export function AuthTab({ status, onDirtyChange }: AuthTabProps): JSX.Element {
  const setStatus = useAuthStore((state) => state.setStatus)
  const bridge = getAgentBridge()

  const [token, setToken] = useState('')
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // One dirty signal for both inputs — the dialog only needs "is anything unsaved".
  useEffect(() => {
    onDirtyChange(token.trim().length > 0 || key.trim().length > 0)
  }, [token, key, onDirtyChange])

  const run = useCallback(
    async (action: () => Promise<AuthStatus>, clear: () => void): Promise<void> => {
      setBusy(true)
      setError(null)
      try {
        setStatus(await action())
        clear()
      } catch (cause) {
        // Surfaced verbatim: the vault's own errors ("OS encryption is unavailable…", "The API key
        // is empty or malformed.") are already user-facing sentences, and inventing a generic
        // message here would hide the one case the user can actually act on.
        setError(cause instanceof Error ? cause.message : String(cause))
      } finally {
        setBusy(false)
      }
    },
    [setStatus],
  )

  const saveToken = useCallback(() => {
    if (bridge === undefined) return
    void run(
      async () => bridge.setSubscriptionToken(token),
      () => {
        setToken('')
      },
    )
  }, [bridge, run, token])

  const removeToken = useCallback(() => {
    if (bridge === undefined) return
    void run(
      async () => bridge.clearSubscriptionToken(),
      () => undefined,
    )
  }, [bridge, run])

  const saveKey = useCallback(() => {
    if (bridge === undefined) return
    void run(
      async () => {
        await bridge.setApiKey(key)
        // `agent:setKey` answers with only the key slot; re-read both so the active mode is right.
        return bridge.getAuthStatus()
      },
      () => {
        setKey('')
      },
    )
  }, [bridge, run, key])

  const removeKey = useCallback(() => {
    if (bridge === undefined) return
    void run(
      async () => {
        await bridge.clearApiKey()
        return bridge.getAuthStatus()
      },
      () => undefined,
    )
  }, [bridge, run])

  // Stable identities: an inline arrow would be a new prop every keystroke.
  const onTokenChange = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    setToken(event.target.value)
  }, [])

  const onKeyChange = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    setKey(event.target.value)
  }, [])

  const subscriptionActive = status.mode === 'subscription'
  // Non-null only when ANTHROPIC_BASE_URL redirects requests away from Anthropic. Rendered ABOVE
  // both inputs, because the point is to be seen *before* a credential is pasted, not after.
  const endpointWarning = describeEndpointWarning(status.endpoint)

  return (
    <div className="flex flex-col gap-6">
      <section
        aria-labelledby="settings-auth-current"
        className="flex flex-col gap-1 rounded-panel bg-surface-sunken px-4 py-3"
      >
        <PanelHeading id="settings-auth-current">Status</PanelHeading>
        <p className="text-ui text-text" data-testid="auth-status">
          {describeAuthStatus(status)}
        </p>
        {status.mode === 'subscription' && status.apiKey.configured ? (
          <p className="text-caption text-text-muted">
            An API key is also stored {maskedSuffix(status.apiKey)}. Remove the subscription token
            to use it instead.
          </p>
        ) : null}
      </section>

      {error !== null ? (
        // `alert`: the save the user just asked for did not happen, and they are about to move on.
        <Notice tone="danger" role="alert" icon="⚠">
          {error}
        </Notice>
      ) : null}

      {endpointWarning !== null ? (
        // `alert` rather than the primitive's polite default: this is the one notice that must be
        // heard before the next keystroke, because the next keystroke may be a pasted credential.
        <Notice tone="warning" role="alert" icon="⚠">
          <span data-testid="auth-endpoint-warning">{endpointWarning}</span>
        </Notice>
      ) : null}

      {/* --- preferred path ------------------------------------------------------------------- */}
      <section aria-labelledby="settings-auth-subscription" className="flex flex-col gap-2">
        <h3 id="settings-auth-subscription" className="text-ui font-semibold text-text">
          Sign in with your Claude subscription
        </h3>
        <p className="text-ui-sm text-text-muted">
          Recommended for Pro, Max, Team, and Enterprise plans — usage counts against your
          subscription instead of pay-as-you-go API billing. Run this in a terminal, then paste the
          token it prints:
        </p>
        <code className="w-fit rounded-control bg-surface-sunken px-2 py-1 font-mono text-ui-sm text-text">
          {SETUP_TOKEN_COMMAND}
        </code>

        <label htmlFor="settings-subscription-token" className="sr-only">
          Claude subscription token
        </label>
        <div className="flex gap-2">
          <Input
            id="settings-subscription-token"
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder="sk-ant-oat01-…"
            value={token}
            disabled={busy}
            onChange={onTokenChange}
          />
          <Button
            variant="primary"
            onClick={saveToken}
            disabled={busy || token.trim().length === 0}
          >
            Save token
          </Button>
        </div>

        {status.subscription.configured ? (
          <div>
            <Button variant="link" onClick={removeToken} disabled={busy}>
              Remove subscription token
            </Button>
          </div>
        ) : null}
      </section>

      {/* --- fallback ------------------------------------------------------------------------- */}
      <section aria-labelledby="settings-auth-key" className="flex flex-col gap-2">
        <h3 id="settings-auth-key" className="text-ui font-semibold text-text">
          Or use an API key
        </h3>
        <p className="text-ui-sm text-text-muted">
          Billed per token to your Anthropic Console account.
          {subscriptionActive
            ? ' Currently inactive — the subscription token takes precedence.'
            : ''}
        </p>

        <label htmlFor="settings-api-key" className="sr-only">
          Anthropic API key
        </label>
        <div className="flex gap-2">
          <Input
            id="settings-api-key"
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder="sk-ant-…"
            value={key}
            disabled={busy}
            onChange={onKeyChange}
          />
          <Button onClick={saveKey} disabled={busy || key.trim().length === 0}>
            Save key
          </Button>
        </div>

        {status.apiKey.configured ? (
          <div>
            <Button variant="link" onClick={removeKey} disabled={busy}>
              Remove API key
            </Button>
          </div>
        ) : null}
      </section>

      <p className="text-caption text-text-muted">
        Credentials are encrypted with your OS keychain and leave this machine only as requests to
        the configured Anthropic endpoint.
      </p>
    </div>
  )
}
