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
 */

import { useCallback, useEffect, useState, type ChangeEvent, type JSX } from 'react'
import {
  describeAuthStatus,
  maskedSuffix,
  SETUP_TOKEN_COMMAND,
  type AuthStatus,
} from '../../../../shared/agent/auth'
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

  return (
    <div className="flex flex-col gap-6">
      <section
        aria-labelledby="settings-auth-current"
        className="rounded-md border border-chrome-line bg-chrome-alt px-4 py-3 dark:border-ink-line dark:bg-ink-alt"
      >
        <h3
          id="settings-auth-current"
          className="text-[11px] font-medium uppercase tracking-wide text-chrome-muted dark:text-ink-muted"
        >
          Status
        </h3>
        <p className="mt-1 text-[13px] text-shell-fg dark:text-ink-fg" data-testid="auth-status">
          {describeAuthStatus(status)}
        </p>
        {status.mode === 'subscription' && status.apiKey.configured ? (
          <p className="mt-1 text-[11px] text-chrome-muted dark:text-ink-muted">
            An API key is also stored {maskedSuffix(status.apiKey)}. Remove the subscription token
            to use it instead.
          </p>
        ) : null}
      </section>

      {error !== null ? (
        <p role="alert" className="text-[12px] text-red-600 dark:text-red-400">
          {error}
        </p>
      ) : null}

      {/* --- preferred path ------------------------------------------------------------------- */}
      <section aria-labelledby="settings-auth-subscription" className="flex flex-col gap-2">
        <h3
          id="settings-auth-subscription"
          className="text-[13px] font-semibold text-shell-fg dark:text-ink-fg"
        >
          Sign in with your Claude subscription
        </h3>
        <p className="text-[12px] text-chrome-muted dark:text-ink-muted">
          Recommended for Pro, Max, Team, and Enterprise plans — usage counts against your
          subscription instead of pay-as-you-go API billing. Run this in a terminal, then paste the
          token it prints:
        </p>
        <code className="w-fit rounded bg-chrome-alt px-2 py-1 font-mono text-[12px] text-shell-fg dark:bg-ink-alt dark:text-ink-fg">
          {SETUP_TOKEN_COMMAND}
        </code>

        <label htmlFor="settings-subscription-token" className="sr-only">
          Claude subscription token
        </label>
        <div className="flex gap-2">
          <input
            id="settings-subscription-token"
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder="sk-ant-oat01-…"
            value={token}
            disabled={busy}
            onChange={onTokenChange}
            className="min-w-0 flex-1 rounded border border-chrome-line bg-chrome px-2 py-1 text-[13px] text-shell-fg dark:border-ink-line dark:bg-ink dark:text-ink-fg"
          />
          <button
            type="button"
            onClick={saveToken}
            disabled={busy || token.trim().length === 0}
            className="rounded bg-accent px-3 py-1 text-[13px] font-medium text-white disabled:opacity-50"
          >
            Save token
          </button>
        </div>

        {status.subscription.configured ? (
          <button
            type="button"
            onClick={removeToken}
            disabled={busy}
            className="w-fit text-[12px] text-chrome-muted underline disabled:opacity-50 dark:text-ink-muted"
          >
            Remove subscription token
          </button>
        ) : null}
      </section>

      {/* --- fallback ------------------------------------------------------------------------- */}
      <section aria-labelledby="settings-auth-key" className="flex flex-col gap-2">
        <h3
          id="settings-auth-key"
          className="text-[13px] font-semibold text-shell-fg dark:text-ink-fg"
        >
          Or use an API key
        </h3>
        <p className="text-[12px] text-chrome-muted dark:text-ink-muted">
          Billed per token to your Anthropic Console account.
          {subscriptionActive
            ? ' Currently inactive — the subscription token takes precedence.'
            : ''}
        </p>

        <label htmlFor="settings-api-key" className="sr-only">
          Anthropic API key
        </label>
        <div className="flex gap-2">
          <input
            id="settings-api-key"
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder="sk-ant-…"
            value={key}
            disabled={busy}
            onChange={onKeyChange}
            className="min-w-0 flex-1 rounded border border-chrome-line bg-chrome px-2 py-1 text-[13px] text-shell-fg dark:border-ink-line dark:bg-ink dark:text-ink-fg"
          />
          <button
            type="button"
            onClick={saveKey}
            disabled={busy || key.trim().length === 0}
            className="rounded border border-chrome-line px-3 py-1 text-[13px] font-medium text-shell-fg disabled:opacity-50 dark:border-ink-line dark:text-ink-fg"
          >
            Save key
          </button>
        </div>

        {status.apiKey.configured ? (
          <button
            type="button"
            onClick={removeKey}
            disabled={busy}
            className="w-fit text-[12px] text-chrome-muted underline disabled:opacity-50 dark:text-ink-muted"
          >
            Remove API key
          </button>
        ) : null}
      </section>

      <p className="text-[11px] text-chrome-muted dark:text-ink-muted">
        Credentials are encrypted with your OS keychain and never leave this machine except as
        requests to Anthropic.
      </p>
    </div>
  )
}
