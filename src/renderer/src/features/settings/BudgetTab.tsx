/**
 * Settings ▸ Budget (M2.5) — fills in the placeholder M2.7 left here.
 *
 * Two jobs: show what this session has cost against its cap, and set the cap. Both are deliberately
 * on one screen, because a limit chosen without seeing what a real session costs is a number picked
 * out of the air.
 *
 * The copy is explicit about the two semantics the guard depends on and that a user cannot infer:
 * the meter is **per session** (it resets when Sloodge restarts) and the estimate is **approximate**
 * (§10 — a client-side price table, never billing truth). Both are the kind of thing that, left
 * unsaid, turn into a support case about a number that "went missing" or "doesn't match the bill".
 */

import { useCallback, useEffect, useState, type ChangeEvent, type JSX } from 'react'
import {
  DEFAULT_BUDGET_CAP_USD,
  evaluateBudget,
  MAX_BUDGET_CAP_USD,
  parseBudgetCap,
  type BudgetCap,
} from '../../../../shared/agent/budget'
import { formatCostUsd } from '../../../../shared/agent/cost'
import { selectBudgetCap, selectBudgetLoaded, useBudgetStore } from '../../stores/budgetStore'
import { selectSessionCostUsd, useSessionMeterStore } from '../../stores/sessionMeterStore'
import { getAgentBridge } from '../chat/agentClient'

/** How a cap is rendered into the editable field. `null` (no limit) leaves it blank. */
function capToInput(cap: BudgetCap): string {
  return cap === null ? '' : cap.toFixed(2)
}

export function BudgetTab(): JSX.Element {
  const storedCap = useBudgetStore(selectBudgetCap)
  const loaded = useBudgetStore(selectBudgetLoaded)
  const setCap = useBudgetStore((state) => state.setCap)
  const spentUsd = useSessionMeterStore(selectSessionCostUsd)

  const [limited, setLimited] = useState(storedCap !== null)
  const [draft, setDraft] = useState(() => capToInput(storedCap))
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  // Re-sync when the probe resolves after the dialog opened. Keyed on the stored value so a user
  // mid-edit is not overwritten by their own save echoing back.
  useEffect(() => {
    setLimited(storedCap !== null)
    setDraft(capToInput(storedCap))
  }, [storedCap])

  const status = evaluateBudget(spentUsd, storedCap)

  const persist = useCallback(
    (cap: BudgetCap) => {
      const bridge = getAgentBridge()
      // Optimistic: the store is the renderer's mirror and main is authoritative, so we show the
      // new cap immediately and correct it from what main actually stored.
      setCap(cap)
      setSaved(true)
      if (bridge === undefined) return
      void bridge
        .setBudgetCap(cap)
        .then((stored) => {
          setCap(stored)
        })
        .catch(() => {
          setError('The budget could not be saved. It will reset when Sloodge restarts.')
        })
    },
    [setCap],
  )

  const onToggleLimit = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const next = event.currentTarget.checked
      setLimited(next)
      setError(null)
      if (next) {
        // Turning the limit back on restores the last cap the user had, or the default — never
        // "on, but blank", which would look enabled while capping nothing.
        const restored = parseBudgetCap(draft) ?? DEFAULT_BUDGET_CAP_USD
        setDraft(restored.toFixed(2))
        persist(restored)
      } else {
        persist(null)
      }
    },
    [draft, persist],
  )

  const onDraftChange = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    setDraft(event.currentTarget.value)
    setError(null)
    setSaved(false)
  }, [])

  const onCommit = useCallback(() => {
    if (!limited) return
    const parsed = parseBudgetCap(draft)
    if (parsed === undefined) {
      setError(`Enter an amount between $0.01 and $${String(MAX_BUDGET_CAP_USD)}.`)
      return
    }
    setDraft(parsed.toFixed(2))
    persist(parsed)
  }, [draft, limited, persist])

  return (
    <div className="flex flex-col gap-4">
      <section className="flex flex-col gap-1">
        <p className="text-[13px] text-shell-fg dark:text-ink-fg">
          This session has spent{' '}
          <span data-testid="budget-spend" className="font-medium">
            <span aria-hidden="true">≈</span> {formatCostUsd(spentUsd)}
          </span>
          {storedCap === null ? ' of an unlimited budget.' : <> of {formatCostUsd(storedCap)}.</>}
        </p>
        <p className="text-[12px] text-chrome-muted dark:text-ink-muted">
          Estimated from Claude&rsquo;s published prices, not from your bill. The total covers this
          session only and starts again when Sloodge restarts.
        </p>
        {status.level === 'blocked' ? (
          <p data-testid="budget-blocked" className="text-[12px] text-red-600 dark:text-red-400">
            The budget is used up, so new messages are being refused. Any turn already running was
            allowed to finish. Raise the limit below to continue.
          </p>
        ) : null}
        {status.level === 'warn' ? (
          <p className="text-[12px] text-amber-600 dark:text-amber-500">
            Approaching the limit. New messages stop once it is reached.
          </p>
        ) : null}
      </section>

      <section className="flex flex-col gap-2 border-t border-chrome-line pt-3 dark:border-ink-line">
        <label className="flex items-center gap-2 text-[13px] text-shell-fg dark:text-ink-fg">
          <input
            type="checkbox"
            checked={limited}
            disabled={!loaded}
            onChange={onToggleLimit}
            className="h-3.5 w-3.5 accent-[var(--color-accent,currentColor)]"
          />
          Limit what one session can spend
        </label>

        <div className="flex items-center gap-2 pl-5">
          <span aria-hidden="true" className="text-[13px] text-chrome-muted dark:text-ink-muted">
            $
          </span>
          <input
            type="text"
            inputMode="decimal"
            aria-label="Session budget in dollars"
            value={draft}
            disabled={!limited || !loaded}
            onChange={onDraftChange}
            onBlur={onCommit}
            className="w-24 rounded border border-chrome-line bg-white px-2 py-1 text-[13px] text-shell-fg disabled:opacity-50 dark:border-ink-line dark:bg-ink-alt dark:text-ink-fg"
          />
          <button
            type="button"
            disabled={!limited || !loaded}
            onClick={onCommit}
            className="rounded border border-chrome-line px-2.5 py-1 text-[12px] text-shell-fg disabled:opacity-50 dark:border-ink-line dark:text-ink-fg"
          >
            Save
          </button>
          {error === null && saved ? (
            <span className="text-[12px] text-chrome-muted dark:text-ink-muted">Saved</span>
          ) : null}
        </div>

        {error !== null ? (
          <p role="alert" className="pl-5 text-[12px] text-red-600 dark:text-red-400">
            {error}
          </p>
        ) : null}

        <p className="pl-5 text-[12px] text-chrome-muted dark:text-ink-muted">
          When the limit is reached Sloodge stops accepting new messages. A message already being
          answered is never cut off part-way — the work is paid for either way, and stopping
          mid-edit would leave the deck half-changed.
        </p>
      </section>
    </div>
  )
}
