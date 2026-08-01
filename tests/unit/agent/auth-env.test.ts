/**
 * The subprocess environment boundary (M2.7, round 3).
 *
 * Rounds 1–2 pinned a deny-list variable by variable, and both times the next review found a layer
 * nobody had enumerated — credential, then provider, then transport. A test that asserts "these
 * known-bad names are absent" cannot fail when the list is *incomplete*, which is exactly how each
 * gap shipped green.
 *
 * So this file tests the boundary the way M4.3's safe-pptx test does: seed the parent environment
 * with every hostile variable we can name **plus invented ones nobody has enumerated**, and assert
 * the built environment contains *only* allow-listed keys. The invented names are the point — the
 * guard has to reject what no list mentions.
 */

import { describe, expect, it } from 'vitest'
import {
  allowedEnv,
  buildAuthEnv,
  INHERITED_ENV_ALLOW,
  isInheritedEnvVar,
  type AgentCredential,
} from '../../../src/main/agent/auth-env'

const SUBSCRIPTION: AgentCredential = { kind: 'subscription', value: 'sk-ant-oat01-test' }
const API_KEY: AgentCredential = { kind: 'api-key', value: 'sk-ant-api-test' }

/**
 * The CLI's real provider-sanitisation array, extracted verbatim from the bundled binary 2.1.220.
 * Fourteen entries — not the six-entry `THIRD_PARTY_PROVIDER_LABELS` display map an earlier round
 * mistook for it. `CLAUDE_CODE_USE_GATEWAY` is the one that mattered.
 */
const CLI_PROVIDER_SANITISATION_ARRAY = [
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_USE_ANTHROPIC_AWS',
  'CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD',
  'CLAUDE_CODE_USE_MANTLE',
  'CLAUDE_CODE_USE_GATEWAY',
  'ANTHROPIC_FOUNDRY_RESOURCE',
  'ANTHROPIC_VERTEX_PROJECT_ID',
  'ANTHROPIC_AWS_WORKSPACE_ID',
  'ANTHROPIC_GOOGLE_CLOUD_PROJECT',
  'ANTHROPIC_GOOGLE_CLOUD_LOCATION',
  'ANTHROPIC_GOOGLE_CLOUD_WORKSPACE_ID',
  'CLOUD_ML_REGION',
] as const

/** Everything else known to redirect a request, carry a credential, or select a transport. */
const OTHER_HOSTILE_VARS = [
  // credential carriers
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR',
  'CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR',
  'ANTHROPIC_CUSTOM_HEADERS',
  // transport — the round-3 blocker
  'ANTHROPIC_UNIX_SOCKET',
  // per-provider auth skips
  'CLAUDE_CODE_SKIP_BEDROCK_AUTH',
  'CLAUDE_CODE_SKIP_VERTEX_AUTH',
  'CLAUDE_CODE_SKIP_FOUNDRY_AUTH',
  'CLAUDE_CODE_SKIP_MANTLE_AUTH',
  'CLAUDE_CODE_SKIP_ANTHROPIC_AWS_AUTH',
  'CLAUDE_CODE_SKIP_ANTHROPIC_GOOGLE_CLOUD_AUTH',
  // third-party and proxy endpoints
  'ANTHROPIC_BEDROCK_BASE_URL',
  'ANTHROPIC_BEDROCK_MANTLE_BASE_URL',
  'ANTHROPIC_VERTEX_BASE_URL',
  'ANTHROPIC_FOUNDRY_BASE_URL',
  'ANTHROPIC_AWS_BASE_URL',
  'ANTHROPIC_GOOGLE_CLOUD_BASE_URL',
  'CLAUDE_GATEWAY_ALLOW_LOOPBACK',
  'CLAUDE_CODE_PROXY_URL',
  'CLAUDE_CODE_API_BASE_URL',
  // mTLS material
  'CLAUDE_CODE_CLIENT_CERT',
  'CLAUDE_CODE_CLIENT_KEY',
  'CLAUDE_CODE_CLIENT_KEY_PASSPHRASE',
] as const

/**
 * Names nobody has enumerated. These stand in for whatever Anthropic ships next release, and they
 * are the reason this is a boundary test rather than another audit: a deny-list cannot fail these.
 */
const UNENUMERATED_VARS = [
  'ANTHROPIC_FUTURE_THING',
  'CLAUDE_CODE_USE_SOMETHING_NEW',
  'ANTHROPIC_SEND_CREDENTIAL_TO',
  'CLAUDE_CODE_TRANSPORT_V2',
  'TOTALLY_MADE_UP_VARIABLE',
] as const

const ALL_HOSTILE: readonly string[] = [
  ...CLI_PROVIDER_SANITISATION_ARRAY,
  ...OTHER_HOSTILE_VARS,
  ...UNENUMERATED_VARS,
]

/** A parent environment seeded with every hostile name plus a plausible set of benign ones. */
function hostileBaseEnv(): Record<string, string> {
  const base: Record<string, string> = {
    PATH: '/usr/bin:/bin',
    HOME: '/home/u',
    LANG: 'C.UTF-8',
    TMPDIR: '/tmp',
  }
  for (const name of ALL_HOSTILE) base[name] = 'hostile-value'
  return base
}

