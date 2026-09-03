/**
 * The chat transcript reducer — the pure heart of the chat panel (50-agent-integration.md §9).
 *
 * A scripted sequence of `TranscriptAction`s (a user turn, then the `AgentEvent`s that stream back)
 * folds into a `Transcript`: the message list the panel renders, the streaming-state machine that
 * drives the composer/Stop control, and the running session cost. It is a *pure function of
 * (state, action)* with an injectable clock/id source out of the way (ids come from an in-state
 * counter), so the whole M2.3 behaviour contract — delta accumulation, tool-chip insertion, error
 * mapping, turn-state transitions — is provable by feeding events and asserting the transcript, with
 * no React, no IPC and no live API call. The hook (`useChatSession.ts`) is the only stateful wrapper.
 *
 * ## The streaming-state machine
 *
 *   idle ──user-send──▶ streaming ──turn-end──▶ idle
 *                          │ ├─error(interrupted)/interrupt-requested──▶ interrupted
 *                          │ └─error(other)────────────────────────────▶ error
 *   error/interrupted ──user-send──▶ streaming   (a new turn always clears the prior end-state)
 *
 * `turn-end` and `error` can both arrive for one failed turn (the SDK emits a `result` on failure
 * too, mapped to `[turn-end, error]` — event-mapping.ts), so `error` is applied last and wins: a
 * turn that failed reads `error`, not `idle`. Cost is folded on `turn-end` regardless, because an
 * error result still carries cost (§10).
 *
 * ## One assistant bubble per turn
 *
 * The wireframe (20-ui-wireframes.md) shows a single "⏺ Claude" bubble per turn with tool-call chips
 * *inline*, so every assistant delta, tool-use and finalized message for a turn accumulates into the
 * one streaming assistant message created when the user sends. Deltas are authoritative for the
 * visible text; a finalized `assistant-message` only fills text in when no deltas were delivered
 * (partial-message streaming off or dropped) and always folds in usage. This is why the reducer never
 * double-renders text that already streamed token by token.
 */

import type { AgentErrorKind, AgentEvent, AgentUsage } from '../../../../shared/agent/types'
import {
  abandonTurn,
  beginTurn,
  foldTurnCost,
  INITIAL_COST_STATE,
  type CostState,
} from '../../../../shared/agent/cost'

/** The four lifecycle states the composer and Stop control branch on. */
export type TurnState = 'idle' | 'streaming' | 'error' | 'interrupted'

/** An inline tool-call chip, e.g. `✎ Editing slide`. */
export type ToolChip = {
  readonly toolUseId: string
  readonly glyph: string
  readonly text: string
}

export type ChatMessage =
  | { readonly kind: 'user'; readonly id: string; readonly turnId: string; readonly text: string }
  | {
      readonly kind: 'assistant'
      readonly id: string
      /** The send that opened this bubble (`user-send.turnId`), so a refusal can take back exactly it. */
      readonly turnId: string
      readonly text: string
      readonly tools: readonly ToolChip[]
      /** True while this bubble is the live target of deltas/chips; false once the turn settles. */
      readonly streaming: boolean
      /** Summed usage across the turn's assistant messages, or `null` until one arrives. */
      readonly usage: AgentUsage | null
    }
  | {
      readonly kind: 'error'
      readonly id: string
      readonly errorKind: AgentErrorKind
      readonly text: string
      readonly recoverable: boolean
    }
  /**
   * A neutral system line — not the assistant speaking and not a failure. Today this is only the
   * degraded-skills notice (M2.4): the session works, so an error bubble would overstate it, but a
   * silent skill-less session is the failure that notice exists to prevent.
   */
  | { readonly kind: 'notice'; readonly id: string; readonly text: string }

export type Transcript = {
  readonly turnState: TurnState
  readonly messages: readonly ChatMessage[]
  /**
   * Running session cost estimate (§10 — "≈", never billing truth), held as the **shared**
   * accumulator state from `shared/agent/cost.ts`.
   *
   * Shared, rather than a private field that folds the same way, because M2.5 puts this number in
   * the status bar and enforces the budget cap against it: it now has to *equal* what main recorded,
   * not merely resemble it. Both sides call `beginTurn`/`foldTurnCost` on the same events in the same
   * order, so agreement is structural — see that module for the fold rule, and for why it counts
   * open turns rather than flipping a boolean (overlapping turns used to lose a whole turn's cost on
   * both sides at once, which no cross-check between them could detect).
   */
  readonly cost: CostState
  /** In-state monotonic id source, so the reducer stays pure (no `Date.now`/`Math.random`). */
  readonly seq: number
}

