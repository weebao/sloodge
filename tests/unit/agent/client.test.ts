import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * `client.ts` is the one file that imports the Agent SDK and applies the isolation levers of
 * 50-agent-integration.md §5. Both the SDK and `electron` are mocked so the security-critical
 * `Options` shape can be asserted without a subprocess — the same `vi.mock` discipline M2.0 used for
 * the protocol wiring.
 */
const mocks = vi.hoisted(() => ({
  query: vi.fn((_params: { prompt: unknown; options: unknown }) => ({ marker: 'handle' })),
}))

vi.mock('electron', () => ({ app: { getPath: () => '/userData' } }))
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: mocks.query }))

const { buildSdkOptions, defaultAgentPaths, realQuery } =
  await import('../../../src/main/agent/client')
const { DEFAULT_AGENT_MODEL } = await import('../../../src/shared/agent/types')

const OPTIONS = {
  apiKey: 'sk-ant-secret',
  model: DEFAULT_AGENT_MODEL,
  cwd: '/userData/agent/workspace',
  configDir: '/userData/agent/claude',
} as const

beforeEach(() => {
  mocks.query.mockClear()
})

describe('buildSdkOptions — isolation invariants (§5)', () => {
  it('loads only the project settings source, never the user ambient config', () => {
    expect(buildSdkOptions(OPTIONS).settingSources).toEqual(['project'])
  })

  it('ignores any on-disk .mcp.json', () => {
    expect(buildSdkOptions(OPTIONS).strictMcpConfig).toBe(true)
  })

  it('spreads process.env and redirects config + disables auto-memory', () => {
    const env = buildSdkOptions(OPTIONS).env ?? {}
    expect(env['ANTHROPIC_API_KEY']).toBe('sk-ant-secret')
    expect(env['CLAUDE_CONFIG_DIR']).toBe('/userData/agent/claude')
    expect(env['CLAUDE_CODE_DISABLE_AUTO_MEMORY']).toBe('1')
    // env REPLACES the subprocess environment in the TS SDK — PATH must be spread through.
    expect(env['PATH']).toBe(process.env['PATH'])
  })

  it('denies the dangerous built-in tools and keeps Bash off the allow list', () => {
    const options = buildSdkOptions(OPTIONS)
    for (const denied of ['Bash', 'Write', 'Edit', 'WebSearch', 'WebFetch', 'Agent', 'Task']) {
      expect(options.disallowedTools).toContain(denied)
    }
    expect(options.allowedTools).not.toContain('Bash')
    expect(options.permissionMode).toBe('default')
  })

  it('passes the model through and streams partial messages', () => {
    const options = buildSdkOptions(OPTIONS)
    expect(options.model).toBe(DEFAULT_AGENT_MODEL)
    expect(options.includePartialMessages).toBe(true)
  })

  it('omits resume unless a session id is supplied', () => {
    expect('resume' in buildSdkOptions(OPTIONS)).toBe(false)
    expect(buildSdkOptions({ ...OPTIONS, resumeSessionId: 'sess-9' }).resume).toBe('sess-9')
  })
})

describe('realQuery', () => {
  it('calls the SDK query with the built options and the prompt, returning the handle', () => {
    const prompt = (async function* () {})() as never
    const handle = realQuery({ prompt, options: OPTIONS })
    expect(mocks.query).toHaveBeenCalledOnce()
    const call = mocks.query.mock.calls[0]?.[0]
    expect(call?.prompt).toBe(prompt)
    expect(call?.options).toMatchObject({ settingSources: ['project'], model: DEFAULT_AGENT_MODEL })
    expect(handle).toEqual({ marker: 'handle' })
  })
})

describe('defaultAgentPaths', () => {
  it('derives app-owned paths under userData', () => {
    expect(defaultAgentPaths()).toEqual({
      cwd: '/userData/agent/workspace',
      configDir: '/userData/agent/claude',
    })
  })
})
