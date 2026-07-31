import type { JSX } from 'react'

export type StatusBarProps = {
  currentSlide: number
  slideCount: number
  themeName: string
  issueCount: number
  sessionCost: string
}

/**
 * Bottom status bar: deck position, theme, slide-contract issues, session cost
 * and Present. All values are placeholders in M0.4 and Present is a no-op.
 */
export function StatusBar({
  currentSlide,
  slideCount,
  themeName,
  issueCount,
  sessionCost,
}: StatusBarProps): JSX.Element {
  return (
    <footer
      aria-label="Status bar"
      className="flex h-7 shrink-0 items-center gap-3 border-t border-chrome-line bg-chrome px-3 text-[11px] text-chrome-muted dark:border-ink-line dark:bg-ink dark:text-ink-muted"
    >
      <span>
        Slide {currentSlide} of {slideCount}
      </span>
      <span aria-hidden="true" className="h-3 w-px bg-chrome-line dark:bg-ink-line" />
      <span>theme: {themeName}</span>
      <span aria-hidden="true" className="h-3 w-px bg-chrome-line dark:bg-ink-line" />
      <span>
        <span aria-hidden="true">⚠</span> {issueCount} issues
      </span>
      <span aria-hidden="true" className="h-3 w-px bg-chrome-line dark:bg-ink-line" />
      <span>{sessionCost} session</span>

      <button
        type="button"
        aria-disabled="true"
        title="Present (not wired up yet)"
        className="ml-auto inline-flex items-center gap-1.5 rounded border border-chrome-line bg-white px-2.5 py-0.5 text-[11px] font-medium text-shell-fg transition-colors hover:border-accent hover:text-accent dark:border-ink-line dark:bg-ink-alt dark:text-ink-fg"
      >
        <svg aria-hidden="true" viewBox="0 0 16 16" className="h-3 w-3" fill="none">
          <rect x="1.5" y="2.5" width="13" height="9" rx="1.5" stroke="currentColor" />
          <path d="M5.5 13.5h5" stroke="currentColor" strokeLinecap="round" />
        </svg>
        Present
      </button>
    </footer>
  )
}
