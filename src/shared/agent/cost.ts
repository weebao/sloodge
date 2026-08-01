/**
 * The **one** cost-accumulation rule, shared by main and the renderer (M2.5,
 * 50-agent-integration.md §10).
 *
 * ## Why this is a shared module rather than two accumulators
 *
 * Before M2.5 the session cost was summed twice: `AgentSession.spendUsd` folded every `turn-end`
 * unconditionally, and the renderer's transcript folded once per turn behind its own flag. In the
 * happy path (one send, one `result`) the two agree by coincidence. They disagree the moment the
 * stream is not the happy path — a duplicated `result`, or a `result` arriving outside any turn —
 * and the disagreement is invisible: main logs one number and the status bar shows another.
 *
 * A meter that drifts from what was actually spent is worse than no meter, and *the guard reads the
 * same number* — a budget cap enforced against a number that is not main's number is not a guard.
 * So the fold rule lives here and both sides call it.
 *
 * ## The rule
 *
 * Cost folds **once per opened turn**, tracked by a count of turns that have been opened by
 * `beginTurn` and not yet folded:
 *
 *   beginTurn (user sends) ──▶ openTurns + 1
 *   turn-end ──▶ openTurns > 0 ? (total += cost, openTurns - 1) : no-op
 *
 * Counting rather than gating on the turn's *display* state is deliberate: the SDK's post-interrupt
 * `result` lands after the turn has already settled to `interrupted`, and a failed turn's `result`
 * arrives paired with an `error`. Both still carry real cost and must be counted — an error result
 * is billed (§10) — while a duplicate `result` must not be.
 *
 * ## Why a counter and not a boolean
 *
 * This was a `folded: boolean` and that was **wrong**, in a way the agreement test could not see.
 * Turns can overlap: `interrupt-requested` moves the transcript to `interrupted` immediately, while
 * the SDK's `result` for that turn is still in flight, and the composer's only send guard is
 * `turnState === 'streaming'`. So Stop → retype → Send inside the interrupt round-trip opens a
 * second turn while the first is still unfolded. With a boolean, `beginTurn` was a no-op, the late
 * result folded turn A, and turn B's result hit "already folded" and contributed **nothing** — a
 * whole turn's money vanished from the meter *and* from the guard the meter feeds.
 *
 * Both accumulators shared the flaw, so they stayed in perfect agreement while both under-reported.
 * That is the lesson worth keeping: **agreement is not correctness**, which is why
 * `cost-agreement.test.ts` now also checks both totals against an independent model of the script
 * rather than only against each other.
 *
 * `openTurns: 0` is "no turn is open": a stray `turn-end` before anything was sent contributes
 * nothing rather than opening the total on an event we cannot attribute.
 */

/** The accumulator's whole state: a running total and how many opened turns have yet to fold. */
export type CostState = {
  /** Client-side estimate in USD. Displayed with a leading "≈"; never billing truth (§10). */
  readonly totalUsd: number
  /** Turns opened by `beginTurn` whose `turn-end` has not yet been folded. Never negative. */
  readonly openTurns: number
}

export const INITIAL_COST_STATE: CostState = { totalUsd: 0, openTurns: 0 }

/**
 * Open a turn: one more `turn-end` will fold. Called when the user sends — `AgentSession.send` in
 * main, the `user-send` action in the renderer's transcript — so both sides mark turn boundaries at
 * the same point in the same event order.
 *
 * Deliberately **not** idempotent: two sends mean two results are owed, and collapsing them is
 * exactly how a turn's cost used to disappear.
 */
export function beginTurn(state: CostState): CostState {
  return { ...state, openTurns: state.openTurns + 1 }
}

/**
 * Fold one `turn-end`'s cost into the total, consuming one open turn.
 *
 * Non-finite and negative costs contribute zero rather than poisoning the total with `NaN` or
 * walking it backwards: `total_cost_usd` is a number we receive, not one we compute, and a meter
 * that reads `$NaN` after one malformed message is a worse failure than an undercount. The turn is
 * still consumed, because the turn *did* end — the alternative would let the next stray `turn-end`
 * fold in its place.
 */
export function foldTurnCost(state: CostState, costUsd: number): CostState {
  if (state.openTurns === 0) return state
  const delta = Number.isFinite(costUsd) && costUsd > 0 ? costUsd : 0
  return { totalUsd: state.totalUsd + delta, openTurns: state.openTurns - 1 }
}

/**
 * Format a spend estimate for display: `$0.42`.
 *
 * Callers prefix "≈" themselves (the status bar and the chat panel both do) because the symbol is a
 * claim about the *number's provenance* — a client-side estimate from the SDK's bundled price table
 * (§10) — and belongs next to the label, not baked into every use of the number.
 *
 * A spend that is real but rounds to nothing reads `< $0.01` rather than `$0.00`. Cheap turns are
 * the common case for "make the title bigger", and a meter that says `$0.00` after five real turns
 * teaches the user the meter is decorative — exactly when they should be able to trust it.
 */
export function formatCostUsd(usd: number): string {
  if (!Number.isFinite(usd) || usd <= 0) return '$0.00'
  if (usd < 0.005) return '< $0.01'
  return `$${usd.toFixed(2)}`
}
