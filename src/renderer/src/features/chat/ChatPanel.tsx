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
import { Button, Chip, FOCUS_RING, Notice, PanelHeading } from '../../components/ui'
import { useDeckStore } from '../../stores/deckStore'
import { useChatContextStore } from './chatContextStore'
import type { ChatMessage, ToolChip, Transcript } from './transcript'
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
 *
 * M8b.3 surface 1 (ui-design-audit.md §4.4, §7 row 1): the view is drawn from the role tokens and
 * the M8b.2 primitives — `Button` for Send / Stop / Open Settings, `Chip` for the context and tool
 * pills, `Notice` for the error bubble, `PanelHeading` for the title — with no `dark:` twins (a role
 * token swaps by mode on its own, R1), no palette colour, no invented alpha (R3) and no focus ring
 * of its own (R6). Findings closed here: U2/U4 (composer fill and border), U10 (its focus ring), U12
 * (context-chip border), U13 (auth-gate border), U18 (error-bubble border).
 */
export type ChatPanelProps = {
  /** Opens Settings on the Auth tab. Supplied by `AppShell`, which owns the dialog. */
  onOpenAuthSettings?: (() => void) | undefined
}

/**
 * The composer is a `<textarea>` and `Input` renders an `<input>`, so it cannot adopt the primitive
 * itself. This is `Input`'s recipe without the fixed `h-control` — a three-row field is not a 28px
 * control — spelling the same `bg-field` / `border-line-strong` pair the audit prescribes for U2 and
 * U4 (field vs panel is identified by the border, census rows 40 and 54), and the shared
 * `FOCUS_RING` for U10 rather than the `focus:border-accent` it replaced.
 */
const COMPOSER = `w-full min-w-0 resize-none rounded-control border border-line-strong bg-field px-2 py-1 text-ui text-text placeholder:text-text-muted disabled:cursor-default disabled:opacity-50 ${FOCUS_RING}`

/**
 * A message fades in on mount at `duration-base` — the one chat animation M8b.0 §3.1 approved.
 * `@starting-style` (the `starting:` variant) fires only when the element enters the document, so a
 * streaming bubble re-rendering on every delta never replays it; reduced-motion keeps opacity
 * transitions at `duration-fast` (theme.css), so the cue survives the preference. The transcript is
 * never smooth-scrolled (F7): the effect below assigns `scrollTop` directly.
 */
