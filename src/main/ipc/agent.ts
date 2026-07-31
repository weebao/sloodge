/**
 * The `electron`-touching half of the agent IPC. Everything with a decision in it lives in
 * `../agent/*` (pure, unit-tested); this file is wiring, kept thin enough to review by eye, and
 * covered with `vi.mock('electron')` like M2.0's protocol wiring test.
 *
 * Both the preload and this layer validate every payload — the preload screen is a convenience, this
 * one is the trusted boundary, because `ipcRenderer.invoke` is reachable from any renderer code.
 */

import { ipcMain, type WebContents } from 'electron'
import {
  AGENT_CLEAR_KEY_CHANNEL,
  AGENT_EVENT_CHANNEL,
  AGENT_INTERRUPT_CHANNEL,
  AGENT_KEY_STATUS_CHANNEL,
  AGENT_SEND_CHANNEL,
  AGENT_SET_KEY_CHANNEL,
  type AgentInterruptResponse,
  type AgentKeyStatusResponse,
  type AgentSendResponse,
  type AgentSetKeyResponse,
} from '../../shared/ipc-contract'
import { isAgentSendRequest, isApiKeySetRequest, type ApiKeyStatus } from '../../shared/agent/types'
import { defaultAgentPaths, realQuery } from '../agent/client'
import { AgentService } from '../agent/service'
import * as vault from '../agent/vault'

export type AgentIpcDeps = {
  readonly service: AgentService
  readonly saveApiKey: (key: string) => Promise<ApiKeyStatus>
  readonly clearApiKey: () => Promise<ApiKeyStatus>
  readonly getApiKeyStatus: () => Promise<ApiKeyStatus>
}

/** Renderers whose teardown hooks are installed — a WeakSet so a destroyed WebContents isn't held. */
const trackedSenders = new WeakSet<WebContents>()

function trackSender(service: AgentService, sender: WebContents): void {
  if (trackedSenders.has(sender)) return
  trackedSenders.add(sender)
  const drop = (): void => {
    void service.dispose(sender.id)
  }
  // A renderer that reloads, closes, or crashes must not strand its session's subprocess (§9).
  sender.on('destroyed', drop)
  sender.on('render-process-gone', drop)
}

/**
 * Register the agent channels. Returns the `AgentService` so `src/main/index.ts` can `disposeAll()`
 * on quit. Dependencies default to the real vault + SDK facade but are injectable for tests.
 */
export function installAgentIpc(deps: Partial<AgentIpcDeps> = {}): AgentService {
  const service =
    deps.service ??
    new AgentService({
      queryFn: realQuery,
      loadApiKey: vault.loadApiKey,
      resolvePaths: defaultAgentPaths,
    })
  const saveApiKey = deps.saveApiKey ?? vault.saveApiKey
  const clearApiKey = deps.clearApiKey ?? vault.clearApiKey
  const getApiKeyStatus = deps.getApiKeyStatus ?? vault.getApiKeyStatus

  ipcMain.handle(
    AGENT_SET_KEY_CHANNEL,
    async (_event, payload: unknown): Promise<AgentSetKeyResponse> => {
      if (!isApiKeySetRequest(payload)) throw new Error('agent:setKey requires { key: string }')
      return { status: await saveApiKey(payload.key) }
    },
  )

  ipcMain.handle(AGENT_CLEAR_KEY_CHANNEL, async (): Promise<AgentKeyStatusResponse> => {
    return { status: await clearApiKey() }
  })

  ipcMain.handle(AGENT_KEY_STATUS_CHANNEL, async (): Promise<AgentKeyStatusResponse> => {
    return { status: await getApiKeyStatus() }
  })

  ipcMain.handle(
    AGENT_SEND_CHANNEL,
    async (event, payload: unknown): Promise<AgentSendResponse> => {
      if (!isAgentSendRequest(payload)) throw new Error('agent:send requires { text: string }')
      trackSender(service, event.sender)
      const sender = event.sender
      return service.send(sender.id, payload.text, (agentEvent) => {
        // The renderer may have gone away between turns; a send to a destroyed WebContents throws.
        if (!sender.isDestroyed()) sender.send(AGENT_EVENT_CHANNEL, agentEvent)
      })
    },
  )

  ipcMain.handle(AGENT_INTERRUPT_CHANNEL, async (event): Promise<AgentInterruptResponse> => {
    return service.interrupt(event.sender.id)
  })

  return service
}
