/**
 * The budget guard (M2.5, 50-agent-integration.md §10) — a pure state machine over
 * "how much has this session spent" and "what is the cap", with no I/O and no React, so the whole
 * accumulate → warn → block → refuse progression is unit-tested rather than clicked through.
 *
 * ## The semantics, decided deliberately
 *
 * **The meter is per *session*, not rolling.** A session is one `query()` — one deck window from
 * the moment the agent first answers until the app quits. That is the only scope we can measure
 * honestly: the SDK gives us `total_cost_usd` per `result` and offers **no session-level or
 * lifetime total** (§10), and Sloodge has no durable spend ledger. A "rolling" or per-deck meter
 * would have to persist spend across runs and re-attribute it on resume (§12), and until that
 * exists a per-deck *budget* would silently never bind — every relaunch would reset the spend it is
 * supposed to cap. The wireframe agrees: the bar reads "$0.42 session".
 *
 * The cap is therefore an **app preference**, not a deck field. A cap must be scoped at least as
 * wide as the thing it caps; storing it in the `.sloodge` file (as §10 sketches) would imply
 * per-deck accounting we do not have. When durable per-deck spend lands, the cap moves into the
 * deck's settings block alongside it — noted in §10 rather than half-built here.
 *
 * **Warn, then hard stop — at the turn boundary.** Three live levels below `off`:
 *
 *   ok ──spend ≥ 80% of cap──▶ warn ──spend ≥ cap──▶ blocked
 *
 * `warn` is amber and still sends (§10's "at 80% the bar turns amber"). `blocked` **refuses to
 * start a new turn**; it does not merely colour something red.
 *
 * ## What happens when a single turn crosses the cap
 *
 * You cannot un-spend it. The two honest options are stop-before-the-next-turn and
 * interrupt-in-flight, and Sloodge does the first — plus hands the second to the one component that
 * can actually do it. The reasoning, because "we picked the easy one" would be the wrong answer:
 *
 * 1. **We cannot observe a mid-turn crossing.** Cost reaches us only on the `result` message, i.e.
 *    when the turn is already over. Deltas carry no price and assistant `usage` carries tokens, not
 *    dollars. Interrupting "as the cap is crossed" would require a local token→price table — the
 *    exact thing §10 forbids us from billing off.
 * 2. **Interrupting mid-turn destroys the value of money already spent.** The tokens are burnt
 *    either way; an interrupt at slide 3 of 5 leaves the user having paid full price for a
 *    half-edited deck. The cap exists to bound spend, not to maximise waste.
 * 3. **The SDK owns the in-flight brake, and we use it.** `Options.maxBudgetUsd` stops the query
 *    from inside and ends it with `result.subtype === 'error_max_budget_usd'` — already classified
 *    as the `budget` error kind (event-mapping.ts). `remainingBudgetUsd` below computes what main
 *    passes, so the ceiling is enforced *during* a turn by the only layer that prices tokens, while
 *    this module enforces admission *between* turns with copy the user can act on.
 *
 * So: a turn in flight always runs to completion under the SDK's own ceiling; the next one is
 * refused by us. Neither half is silent.
 */

import { formatCostUsd } from './cost'

/** §10's default: enough for a real editing session, small enough that a runaway is survivable. */
export const DEFAULT_BUDGET_CAP_USD = 2

/** §10: "at 80% the bar turns amber". */
export const BUDGET_WARN_FRACTION = 0.8

/**
 * A ceiling on the ceiling. Not a policy about how much anyone may spend — it is an input-validation
 * bound, so a slipped decimal point in the Settings field ("2000" for "20.00") is rejected at the
 * form rather than persisted as a cap that will never bind.
 */
export const MAX_BUDGET_CAP_USD = 1000

/**
 * The configured cap in USD, or `null` for **no limit**. `null` rather than `0` or `Infinity`
 * because "no cap" is a distinct user choice that has to survive a JSON round-trip and be
 * distinguishable from "a cap of zero" (which would block every turn — a real, if unhelpful,
 * setting we therefore refuse at parse time).
 */
export type BudgetCap = number | null

/**
 * - `off` — no cap configured; the meter still runs, nothing is refused.
 * - `ok` — under the warn threshold.
 * - `warn` — at or past 80% of the cap; amber, still sends.
 * - `blocked` — at or past the cap; a new turn is refused.
 */
export type BudgetLevel = 'off' | 'ok' | 'warn' | 'blocked'

export type BudgetStatus = {
  readonly level: BudgetLevel
  readonly capUsd: BudgetCap
  readonly spentUsd: number
  /** USD left before the cap; `null` when uncapped. Never negative — an overshoot reads `0`. */
  readonly remainingUsd: number | null
  /** Spend as a fraction of the cap, clamped to `[0, 1]` for the progress bar; `0` when uncapped. */
  readonly fraction: number
}

function sanitizeSpend(spentUsd: number): number {
  return Number.isFinite(spentUsd) && spentUsd > 0 ? spentUsd : 0
}