export const initialTranscript: Transcript = {
  turnState: 'idle',
  messages: [],
  cost: INITIAL_COST_STATE,
  seq: 0,
}

export type TranscriptAction =
  /**
   * The user pressed Send: append their message and open a fresh streaming assistant bubble.
   * `turnId` is minted by the hook and stamped on both messages so `turn-refused` can name them.
   */
  | { readonly type: 'user-send'; readonly text: string; readonly turnId: string }
  /** The user pressed Stop: reflect the interrupt locally (the hook calls `bridge.interrupt`). */
  | { readonly type: 'interrupt-requested' }
  /**
   * Main did not open the turn we optimistically opened — it refused (its own budget check, or a
   * credential that vanished) or the invoke rejected before reaching the session. Rolls the optimism
   * back: the bubbles come out, the open-turn count is released, and the composer takes the text
   * back — see the reducer for why each of those matters.
   */
  | { readonly type: 'turn-refused'; readonly turnId: string }
  /** One event off the `agent:event` feed. */
  | { readonly type: 'agent-event'; readonly event: AgentEvent }

/* -------------------------------------------------------------------------------------------- *
 * Tool-chip mapping — bare main-derived label -> glyph + friendly verb (50 §9)
 *
 * The `tool-use` event carries only the humanised label main produced ("update slide"), never the
 * raw `mcp__slides__*` name. Per-slide-index enrichment ("Editing slide 2") needs main to fold the
 * tool args into that label; until it does, the chip shows the verb without a number. The mapping is
 * a pure lookup so it is exhaustively testable.
 * -------------------------------------------------------------------------------------------- */

type ChipStyle = { glyph: string; text: string }

const CHIP_STYLES: readonly { match: RegExp; style: ChipStyle }[] = [
  { match: /create|new|insert|add/, style: { glyph: '+', text: 'New slide' } },
  { match: /update|edit|set|patch/, style: { glyph: '✎', text: 'Editing slide' } },
  { match: /read|get/, style: { glyph: '👁', text: 'Reading slide' } },
  { match: /reorder|move/, style: { glyph: '⇅', text: 'Reordering slides' } },
  { match: /screenshot|render|preview/, style: { glyph: '📸', text: 'Rendering preview' } },
]

export function toolChipStyle(label: string): ChipStyle {
  const normalized = label.toLowerCase()
  for (const { match, style } of CHIP_STYLES) {
    if (match.test(normalized)) return style
  }
  // Unknown tool: show the label main gave us rather than inventing copy for it.
  return { glyph: '⚙', text: label }
}

/* -------------------------------------------------------------------------------------------- *
 * Error copy — kind -> user-facing chat bubble text (50 §4, §13)
 * -------------------------------------------------------------------------------------------- */

const ERROR_COPY: Record<AgentErrorKind, string> = {
  auth: 'Authentication failed — check your Claude API key in Settings.',
  'rate-limit': 'Claude is busy right now. Try again in a moment.',
  overloaded: 'Claude is overloaded. Try again shortly.',
  network: "Can't reach Claude. Slides and Design Mode still work offline.",
  // M2.5 re-scoped this from "this deck" to the session — what the guard actually meters — and
  // names the tab that changes it. Shared by both budget paths: our turn-admission refusal and the
  // SDK's mid-turn `error_max_budget_usd` ceiling.
  budget: 'Budget reached for this session. Raise the limit in Settings ▸ Budget to continue.',
  'max-turns': 'This got complicated — Claude stopped after the step limit.',
  interrupted: 'Stopped.',
  'runtime-missing': 'The Claude runtime is missing. Reinstall Sloodge.',
  unknown: 'The agent turn failed.',
}

