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
 *
 * Presentation (M8b.3 surface 4, ui-design-audit.md §4.8): every standing message about state —
 * the limit still being read, the approaching / used-up warnings, the uncap confirmation, a save
 * that failed — is a `Notice`, whose tone gives it a tint, a border, an icon and an `sr-only`
 * word, so none of them is status by colour alone. That is also what closes T1 and U17 here: the
 * `Notice`'s `border-warning` replaces the `amber-500/60` confirm-box border (1.56:1), and its
 * `text-text` body on `warning-soft` (16.62 / 12.05) replaces the 12px `amber-800` warn text. The
 * bare warning text token would have measured 6.83 / 7.65 too, but the `semantic-contrast` clause
 * that requires a `dark:` twin on that utility belongs to the status-bar PR (§5.9), and a twin is
 * what R1 forbids on a migrated file — the `Notice` needs neither. The checkbox row is a two-column
 * layout (the box, then everything it governs), so the label, the amount row and the copy under it
 * align structurally rather than through four `pl-5`s; flex rather than `grid-cols-[auto_1fr]`,
 * because an arbitrary value is a gate column (§7).
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
import { Button, Input, Notice } from '../../components/ui'
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
      <section className="flex flex-col gap-2">
        <p className="text-ui text-text">
          This session has spent{' '}
          <span data-testid="budget-spend" className="font-medium tabular-nums">
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
            <>
              {' of '}
              <span className="tabular-nums">{formatCostUsd(knownCap)}</span>.
            </>
          )}
        </p>
        {!loaded ? (
          <Notice tone="warning" icon="⚠">
            <span data-testid="budget-unloaded">
              {probeFailed
                ? 'Your saved limit could not be read here. Sloodge is still enforcing it; setting one below will store it.'
                : 'Reading your saved limit…'}
            </span>
          </Notice>
        ) : null}
        <p className="text-ui-sm text-text-muted">
          Estimated from Claude&rsquo;s published prices, not from your bill. The total covers this
          session only and starts again when Sloodge restarts.
        </p>
        {status.level === 'blocked' ? (
          <Notice tone="danger" icon="⚠">
            <span data-testid="budget-blocked">
              The budget is used up, so new messages are being refused. Raise the limit below to
              continue.
            </span>
          </Notice>
        ) : null}
        {status.level === 'warn' ? (
          <Notice tone="warning" icon="⚠">
            Approaching the limit. New messages stop once it is reached.
          </Notice>
        ) : null}
      </section>

      <section className="flex gap-2 border-t border-line pt-3">
        {/* Column one: the box, centred on the label's first line (h-5 is text-ui's line box). */}
        <span className="flex h-5 shrink-0 items-center">
          <input
            id="settings-budget-limit"
            type="checkbox"
            checked={limited}
            disabled={!editable}
            onChange={onToggleLimit}
            className="h-3.5 w-3.5 accent-accent"
          />
        </span>
        {/* Column two: everything the box governs, aligned to the label by construction. */}
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <label htmlFor="settings-budget-limit" className="text-ui text-text">
            Limit what one session can spend
          </label>

          {confirmingUncap ? (
            <Notice tone="warning" icon="⚠">
              <div data-testid="budget-confirm-uncap" className="flex flex-col gap-2">
                <p>
                  Remove the limit? Sloodge will keep answering for as long as you keep asking, with
                  nothing to stop a session that runs away.
                </p>
                <div className="flex gap-2">
                  <Button onClick={cancelUncap}>Keep the limit</Button>
                  <Button variant="danger" onClick={confirmUncap}>
                    Remove it
                  </Button>
                </div>
              </div>
            </Notice>
          ) : null}

          <div className="flex items-center gap-2">
            <span aria-hidden="true" className="text-ui text-text-muted">
              $
            </span>
            {/* `Input` fills its container; a dollar amount does not want the whole row. */}
            <div className="w-24">
              <Input
                type="text"
                inputMode="decimal"
                aria-label="Session budget in dollars"
                value={draft}
                disabled={!limited || !editable}
                onChange={onDraftChange}
                onBlur={onCommit}
              />
            </div>
            <Button disabled={!limited || !editable} onClick={onCommit}>
              Save
            </Button>
            {error === null && saved ? (
              <span className="text-ui-sm text-success">
                <span aria-hidden="true">✓</span> Saved
              </span>
            ) : null}
          </div>

          {error !== null ? (
            <Notice tone="danger" role="alert" icon="⚠">
              {error}
            </Notice>
          ) : null}

          <p className="text-ui-sm text-text-muted">
            When the limit is reached Sloodge stops accepting new messages. A message already being
            answered is allowed to finish — unless you lower the limit below what this session has
            already spent, in which case it is stopped. Sloodge learns what a message cost only once
            it ends, so one long message can carry the total past the limit before anything stops
            it, and that spend is counted. After a stop, raising the limit lets the next message
            spend up to the new limit on its own, on top of what the session had already spent.
          </p>
        </div>
      </section>
    </div>
  )
}
