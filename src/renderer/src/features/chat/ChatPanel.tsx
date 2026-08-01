import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type JSX,
  type KeyboardEvent,
} from 'react'
import { elementContextLabel } from '../../../../shared/design/element-context'
import { formatCostUsd } from '../../../../shared/agent/cost'
import { useDeckStore } from '../../stores/deckStore'
import { useChatContextStore } from './chatContextStore'
import type { ChatMessage, ToolChip } from './transcript'
import { useChatSession } from './useChatSession'

/**
 * Right-docked chat panel, live as of M2.3 (50-agent-integration.md §9, 20-ui-wireframes.md).
 *
 * It streams assistant output into a growing transcript, shows tool-call chips inline as the agent
 * writes ("✎ Editing slide"), and drives the composer through the four turn states: idle (Send),
 * streaming (spinner + Stop), and the error/interrupted end-states that surface as chat bubbles. All
 * the state logic lives in `useChatSession` / the pure `transcript` reducer; this file is the view.
 *
 * Deck hot-updates ride a separate feed (`deck:updated` → `deckStore.applyRemoteDeck`, wired in
 * `AppShell`), so the canvas and rail update mid-turn independently of this chat stream.
 */
export type ChatPanelProps = {
  /** Opens Settings on the Auth tab. Supplied by `AppShell`, which owns the dialog. */
  onOpenAuthSettings?: (() => void) | undefined
}