/**
 * User-facing text for an error event. Known kinds get calibrated copy; `unknown` falls back to the
 * event's own message when it carries one, so a novel SDK failure is still legible rather than a
 * generic dead end.
 *
 * `budget` gets the same treatment so our own refusal can name the cap the user is arguing with
 * ("Budget reached for this session ($2.00)…" — `budgetRefusalMessage`). That is safe only because
 * `event-mapping` now leaves `message` empty for every kind with calibrated copy: an SDK-raised
 * `error_max_budget_usd` no longer carries "Turn ended: error_max_budget_usd", so it falls through
 * to the sentence below rather than putting a raw subtype on screen.
 */
export function errorCopy(kind: AgentErrorKind, message: string): string {
  if ((kind === 'unknown' || kind === 'budget') && message.trim().length > 0) return message
  return ERROR_COPY[kind]
}

/* -------------------------------------------------------------------------------------------- *
 * Reducer
 * -------------------------------------------------------------------------------------------- */

function sumUsage(a: AgentUsage | null, b: AgentUsage): AgentUsage {
  if (a === null) return b
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
  }
}

/** Index of the live (streaming) assistant bubble, or -1 when the turn has no open bubble. */
function liveAssistantIndex(messages: readonly ChatMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]
    if (message?.kind === 'assistant' && message.streaming) return i
    // Only the trailing bubble of the current turn can be live; stop at the previous user turn.
    if (message?.kind === 'user') return -1
  }
  return -1
}

/** Replace the message at `index` with the result of `patch`, returning a new array. */
function patchAt(
  messages: readonly ChatMessage[],
  index: number,
  patch: (message: ChatMessage) => ChatMessage,
): ChatMessage[] {
  return messages.map((message, i) => (i === index ? patch(message) : message))
}

/** Settle the live assistant bubble (streaming -> false) without otherwise changing it. */
function settleLive(messages: readonly ChatMessage[]): ChatMessage[] {
  const index = liveAssistantIndex(messages)
  if (index === -1) return [...messages]
  return patchAt(messages, index, (message) =>
    message.kind === 'assistant' ? { ...message, streaming: false } : message,
  )
}

function applyAgentEvent(state: Transcript, event: AgentEvent): Transcript {
  switch (event.type) {
    case 'ready':
      // Session handshake — no transcript change (the user bubble already opened the turn).
      return state

    case 'skills-status':
      // Status-bar telemetry, not conversation (M2.5). The chat panel deliberately says nothing
      // about a session that repaired itself; `sessionMeterStore` carries this to the status bar.
      return state

    case 'skills-degraded': {
      // Appended *before* the live assistant bubble would settle, so the user sees the caveat
      // alongside the answer it applies to. The turn is untouched: this is not a failure.
      const message: ChatMessage = {
        kind: 'notice',
        id: `n${String(state.seq)}`,
        text: `Slide skills unavailable (${event.missing.join(', ')}) — slides may not follow Sloodge's design rules.`,
      }
      return { ...state, messages: [...state.messages, message], seq: state.seq + 1 }
    }

    case 'assistant-delta': {
      const index = liveAssistantIndex(state.messages)
      if (index === -1) return state
      return {
        ...state,
        messages: patchAt(state.messages, index, (message) =>
          message.kind === 'assistant' ? { ...message, text: message.text + event.text } : message,
        ),
      }
    }

    case 'assistant-message': {
      const index = liveAssistantIndex(state.messages)
      if (index === -1) return state
      return {
        ...state,
        messages: patchAt(state.messages, index, (message) =>
          message.kind === 'assistant'
            ? {
                ...message,
                // Deltas are authoritative for display; only fill text when none streamed.
                text: message.text.length > 0 ? message.text : event.text,
                usage: sumUsage(message.usage, event.usage),
              }
            : message,
        ),
      }
    }

    case 'tool-use': {
      const index = liveAssistantIndex(state.messages)
      if (index === -1) return state
      const style = toolChipStyle(event.label)
      const chip: ToolChip = { toolUseId: event.toolUseId, glyph: style.glyph, text: style.text }
      return {
        ...state,
        messages: patchAt(state.messages, index, (message) =>
          message.kind === 'assistant' ? { ...message, tools: [...message.tools, chip] } : message,
        ),
      }
    }

    case 'turn-end': {
      // Fold this turn's `result` cost against the open-turn count rather than `turnState`, so it
      // works no matter which terminal state the turn has reached or when `turn-end` arrives:
      //  - streaming -> turn-end: folds, settles, goes idle;
      //  - streaming -> error -> turn-end (or the paired [turn-end, error]): folds once, keeps error;
      //  - streaming -> interrupt -> turn-end: folds the interrupted turn's cost, keeps interrupted;
      //  - a duplicate turn-end (no turn left open) is a reference-preserving no-op;
      //  - Stop -> resend -> both results: two open turns, two folds, neither lost.
      // Only a still-`streaming` turn transitions to `idle`; a settled turn keeps its end-state.
      const cost = foldTurnCost(state.cost, event.costUsd)
      if (cost === state.cost) return state
      return {
        ...state,
        turnState: state.turnState === 'streaming' ? 'idle' : state.turnState,
        messages: settleLive(state.messages),
        cost,
      }
    }

    case 'error': {
      const settled = settleLive(state.messages)
      const id = `e${String(state.seq)}`
      const message: ChatMessage = {
        kind: 'error',
        id,
        errorKind: event.kind,
        text: errorCopy(event.kind, event.message),
        recoverable: event.recoverable,
      }
      return {
        ...state,
        turnState: event.kind === 'interrupted' ? 'interrupted' : 'error',
        messages: [...settled, message],
        seq: state.seq + 1,
      }
    }
  }
}

