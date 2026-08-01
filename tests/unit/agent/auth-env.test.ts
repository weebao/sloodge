/**
 * The credential-environment guard (M2.7).
 *
 * These are the tests that stop us silently billing the wrong account. The CLI's precedence puts
 * `ANTHROPIC_API_KEY` ABOVE `CLAUDE_CODE_OAUTH_TOKEN`, and `buildAuthEnv` spreads `process.env` —
 * so "set the token" without "delete the key" would leave an ambient key quietly winning while the
 * UI says "using your Claude subscription".
 */

import { describe, expect, it } from 'vitest'
import {
  buildAuthEnv,
  STRIPPED_ENV_VARS,
  THIRD_PARTY_PROVIDER_ENV_VARS,
  type AgentCredential,
} from '../../../src/main/agent/auth-env'

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

/**
 * Layer 1: provider selection, which the CLI evaluates BEFORE any credential logic.
 *
 * `getAPIProvider()` in the bundled CLI 2.1.220 is env-only and never consults
 * `CLAUDE_CODE_OAUTH_TOKEN`; a sibling gate forces the OAuth path off under any third-party
 * provider, and the Bedrock branch nulls `Authorization` and authenticates with AWS instead. So an
 * ambient provider switch does not merely change routing — it makes the credential the user chose in
 * Settings unused, while the UI still says it is in use.
 */
describe('provider pinning', () => {
  it('exports exactly the six switches the CLI uses to select a provider', () => {
    // Mirrors the CLI's own exported THIRD_PARTY_PROVIDER_ENV_VARS map. `gateway` is absent on
    // purpose: its predicate reads in-memory login state, not the environment.
    expect(THIRD_PARTY_PROVIDER_ENV_VARS.toSorted()).toEqual(
      [
        'CLAUDE_CODE_USE_ANTHROPIC_AWS',
        'CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD',
        'CLAUDE_CODE_USE_BEDROCK',
        'CLAUDE_CODE_USE_FOUNDRY',
        'CLAUDE_CODE_USE_MANTLE',
        'CLAUDE_CODE_USE_VERTEX',
      ].toSorted(),
    )
  })

  /**
   * The blocker this round fixed, pinned per-variable and for BOTH credential kinds.
   *
   * Mutation check: drop any one name from PROVIDER_ENV_VARS and the matching case fails.
   */
  it.each([...THIRD_PARTY_PROVIDER_ENV_VARS])(
    'deletes %s so an ambient switch cannot route the subscription token to a 3P provider',
    (providerVar) => {
      const env = buildAuthEnv({ [providerVar]: '1', PATH: '/usr/bin' }, SUBSCRIPTION)
      expect(providerVar in env).toBe(false)
      // …and the token is still the credential that survives.
      expect(env['CLAUDE_CODE_OAUTH_TOKEN']).toBe('sk-ant-oat01-test')
      expect(env['PATH']).toBe('/usr/bin')
    },
  )

  it.each([...THIRD_PARTY_PROVIDER_ENV_VARS])(
    'deletes %s for an api-key session too',
    (providerVar) => {
      const env = buildAuthEnv({ [providerVar]: 'true' }, API_KEY)
      expect(providerVar in env).toBe(false)
    },
  )

  it('routes firstParty even when every provider switch is set at once', () => {
    const ambient: Record<string, string> = { PATH: '/usr/bin' }
    for (const name of THIRD_PARTY_PROVIDER_ENV_VARS) ambient[name] = '1'
    const env = buildAuthEnv(ambient, SUBSCRIPTION)
    // Nothing left for getAPIProvider() to match on -> its final `: "firstParty"` branch.
    for (const name of THIRD_PARTY_PROVIDER_ENV_VARS) expect(name in env).toBe(false)
    expect(env['CLAUDE_CODE_OAUTH_TOKEN']).toBe('sk-ant-oat01-test')
  })

  it('deletes rather than neutralises — no provider switch is left set to a falsy string', () => {
    // "0" would work against today's zod boolean coercion, but deletion does not depend on that
    // parser staying as it is, and it matches the CLI's own sibling-disabling helper (`void 0`).
    const ambient: Record<string, string> = {}
    for (const name of THIRD_PARTY_PROVIDER_ENV_VARS) ambient[name] = '1'
    const env = buildAuthEnv(ambient, SUBSCRIPTION)
    for (const name of THIRD_PARTY_PROVIDER_ENV_VARS) expect(env[name]).toBeUndefined()
  })

  it('strips the per-provider auth-skip and third-party base-URL siblings', () => {
    const ambient = {
      CLAUDE_CODE_SKIP_BEDROCK_AUTH: '1',
      CLAUDE_CODE_SKIP_VERTEX_AUTH: '1',
      ANTHROPIC_BEDROCK_BASE_URL: 'https://bedrock.internal',
      ANTHROPIC_VERTEX_BASE_URL: 'https://vertex.internal',
    }
    const env = buildAuthEnv(ambient, SUBSCRIPTION)
    for (const name of Object.keys(ambient)) expect(name in env).toBe(false)
  })

  it('strips ANTHROPIC_CUSTOM_HEADERS, which can inject an Authorization header', () => {
    const env = buildAuthEnv(
      { ANTHROPIC_CUSTOM_HEADERS: 'Authorization: Bearer attacker-token' },
      SUBSCRIPTION,
    )
    expect('ANTHROPIC_CUSTOM_HEADERS' in env).toBe(false)
  })

  it('removes every declared variable in one sweep', () => {
    const ambient = Object.fromEntries(STRIPPED_ENV_VARS.map((name) => [name, 'x']))
    const env = buildAuthEnv({ ...ambient, PATH: '/usr/bin' }, SUBSCRIPTION)
    const survivors = STRIPPED_ENV_VARS.filter(
      (name) => name in env && name !== 'CLAUDE_CODE_OAUTH_TOKEN',
    )
    expect(survivors).toEqual([])
  })
})
