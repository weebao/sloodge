/**
 * The **one** cost-accumulation rule, shared by main and the renderer (M2.5,
 * 50-agent-integration.md §10).
 *
 * ## Why this is a shared module rather than two accumulators
 *
 * Before M2.5 the session cost was summed twice: `AgentSession.spendUsd` folded every `turn-end`
 * unconditionally, and the renderer's transcript folded once per turn behind a `costFolded` flag.
 * In the happy path (one send, one `result`) the two agree by coincidence. They disagree the moment
 * the stream is not the happy path — a duplicated `result`, or a `result` arriving outside any turn
 * — and the disagreement is invisible: main logs one number and the status bar shows another.
 *
 * A meter that drifts from what was actually spent is worse than no meter, and *the guard reads the
 * same number* — a budget cap enforced against a number that is not main's number is not a guard.
 * So the fold rule lives here, both sides call it, and agreement is structural rather than a
 * property two files happen to share. `tests/unit/agent/cost-agreement.test.ts` drives one scripted
 * event sequence through both accumulators and asserts they land on the same total; that test is
 * only meaningful because neither side is free to invent its own arithmetic.
 *
 * ## The rule
 *
 * Cost folds **exactly once per turn**, keyed on a turn that has been opened by `beginTurn`:
 *
 *   beginTurn (user sends) ──▶ folded: false ──turn-end──▶ folded: true (total += cost)
 *                                                   └─any further turn-end: no-op
 *
 * Gating on a flag rather than on the turn's *display* state is deliberate and is the reason the
 * renderer's version was written this way (transcript.ts): the SDK's post-interrupt `result` lands
 * after the turn has already settled to `interrupted`, and a failed turn's `result` arrives paired
 * with an `error`. Both still carry real cost and must be counted — an error result is billed
 * (§10) — while a duplicate `result` must not be. Only `folded` distinguishes those cases.
 *
 * The initial state is `folded: true`, i.e. "no turn is open": a stray `turn-end` before anything
 * was sent contributes nothing rather than opening the total on an event we cannot attribute.
 */

/** The accumulator's whole state: a running total and whether the open turn has already folded. */
export type CostState = {
  /** Client-side estimate in USD. Displayed with a leading "≈"; never billing truth (§10). */
  readonly totalUsd: number
  /** True when the current turn's `result` cost has been counted (or no turn is open). */
  readonly folded: boolean
}

export const INITIAL_COST_STATE: CostState = { totalUsd: 0, folded: true }

/**
 * Open a turn: the next `turn-end` will fold. Called when the user sends — `AgentSession.send` in
 * main, the `user-send` action in the renderer's transcript — so both sides mark turn boundaries at
 * the same point in the same event order.
 */
export function beginTurn(state: CostState): CostState {
  if (!state.folded) return state
  return { ...state, folded: false }
}

/**
 * Fold one `turn-end`'s cost into the total, at most once per opened turn.
 *
 * Non-finite and negative costs contribute zero rather than poisoning the total with `NaN` or
 * walking it backwards: `total_cost_usd` is a number we receive, not one we compute, and a meter
 * that reads `$NaN` after one malformed message is a worse failure than an undercount. The turn is
 * still marked folded, because the turn *did* end — the alternative would let the next stray
 * `turn-end` fold in its place.
 */
export function foldTurnCost(state: CostState, costUsd: number): CostState {
  if (state.folded) return state
  const delta = Number.isFinite(costUsd) && costUsd > 0 ? costUsd : 0
  return { totalUsd: state.totalUsd + delta, folded: true }
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