/**
 * Fold one action into the transcript. Total and pure: unknown or out-of-turn events are no-ops
 * rather than throws, so a stray event between turns can never corrupt the message list.
 */
export function reduceTranscript(state: Transcript, action: TranscriptAction): Transcript {
  switch (action.type) {
    case 'user-send': {
      const userId = `u${String(state.seq)}`
      const assistantId = `a${String(state.seq + 1)}`
      const { turnId } = action
      const user: ChatMessage = { kind: 'user', id: userId, turnId, text: action.text }
      const assistant: ChatMessage = {
        kind: 'assistant',
        id: assistantId,
        turnId,
        text: '',
        tools: [],
        streaming: true,
        usage: null,
      }
      return {
        ...state,
        turnState: 'streaming',
        messages: [...state.messages, user, assistant],
        // A fresh turn: its `result` cost has not been folded yet. `AgentSession.send` opens the
        // turn on the same event, which is what keeps the two accumulators in step.
        cost: beginTurn(state.cost),
        seq: state.seq + 2,
      }
    }

    case 'interrupt-requested':
      // Only meaningful mid-stream; a Stop pressed when idle is a no-op the button also guards.
      if (state.turnState !== 'streaming') return state
      return { ...state, turnState: 'interrupted', messages: settleLive(state.messages) }

    case 'turn-refused': {
      // The renderer opens a turn the instant the user hits Send — that is what makes the assistant
      // bubble appear immediately — but main is the one that decides whether it runs. When main did
      // not open it, all three parts of that optimism have to come back, together:
      //
      //  - the **open turn**, or the renderer stays one ahead of main's ledger forever and a later
      //    stray `result` folds into a turn that never existed (the two counts feed the same guard);
      //  - the **bubbles**, because a user message shown in the transcript reads as sent, and this
      //    one never was;
      //  - the **text**, which `ChatPanel` restores to the composer so the turn can be retried.
      //
      // Found by the id the send minted, never by tail position: a Stop pressed during the round
      // trip settles the bubble, and a notice or a late delta from a prior turn can land behind it,
      // and neither changes the fact that main never ran this turn.
      const ownedByRefused = (message: ChatMessage): boolean =>
        (message.kind === 'user' || message.kind === 'assistant') &&
        message.turnId === action.turnId
      const refused = state.messages.filter(ownedByRefused)
      if (refused.length === 0) return state
      const wasLive = refused.some((message) => message.kind === 'assistant' && message.streaming)
      return {
        ...state,
        turnState: wasLive && state.turnState === 'streaming' ? 'idle' : state.turnState,
        messages: state.messages.filter((message) => !ownedByRefused(message)),
        cost: abandonTurn(state.cost),
      }
    }

    case 'agent-event':
      return applyAgentEvent(state, action.event)
  }
}