const ARRIVE = 'transition-opacity duration-base starting:opacity-0'

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
    const submitted = draft
    if (submitted.trim().length === 0) return
    // A refused turn never runs, so the composer keeps the user's words to retry — and the context
    // chip stays attached to them. Clearing on a refusal would silently eat a message that was never
    // sent. `send` is **awaited** because the refusal can come from main (its own budget check, or a
    // credential that vanished), which is only known a round trip later; clearing optimistically was
    // exactly how a main-refused message used to disappear.
    void send(submitted, attachment).then((accepted) => {
      if (!accepted) return
      // Clear only what was sent. Stop re-enables the composer while the accept is still in flight,
      // so text typed or a chip attached in that window is the user's next message, not this one's.
      if (attachment !== null && useChatContextStore.getState().attachment === attachment) {
        clearContext()
      }
      setDraft((current) => (current === submitted ? '' : current))
    })
  }, [draft, send, attachment, clearContext])

  const onDraftChange = useCallback((event: ChangeEvent<HTMLTextAreaElement>) => {
    setDraft(event.target.value)
  }, [])

  const canSend = hasBridge && !needsKey && !streaming && draft.trim().length > 0

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      // Enter sends; Shift+Enter inserts a newline. IME composition (`isComposing`) must never
      // send — pressing Enter to accept a candidate would otherwise fire the turn. The same gate as
      // the button, so Enter with no bridge is inert for the same reason the hint below states.
      if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
        event.preventDefault()
        if (canSend) submit()
      }
    },
    [submit, canSend],
  )

  // Turn boundaries, announced once each (ui-design-direction.md §3.2 #12). `role="log"` is already
  // a polite live region, and a token-by-token stream inside one re-reads the growing answer on
  // every delta; `aria-busy` on the log holds those announcements until the turn settles, and this
  // one stable region says how it settled — keyed on the turn state, not on `streaming` alone, so
  // Stop is not read out as a finish (`announce`, below). Derived, not stored: the text changes
  // only at a boundary, which is exactly when a live region should speak.
  const announcement = announce(transcript)

  return (
    <aside
      aria-label="Chat"
      className="flex w-chat shrink-0 flex-col border-l border-line bg-surface"
    >
      <div className="border-b border-line px-3 py-2">
        <PanelHeading level={2}>Chat</PanelHeading>
      </div>

      <div
        ref={logRef}
        role="log"
        aria-label="Conversation"
        aria-busy={streaming}
        className="flex flex-1 flex-col gap-3 overflow-y-auto px-3 py-3"
      >
        {transcript.messages.length === 0 ? (
          <EmptyState />
        ) : (
          transcript.messages.map((message) => <MessageBubble key={message.id} message={message} />)
        )}
      </div>
      <p className="sr-only" aria-live="polite">
        {announcement}
      </p>

      <div className="flex flex-col gap-2 border-t border-line p-2">
        {needsKey ? <AuthGate onOpenSettings={onOpenAuthSettings} /> : null}
        {hasBridge ? null : (
          // The reason Send and Enter do nothing, on screen rather than only in the button's tooltip.
          <p className="text-caption text-text-muted">Chat is unavailable in this window.</p>
        )}

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
          className={COMPOSER}
        />
        <div className="flex items-center gap-2">
          {attachment !== null ? (
            // The test id and tooltip sit on a wrapper because `Chip` owns its own attributes; the
            // ✕ inside it is labelled "Remove element context" by the primitive.
            <span
              data-testid="chat-context-chip"
              title={`Element context: ${attachment.element.ancestorPath}`}
              className="flex min-w-0"
            >
              <Chip tone="accent" label="element context" onRemove={clearContext}>
                {elementContextLabel(attachment)}
              </Chip>
            </span>
          ) : (
            // An empty slot, not a chip: dashed `line-strong` so the outline is visible on the panel
            // (3.79 / 3.52) where a hairline `line` would not be, and muted text because it is inert.
            <span
              data-testid="chat-context-empty"
              title="Select an element in Design Mode, then “Ask Claude about this element”"
              className="inline-flex items-center gap-1 rounded-full border border-dashed border-line-strong px-2 py-0.5 text-caption text-text-muted"
            >
              <span aria-hidden="true">⊕</span> no context
            </span>
          )}

          {transcript.cost.totalUsd > 0 ? (
            // Cost meter (10-architecture.md §1.3). Labelled "≈" — a client-side estimate from the
            // SDK's price table, never billing truth (50-agent-integration.md §10). The status bar
            // shows the same number from the same accumulator (M2.5); this one stays because it sits
            // next to the composer where the spending actually happens.
            <span className="text-caption text-text-muted">
              <span aria-hidden="true">≈</span>
              <span className="sr-only">approximately </span>{' '}
              {formatCostUsd(transcript.cost.totalUsd)} session
            </span>
          ) : null}

          <span className="ml-auto">
            {streaming ? (
              <Button variant="secondary" onClick={interrupt}>
                <span aria-hidden="true">◼</span> Stop
              </Button>
            ) : (
              <Button
                variant="primary"
                onClick={submit}
                disabled={!canSend}
                aria-disabled={!canSend}
                title={hasBridge ? 'Send (Enter)' : 'Chat is unavailable in this window'}
              >
                Send <span aria-hidden="true">➤</span>
              </Button>
            )}
          </span>
        </div>
      </div>
    </aside>
  )
}

function EmptyState(): JSX.Element {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 text-center">
      <span aria-hidden="true" className="text-title text-text-muted">
        ✦
      </span>
      <p className="text-ui-sm text-text-muted">
        No messages yet. Describe the deck you want and Claude will build it slide by slide.
      </p>
    </div>
  )
}

