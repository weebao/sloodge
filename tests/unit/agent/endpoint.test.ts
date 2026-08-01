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
  describeEndpoint,
  describeEndpointWarning,
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
    })
  })

  it('flags a non-default port or scheme', () => {
    expect(describeEndpoint('http://localhost:4000')).toEqual({
      custom: true,
      host: 'http://localhost:4000',
    })
  })

  /**
   * A base URL may legitimately carry userinfo. Echoing it back would leak a credential through the
   * very channel this milestone exists to keep clean, so we reduce to origin.
   */
  it('strips userinfo — a password in the base URL must not reach the renderer', () => {
    const info = describeEndpoint('https://user:hunter2@proxy.internal/v1')
    expect(info).toEqual({ custom: true, host: 'https://proxy.internal' })
    expect(JSON.stringify(info)).not.toContain('hunter2')
  })

  it('reports an unparseable value as custom with no host rather than swallowing it', () => {
    // The CLI will still use it, so the user must still be warned; we just cannot name the target.
    expect(describeEndpoint('not a url')).toEqual({ custom: true, host: null })
  })
})

describe('describeEndpointWarning', () => {
  it('is silent on the default endpoint', () => {
    expect(describeEndpointWarning(DEFAULT_ENDPOINT)).toBeNull()
  })

  it('names the host and says credentials go there', () => {
    const text = describeEndpointWarning({ custom: true, host: 'https://proxy.internal' })
    expect(text).toContain('https://proxy.internal')
    expect(text).toMatch(/credentials/i)
  })

  it('still warns when the host is unknown', () => {
    expect(describeEndpointWarning({ custom: true, host: null })).toMatch(/custom endpoint/i)
  })
})
