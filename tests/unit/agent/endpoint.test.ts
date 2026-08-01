/**
 * Where the credential goes (M2.7 round 2).
 *
 * `ANTHROPIC_BASE_URL` is deliberately NOT stripped — corporate-gateway routing is a deployment shape
 * §4 plans for, and deleting it would replace a working setup with an opaque failure. The defect the
 * review found was that it was *invisible* while the Auth tab promised credentials only ever reach
 * Anthropic. These tests pin the visibility that replaces that promise.
 */

import { describe, expect, it } from 'vitest'
import {
  DEFAULT_API_BASE_URL,
  DEFAULT_ENDPOINT,
  describeAgentEndpoint,
  describeEndpoint,
  describeEndpointWarning,
  readEnvVar,
} from '../../../src/shared/agent/endpoint'

describe('describeEndpoint', () => {
  it('reports the default when unset', () => {
    expect(describeEndpoint(undefined)).toEqual(DEFAULT_ENDPOINT)
    expect(describeEndpoint(null)).toEqual(DEFAULT_ENDPOINT)
    expect(describeEndpoint('')).toEqual(DEFAULT_ENDPOINT)
    expect(describeEndpoint('   ')).toEqual(DEFAULT_ENDPOINT)
  })

  it('treats an explicit default as not-custom, so no pointless warning appears', () => {
    expect(describeEndpoint(DEFAULT_API_BASE_URL)).toEqual(DEFAULT_ENDPOINT)
    expect(describeEndpoint('https://api.anthropic.com/')).toEqual(DEFAULT_ENDPOINT)
  })

  it('flags a proxy and reports its origin', () => {
    expect(describeEndpoint('https://litellm.corp.internal/v1')).toEqual({
      custom: true,
      host: 'https://litellm.corp.internal',
      transport: 'network',
    })
  })

  it('flags a non-default port or scheme', () => {
    expect(describeEndpoint('http://localhost:4000')).toEqual({
      custom: true,
      host: 'http://localhost:4000',
      transport: 'network',
    })
  })

  /**
   * A base URL may legitimately carry userinfo. Echoing it back would leak a credential through the
   * very channel this milestone exists to keep clean, so we reduce to origin.
   */
  it('strips userinfo — a password in the base URL must not reach the renderer', () => {
    const info = describeEndpoint('https://user:hunter2@proxy.internal/v1')
    expect(info).toEqual({ custom: true, host: 'https://proxy.internal', transport: 'network' })
    expect(JSON.stringify(info)).not.toContain('hunter2')
  })

  it('reports an unparseable value as custom with no host rather than swallowing it', () => {
    // The CLI will still use it, so the user must still be warned; we just cannot name the target.
    expect(describeEndpoint('not a url')).toEqual({
      custom: true,
      host: null,
      transport: 'network',
    })
  })

  /**
   * `URL.origin` returns the *string* "null" for opaque-origin schemes, which rendered as
   * "Requests are routed to null" — reading as a bug in the one sentence whose job is to warn.
   */
  it.each(['file:///etc/passwd', 'data:text/html,<b>hi', 'javascript:alert(1)'])(
    'normalises the opaque origin of %s to an unknown host, still warning',
    (value) => {
      const info = describeEndpoint(value)
      expect(info).toEqual({ custom: true, host: null, transport: 'network' })
      expect(describeEndpointWarning(info)).not.toContain('null')
    },
  )
})

describe('describeEndpointWarning', () => {
  it('is silent on the default endpoint', () => {
    expect(describeEndpointWarning(DEFAULT_ENDPOINT)).toBeNull()
  })

  it('names the host and says credentials go there', () => {
    const text = describeEndpointWarning({
      custom: true,
      host: 'https://proxy.internal',
      transport: 'network',
    })
    expect(text).toContain('https://proxy.internal')
    expect(text).toMatch(/credentials/i)
  })

  it('still warns when the host is unknown', () => {
    expect(describeEndpointWarning({ custom: true, host: null, transport: 'network' })).toMatch(
      /custom endpoint/i,
    )
  })

  it('names the socket rather than a host when the transport is intercepted', () => {
    const text = describeEndpointWarning({ custom: true, host: null, transport: 'unix-socket' })
    expect(text).toMatch(/local socket/i)
    expect(text).not.toContain('null')
  })
})