/**
 * Classify the session against its cap. Total: any pairing of numbers produces a status.
 *
 * **The two failure directions are not treated alike.** `null` is the user's explicit "no limit" and
 * is honoured. A cap that is *malformed* — `NaN`, negative, zero — is not a choice anyone made, and
 * reading it as "uncapped" would silently disable a spend control at exactly the moment its state is
 * untrustworthy, so it falls back to `DEFAULT_BUDGET_CAP_USD` instead. That is fail-safe without
 * being unusable: the user is capped at the documented default rather than either overspending or
 * being locked out of their own chat box.
 *
 * It should be unreachable — `isBudgetCap` gates the IPC and the file, `parseBudgetCap` gates the
 * form — and it is defence for the day someone adds a fourth path that forgets to validate.
 *
 * A malformed *spend* still reads as 0: the total is ours to compute, and a `NaN` meter must not
 * decide anyone is over budget.
 */
export function evaluateBudget(spentUsd: number, capUsd: BudgetCap): BudgetStatus {
  const spent = sanitizeSpend(spentUsd)
  if (capUsd === null) {
    return { level: 'off', capUsd: null, spentUsd: spent, remainingUsd: null, fraction: 0 }
  }
  if (!Number.isFinite(capUsd) || capUsd <= 0) {
    return evaluateBudget(spent, DEFAULT_BUDGET_CAP_USD)
  }
  const fraction = Math.min(1, spent / capUsd)
  const level: BudgetLevel =
    spent >= capUsd ? 'blocked' : spent >= capUsd * BUDGET_WARN_FRACTION ? 'warn' : 'ok'
  return {
    level,
    capUsd,
    spentUsd: spent,
    remainingUsd: Math.max(0, capUsd - spent),
    fraction,
  }
}

/** Whether a new turn may be started. The one question the composer asks before sending. */
export function canStartTurn(status: BudgetStatus): boolean {
  return status.level !== 'blocked'
}

/**
 * What main passes as `Options.maxBudgetUsd` for a query opened now (§10's "per-turn ceiling:
 * remaining budget"). `undefined` when uncapped, so the option is omitted rather than sent as a
 * sentinel the SDK would read as a real ceiling.
 *
 * A remaining of `0` is passed through deliberately: the session is already blocked, and a query
 * that ends immediately with `error_max_budget_usd` is the correct outcome — not one that runs free
 * because the number looked degenerate.
 */
export function remainingBudgetUsd(spentUsd: number, capUsd: BudgetCap): number | undefined {
  const status = evaluateBudget(spentUsd, capUsd)
  return status.remainingUsd ?? undefined
}

/**
 * The refusal copy, shown as a chat error bubble when a send is blocked. Names the cap so the number
 * the user is arguing with is on screen, and points at the exact place to change it — §10's copy,
 * re-scoped from "this deck" to "this session" to match the semantics above.
 */
export function budgetRefusalMessage(capUsd: BudgetCap): string {
  const cap = capUsd === null ? '' : ` (${formatCostUsd(capUsd)})`
  return `Budget reached for this session${cap}. Raise the limit in Settings ▸ Budget to continue.`
}

/**
 * Parse the Settings amount field into a cap. Returns `undefined` for input that is not a usable
 * amount, which the form renders as a validation message.
 *
 * Deliberately returns `number | undefined` rather than `BudgetCap | undefined`: "no limit" is not a
 * thing anyone can *type*, it is the checkbox next to the field. Keeping `null` out of this
 * function's range means the form cannot accidentally uncap a user by parsing a blank box.
 *
 * Rejects zero and negatives (a cap of nothing blocks every turn, and is far more likely to be a
 * typo than an intent), anything above `MAX_BUDGET_CAP_USD`, and anything non-numeric. Accepts a
 * leading `$` and surrounding whitespace because people type money that way.
 */
export function parseBudgetCap(input: string): number | undefined {
  const trimmed = input.trim().replace(/^\$/, '').trim()
  // `Number` accepts '0x10', 'Infinity' and '1e3'; require plain decimal money.
  const match = /^(\d+)(?:\.(\d+))?$/.exec(trimmed)
  if (match === null) return undefined

  // Rounded to cents on the *digits the user typed*, not on the parsed float. `Math.round(1.005 *
  // 100)` is 100, because 1.005 is stored as slightly less than 1.005 — so a naive round would
  // silently store $1.00 for someone who typed $1.005 and then block at a number they never chose.
  // Money is a decimal quantity; rounding it as text is the only way to round it half-up correctly.
  const whole = match[1] ?? '0'
  const frac = match[2] ?? ''
  const roundUp = frac.length > 2 && Number(frac[2]) >= 5
  const cents = Number(whole) * 100 + Number(frac.slice(0, 2).padEnd(2, '0')) + (roundUp ? 1 : 0)

  const value = cents / 100
  if (!Number.isFinite(value) || value <= 0 || value > MAX_BUDGET_CAP_USD) return undefined
  return value
}

/** Shape gate for a cap arriving over IPC or read back from disk. */
export function isBudgetCap(value: unknown): value is BudgetCap {
  if (value === null) return true
  return (
    typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= MAX_BUDGET_CAP_USD
  )
}

/** `agent:setBudget` request — the renderer's Settings ▸ Budget tab writing a new cap. */
export type BudgetSetRequest = { readonly capUsd: BudgetCap }

/**
 * Gate for the request payload at the trusted boundary. Rejects a cap outside the validated range
 * rather than clamping it: main persisting a number the Settings form would refuse to produce is a
 * bug worth surfacing as a rejected invoke, not one worth silently rounding into range.
 */
export function isBudgetSetRequest(value: unknown): value is BudgetSetRequest {
  return (
    typeof value === 'object' &&
    value !== null &&
    isBudgetCap((value as { capUsd?: unknown }).capUsd)
  )
}
