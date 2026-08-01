/**
 * The M2.7 auth channels' wiring (`agent:authStatus`, `agent:setSubscriptionToken`,
 * `agent:clearSubscriptionToken`).
 *
 * Same shape as `agent-ipc.test.ts` — `electron` and the SDK are mocked, the vault is injected — so
 * the trusted boundary's validation and, above all, the "only masked status comes back" rule are
 * asserted without a keychain or a subprocess.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentService } from '../../../src/main/agent/service'
import type { AuthStatus } from '../../../src/shared/agent/auth'
import { DEFAULT_ENDPOINT } from '../../../src/shared/agent/endpoint'
import type { ApiKeyStatus } from '../../../src/shared/agent/types'

const mocks = vi.hoisted(() => ({ ipcHandle: vi.fn(), ipcOn: vi.fn() }))

vi.mock('electron', () => ({
  ipcMain: { handle: mocks.ipcHandle, on: mocks.ipcOn },
  webContents: { fromId: vi.fn(() => undefined) },
  app: { getPath: () => '/ud' },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: () => Buffer.from(''),
    decryptString: () => '',
  },
}))
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: vi.fn() }))

const { installAgentIpc } = await import('../../../src/main/ipc/agent')
const contract = await import('../../../src/shared/ipc-contract')

type Handler = (event: unknown, payload?: unknown) => unknown

function handlerFor(channel: string): Handler {
  const call = mocks.ipcHandle.mock.calls.find((c) => c[0] === channel)
  if (!call) throw new Error(`no handler registered for ${channel}`)
  return call[1] as Handler
}

const MASKED: ApiKeyStatus = { configured: true, last4: 'abcd' }
const UNSET: ApiKeyStatus = { configured: false, last4: null }
const SUBSCRIBED: AuthStatus = {
  mode: 'subscription',
  apiKey: UNSET,
  subscription: MASKED,
  endpoint: DEFAULT_ENDPOINT,
}
const NOTHING: AuthStatus = {
  mode: 'not-configured',
  apiKey: UNSET,
  subscription: UNSET,
  endpoint: DEFAULT_ENDPOINT,
}

/**
 * A vault stub that records what it was handed, so we can prove the secret went *in*. The return type
 * is inferred rather than annotated: spelling it as `ReturnType<typeof vi.fn>` widens each member to
 * the untyped mock signature, which no longer satisfies `Partial<AgentIpcDeps>`.
 */
function stubVault(status: AuthStatus = SUBSCRIBED) {
  return {
    saveSubscriptionToken: vi.fn(async (_token: string) => MASKED),
    clearSubscriptionToken: vi.fn(async () => UNSET),
    getAuthStatus: vi.fn(async () => status),
    saveApiKey: vi.fn(async (_key: string) => MASKED),
    clearApiKey: vi.fn(async () => UNSET),
    getApiKeyStatus: vi.fn(async () => UNSET),
  }
}

function install(status: AuthStatus = SUBSCRIBED): ReturnType<typeof stubVault> {
  const vault = stubVault(status)
  const service = { send: vi.fn(), interrupt: vi.fn(), dispose: vi.fn(), disposeAll: vi.fn() }
  installAgentIpc({ service: service as unknown as AgentService, ...vault })
  return vault
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('channel registration', () => {
  it('registers the three auth channels', () => {
    install()
    const channels = mocks.ipcHandle.mock.calls.map((c) => c[0] as string)
    expect(channels).toContain(contract.AGENT_AUTH_STATUS_CHANNEL)
    expect(channels).toContain(contract.AGENT_SET_SUBSCRIPTION_TOKEN_CHANNEL)
    expect(channels).toContain(contract.AGENT_CLEAR_SUBSCRIPTION_TOKEN_CHANNEL)
  })

  it('declares all three on the request allow-list', () => {
    // A handler on a channel the contract does not list would never be reachable from the preload.
    for (const channel of [
      contract.AGENT_AUTH_STATUS_CHANNEL,
      contract.AGENT_SET_SUBSCRIPTION_TOKEN_CHANNEL,
      contract.AGENT_CLEAR_SUBSCRIPTION_TOKEN_CHANNEL,
    ]) {
      expect(contract.IPC_REQUEST_CHANNELS).toContain(channel)
    }
  })
})

describe('agent:authStatus', () => {
  it('returns the combined masked status', async () => {
    install()
    expect(await handlerFor(contract.AGENT_AUTH_STATUS_CHANNEL)({})).toEqual({
      status: SUBSCRIBED,
    })
  })
})

describe('agent:setSubscriptionToken', () => {
  it('passes the token to the vault', async () => {
    const vault = install()
    await handlerFor(contract.AGENT_SET_SUBSCRIPTION_TOKEN_CHANNEL)(
      {},
      {
        key: 'sk-ant-oat01-abcd',
      },
    )
    expect(vault.saveSubscriptionToken).toHaveBeenCalledWith('sk-ant-oat01-abcd')
  })

  it('answers with the combined status, not just the slot it wrote', async () => {
    // The renderer's next render must reflect the *mode*, which depends on both slots.
    const vault = install()
    const response = await handlerFor(contract.AGENT_SET_SUBSCRIPTION_TOKEN_CHANNEL)(
      {},
      {
        key: 'sk-ant-oat01-abcd',
      },
    )
    expect(vault.getAuthStatus).toHaveBeenCalled()
    expect(response).toEqual({ status: SUBSCRIBED })
  })

  /**
   * The M2.1 rule, at the boundary that enforces it: whatever went in, nothing that comes back may
   * contain it. Mutation check: return the plaintext from the handler and this fails.
   */
  it('never echoes the token back toward the renderer', async () => {
    install()
    const secret = 'sk-ant-oat01-do-not-leak'
    const response = await handlerFor(contract.AGENT_SET_SUBSCRIPTION_TOKEN_CHANNEL)(
      {},
      {
        key: secret,
      },
    )
    expect(JSON.stringify(response)).not.toContain(secret)
  })

  it('rejects a malformed payload rather than trusting the renderer', async () => {
    install()
    const handler = handlerFor(contract.AGENT_SET_SUBSCRIPTION_TOKEN_CHANNEL)
    // `ipcRenderer.invoke` is reachable from any renderer code, so this is the trusted screen.
    await expect(handler({}, { token: 'wrong-field' })).rejects.toThrow(/requires/)
    await expect(handler({}, null)).rejects.toThrow(/requires/)
    await expect(handler({}, 'a-bare-string')).rejects.toThrow(/requires/)
  })

  it('does not write anything when the payload is rejected', async () => {
    const vault = install()
    await expect(
      handlerFor(contract.AGENT_SET_SUBSCRIPTION_TOKEN_CHANNEL)({}, {}),
    ).rejects.toThrow()
    expect(vault.saveSubscriptionToken).not.toHaveBeenCalled()
  })
})

describe('agent:clearSubscriptionToken', () => {
  it('clears the slot and reports the recomputed status', async () => {
    const vault = install(NOTHING)
    const response = await handlerFor(contract.AGENT_CLEAR_SUBSCRIPTION_TOKEN_CHANNEL)({})
    expect(vault.clearSubscriptionToken).toHaveBeenCalled()
    expect(response).toEqual({ status: NOTHING })
  })

  it('leaves the API key alone — signing out should fall back, not strand the user', async () => {
    const vault = install()
    await handlerFor(contract.AGENT_CLEAR_SUBSCRIPTION_TOKEN_CHANNEL)({})
    expect(vault.clearApiKey).not.toHaveBeenCalled()
  })
})
