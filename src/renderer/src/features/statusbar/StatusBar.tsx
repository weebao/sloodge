import { useMemo, type JSX } from 'react'
import { formatCostUsd } from '../../../../shared/agent/cost'
import type { BudgetStatus } from '../../../../shared/agent/budget'
import type { SessionSkills } from '../../stores/sessionMeterStore'

/**
 * What File ▸ Open has to say (M4.5). An `error` is a file that could not be opened; a `warning` is
 * an open that succeeded but lost something (slides over the cap, text-only fallbacks, dropped
 * images), summarised in `message` with each item in `details`.
 */
export type OpenStatus = {
  readonly severity: 'error' | 'warning'
  readonly message: string
  readonly details: readonly string[]
}

export type StatusBarProps = {
  currentSlide: number
  slideCount: number
  themeName: string
  issueCount: number
  /**
   * The session's spend estimate in dollars (M2.5). A **number**, not preformatted text: the bar
   * decides how to render it, and the budget colouring below has to reason about the value anyway.
   */
  sessionCostUsd: number
  /** The session against its cap (§10). `level: 'off'` renders the meter with no cap alongside it. */
  budget: BudgetStatus
  /**
   * The cap could not be read from main (M2.5). `budget` is then evaluated uncapped, but the session
   * is *not* uncapped — main enforces the real cap — so the meter says the limit is unknown instead
   * of showing a bare spend that reads as "no limit".
   */
  budgetUnknown?: boolean
  /** How the session loaded its slide skills (§8). `null` before the first init; see below. */
  skills: SessionSkills
  /**
   * Enter Present mode (M4.1). Optional: without it the button stays the disabled placeholder it was
   * through M0.4, so the status bar is still renderable in isolation without standing up Present.
   */
  onPresent?: () => void
  /**
   * The outcome of the last File ▸ Open (M4.5). Shown here rather than in a modal: a failed open is
   * informational — the previous document is still on screen and still editable — and a lossy import
   * is a fact about the new document, not a decision; a dialog would demand a dismissal the user has
   * nothing to decide about. The full text, details included, is the tooltip.
   */
  openStatus?: OpenStatus | null
}

/** The one segment whose absence is the good news — see `SkillsIndicator`. */
function skillsLabel(skills: SessionSkills): string | null {
  if (skills === 'fallback') return 'skills: fallback'
  if (skills === 'unavailable') return 'skills: unavailable'
  return null
}

/**
 * 50-agent-integration.md §8's status line, the half of the fallback story that makes the other half
 * honest: `AgentSession` will silently restart a skill-less session with a different prompt shape,
 * and §8 requires that never be invisible.
 *
 * Shown **only when something is off-nominal**. A healthy session (`ok`) and a session that has not
 * started yet (`null`) render nothing: a permanent "skills: ok" would be four more words of chrome
 * that are true 99.9% of the time, which is precisely how a status indicator stops being read.
 */
function SkillsIndicator({ skills }: { skills: SessionSkills }): JSX.Element | null {
  const label = skillsLabel(skills)
  if (label === null) return null
  const degraded = skills === 'unavailable'
  return (
    <>
      <span aria-hidden="true" className="h-3 w-px bg-chrome-line dark:bg-ink-line" />
      <span
        data-testid="statusbar-skills"
        title={
          degraded
            ? 'The bundled slide skills could not be loaded for this session. Slides may not follow Sloodge’s design rules.'
            : 'Slide skills could not be loaded from disk, so this session inlines them into the prompt instead. Same output, higher token cost per turn.'
        }
        className={
          degraded ? 'text-red-600 dark:text-red-400' : 'text-amber-600 dark:text-amber-500'
        }
      >
        {label}
      </span>
    </>
  )
}

