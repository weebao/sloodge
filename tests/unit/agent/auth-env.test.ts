/**
 * The credential-environment guard (M2.7).
 *
 * These are the tests that stop us silently billing the wrong account. The CLI's precedence puts
 * `ANTHROPIC_API_KEY` ABOVE `CLAUDE_CODE_OAUTH_TOKEN`, and `buildAuthEnv` spreads `process.env` —
 * so "set the token" without "delete the key" would leave an ambient key quietly winning while the
 * UI says "using your Claude subscription".
 */

import { describe, expect, it } from 'vitest'
import { buildAuthEnv, type AgentCredential } from '../../../src/main/agent/auth-env'

const SUBSCRIPTION: AgentCredential = { kind: 'subscription', value: 'sk-ant-oat01-test' }
const API_KEY: AgentCredential = { kind: 'api-key', value: 'sk-ant-api-test' }

describe('buildAuthEnv', () => {
  it('keeps the ambient environment so the subprocess retains PATH and HOME', () => {
    // The TS SDK's `env` REPLACES the environment; dropping the spread costs the child its PATH.
    const env = buildAuthEnv({ PATH: '/usr/bin', HOME: '/home/u' }, API_KEY)
    expect(env['PATH']).toBe('/usr/bin')
    expect(env['HOME']).toBe('/home/u')
  })

  it('drops undefined values rather than stringifying them', () => {
    // `spawn` turns an `undefined` value into the literal string "undefined".
    const env = buildAuthEnv({ PATH: '/usr/bin', EMPTY: undefined }, API_KEY)
    expect('EMPTY' in env).toBe(false)
  })

  describe('api-key credential', () => {
    it('sets ANTHROPIC_API_KEY', () => {
      expect(buildAuthEnv({}, API_KEY)['ANTHROPIC_API_KEY']).toBe('sk-ant-api-test')
    })

    it('removes an inherited subscription token so the two cannot both be live', () => {
      const env = buildAuthEnv({ CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-ambient' }, API_KEY)
      expect('CLAUDE_CODE_OAUTH_TOKEN' in env).toBe(false)
    })
  })

  describe('subscription credential', () => {
    it('sets CLAUDE_CODE_OAUTH_TOKEN', () => {
      expect(buildAuthEnv({}, SUBSCRIPTION)['CLAUDE_CODE_OAUTH_TOKEN']).toBe('sk-ant-oat01-test')
    })

    /**
     * The load-bearing one. `ANTHROPIC_API_KEY` outranks `CLAUDE_CODE_OAUTH_TOKEN`, so an ambient key
     * inherited from the user's shell would hijack the session. Deleting it — not merely declining to
     * set it — is what makes the subscription choice real.
     *
     * Mutation check: change `delete env[name]` in auth-env.ts to a no-op, or drop
     * `ANTHROPIC_API_KEY` from `CREDENTIAL_ENV_VARS`, and this fails.
     */
    it('DELETES an ambient ANTHROPIC_API_KEY that would otherwise outrank the token', () => {
      const env = buildAuthEnv(
        { ANTHROPIC_API_KEY: 'sk-ant-ambient-from-shell', PATH: '/usr/bin' },
        SUBSCRIPTION,
      )
      expect('ANTHROPIC_API_KEY' in env).toBe(false)
      expect(env['CLAUDE_CODE_OAUTH_TOKEN']).toBe('sk-ant-oat01-test')
      // …and the rest of the environment is untouched.
      expect(env['PATH']).toBe('/usr/bin')
    })

    it('removes every other credential source the CLI would consult first', () => {
      const env = buildAuthEnv(
        {
          ANTHROPIC_API_KEY: 'k',
          ANTHROPIC_AUTH_TOKEN: 't',
          CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR: '3',
        },
        SUBSCRIPTION,
      )
      expect('ANTHROPIC_API_KEY' in env).toBe(false)
      expect('ANTHROPIC_AUTH_TOKEN' in env).toBe(false)
      expect('CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR' in env).toBe(false)
    })

    it('leaves ANTHROPIC_BASE_URL alone — a proxy endpoint is config, not a credential', () => {
      const env = buildAuthEnv({ ANTHROPIC_BASE_URL: 'https://proxy.internal' }, SUBSCRIPTION)
      expect(env['ANTHROPIC_BASE_URL']).toBe('https://proxy.internal')
    })
  })

  it('never leaves both credential variables set at once, whichever mode is chosen', () => {
    const ambient = { ANTHROPIC_API_KEY: 'k', CLAUDE_CODE_OAUTH_TOKEN: 't' }
    for (const credential of [API_KEY, SUBSCRIPTION]) {
      const env = buildAuthEnv(ambient, credential)
      const present = ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'].filter((n) => n in env)
      expect(present).toHaveLength(1)
    }
  })
})
