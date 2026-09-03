/**
 * The `electron`-touching half of the agent IPC. Everything with a decision in it lives in
 * `../agent/*` (pure, unit-tested); this file is wiring, kept thin enough to review by eye, and
 * covered with `vi.mock('electron')` like M2.0's protocol wiring test.
 *
 * Both the preload and this layer validate every payload — the preload screen is a convenience, this
 * one is the trusted boundary, because `ipcRenderer.invoke` is reachable from any renderer code.
 */

import { ipcMain, webContents, type WebContents } from 'electron'
import {
  AGENT_AUTH_STATUS_CHANNEL,
  AGENT_BUDGET_CHANNEL,
  AGENT_SET_BUDGET_CHANNEL,
  AGENT_CLEAR_KEY_CHANNEL,
  AGENT_CLEAR_SUBSCRIPTION_TOKEN_CHANNEL,
  AGENT_SET_SUBSCRIPTION_TOKEN_CHANNEL,
  AGENT_EVENT_CHANNEL,
  AGENT_INTERRUPT_CHANNEL,
  AGENT_KEY_STATUS_CHANNEL,
  AGENT_SEND_CHANNEL,
  AGENT_SET_KEY_CHANNEL,
  DECK_AGENT_EDIT_CHANNEL,
  DECK_AGENT_EDIT_RESULT_CHANNEL,
  type AgentAuthStatusResponse,
  type AgentBudgetResponse,
  type AgentInterruptResponse,
  type AgentKeyStatusResponse,
  type AgentSendResponse,
  type AgentSetKeyResponse,
} from '../../shared/ipc-contract'
import { isAgentSendRequest, isApiKeySetRequest, type ApiKeyStatus } from '../../shared/agent/types'
import { isBudgetSetRequest, type BudgetCap } from '../../shared/agent/budget'
import type { AuthStatus } from '../../shared/agent/auth'
import { isAgentEditResponse } from '../../shared/document/agent-edit'
import { budgetStore } from '../agent/budget-store'
import { bundledSkillsDir, defaultAgentPaths, realQuery } from '../agent/client'
import {
  composeFallbackSystemPrompt,
  materializeSkills,
  nodeSkillFs,
  readSkillBodies,
} from '../agent/skills'
import { createRendererDeckEditor, type RendererDeckEditor } from '../agent/deck-editor'
import { createDeckToolHost } from '../agent/deck-host'
import { AgentService } from '../agent/service'
import { createSlidesServer } from '../agent/tools'
import * as vault from '../agent/vault'

export type AgentIpcDeps = {
  readonly service: AgentService
  readonly saveApiKey: (key: string) => Promise<ApiKeyStatus>
  readonly clearApiKey: () => Promise<ApiKeyStatus>
  readonly getApiKeyStatus: () => Promise<ApiKeyStatus>
  /** M2.7 — the `claude setup-token` subscription token, same vault rules as the key. */
  readonly saveSubscriptionToken: (token: string) => Promise<ApiKeyStatus>
  readonly clearSubscriptionToken: () => Promise<ApiKeyStatus>
  /** Both slots, masked and combined into the active mode. */
  readonly getAuthStatus: () => Promise<AuthStatus>
  /** M2.5 — the persisted session spend cap (§10). */
  readonly getBudgetCap: () => Promise<BudgetCap>
  readonly setBudgetCap: (cap: BudgetCap) => Promise<BudgetCap>
}

/** Renderers whose teardown hooks are installed — a WeakSet so a destroyed WebContents isn't held. */
const trackedSenders = new WeakSet<WebContents>()

function trackSender(
  service: AgentService,
  sender: WebContents,
  editors: Map<number, RendererDeckEditor>,
): void {
  if (trackedSenders.has(sender)) return
  trackedSenders.add(sender)
  const drop = (): void => {
    void service.dispose(sender.id)
    // Fail any tool call waiting on this renderer's deck, then forget it — no orphaned pending
    // request, and the next session for a same-id renderer gets a fresh editor (§9, M2.6 no-hang).
    editors.get(sender.id)?.rejectAll()
    editors.delete(sender.id)
  }
  // A renderer that reloads, closes, or crashes must not strand its session's subprocess (§9).
  sender.on('destroyed', drop)
  sender.on('render-process-gone', drop)
}

/**
 * Build the M2.6 reconciliation surface: one `RendererDeckEditor` per renderer (created lazily when a
 * session first needs the deck), a response router keyed by sender id, and the `resolveMcpServers`
 * the agent service uses to attach `mcp__slides__*` bound to that renderer's authoritative deck.
 */
function installDeckReconciliation(): {
  editors: Map<number, RendererDeckEditor>
  resolveMcpServers: (senderId: number) => Readonly<Record<string, unknown>>
} {
  const editors = new Map<number, RendererDeckEditor>()

  // Renderer → main replies, correlated back to the pending tool call by the editor for that sender.
  ipcMain.on(DECK_AGENT_EDIT_RESULT_CHANNEL, (event, payload: unknown) => {
    if (isAgentEditResponse(payload)) editors.get(event.sender.id)?.deliver(payload)
  })

  const editorFor = (senderId: number): RendererDeckEditor => {
    const existing = editors.get(senderId)
    if (existing !== undefined) return existing
    const editor = createRendererDeckEditor({
      // Looked up by id each call so a renderer that went away reports `renderer-unavailable` rather
      // than the tool call hanging — no held WebContents to go stale.
      isAlive: () => {
        const wc = webContents.fromId(senderId)
        return wc !== undefined && !wc.isDestroyed()
      },
      send: (request) => {
        const wc = webContents.fromId(senderId)
        if (wc !== undefined && !wc.isDestroyed()) wc.send(DECK_AGENT_EDIT_CHANNEL, request)
      },
    })
    editors.set(senderId, editor)
    return editor
  }

  const resolveMcpServers = (senderId: number): Readonly<Record<string, unknown>> => {
    const host = createDeckToolHost({ editor: editorFor(senderId), sessionId: String(senderId) })
    return { slides: createSlidesServer(host) }
  }

  return { editors, resolveMcpServers }
}

