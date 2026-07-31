import type { JSX } from 'react'

/**
 * Right-docked chat panel. M0.4 renders a static transcript placeholder and an
 * inert composer; streaming, tool-call chips and the context bundle land with
 * the agent milestone.
 */
export function ChatPanel(): JSX.Element {
  return (
    <aside
      aria-label="Chat"
      className="flex w-[320px] shrink-0 flex-col border-l border-chrome-line bg-chrome dark:border-ink-line dark:bg-ink"
    >
      <h2 className="border-b border-chrome-line px-3 py-2 text-[11px] font-semibold uppercase tracking-wider text-chrome-muted dark:border-ink-line dark:text-ink-muted">
        Chat
      </h2>

      <div
        role="log"
        aria-label="Conversation"
        className="flex flex-1 flex-col items-center justify-center gap-2 overflow-y-auto px-4 text-center"
      >
        <span aria-hidden="true" className="text-lg text-chrome-muted dark:text-ink-muted">
          ✦
        </span>
        <p className="text-[12px] leading-relaxed text-chrome-muted dark:text-ink-muted">
          No messages yet. Describe the deck you want and Claude will build it slide by slide.
        </p>
      </div>

      <div className="border-t border-chrome-line p-2 dark:border-ink-line">
        <label className="sr-only" htmlFor="chat-composer">
          Ask Claude
        </label>
        <textarea
          id="chat-composer"
          rows={3}
          placeholder="Ask Claude…"
          className="w-full resize-none rounded border border-chrome-line bg-white p-2 text-[13px] text-shell-fg outline-none placeholder:text-chrome-muted focus:border-accent dark:border-ink-line dark:bg-ink-alt dark:text-ink-fg"
        />
        <div className="mt-2 flex items-center gap-2">
          <span className="inline-flex items-center gap-1 rounded-full border border-dashed border-chrome-line px-2 py-0.5 text-[11px] text-chrome-muted dark:border-ink-line dark:text-ink-muted">
            <span aria-hidden="true">⊕</span> no context
          </span>
          <button
            type="button"
            aria-disabled="true"
            title="Send (not wired up yet)"
            className="ml-auto inline-flex items-center gap-1 rounded bg-accent px-3 py-1 text-[12px] font-medium text-white transition-opacity hover:opacity-90"
          >
            Send <span aria-hidden="true">➤</span>
          </button>
        </div>
      </div>
    </aside>
  )
}
