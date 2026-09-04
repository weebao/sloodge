/**
 * The **one** cost-accumulation rule, shared by main and the renderer (M2.5,
 * 50-agent-integration.md §10).
 *
 * ## What `total_cost_usd` actually is
 *
 * Every SDK `result` carries `total_cost_usd`, and it is **not the price of the turn that just
 * ended**. In the bundled CLI (2.1.220, `@anthropic-ai/claude-agent-sdk` 0.3.220) it is the
 * subprocess's running total: `Jbi()` does `Ot.totalCostUSD += e` after every API call, `vS()` reads
 * that global, every `result` builder writes `total_cost_usd: vS()`, and the only per-turn reset
 * (`j2m()`) has no callers. Real turns costing 0.10 / 0.25 / 1.00 therefore arrive as snapshots
 * 0.10 / 0.35 / 1.35. Round 4 of review found both ledgers summing those to $1.80 for a $1.35
 * session — over-counting from the second turn of every session, growing with every turn, and
 * making the cap bind at money the user never spent. `sdk-cost-contract.test.ts` pins the CLI
 * version this was read from, so a runtime bump forces someone to re-verify these symbols.
 *
 * ## The rule
 *
 * A snapshot is folded as a **monotone maximum for the query generation it came from**, never added:
 *
 *   beginTurn (user sends)        ──▶ openTurns + 1
 *   turn-end {generation, snapshot} ──▶ openTurns > 0 ? fold : no-op, where fold is
 *       same generation  : liveUsd = max(liveUsd, snapshot)
 *       later generation : closedUsd += liveUsd; liveUsd = snapshot
 *   totalUsd = closedUsd + liveUsd
 *
 * `generation` is `AgentSession`'s query counter — each `query()` is one CLI subprocess with its own
 * tracker, so each is its own running total. A later generation's first snapshot is the moment the
 * previous one is known to be finished: its last reported total is banked into `closedUsd` and the
 * new process starts from zero. That baseline is **deliberately additive** — see below.
 *
 * `max` makes a repeated or out-of-order `result` harmless to the money: the same snapshot twice is
 * the same maximum, and two overlapping turns' results carry the totals in the order the process
 * emitted them, so whichever lands second is the larger. The uuid dedup in `event-mapping.ts` is
 * still load-bearing, but for the **turn count**: `openTurns` is what settles the composer and lets
 * `AgentSession.closeOpenTurns` know how many turns a dead query owes, and a duplicated `result` would
 * consume a live turn's slot.
 *
 * ## Why a re-armed query is banked, not trusted
 *
 * When `AgentSession` re-arms after a query ends it passes `resume`, and the CLI *can* restore its
 * tracker on resume: `xws(id)` returns `{ totalCostUSD: lastCost }` when the per-cwd project config's
 * `lastSessionId` equals the resumed id. If that happened, the new generation's first snapshot would
 * already include the old spend and banking would double-count it. It does not happen on the SDK
 * path: the only writer of `lastSessionId`/`lastCost` is `nZu()`, whose callers are the `/clear`
 * conversation reset (`PSi()`) and the interactive REPL's exit hook (`Vzf`, a React effect that also
 * prints "Cost:" to stdout). A stream-json session never runs either, so the resumed process's total
 * starts at $0 and the additive baseline is exact. Were a future CLI to restore it, this rule reads
 * **high** by the banked amount — the safe direction for a spend control — never low; the contract
 * test is what turns that "were" into a deliberate decision.
 *
 * ## Why a counter for turns
 *
 * Turns overlap: `interrupt-requested` moves the transcript to `interrupted` while the SDK's `result`
 * is still in flight, so Stop → retype → Send opens a second turn before the first has ended. A
 * boolean "folded" flag collapsed the two and lost a turn from both ledgers at once (round 1); a
 * counter without result identity let a duplicate consume the second turn's slot (round 2). Both
 * sides run this file on the same events, so they agree — and `cost-agreement.test.ts` checks both
 * against a model of the script as well, because agreement alone cannot catch a shared error.
 *
 * `openTurns: 0` is "no turn is open": a `turn-end` nothing sent contributes nothing.
 */

/** One `result`'s money, as the fold consumes it. */
export type CostSnapshot = {
  /** The `query()` generation that reported it — its subprocess, hence its running total. */
  readonly generation: number
  /** `result.total_cost_usd`: that subprocess's total so far, not this turn's price. */
  readonly snapshotUsd: number
}

export type CostState = {
  /** `closedUsd + liveUsd`. Client-side estimate; displayed with a leading "≈", never billing truth. */
  readonly totalUsd: number
  /** The last total each finished query generation reported, summed. */
  readonly closedUsd: number
  /** The highest total the live generation has reported. */
  readonly liveUsd: number
  /** Which generation `liveUsd` belongs to. */
  readonly generation: number
  /** Turns opened by `beginTurn` whose `turn-end` has not yet been folded. Never negative. */
  readonly openTurns: number
}

export const INITIAL_COST_STATE: CostState = {
  totalUsd: 0,
  closedUsd: 0,
  liveUsd: 0,
  generation: 0,
  openTurns: 0,
}

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
 * Fold one `turn-end`, consuming one open turn. See the module docstring for the rule.
 *
 * A non-finite or negative snapshot reads as zero: `total_cost_usd` is a number we receive, not one
 * we compute, and a meter that reads `$NaN` after one malformed message is a worse failure than a
 * missed fold. The turn is still consumed, because the turn *did* end.
 */
export function foldTurnCost(state: CostState, snapshot: CostSnapshot): CostState {
  if (state.openTurns === 0) return state
  const reported =
    Number.isFinite(snapshot.snapshotUsd) && snapshot.snapshotUsd > 0 ? snapshot.snapshotUsd : 0
  const advanced = snapshot.generation > state.generation
  const closedUsd = advanced ? state.closedUsd + state.liveUsd : state.closedUsd
  const liveUsd = Math.max(advanced ? 0 : state.liveUsd, reported)
  return {
    totalUsd: closedUsd + liveUsd,
    closedUsd,
    liveUsd,
    generation: advanced ? snapshot.generation : state.generation,
    openTurns: state.openTurns - 1,
  }
}

/**
 * Close an opened turn that main never opened, without touching the money.
 *
 * The renderer opens its turn optimistically, before main has accepted the send — that is what makes
 * the assistant bubble appear the instant you hit Send. When main then *refuses* (its own budget
 * check, or a credential that vanished), or the invoke rejects before reaching the session, main
 * never opened a matching turn, so the renderer would be left one turn ahead forever: a later stray
 * `result` would fold into the phantom, and the two ledgers the guard depends on would disagree
 * permanently. This is the rollback for that. (A turn main *did* open and whose query then ended
 * without answering is closed by main itself, with a zero-cost `turn-end` both sides fold.)
 */
export function abandonTurn(state: CostState): CostState {
  if (state.openTurns === 0) return state
  return { ...state, openTurns: state.openTurns - 1 }
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