export function ChatPanel({ onOpenAuthSettings }: ChatPanelProps = {}): JSX.Element {
  const { transcript, needsAuth, hasBridge, send, interrupt } = useChatSession()
  const attachment = useChatContextStore((state) => state.attachment)
  const clearContext = useChatContextStore((state) => state.clear)
  const currentSlideId = useDeckStore((state) => state.currentSlideId)
  const [draft, setDraft] = useState('')
  const logRef = useRef<HTMLDivElement>(null)

  const streaming = transcript.turnState === 'streaming'
  const needsKey = hasBridge && needsAuth

  // Invalidate a stale context chip on slide switch: a bundle built for slide A must not ride a turn
  // sent while looking at slide B (the element isn't the one on screen, and the agent would edit the
  // wrong slide's element). The bundle records its own slide id, so drop it the moment the current
  // slide moves off it. Guarded on a non-null current slide so a deckless test host never clears.
  useEffect(() => {
    if (attachment !== null && currentSlideId !== null && attachment.slide.id !== currentSlideId) {
      clearContext()
    }
  }, [attachment, currentSlideId, clearContext])

  // Keep the newest message in view as the transcript grows or a turn streams in.
  useEffect(() => {
    const log = logRef.current
    if (log !== null) log.scrollTop = log.scrollHeight
  }, [transcript.messages, transcript.turnState])

  const submit = useCallback(() => {
    if (draft.trim().length === 0) return
    // A refused turn never runs, so the composer keeps the user's words to retry — and the context
    // chip stays attached to them. Clearing on a refusal would silently eat a message that was never
    // sent. `send` is **awaited** because the refusal can come from main (its own budget check, or a
    // credential that vanished), which is only known a round trip later; clearing optimistically was
    // exactly how a main-refused message used to disappear.
    void send(draft, attachment).then((accepted) => {
      if (!accepted) return
      // Consume the pending element context with this turn, then clear the chip.
      if (attachment !== null) clearContext()
      setDraft('')
    })
  }, [draft, send, attachment, clearContext])

  const onDraftChange = useCallback((event: ChangeEvent<HTMLTextAreaElement>) => {
    setDraft(event.target.value)
  }, [])

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      // Enter sends; Shift+Enter inserts a newline. IME composition (`isComposing`) must never
      // send — pressing Enter to accept a candidate would otherwise fire the turn.
      if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
        event.preventDefault()
        submit()
      }
    },
    [submit],
  )

  const canSend = hasBridge && !needsKey && !streaming && draft.trim().length > 0

  return (
    <aside
      aria-label="Chat"
      className="flex w-[320px] shrink-0 flex-col border-l border-chrome-line bg-chrome dark:border-ink-line dark:bg-ink"
    >
      <h2 className="border-b border-chrome-line px-3 py-2 text-[11px] font-semibold uppercase tracking-wider text-chrome-muted dark:border-ink-line dark:text-ink-muted">
        Chat
      </h2>

      <div
        ref={logRef}
        role="log"
        aria-label="Conversation"
        aria-live="polite"
        className="flex flex-1 flex-col gap-3 overflow-y-auto px-3 py-3"
      >
        {transcript.messages.length === 0 ? (
          <EmptyState />
        ) : (
          transcript.messages.map((message) => <MessageBubble key={message.id} message={message} />)
        )}
      </div>

      <div className="border-t border-chrome-line p-2 dark:border-ink-line">
        {needsKey ? <AuthGate onOpenSettings={onOpenAuthSettings} /> : null}

        <label className="sr-only" htmlFor="chat-composer">
          Ask Claude
        </label>
        <textarea
          id="chat-composer"
          rows={3}
          value={draft}
          disabled={streaming || needsKey}
          placeholder="Ask Claude…"
          onChange={onDraftChange}
          onKeyDown={onKeyDown}
          className="w-full resize-none rounded border border-chrome-line bg-white p-2 text-[13px] text-shell-fg outline-none placeholder:text-chrome-muted focus:border-accent disabled:opacity-60 dark:border-ink-line dark:bg-ink-alt dark:text-ink-fg"
        />
        <div className="mt-2 flex items-center gap-2">
          {attachment !== null ? (
            <span
              data-testid="chat-context-chip"
              title={`Element context: ${attachment.element.ancestorPath}`}
              className="inline-flex items-center gap-1 rounded-full border border-accent/50 bg-accent/10 px-2 py-0.5 text-[11px] text-shell-fg dark:text-ink-fg"
            >
              {elementContextLabel(attachment)}
              <button
                type="button"
                aria-label="Remove element context"
                data-testid="chat-context-remove"
                onClick={clearContext}
                className="ml-0.5 rounded-full px-1 leading-none text-chrome-muted hover:text-shell-fg dark:text-ink-muted dark:hover:text-ink-fg"
              >
                <span aria-hidden="true">×</span>
              </button>
            </span>
          ) : (
            <span
              data-testid="chat-context-empty"
              title="Select an element in Design Mode, then “Ask Claude about this element”"
              className="inline-flex items-center gap-1 rounded-full border border-dashed border-chrome-line px-2 py-0.5 text-[11px] text-chrome-muted dark:border-ink-line dark:text-ink-muted"
            >
              <span aria-hidden="true">⊕</span> no context
            </span>
          )}

          {transcript.cost.totalUsd > 0 ? (
            // Cost meter (10-architecture.md §1.3). Labelled "≈" — a client-side estimate from the
            // SDK's price table, never billing truth (50-agent-integration.md §10). The status bar
            // shows the same number from the same accumulator (M2.5); this one stays because it sits
            // next to the composer where the spending actually happens.
            <span className="text-[11px] text-chrome-muted dark:text-ink-muted">
              <span aria-hidden="true">≈</span>
              <span className="sr-only">approximately </span>{' '}
              {formatCostUsd(transcript.cost.totalUsd)} session
            </span>
          ) : null}

          {streaming ? (
            <button
              type="button"
              onClick={interrupt}
              className="ml-auto inline-flex items-center gap-1 rounded border border-chrome-line px-3 py-1 text-[12px] font-medium text-shell-fg transition-colors hover:bg-chrome-line/40 dark:border-ink-line dark:text-ink-fg"
            >
              <span aria-hidden="true">◼</span> Stop
            </button>
          ) : (
            <button
              type="button"
              onClick={submit}
              disabled={!canSend}
              aria-disabled={!canSend}
              title={hasBridge ? 'Send (Enter)' : 'Chat is unavailable in this window'}
              className="ml-auto inline-flex items-center gap-1 rounded bg-accent px-3 py-1 text-[12px] font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-40"
            >
              Send <span aria-hidden="true">➤</span>
            </button>
          )}
        </div>
      </div>
    </aside>
  )
}