/**
 * The authoritative disclosure: derived from the environment the subprocess actually receives, so
 * the UI's claim and the child's behaviour cannot drift (round 2 read `process.env` separately and
 * missed the socket transport entirely as a result).
 */
describe('describeAgentEndpoint', () => {
  it('reports the default for an allow-listed env with no redirect', () => {
    expect(describeAgentEndpoint({ PATH: '/usr/bin', HOME: '/home/u' })).toEqual(DEFAULT_ENDPOINT)
  })

  it('reports the base URL when one is present', () => {
    expect(describeAgentEndpoint({ ANTHROPIC_BASE_URL: 'https://proxy.internal' })).toEqual({
      custom: true,
      host: 'https://proxy.internal',
      transport: 'network',
    })
  })

  /**
   * Transport wins: under a socket the CLI never consults the base URL, so reporting the URL would
   * be actively misleading. Unreachable while the allow-list excludes the socket — this is the guard
   * that keeps the UI honest if it is ever deliberately admitted.
   */
  it('reports the socket transport ahead of any base URL', () => {
    expect(
      describeAgentEndpoint({
        ANTHROPIC_UNIX_SOCKET: '/tmp/s.sock',
        ANTHROPIC_BASE_URL: 'https://api.anthropic.com',
      }),
    ).toEqual({ custom: true, host: null, transport: 'unix-socket' })
  })

  it('ignores an empty socket value', () => {
    expect(describeAgentEndpoint({ ANTHROPIC_UNIX_SOCKET: '  ' })).toEqual(DEFAULT_ENDPOINT)
  })
})

/**
 * Admission and consumption must agree about casing.
 *
 * `allowedEnv` matches the allow-list case-insensitively (Windows names vary) and preserves the
 * caller's original casing, so an ambient `anthropic_base_url` is admitted and handed to the child —
 * where Windows, whose env lookup is case-insensitive, honours it. Round 3 read it back
 * case-sensitively, so the child was redirected while the UI reported the default and rendered no
 * warning: the exact invariant the design rests on (admitted ONLY because disclosed), broken.
 *
 * Mutation check: revert either read in `describeAgentEndpoint` to `env['NAME']` and the lowercase
 * and mixed-case cases red.
 */
describe('describeAgentEndpoint — casing', () => {
  it.each([
    ['canonical (control)', 'ANTHROPIC_BASE_URL'],
    ['lowercase', 'anthropic_base_url'],
    ['mixed case', 'Anthropic_Base_Url'],
  ])('discloses a redirect declared in %s', (_label, key) => {
    const info = describeAgentEndpoint({ [key]: 'https://evil.test' })
    expect(info).toEqual({ custom: true, host: 'https://evil.test', transport: 'network' })
    expect(describeEndpointWarning(info)).toContain('https://evil.test')
  })

  it.each(['ANTHROPIC_UNIX_SOCKET', 'anthropic_unix_socket', 'Anthropic_Unix_Socket'])(
    'discloses a socket declared as %s',
    (key) => {
      expect(describeAgentEndpoint({ [key]: '/tmp/s.sock' }).transport).toBe('unix-socket')
    },
  )

  /**
   * Two keys differing only in case are distinct on Linux and both survive admission. Reporting the
   * first would let a harmless canonical value mask a hostile lowercase one.
   */
  it('reports the alarming variant when two casings disagree', () => {
    const info = describeAgentEndpoint({
      ANTHROPIC_BASE_URL: 'https://api.anthropic.com',
      anthropic_base_url: 'https://evil.test',
    })
    expect(info.custom).toBe(true)
    expect(info.host).toBe('https://evil.test')
  })

  it('stays quiet when every casing is the default endpoint', () => {
    expect(
      describeAgentEndpoint({
        ANTHROPIC_BASE_URL: 'https://api.anthropic.com',
        anthropic_base_url: 'https://api.anthropic.com/',
      }),
    ).toEqual(DEFAULT_ENDPOINT)
  })
})

describe('readEnvVar', () => {
  it('finds a canonical key directly', () => {
    expect(readEnvVar({ PATH: '/usr/bin' }, 'PATH')).toBe('/usr/bin')
  })

  it('finds a differently-cased key', () => {
    expect(readEnvVar({ Path: 'C:\\Windows' }, 'PATH')).toBe('C:\\Windows')
  })

  it('returns undefined when absent', () => {
    expect(readEnvVar({ HOME: '/home/u' }, 'PATH')).toBeUndefined()
  })
})
