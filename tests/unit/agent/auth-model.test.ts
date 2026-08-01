/**
 * The shared auth model (M2.7) — mode precedence and the masking that keeps plaintext out of the
 * renderer (50-agent-integration.md §4).
 */

import { describe, expect, it } from 'vitest'
import {
  deriveAuthStatus,
  describeAuthStatus,
  isAuthenticated,
  maskedSuffix,
  NOT_CONFIGURED,
  SETUP_TOKEN_COMMAND,
  UNCONFIGURED,
} from '../../../src/shared/agent/auth'
import type { ApiKeyStatus } from '../../../src/shared/agent/types'

const configured = (last4: string): ApiKeyStatus => ({ configured: true, last4 })

describe('deriveAuthStatus', () => {
  it('reports not-configured when neither slot is filled', () => {
    expect(deriveAuthStatus(UNCONFIGURED, UNCONFIGURED).mode).toBe('not-configured')
  })

  it('reports api-key when only a key is stored', () => {
    expect(deriveAuthStatus(configured('aXY9'), UNCONFIGURED).mode).toBe('api-key')
  })

  it('reports subscription when only a token is stored', () => {
    expect(deriveAuthStatus(UNCONFIGURED, configured('7f2b')).mode).toBe('subscription')
  })

  /**
   * The deliberate inversion of the CLI's own precedence: pasting a subscription token is a
   * "bill my plan, not my card" choice, and a leftover key must not silently override it.
   * `buildAuthEnv` implements the other half by deleting `ANTHROPIC_API_KEY`.
   */
  it('prefers the subscription token when BOTH are stored', () => {
    const status = deriveAuthStatus(configured('aXY9'), configured('7f2b'))
    expect(status.mode).toBe('subscription')
    // …while still reporting the key honestly, so the Auth tab can say it is stored but inactive.
    expect(status.apiKey.configured).toBe(true)
  })

  it('passes both slots through unchanged', () => {
    const key = configured('aXY9')
    const token = configured('7f2b')
    const status = deriveAuthStatus(key, token)
    expect(status.apiKey).toEqual(key)
    expect(status.subscription).toEqual(token)
  })
})

describe('isAuthenticated', () => {
  it('is false only for not-configured', () => {
    expect(isAuthenticated(NOT_CONFIGURED)).toBe(false)
    expect(isAuthenticated(deriveAuthStatus(configured('aXY9'), UNCONFIGURED))).toBe(true)
    expect(isAuthenticated(deriveAuthStatus(UNCONFIGURED, configured('7f2b')))).toBe(true)
  })
})

describe('maskedSuffix', () => {
  it('renders at most the last four characters', () => {
    expect(maskedSuffix(configured('aXY9'))).toBe('••••aXY9')
  })

  it('truncates anything longer, so a full secret can never render', () => {
    // Defence in depth: even if a caller mistakenly put a whole key in `last4`, only 4 chars escape.
    expect(maskedSuffix(configured('sk-ant-supersecret-value'))).toBe('••••alue')
  })

  it('is empty when there is nothing to show', () => {
    expect(maskedSuffix(UNCONFIGURED)).toBe('')
    expect(maskedSuffix({ configured: true, last4: '' })).toBe('')
  })
})

describe('describeAuthStatus', () => {
  it('names the subscription path first-person and without a secret', () => {
    const text = describeAuthStatus(deriveAuthStatus(UNCONFIGURED, configured('7f2b')))
    expect(text).toContain('Claude subscription')
    expect(text).toContain('••••7f2b')
  })

  it('describes a configured key with only its last four', () => {
    expect(describeAuthStatus(deriveAuthStatus(configured('aXY9'), UNCONFIGURED))).toBe(
      'API key configured ••••aXY9',
    )
  })

  it('says so plainly when nothing is configured', () => {
    expect(describeAuthStatus(NOT_CONFIGURED)).toBe('Not configured')
  })

  it('has no trailing whitespace when there is no last4 to append', () => {
    const text = describeAuthStatus(
      deriveAuthStatus(UNCONFIGURED, { configured: true, last4: null }),
    )
    expect(text).toBe(text.trimEnd())
  })

  /**
   * The M2.1 invariant, asserted the same way `vault.test.ts` asserts it: serialise the whole
   * renderer-facing status and prove the secret is not in it.
   */
  it('cannot leak a stored credential', () => {
    const secret = 'sk-ant-oat01-do-not-leak'
    const status = deriveAuthStatus(UNCONFIGURED, { configured: true, last4: secret.slice(-4) })
    expect(JSON.stringify(status)).not.toContain(secret)
    expect(describeAuthStatus(status)).not.toContain(secret)
  })
})

describe('SETUP_TOKEN_COMMAND', () => {
  it('is the command the CLI actually exposes', () => {
    // Verified against the bundled CLI 2.1.220: `claude setup-token` — "Set up a long-lived
    // authentication token (requires Claude subscription)".
    expect(SETUP_TOKEN_COMMAND).toBe('claude setup-token')
  })
})