function EmptyState(): JSX.Element {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 text-center">
      <span aria-hidden="true" className="text-lg text-chrome-muted dark:text-ink-muted">
        ✦
      </span>
      <p className="text-[12px] leading-relaxed text-chrome-muted dark:text-ink-muted">
        No messages yet. Describe the deck you want and Claude will build it slide by slide.
      </p>
    </div>
  )
}

function MessageBubble({ message }: { message: ChatMessage }): JSX.Element {
  if (message.kind === 'user') {
    return (
      <div className="self-end rounded-lg bg-accent px-3 py-2 text-[13px] text-white">
        <p className="whitespace-pre-wrap">{message.text}</p>
      </div>
    )
  }

  if (message.kind === 'error') {
    return (
      <div
        role="alert"
        className="self-start rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-[13px] text-red-800 dark:border-red-800 dark:bg-red-950 dark:text-red-200"
      >
        <p className="whitespace-pre-wrap">⚠ {message.text}</p>
      </div>
    )
  }

  if (message.kind === 'notice') {
    // `status`, not `alert`: the session works, it is just degraded. Deliberately quiet chrome so it
    // reads as a caveat on the answer rather than a failure of it (M2.4, §8).
    return (
      <div
        role="status"
        data-testid="chat-notice"
        className="self-start rounded-lg border border-dashed border-chrome-line px-3 py-2 text-[12px] text-chrome-muted dark:border-ink-line dark:text-ink-muted"
      >
        <p className="whitespace-pre-wrap">{message.text}</p>
      </div>
    )
  }

  return (
    <div className="self-start rounded-lg bg-white px-3 py-2 text-[13px] text-shell-fg dark:bg-ink-alt dark:text-ink-fg">
      <p className="mb-1 flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wide text-chrome-muted dark:text-ink-muted">
        <span aria-hidden="true">●</span> Claude
      </p>
      {message.tools.length > 0 ? (
        <ul className="mb-1 flex flex-col gap-1">
          {message.tools.map((tool) => (
            <ToolChipRow key={tool.toolUseId} chip={tool} />
          ))}
        </ul>
      ) : null}
      {message.text.length > 0 ? (
        <p className="whitespace-pre-wrap">{message.text}</p>
      ) : message.streaming ? (
        message.tools.length === 0 ? (
          <p className="text-chrome-muted dark:text-ink-muted">
            <span className="inline-flex gap-0.5" aria-label="Claude is typing">
              <span className="animate-pulse">●</span>
            </span>
          </p>
        ) : null
      ) : message.tools.length === 0 ? (
        // A settled turn that produced no text and no tool calls: say so rather than leave a bare
        // "● Claude" header that reads as a rendering bug.
        <p className="italic text-chrome-muted dark:text-ink-muted">(no response)</p>
      ) : null}
    </div>
  )
}

function ToolChipRow({ chip }: { chip: ToolChip }): JSX.Element {
  return (
    <li className="inline-flex w-fit items-center gap-1 rounded-full bg-chrome-line/40 px-2 py-0.5 text-[11px] text-chrome-muted dark:bg-ink-line/60 dark:text-ink-muted">
      <span aria-hidden="true">{chip.glyph}</span> {chip.text}…
    </li>
  )
}

/**
 * The composer's unauthenticated state (M2.7).
 *
 * Through M2.6 this was an inline key form. It is now a link into Settings > Auth, because there must
 * be exactly one place a credential is entered - two entry points means two validation paths, two
 * masking rules, and a real chance they drift. It also means the composer never has to explain the
 * subscription-vs-key choice in the width of a sidebar.
 */
function AuthGate({ onOpenSettings }: { onOpenSettings?: (() => void) | undefined }): JSX.Element {
  return (
    <div className="mb-2 rounded border border-accent/40 bg-accent/5 p-2 text-[12px]">
      <p className="mb-1 font-medium text-shell-fg dark:text-ink-fg">Set up authentication</p>
      <p className="mb-2 text-[11px] text-chrome-muted dark:text-ink-muted">
        Sign in with your Claude subscription, or add an API key, before Claude can build slides.
      </p>
      <button
        type="button"
        onClick={onOpenSettings}
        className="rounded bg-accent px-2 py-1 text-[12px] font-medium text-white"
      >
        Open Settings
      </button>
    </div>
  )
}
