/**
 * Subscribes the deck store to the agent's `deck:updated` push, so the canvas and rail hot-update as
 * the agent writes (50-agent-integration.md §9). Kept out of `ChatPanel` on purpose: deck mutations
 * and chat narrative are independent streams (10-architecture.md §9 invariant 3), and the deck store
 * is owned by the shell, not the chat feature.
 *
 * The subscription lives and dies with the bridge; a browser host with no agent surface installs
 * nothing and the editor runs unchanged.
 *
 * ## Why Design Mode's selection is dropped here
 *
 * `applyRemoteDeck` replaces the whole document — new manifest, new slide bytes, history reset. A
 * `data-sl-id` is positional (`slide-map.ts`), so after the agent restructures a slide the id the
 * user had selected either names nothing or names a *different* element, while the overlay keeps
 * painting the box at the geometry the old element had. `useTextEditing` already abandons an open
 * caret on this path for the same reason; the selection has to go with it, and this is the one place
 * that knows a remote replacement happened as opposed to an edit the user just made (round-3 major).
 * Local edits deliberately keep their selection — a drag re-selects the element it moved.
 */

import { useEffect } from 'react'
import { getAgentBridge } from '../features/chat/agentClient'
import { useDesignStore } from '../features/design/designStore'
import { useDeckStore } from '../stores/deckStore'

export function useAgentDeckSync(): void {
  useEffect(() => {
    const bridge = getAgentBridge()
    if (bridge === undefined) return undefined
    return bridge.onDeckUpdated((update) => {
      // Only on a snapshot that was actually adopted: a malformed push is a no-op, and a no-op must
      // not cost the user their selection.
      if (useDeckStore.getState().applyRemoteDeck(update)) {
        useDesignStore.getState().clearTransient()
      }
    })
  }, [])
}