function MessageBubble({ message }: { message: ChatMessage }): JSX.Element {
  if (message.kind === 'user') {
    return (
      <div className={`self-end rounded-panel bg-accent px-3 py-2 text-ui text-on-fill ${ARRIVE}`}>
        <p className="whitespace-pre-wrap">{message.text}</p>
      </div>
    )
  }

  if (message.kind === 'error') {
    // `alert`, deliberately: a failed turn is the one thing in this transcript that must interrupt.
    return (
      <div className={`self-start ${ARRIVE}`}>
        <Notice tone="danger" role="alert" icon="⚠">
          <span className="whitespace-pre-wrap">{message.text}</span>
        </Notice>
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
        className={`self-start rounded-panel bg-surface-sunken px-3 py-2 text-ui-sm text-text-muted ${ARRIVE}`}
      >
        <p className="whitespace-pre-wrap">{message.text}</p>
      </div>
    )
  }

  return (
    <div
      className={`flex flex-col gap-1 self-start rounded-panel bg-surface-raised px-3 py-2 text-ui text-text shadow-raised ${ARRIVE}`}
    >
      <p className="flex items-center gap-1 text-caption font-semibold uppercase tracking-caps text-text-muted">
        <span aria-hidden="true">●</span> Claude
      </p>
      {message.tools.length > 0 ? (
        <ul className="flex flex-col gap-1">
          {message.tools.map((tool) => (
            <ToolChipRow key={tool.toolUseId} chip={tool} />
          ))}
        </ul>
      ) : null}
      {message.text.length > 0 ? (
        <p className="whitespace-pre-wrap">{message.text}</p>
      ) : message.streaming ? (
        message.tools.length === 0 ? (
          // `animate-working` is the 900ms opacity dip; under reduced motion theme.css runs it once,
          // which leaves the static "…" the audit asks for.
          <p className="text-text-muted">
            <span className="animate-working" aria-label="Claude is typing">
              …
            </span>
          </p>
        ) : null
      ) : message.tools.length === 0 ? (
        // A settled turn that produced no text and no tool calls: say so rather than leave a bare
        // "● Claude" header that reads as a rendering bug.
        <p className="text-text-muted italic">(no response)</p>
      ) : null}
    </div>
  )
}

function ToolChipRow({ chip }: { chip: ToolChip }): JSX.Element {
  return (
    <li className="flex">
      <Chip>
        <span aria-hidden="true">{chip.glyph}</span> {chip.text}…
      </Chip>
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
 *
 * `bg-accent-soft` with a full-strength `border-accent` (4.52 / 3.87 on its own tint, 4.97 / 5.09 on
 * the panel) because this box is a call to action, not a label — the audit's U13 replacement.
 */
function AuthGate({ onOpenSettings }: { onOpenSettings?: (() => void) | undefined }): JSX.Element {
  return (
    <div className="flex flex-col gap-2 rounded-panel border border-accent bg-accent-soft p-2 text-ui-sm text-text">
      <div>
        <p className="font-medium">Set up authentication</p>
        <p>
          Sign in with your Claude subscription, or add an API key, before Claude can build slides.
        </p>
      </div>
      <div>
        <Button variant="primary" onClick={onOpenSettings}>
          Open Settings
        </Button>
      </div>
    </div>
  )
}

/**
 * What the `sr-only` region says for the turn's state. A finish is only a finish: Stop settles the
 * turn as `interrupted` with no bubble of its own, so this sentence is the one thing that tells a
 * screen-reader user their Stop took. A failed turn says nothing here — the reducer appends the
 * `role="alert"` bubble on every `error` event, including a budget refusal that never streamed, and
 * that assertive region is the announcement; a second sentence would read the failure twice, or
 * call a refused send a "response". `idle` before the first turn is the empty string, so mount says
 * nothing.
 */
function announce(transcript: Transcript): string {
  switch (transcript.turnState) {
    case 'streaming':
      return 'Claude is responding'
    case 'interrupted':
      return 'Response stopped'
    case 'error':
      return ''
    case 'idle':
      return transcript.messages.length > 0 ? 'Claude has finished responding' : ''
  }
}
