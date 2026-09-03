import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentService } from '../../../src/main/agent/service'

/**
 * `ipc/agent.ts` is the electron wiring — thin, but it holds the trusted payload validation and the
 * subprocess-teardown hooks. `electron` and the SDK are mocked; the service and vault are injected,
 * so the wiring is asserted end to end without a keychain or a subprocess.
 */
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

function fakeSender(id = 7): {
  id: number
  isDestroyed: () => boolean
  send: ReturnType<typeof vi.fn>
  on: ReturnType<typeof vi.fn>
  listeners: Map<string, () => void>
} {
  const listeners = new Map<string, () => void>()
  return {
    id,
    isDestroyed: () => false,
    send: vi.fn(),
    on: vi.fn((event: string, cb: () => void) => listeners.set(event, cb)),
    listeners,
  }
}

function fakeService(): {
  send: ReturnType<typeof vi.fn>
  interrupt: ReturnType<typeof vi.fn>
  dispose: ReturnType<typeof vi.fn>
  setBudgetCap: ReturnType<typeof vi.fn>
} {
  return {
    send: vi.fn(async () => ({ accepted: true })),
    interrupt: vi.fn(async () => ({ interrupted: true })),
    dispose: vi.fn(async () => {}),
    setBudgetCap: vi.fn(),
  }
}

const vaultStub = {
  saveApiKey: vi.fn(async () => ({ configured: true, last4: 'W3z9' })),
  clearApiKey: vi.fn(async () => ({ configured: false, last4: null })),
  getApiKeyStatus: vi.fn(async () => ({ configured: true, last4: 'W3z9' })),
}

beforeEach(() => {
  mocks.ipcHandle.mockClear()
  vaultStub.saveApiKey.mockClear()
})

const budgetStub = {
  getBudgetCap: vi.fn(async () => 2),
  setBudgetCap: vi.fn(async (cap: number | null) => cap),
}

function install(service = fakeService()) {
  installAgentIpc({ service: service as unknown as AgentService, ...vaultStub, ...budgetStub })
  return service
}

describe('installAgentIpc', () => {
  it('registers all five agent channels', () => {
    install()
    const registered = mocks.ipcHandle.mock.calls.map((c) => c[0])
    expect(registered).toEqual(
      expect.arrayContaining([
        contract.AGENT_SET_KEY_CHANNEL,
        contract.AGENT_CLEAR_KEY_CHANNEL,
        contract.AGENT_KEY_STATUS_CHANNEL,
        contract.AGENT_SEND_CHANNEL,
        contract.AGENT_INTERRUPT_CHANNEL,
      ]),
    )
  })

  it('setKey validates the payload and returns the masked status', async () => {
    install()
    const handler = handlerFor(contract.AGENT_SET_KEY_CHANNEL)
    expect(await handler({}, { key: 'sk-ant-live' })).toEqual({
      status: { configured: true, last4: 'W3z9' },
    })
    expect(vaultStub.saveApiKey).toHaveBeenCalledWith('sk-ant-live')
    await expect(async () => handler({}, { key: 42 })).rejects.toThrow()
  })

  it('send validates the payload, drives the service, and forwards events to a live sender', async () => {
    const service = install()
    const handler = handlerFor(contract.AGENT_SEND_CHANNEL)
    const sender = fakeSender()

    const result = await handler({ sender }, { text: 'hello' })
    expect(result).toEqual({ accepted: true })
    expect(service.send).toHaveBeenCalledWith(sender.id, 'hello', expect.any(Function))

    // The emit callback pushes on the agent event channel.
    const emit = service.send.mock.calls[0]?.[2] as (e: unknown) => void
    emit({ type: 'turn-end', costUsd: 0, subtype: 'success' })
    expect(sender.send).toHaveBeenCalledWith(contract.AGENT_EVENT_CHANNEL, {
      type: 'turn-end',
      costUsd: 0,
      subtype: 'success',
    })

    await expect(async () => handler({ sender }, { text: 99 })).rejects.toThrow()
  })

  it('tears down the session when the renderer goes away', async () => {
    const service = install()
    const handler = handlerFor(contract.AGENT_SEND_CHANNEL)
    const sender = fakeSender(11)
    await handler({ sender }, { text: 'go' })

    expect(sender.on).toHaveBeenCalledWith('destroyed', expect.any(Function))
    expect(sender.on).toHaveBeenCalledWith('render-process-gone', expect.any(Function))
    sender.listeners.get('destroyed')?.()
    expect(service.dispose).toHaveBeenCalledWith(11)
  })

  it('setBudget validates, persists, and pushes the stored cap into live sessions (M2.5)', async () => {
    // The push is what lets a cap lowered below current spend stop a streaming turn now, rather
    // than on the next send.
    const service = install()
    const handler = handlerFor(contract.AGENT_SET_BUDGET_CHANNEL)
    expect(await handler({}, { capUsd: 0.5 })).toEqual({ capUsd: 0.5 })
    expect(budgetStub.setBudgetCap).toHaveBeenCalledWith(0.5)
    expect(service.setBudgetCap).toHaveBeenCalledWith(0.5)
    expect(await handler({}, { capUsd: null })).toEqual({ capUsd: null })
    expect(service.setBudgetCap).toHaveBeenLastCalledWith(null)
    await expect(async () => handler({}, { capUsd: -1 })).rejects.toThrow()
    await expect(async () => handler({}, { capUsd: '2' })).rejects.toThrow()
  })

  it('interrupt reports the service result', async () => {
    const service = install()
    const handler = handlerFor(contract.AGENT_INTERRUPT_CHANNEL)
    expect(await handler({ sender: fakeSender() })).toEqual({ interrupted: true })
    expect(service.interrupt).toHaveBeenCalledWith(7)
  })
})
