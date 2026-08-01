/**
 * The pending chat-context attachment — the bridge between Design Mode's "Ask Claude about this
 * element" affordance (the property panel) and the chat composer (§6.1 of
 * `.claude/plans/init/40-design-mode.md`, 20-ui-wireframes.md's `[⊕ctx]` chip).
 *
 * The two live in different subtrees (the panel is docked under the canvas; the composer is the
 * right-dock chat), so the attachment is a tiny shared store rather than prop-drilling. The panel
 * `attach`es a built `ElementContextBundle`; the composer subscribes to it to render the removable
 * chip, and `clear`s it after a send (or when the user dismisses the chip). It is **view state**, not
 * document state — never persisted, never on the undo stack — so it lives here on `createStore`
 * alongside `designStore`, not in `deckStore`.
 *
 * Only one attachment at a time (M3.4 ships single-element context; multi-select is a non-goal, §0).
 * Re-attaching replaces the previous bundle, matching "click Ask on a different element → the chip
 * now shows that element".
 */

import type { ElementContextBundle } from '../../../../shared/design/element-context'
import { createStore } from '../../stores/createStore'

export type ChatContextState = {
  /** The element context attached to the next turn, or `null` when the composer has no context. */
  readonly attachment: ElementContextBundle | null
  /** Attach (or replace) the pending element context. */
  readonly attach: (bundle: ElementContextBundle) => void
  /** Drop the pending context — the user removed the chip, or a send consumed it. */
  readonly clear: () => void
}

export const useChatContextStore = createStore<ChatContextState>((set) => ({
  attachment: null,
  attach: (bundle) => {
    set({ attachment: bundle })
  },
  clear: () => {
    set({ attachment: null })
  },
}))
