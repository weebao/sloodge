/**
 * Subscribes the deck store to the agent's `deck:updated` push, so the canvas and rail hot-update as
 * the agent writes (50-agent-integration.md §9). Kept out of `ChatPanel` on purpose: deck mutations
 * and chat narrative are independent streams (10-architecture.md §9 invariant 3), and the deck store
 * is owned by the shell, not the chat feature.
 *
 * The subscription lives and dies with the bridge; a browser host with no agent surface installs
 * nothing and the editor runs unchanged.
 */

import { useEffect } from 'react'
import { getAgentBridge } from '../features/chat/agentClient'
import { useDeckStore } from '../stores/deckStore'

export function useAgentDeckSync(): void {
  useEffect(() => {
    const bridge = getAgentBridge()
    if (bridge === undefined) return undefined
    return bridge.onDeckUpdated((update) => {
      useDeckStore.getState().applyRemoteDeck(update)
    })
  }, [])
}