/**
 * The cost meter (§10, 20-ui-wireframes.md). Always prefixed "≈": `total_cost_usd` is a client-side
 * estimate from the SDK's bundled price table and is never billing truth, so the symbol travels with
 * the number everywhere it is shown.
 *
 * When a cap is configured it reads `≈ $0.42 / $2.00 session` with a thin progress bar — §10's
 * `$0.34 / $2.00 ▓▓▓░░░░░`. Amber from 80%, red once the cap is reached and turns are refused, so
 * the moment the composer starts saying no is visible *before* the user is told no.
 */
function CostMeter({
  costUsd,
  budget,
  budgetUnknown,
}: {
  costUsd: number
  budget: BudgetStatus
  budgetUnknown: boolean
}): JSX.Element {
  const capped = budget.level !== 'off' && budget.capUsd !== null
  const tone =
    budget.level === 'blocked'
      ? 'text-red-600 dark:text-red-400'
      : budget.level === 'warn' || budgetUnknown
        ? 'text-amber-600 dark:text-amber-500'
        : undefined
  const barTone =
    budget.level === 'blocked'
      ? 'bg-red-500'
      : budget.level === 'warn'
        ? 'bg-amber-500'
        : 'bg-accent'
  // Memoized so the fill is not a fresh object prop on every status-bar render (react-perf). The
  // bar re-renders on every streamed token's cost update, which is exactly when it matters.
  const fillStyle = useMemo(
    () => ({ width: `${String(Math.round(budget.fraction * 100))}%` }),
    [budget.fraction],
  )

  return (
    <span className="inline-flex items-center gap-1.5">
      <span
        data-testid="statusbar-cost"
        className={tone}
        title={
          budgetUnknown
            ? 'Your saved limit could not be read. Sloodge is still enforcing it; open Settings ▸ Budget to retry.'
            : undefined
        }
      >
        <span aria-hidden="true">≈</span>
        <span className="sr-only">approximately </span> {formatCostUsd(costUsd)}
        {budget.capUsd !== null ? ` / ${formatCostUsd(budget.capUsd)}` : ''}
        {budgetUnknown ? ' / limit unknown' : ''} session
      </span>
      {capped ? (
        <span
          data-testid="statusbar-budget-bar"
          // The number next to it is the accessible value; the bar is decoration for a glance.
          aria-hidden="true"
          className="h-1 w-10 overflow-hidden rounded-full bg-chrome-line dark:bg-ink-line"
        >
          <span className={`block h-full rounded-full ${barTone}`} style={fillStyle} />
        </span>
      ) : null}
    </span>
  )
}

/**
 * Bottom status bar: deck position, theme, slide-contract issues, the session cost meter with its
 * budget state, the §8 skills indicator, and Present.
 *
 * `themeName` and `issueCount` are still placeholders; the cost and budget segments are live as of
 * M2.5, fed from `sessionMeterStore` + `budgetStore` by `AppShell`.
 */
export function StatusBar({
  currentSlide,
  slideCount,
  themeName,
  issueCount,
  sessionCostUsd,
  budget,
  budgetUnknown = false,
  skills,
  onPresent,
  openStatus = null,
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
      <SkillsIndicator skills={skills} />
      <span aria-hidden="true" className="h-3 w-px bg-chrome-line dark:bg-ink-line" />
      <CostMeter costUsd={sessionCostUsd} budget={budget} budgetUnknown={budgetUnknown} />
      {openStatus === null ? null : (
        <>
          <span aria-hidden="true" className="h-3 w-px bg-chrome-line dark:bg-ink-line" />
          <span
            role="status"
            title={[openStatus.message, ...openStatus.details].join('\n')}
            className={`max-w-[40ch] truncate ${openStatus.severity === 'error' ? 'text-danger' : 'text-warning'}`}
          >
            <span aria-hidden="true">⚠</span> {openStatus.message}
          </span>
        </>
      )}

      <button
        type="button"
        aria-disabled={onPresent ? undefined : 'true'}
        title={onPresent ? 'Present (fullscreen)' : 'Present (not wired up yet)'}
        onClick={onPresent}
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