/**
 * Register the agent channels. Returns the `AgentService` so `src/main/index.ts` can `disposeAll()`
 * on quit. Dependencies default to the real vault + SDK facade but are injectable for tests.
 */
export function installAgentIpc(deps: Partial<AgentIpcDeps> = {}): AgentService {
  // The reconciliation surface is installed regardless (its response listener is idle until a tool
  // call is made); only the default service is wired to route agent edits through it.
  const { editors, resolveMcpServers } = installDeckReconciliation()
  const getBudgetCap = deps.getBudgetCap ?? (() => budgetStore().load())
  const setBudgetCap = deps.setBudgetCap ?? ((cap: BudgetCap) => budgetStore().save(cap))
  const service =
    deps.service ??
    new AgentService({
      queryFn: realQuery,
      loadCredential: vault.loadAgentCredential,
      resolvePaths: defaultAgentPaths,
      resolveMcpServers,
      loadBudgetCap: getBudgetCap,
      // M2.4: put the three validated slide skills under `<cwd>/.claude/skills` before the
      // subprocess starts, since that is the only settings layer the agent loads (§5, §8).
      prepareWorkspace: (cwd) =>
        materializeSkills({ sourceDir: bundledSkillsDir(), cwd, fs: nodeSkillFs }),
      // M2.5: §8's repair. Only called if an init reports the skills missing, so a healthy session
      // never touches the bundle a second time.
      loadFallbackPrompt: async () =>
        composeFallbackSystemPrompt(
          await readSkillBodies({ sourceDir: bundledSkillsDir(), fs: nodeSkillFs }),
        ),
    })
  const saveApiKey = deps.saveApiKey ?? vault.saveApiKey
  const clearApiKey = deps.clearApiKey ?? vault.clearApiKey
  const getApiKeyStatus = deps.getApiKeyStatus ?? vault.getApiKeyStatus
  const saveSubscriptionToken = deps.saveSubscriptionToken ?? vault.saveSubscriptionToken
  const clearSubscriptionToken = deps.clearSubscriptionToken ?? vault.clearSubscriptionToken
  const getAuthStatus = deps.getAuthStatus ?? vault.getAuthStatus

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

  // --- M2.7 auth surface -------------------------------------------------------------------------
  // Every one of these replies with a masked status only. The `saveSubscriptionToken` handler takes a
  // secret *inward*; there is deliberately no channel that reads either credential back out.

  ipcMain.handle(AGENT_AUTH_STATUS_CHANNEL, async (): Promise<AgentAuthStatusResponse> => {
    return { status: await getAuthStatus() }
  })

  ipcMain.handle(
    AGENT_SET_SUBSCRIPTION_TOKEN_CHANNEL,
    async (_event, payload: unknown): Promise<AgentAuthStatusResponse> => {
      if (!isApiKeySetRequest(payload)) {
        throw new Error('agent:setSubscriptionToken requires { key: string }')
      }
      await saveSubscriptionToken(payload.key)
      // Re-read both slots rather than deriving from the write: the renderer's next render must
      // reflect the *combined* mode, and the key slot may already hold a value.
      return { status: await getAuthStatus() }
    },
  )

  ipcMain.handle(
    AGENT_CLEAR_SUBSCRIPTION_TOKEN_CHANNEL,
    async (): Promise<AgentAuthStatusResponse> => {
      await clearSubscriptionToken()
      return { status: await getAuthStatus() }
    },
  )

  ipcMain.handle(
    AGENT_SEND_CHANNEL,
    async (event, payload: unknown): Promise<AgentSendResponse> => {
      if (!isAgentSendRequest(payload)) throw new Error('agent:send requires { text: string }')
      trackSender(service, event.sender, editors)
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

  // --- M2.5 budget surface -----------------------------------------------------------------------
  // Not a secret, so unlike the credential channels this one reads back exactly what it stores.

  ipcMain.handle(AGENT_BUDGET_CHANNEL, async (): Promise<AgentBudgetResponse> => {
    return { capUsd: await getBudgetCap() }
  })

  ipcMain.handle(
    AGENT_SET_BUDGET_CHANNEL,
    async (_event, payload: unknown): Promise<AgentBudgetResponse> => {
      if (!isBudgetSetRequest(payload)) {
        throw new Error('agent:setBudget requires { capUsd: number | null }')
      }
      const capUsd = await setBudgetCap(payload.capUsd)
      // Bind the saved cap to live sessions now, not on their next send (M2.5 §10: a cap lowered
      // below current spend stops the running turn).
      service.setBudgetCap(capUsd)
      return { capUsd }
    },
  )

  return service
}