describe('the environment boundary', () => {
  it('sanity: the fixture really does seed every hostile name', () => {
    const base = hostileBaseEnv()
    for (const name of ALL_HOSTILE) expect(base[name]).toBe('hostile-value')
    expect(CLI_PROVIDER_SANITISATION_ARRAY).toHaveLength(14)
  })

  /**
   * THE test. Everything not on the allow-list is absent — including names no list mentions.
   *
   * Mutation check: replace `allowedEnv`'s filter with a plain spread and this fails on dozens of
   * keys at once.
   */
  it.each([
    ['subscription', SUBSCRIPTION, 'CLAUDE_CODE_OAUTH_TOKEN'],
    ['api-key', API_KEY, 'ANTHROPIC_API_KEY'],
  ] as const)(
    'admits ONLY allow-listed keys plus the %s credential',
    (_label, credential, credentialVar) => {
      const env = buildAuthEnv(hostileBaseEnv(), credential)
      const unexpected = Object.keys(env).filter(
        (key) => key !== credentialVar && !isInheritedEnvVar(key),
      )
      expect(unexpected).toEqual([])
      expect(env[credentialVar]).toBe(credential.value)
    },
  )

  it('drops every one of the CLI’s 14 provider-sanitisation variables', () => {
    const env = buildAuthEnv(hostileBaseEnv(), SUBSCRIPTION)
    for (const name of CLI_PROVIDER_SANITISATION_ARRAY) expect(name in env).toBe(false)
  })

  it('drops CLAUDE_CODE_USE_GATEWAY specifically — it is a real env-driven provider', () => {
    // An earlier round exempted gateway on the false premise that its predicate was in-memory only.
    const env = buildAuthEnv({ CLAUDE_CODE_USE_GATEWAY: '1' }, SUBSCRIPTION)
    expect('CLAUDE_CODE_USE_GATEWAY' in env).toBe(false)
  })

  it('drops ANTHROPIC_UNIX_SOCKET — the transport layer below the URL', () => {
    // It rewrites every request before URL handling AND short-circuits the bearer check to true, so
    // it would receive the pasted token regardless of the base URL.
    const env = buildAuthEnv({ ANTHROPIC_UNIX_SOCKET: '/tmp/evil.sock' }, SUBSCRIPTION)
    expect('ANTHROPIC_UNIX_SOCKET' in env).toBe(false)
  })

  it('drops names nobody enumerated', () => {
    const env = buildAuthEnv(hostileBaseEnv(), SUBSCRIPTION)
    for (const name of UNENUMERATED_VARS) expect(name in env).toBe(false)
  })

  it('leaves no ambient credential able to outrank the pasted token', () => {
    const env = buildAuthEnv(hostileBaseEnv(), SUBSCRIPTION)
    // The original round-1 precedence bug, still pinned: ANTHROPIC_API_KEY outranks the OAuth token.
    expect('ANTHROPIC_API_KEY' in env).toBe(false)
    expect('ANTHROPIC_AUTH_TOKEN' in env).toBe(false)
    expect(env['CLAUDE_CODE_OAUTH_TOKEN']).toBe('sk-ant-oat01-test')
  })

  it('never leaves both credential variables set at once', () => {
    for (const credential of [API_KEY, SUBSCRIPTION]) {
      const env = buildAuthEnv(hostileBaseEnv(), credential)
      const present = ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'].filter((n) => n in env)
      expect(present).toHaveLength(1)
    }
  })
})

describe('what the allow-list admits', () => {
  it('keeps the OS essentials a child process needs', () => {
    const env = buildAuthEnv(hostileBaseEnv(), SUBSCRIPTION)
    expect(env['PATH']).toBe('/usr/bin:/bin')
    expect(env['HOME']).toBe('/home/u')
    expect(env['LANG']).toBe('C.UTF-8')
    expect(env['TMPDIR']).toBe('/tmp')
  })

  it('matches case-insensitively, because Windows names vary in casing', () => {
    const env = allowedEnv({ Path: 'C:\\Windows', SystemRoot: 'C:\\Windows', TeMp: 'C:\\T' })
    // Original casing is preserved — the child should see the names as the OS wrote them.
    expect(env['Path']).toBe('C:\\Windows')
    expect(env['SystemRoot']).toBe('C:\\Windows')
    expect(env['TeMp']).toBe('C:\\T')
  })

  it('keeps proxy and CA settings, a deliberate entry for corporate reachability', () => {
    const env = allowedEnv({
      HTTPS_PROXY: 'http://proxy:8080',
      NO_PROXY: 'localhost',
      NODE_EXTRA_CA_CERTS: '/etc/ca.pem',
    })
    expect(env['HTTPS_PROXY']).toBe('http://proxy:8080')
    expect(env['NO_PROXY']).toBe('localhost')
    expect(env['NODE_EXTRA_CA_CERTS']).toBe('/etc/ca.pem')
  })

  it('keeps ANTHROPIC_BASE_URL — admitted only because it is disclosed in the UI', () => {
    const env = allowedEnv({ ANTHROPIC_BASE_URL: 'https://proxy.internal' })
    expect(env['ANTHROPIC_BASE_URL']).toBe('https://proxy.internal')
  })

  it('admits no credential, provider, or transport variable by inheritance', () => {
    // The allow-list itself must stay clean: if one of these ever appeared in it, the boundary test
    // above would keep passing while the hole reopened.
    for (const name of ALL_HOSTILE) expect(INHERITED_ENV_ALLOW).not.toContain(name)
  })

  it('drops undefined values rather than stringifying them', () => {
    // `spawn` turns an `undefined` value into the literal string "undefined".
    expect('PATH' in allowedEnv({ PATH: undefined })).toBe(false)
  })
})
