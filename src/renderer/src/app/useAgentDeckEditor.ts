/**
 * The renderer's end of the M2.6 agent-edit reconciliation. Subscribes to the agent tool edits main
 * pushes on `deck:agentEdit`, applies each through the deck store's authoritative `DocumentHistory`
 * (so it lands on the same undo stack the Edit menu drives — undo-parity), and replies with the
 * result so the tool can report success or a typed error back to the agent.
 *
 * The heavy lifting is the pure `handleAgentEditRequest`; this hook is thin glue over the bridge and
 * the store, kept out of `ChatPanel` for the same reason `useAgentDeckSync` is: deck mutations and
 * chat narrative are independent streams (10-architecture.md §9 invariant 3). It lives and dies with
 * the bridge; a browser host with no agent surface installs nothing.
 */

import { useEffect } from 'react'
import { handleAgentEditRequest, type AgentDeckTarget } from '../../../shared/document/agent-edit'
import { getAgentBridge } from '../features/chat/agentClient'
import { useDeckStore } from '../stores/deckStore'

export function useAgentDeckEditor(): void {
  useEffect(() => {
    const bridge = getAgentBridge()
    if (bridge === undefined) return undefined
    const target: AgentDeckTarget = {
      applyAgentCommands: (commands, turnId, toolUseId) =>
        useDeckStore.getState().applyAgentCommands(commands, turnId, toolUseId),
      snapshotForAgent: () => useDeckStore.getState().snapshotForAgent(),
    }
    return bridge.onAgentEditRequest((request) => {
      bridge.sendAgentEditResult(handleAgentEditRequest(target, request))
    })
  }, [])
}
