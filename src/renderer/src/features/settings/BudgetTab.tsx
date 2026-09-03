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

import { useCallback, useEffect, useRef, useState, type ChangeEvent, type JSX } from 'react'
import {
  DEFAULT_BUDGET_CAP_USD,
  evaluateBudget,
  MAX_BUDGET_CAP_USD,
  parseBudgetCap,
  type BudgetCap,
} from '../../../../shared/agent/budget'
import { formatCostUsd } from '../../../../shared/agent/cost'
import {
  selectBudgetCap,
  selectBudgetFailed,
  selectBudgetLoaded,
  useBudgetStore,
} from '../../stores/budgetStore'
import { selectSessionCostUsd, useSessionMeterStore } from '../../stores/sessionMeterStore'
import { getAgentBridge } from '../chat/agentClient'

/** How a cap is rendered into the editable field. `null` (no limit) leaves it blank. */
function capToInput(cap: BudgetCap): string {
  return cap === null ? '' : cap.toFixed(2)
}

export function BudgetTab(): JSX.Element {
  const storedCap = useBudgetStore(selectBudgetCap)
  const loaded = useBudgetStore(selectBudgetLoaded)
  const probeFailed = useBudgetStore(selectBudgetFailed)
  const setCap = useBudgetStore((state) => state.setCap)
  const markFailed = useBudgetStore((state) => state.markFailed)
  const spentUsd = useSessionMeterStore(selectSessionCostUsd)

  // The store seeds a placeholder default before the probe resolves; it is not the user's cap and
  // must not be rendered as one. Until `loaded`, the controls show nothing — as the status line and
  // the guard already do — rather than a ticked box and "2.00" that silently flip a moment later.
  const knownCap: BudgetCap = loaded ? storedCap : null
  const [limited, setLimited] = useState(knownCap !== null)
  const [draft, setDraft] = useState(() => capToInput(knownCap))
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  /** The user asked to remove the limit and has not confirmed it yet. */
  const [confirmingUncap, setConfirmingUncap] = useState(false)
  /** Orders overlapping saves: only the newest one's reply may write the field or the store. */
  const persistSeq = useRef(0)

  // Re-probe on open when the store has no cap yet. `useChatSession` probes once at startup and
  // records a failure, which used to leave every control here disabled for the rest of the run with
  // nothing on screen explaining why. Opening Settings is the natural place to retry.
  useEffect(() => {
    if (loaded) return
    const bridge = getAgentBridge()
    if (bridge === undefined) return
    let live = true
    void bridge
      .getBudgetCap()
      .then((cap) => {
        if (live) setCap(cap)
      })
      .catch(() => {
        if (live) markFailed()
      })
    return () => {
      live = false
    }
  }, [loaded, setCap, markFailed])

  // Re-sync when the probe resolves after the dialog opened. Keyed on the known value so a user
  // mid-edit is not overwritten by their own save echoing back.
  useEffect(() => {
    setLimited(knownCap !== null)
    setDraft(capToInput(knownCap))
  }, [knownCap])

  const status = evaluateBudget(spentUsd, knownCap)
  // A failed probe still permits editing: a save is independently validated in main, so the worst
  // case is the user setting the cap they wanted anyway.
  const editable = loaded || probeFailed

  const persist = useCallback(
    (cap: BudgetCap) => {
      const bridge = getAgentBridge()
      // Nothing to save to: neither "Saved" nor a mirror-store value main has never heard of.
      if (bridge === undefined) return
      persistSeq.current += 1
      const seq = persistSeq.current
      // Optimistic: the store is the renderer's mirror and main is authoritative, so we show the
      // new cap immediately and correct it from what main actually stored.
      const previous = knownCap
      setCap(cap)
      setSaved(true)
      void bridge
        .setBudgetCap(cap)
        .then((stored) => {
          if (seq !== persistSeq.current) return
          setCap(stored)
          // "Saved" only if main stored what was asked. A malformed reply rejects (preload) and
          // lands below; this covers main legitimately storing something else.
          setSaved(Object.is(stored, cap))
        })
        .catch(() => {
          if (seq !== persistSeq.current) return
          // Roll the optimism back rather than leaving the UI showing a cap main does not have —
          // the guard would then be enforced against a different number than the one on screen.
          // The field is reset explicitly: the store bails on an equal write, so its effect alone
          // would not repaint a value the store never saw change.
          setCap(previous)
          setLimited(previous !== null)
          setDraft(capToInput(previous))
          setSaved(false)
          setError('The budget could not be saved, so the previous limit still applies.')
        })
    },
    [setCap, knownCap],
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
        setConfirmingUncap(false)
        persist(restored)
      } else {
        // Removing a spend limit is not a thing to do by brushing a checkbox. Ask first, and do not
        // report "Saved" for something that has not been saved.
        setConfirmingUncap(true)
        setLimited(true)
      }
    },
    [draft, persist],
  )

  const confirmUncap = useCallback(() => {
    setConfirmingUncap(false)
    setLimited(false)
    persist(null)
  }, [persist])

  const cancelUncap = useCallback(() => {
    setConfirmingUncap(false)
    setLimited(true)
  }, [])

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
    // Clicking Save blurs the field first, so both handlers fire for one action; the second sees
    // the value already stored and does nothing.
    if (loaded && parsed === storedCap) return
    persist(parsed)
  }, [draft, limited, loaded, storedCap, persist])

  return (
    <div className="flex flex-col gap-4">
      <section className="flex flex-col gap-1">
        <p className="text-[13px] text-shell-fg dark:text-ink-fg">
          This session has spent{' '}
          <span data-testid="budget-spend" className="font-medium">
            <span aria-hidden="true">≈</span>
            <span className="sr-only">approximately </span> {formatCostUsd(spentUsd)}
          </span>
          {knownCap === null ? (
            loaded ? (
              ' of an unlimited budget.'
            ) : (
              '.'
            )
          ) : (
            <> of {formatCostUsd(knownCap)}.</>
          )}
        </p>
        {!loaded ? (
          <p
            data-testid="budget-unloaded"
            className="text-[12px] text-amber-600 dark:text-amber-500"
          >
            {probeFailed
              ? 'Your saved limit could not be read, so nothing is being enforced right now. Setting one below will store it.'
              : 'Reading your saved limit…'}
          </p>
        ) : null}
        <p className="text-[12px] text-chrome-muted dark:text-ink-muted">
          Estimated from Claude&rsquo;s published prices, not from your bill. The total covers this
          session only and starts again when Sloodge restarts.
        </p>
        {status.level === 'blocked' ? (
          <p data-testid="budget-blocked" className="text-[12px] text-red-600 dark:text-red-400">
            The budget is used up, so new messages are being refused. Raise the limit below to
            continue.
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
            disabled={!editable}
            onChange={onToggleLimit}
            className="h-3.5 w-3.5 accent-[var(--color-accent,currentColor)]"
          />
          Limit what one session can spend
        </label>

        {confirmingUncap ? (
          <div
            data-testid="budget-confirm-uncap"
            className="ml-5 flex flex-col gap-2 rounded border border-amber-500/60 bg-amber-500/10 p-2.5"
          >
            <p className="text-[12px] text-shell-fg dark:text-ink-fg">
              Remove the limit? Sloodge will keep answering for as long as you keep asking, with
              nothing to stop a session that runs away.
            </p>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={cancelUncap}
                className="rounded border border-chrome-line px-2.5 py-1 text-[12px] text-shell-fg dark:border-ink-line dark:text-ink-fg"
              >
                Keep the limit
              </button>
              <button
                type="button"
                onClick={confirmUncap}
                className="rounded bg-red-600 px-2.5 py-1 text-[12px] font-medium text-white"
              >
                Remove it
              </button>
            </div>
          </div>
        ) : null}

        <div className="flex items-center gap-2 pl-5">
          <span aria-hidden="true" className="text-[13px] text-chrome-muted dark:text-ink-muted">
            $
          </span>
          <input
            type="text"
            inputMode="decimal"
            aria-label="Session budget in dollars"
            value={draft}
            disabled={!limited || !editable}
            onChange={onDraftChange}
            onBlur={onCommit}
            className="w-24 rounded border border-chrome-line bg-white px-2 py-1 text-[13px] text-shell-fg disabled:opacity-50 dark:border-ink-line dark:bg-ink-alt dark:text-ink-fg"
          />
          <button
            type="button"
            disabled={!limited || !editable}
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
          answered is allowed to finish — unless you lower the limit below what this session has
          already spent, in which case it is stopped.
        </p>
      </section>
    </div>
  )
}
