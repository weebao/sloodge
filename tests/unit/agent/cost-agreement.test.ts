/**
 * **The ledger never undercounts real spend** — proven combinatorially, not by curated cases.
 *
 * Four review rounds failed this feature on the same shape: two conditions that were each tested
 * alone, and wrong in their product — overlap × boolean fold (r1), overlap × duplicate `result`
 * (r2), overlap × query replacement (r3), cap-stop × query death (r4). Each time both ledgers
 * agreed on the wrong number, so a test comparing them stayed green. Round 4 also found the model
 * itself wrong: every oracle here treated `total_cost_usd` as a per-turn price, when the bundled CLI
 * reports its subprocess's *running total* (cost.ts) — 299 scripts agreeing with a model of an SDK
 * that does not exist. This file therefore does three things a curated list cannot:
 *
 * 1. **Enumerates the conditions and runs every pair and every triple.** The list below is the set of
 *    independent things a real session can do to a turn's cost. Adding a condition here adds its
 *    every crossing automatically; a mechanism added to the session without a condition here is the
 *    next uncrossed pair.
 * 2. **Models the runtime that exists.** The fake emits `total_cost_usd` the way the CLI does: one
 *    running total per subprocess, carried on every `result` that subprocess writes, starting at $0
 *    for every `query()` Sloodge opens (the CLI's resume restore never fires on the SDK path —
 *    `sdk-cost-contract.test.ts`). A turn's `costUsd` is the delta it adds to that total when its
 *    result is written; it never appears on the wire by itself.
 * 3. **Checks both ledgers against a model of the script**, not merely against each other. The model
 *    is one sentence: *the session spent the sum, over subprocesses, of the last total each one
 *    reported; a turn whose subprocess dies before its `result` adds nothing; a `result` with no turn
 *    open adds nothing.* `compose()` computes that from the script it builds, with no reference to
 *    either implementation.
 *
 * Both ledgers are the **real** ones: `AgentSession` with the fake runtime on one side, and the real
 * `reduceTranscript` on the other, fed the `AgentEvent`s the session *emits* — the same events the
 * renderer receives over IPC — interleaved with the renderer's own actions in the order the app
 * produces them (`user-send` before the IPC send, `interrupt-requested` before `interrupt()`).
 */

import { describe, expect, it } from 'vitest'
import { AgentSession } from '../../../src/main/agent/session'
import type {
  AgentQueryFn,
  AgentQueryHandle,
  AgentQueryOptions,
} from '../../../src/main/agent/query-contract'
import {
  initialTranscript,
  reduceTranscript,
  type Transcript,
} from '../../../src/renderer/src/features/chat/transcript'
import type { AgentEvent } from '../../../src/shared/agent/types'

const OPTIONS: AgentQueryOptions = {
  credential: { kind: 'api-key', value: 'sk-ant-test' },
  model: 'claude-opus-5',
  cwd: '/workspace',
  configDir: '/config',
}

/** The session's cap for every script; well above what the turns spend, so admission is moot. */
const CAP = 2

/* -------------------------------------------------------------------------------------------- *
 * The conditions
 * -------------------------------------------------------------------------------------------- */

/**
 * Every independent condition a script can carry. Each is one thing the app, the SDK, or the user
 * can do to a turn; the matrix runs every subset of size ≤ 3.
 *
 * - `overlap`     — Stop → retype → Send: T3 is opened while T2's result is still in flight.
 * - `duplicate`   — the runtime repeats every `result` (same uuid, same snapshot).
 * - `interrupt`   — the user presses Stop on T1; its result still arrives.
 * - `stray`       — a `result` arrives with no turn open.
 * - `missing`     — the runtime ends its stream without ever answering T3.
 * - `dispose`     — the session is closed while T3 is still streaming.
 * - `outOfOrder`  — with two turns open, T3's result arrives before T2's (implies the overlap shape).
 * - `backstop`    — T2 ends with the SDK's `error_max_budget_usd`, which terminates the query.
 * - `lowerAbove`  — Settings lowers the cap mid-turn, but not below what has been spent.
 * - `lowerBelow`  — Settings lowers the cap mid-turn below what has been spent.
 * - `raise`       — Settings raises the cap mid-turn.
 * - `refused`     — main refuses a send the renderer had optimistically opened.
 * - `crash`       — the live query throws while T3 is open, before its result; the user then raises
 *                   the cap, sends T4 on the re-armed query, and lowers the cap below spend while T4
 *                   streams. Round 4: a cap-stop flag left by a query that died must not disarm the
 *                   replacement's cap-stop.
 * - `survivor`    — a cap-stop `interrupt()` lands between turns: the runtime answers with no
 *                   result, and the queued T3 runs to its own result at full cost (the CLI's
 *                   `still_queued` semantics — `Query.interrupt()` does not cancel queued turns).
 */
const CONDITIONS = [
  'overlap',
  'duplicate',
  'interrupt',
  'stray',
  'missing',
  'dispose',
  'outOfOrder',
  'backstop',
  'lowerAbove',
  'lowerBelow',
  'raise',
  'refused',
  'crash',
  'survivor',
] as const

type Condition = (typeof CONDITIONS)[number]

/* -------------------------------------------------------------------------------------------- *
 * The script and its model
 * -------------------------------------------------------------------------------------------- */

type Turn = {
  readonly id: string
  readonly text: string
  /** What this turn adds to its subprocess's running total when its result is written. */
  readonly costUsd: number
  readonly uuid: string
}

const T1: Turn = { id: 'T1', text: 'one', costUsd: 0.1, uuid: 'r-1' }
const T2: Turn = { id: 'T2', text: 'two', costUsd: 0.25, uuid: 'r-2' }
const T3: Turn = { id: 'T3', text: 'three', costUsd: 1, uuid: 'r-3' }
const T4: Turn = { id: 'T4', text: 'four', costUsd: 0.5, uuid: 'r-4' }

type Step =
  | { readonly kind: 'send'; readonly turn: Turn }
  | { readonly kind: 'stop' }
  | { readonly kind: 'result'; readonly turn: Turn; readonly subtype: string }
  | { readonly kind: 'stray' }
  /** The runtime ends its stream; `closes` is how many unanswered turns main must close at $0. */
  | { readonly kind: 'query-ends'; readonly closes: number }
  /** The runtime throws (a transport failure); `closes` as above, plus one typed error. */
  | { readonly kind: 'query-throws'; readonly closes: number }
  /**
   * Settings saved a cap. `reply` is what the runtime answers a *main-initiated* interrupt with:
   * `null` means main must not interrupt at all; `[]` means it interrupts and nothing comes back.
   */
  | { readonly kind: 'set-cap'; readonly capUsd: number; readonly reply: readonly Turn[] | null }
  | { readonly kind: 'refused-send' }
  | { readonly kind: 'dispose' }

type Script = {
  readonly steps: readonly Step[]
  /** The model: what the script actually spent. */
  readonly expectedUsd: number
  /** How many `query()` subprocesses the script should have needed. */
  readonly expectedStarts: number
  /** Turns still open when the script ends (only a dispose mid-turn leaves one). */
  readonly expectedOpenAtEnd: number
  /** How many times the runtime should have been asked to interrupt (user Stops + cap stops). */
  readonly expectedInterrupts: number
  /** Budget errors main should have shown: the SDK backstop's, and one per cap crossing. */
  readonly expectedBudgetErrors: number
  /** Transport errors main should have shown: one per crash. */
  readonly expectedNetworkErrors: number
}

/**
 * Build the script for one set of conditions and, alongside it, what that script should cost.
 *
 * Three turns, in order (a fourth under `crash`). Conditions attach to fixed points so their
 * crossings are well defined: the user Stop and duplicate on T1, the overlap/backstop on T2, the
 * missing/dispose/cap-stop/crash on T3, the refusal and the stray between T1 and T2. The running
 * `expectedUsd` is the model: a result that is written adds its turn's delta to the subprocess's
 * total, and the session's spend is the sum of those totals — so it is the sum of every delta a
 * living subprocess wrote, and nothing for a turn whose subprocess ended first.
 */
function compose(active: ReadonlySet<Condition>): Script {
  const has = (condition: Condition): boolean => active.has(condition)
  const steps: Step[] = []
  let expectedUsd = 0
  let expectedStarts = 1
  let expectedInterrupts = 0
  let expectedBudgetErrors = 0
  let expectedNetworkErrors = 0
  /** Whether a query is alive to crash; the backstop's termination ends one without re-arming. */
  let queryLive = true

  const send = (turn: Turn): void => {
    steps.push({ kind: 'send', turn })
  }
  const stop = (): void => {
    steps.push({ kind: 'stop' })
    expectedInterrupts += 1
  }
  const result = (turn: Turn, subtype = 'success'): void => {
    steps.push({ kind: 'result', turn, subtype })
    expectedUsd += turn.costUsd
  }
  const setCap = (next: number, reply: readonly Turn[] | null): void => {
    steps.push({ kind: 'set-cap', capUsd: next, reply })
  }
  /** Settings lowers the cap below spend: main interrupts, tells the user once, and folds any reply. */
  const capStop = (answers: readonly Turn[]): void => {
    setCap(0.2, answers)
    expectedInterrupts += 1
    expectedBudgetErrors += 1
    for (const turn of answers) expectedUsd += turn.costUsd
  }

  // --- T1: the plain turn, optionally stopped by the user, optionally duplicated by the runtime ---
  send(T1)
  if (has('raise')) setCap(10, null)
  if (has('interrupt')) stop()
  result(T1)
  if (has('refused')) steps.push({ kind: 'refused-send' })
  if (has('stray')) steps.push({ kind: 'stray' })

  // --- T2 (and, in the overlap shape, T3 opened on top of it) ---
  const overlapShape = has('overlap') || has('outOfOrder')
  const terminal = has('backstop')
  send(T2)
  if (has('lowerAbove')) setCap(1.5, null) // spent so far: $0.10
  let t3Open = false
  if (overlapShape) {
    stop()
    send(T3)
    t3Open = true
    if (has('outOfOrder') && !has('missing') && !has('dispose') && !has('crash')) {
      result(T3)
      t3Open = false
    }
    if (terminal) {
      result(T2, 'error_max_budget_usd')
      expectedBudgetErrors += 1
      // The SDK terminated the query. A T3 still open on it is never answered: main closes it at $0.
      steps.push({ kind: 'query-ends', closes: t3Open ? 1 : 0 })
      t3Open = false
      queryLive = false
    } else {
      result(T2)
    }
  } else if (terminal) {
    result(T2, 'error_max_budget_usd')
    expectedBudgetErrors += 1
    steps.push({ kind: 'query-ends', closes: 0 })
    // The next send re-arms: a second subprocess, a fresh running total, the cap in force.
    send(T3)
    t3Open = true
    expectedStarts += 1
  } else {
    result(T2)
    send(T3)
    t3Open = true
  }

  // --- T3: answered, stopped by a lowered cap, left unanswered, crashed, or disposed mid-stream ---
  const t3Answers = !has('missing') && !has('dispose') && !has('crash')
  if (t3Open) {
    if (has('lowerBelow')) {
      // Spent so far is $0.35 (or more); a cap of $0.20 is below it, so main must stop T3. The
      // runtime answers with T3's result only if T3 is in flight and the query lives to deliver it.
      const inFlight = t3Answers && !has('survivor')
      capStop(inFlight ? [T3] : [])
      if (inFlight) {
        t3Open = false
      } else if (t3Answers) {
        // `survivor`: the stop landed idle; the queued T3 ran anyway, to its own result at full cost.
        result(T3)
        t3Open = false
      }
    } else if (t3Answers) {
      result(T3)
      t3Open = false
    }
  } else if (has('lowerBelow')) {
    // Nothing open: lowering below spend has nothing to stop, and must not invent anything.
    setCap(0.2, null)
  }

  if (has('crash')) {
    if (queryLive) {
      // The live query dies. Whatever it still owed is closed at $0 and one transport error is shown.
      steps.push({ kind: 'query-throws', closes: t3Open ? 1 : 0 })
      t3Open = false
      expectedNetworkErrors += 1
    }
    // Round 4's crossing: raise, re-arm on the next send, and lower below spend again while the new
    // turn streams. The replacement must stop it — a cap-stop flag from the dead query must not
    // survive into this one.
    setCap(10, null)
    send(T4)
    expectedStarts += 1
    capStop([T4])
  }

  let expectedOpenAtEnd = 0
  if (has('dispose')) {
    steps.push({ kind: 'dispose' })
    expectedOpenAtEnd = t3Open ? 1 : 0
  } else if (t3Open) {
    // `missing`: the runtime closes its stream without answering. Main closes T3 at $0.
    steps.push({ kind: 'query-ends', closes: 1 })
  }

  return {
    steps,
    expectedUsd,
    expectedStarts,
    expectedOpenAtEnd,
    expectedInterrupts,
    expectedBudgetErrors,
    expectedNetworkErrors,
  }
}

/* -------------------------------------------------------------------------------------------- *
 * The fake runtime and the two-ledger harness
 * -------------------------------------------------------------------------------------------- */

type Runtime = {
  readonly handle: AgentQueryHandle
  /** Write a `result` for `turn`: adds its delta to this subprocess's total and reports that total. */
  readonly result: (turn: Turn, subtype: string) => unknown
  readonly deliver: (messages: readonly unknown[]) => void
  readonly end: () => void
  readonly fail: (error: unknown) => void
}

/**
 * One `query()` — one subprocess, one running total. Messages are released explicitly by the test.
 * `interrupt()` calls back so the harness can answer a main-initiated stop; `return()` ends the
 * stream first so a session closed mid-turn does not hang on a generator parked at its wake-up await.
 *
 * `spent` starts at 0 for every runtime, including one opened with `resumeSessionId`: the CLI's
 * resume restore is keyed on a config entry the SDK path never writes (cost.ts).
 */
function scriptedRuntime(onInterrupt: () => void): Runtime {
  const queue: unknown[] = []
  let wake: (() => void) | null = null
  let ended = false
  let failure: unknown
  let spent = 0

  async function* gen(): AsyncGenerator<unknown, void, unknown> {
    for (;;) {
      while (queue.length > 0) yield queue.shift()
      if (failure !== undefined) throw failure
      if (ended) return
      // Sequential by nature: this generator *is* the runtime's clock.
      // eslint-disable-next-line no-await-in-loop
      await new Promise<void>((resolve) => {
        wake = resolve
      })
    }
  }

  const nudge = (): void => {
    const resume = wake
    wake = null
    resume?.()
  }
  const end = (): void => {
    ended = true
    nudge()
  }

  const handle = gen() as AgentQueryHandle
  handle.interrupt = async () => {
    onInterrupt()
  }
  handle.setModel = async () => undefined
  const originalReturn = handle.return.bind(handle)
  handle.return = ((value?: void) => {
    end()
    return originalReturn(value)
  }) as AgentQueryHandle['return']

  return {
    handle,
    result: (turn, subtype) => {
      spent += turn.costUsd
      return { type: 'result', uuid: turn.uuid, subtype, total_cost_usd: spent }
    },
    deliver: (messages) => {
      queue.push(...messages)
      nudge()
    },
    end,
    fail: (error) => {
      failure = error
      nudge()
    },
  }
}

type Outcome = {
  readonly mainUsd: number
  readonly mainOpen: number
  readonly rendererUsd: number
  readonly rendererOpen: number
  readonly rendererTurnState: Transcript['turnState']
  readonly starts: number
  readonly ceilings: readonly (number | undefined)[]
  readonly interrupts: number
  readonly budgetErrors: number
  readonly networkErrors: number
}

/** A macrotask boundary: every microtask chain a runtime's `end()` started has run by then. */
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

async function run(script: Script, duplicate: boolean): Promise<Outcome> {
  const runtimes: Runtime[] = []
  const ceilings: (number | undefined)[] = []
  let interrupts = 0
  let interruptReply: readonly Turn[] | null = null
  const times = (message: unknown): unknown[] => (duplicate ? [message, message] : [message])

  const queryFn: AgentQueryFn = ({ options }) => {
    ceilings.push(options.maxBudgetUsd)
    const runtime: Runtime = scriptedRuntime(() => {
      interrupts += 1
      const reply = interruptReply
      interruptReply = null
      if (reply !== null) {
        runtime.deliver(reply.flatMap((turn) => times(runtime.result(turn, 'success'))))
      }
    })
    runtimes.push(runtime)
    return runtime.handle
  }

  // The renderer ledger: the real reducer, fed exactly what main emits.
  let renderer: Transcript = initialTranscript
  const emitted: AgentEvent[] = []
  const waiters: (() => void)[] = []
  const session = new AgentSession({
    queryFn,
    options: { ...OPTIONS, maxBudgetUsd: CAP },
    emit: (event) => {
      emitted.push(event)
      renderer = reduceTranscript(renderer, { type: 'agent-event', event })
      for (const waiter of waiters.splice(0)) waiter()
    },
    log: () => {},
  })

  const turnEnds = (): number => emitted.filter((e) => e.type === 'turn-end').length
  const untilTurnEnds = (n: number): Promise<void> =>
    new Promise((resolve, reject) => {
      const deadline = setTimeout(() => {
        reject(
          new Error(
            `expected ${String(n)} turn-ends, saw ${String(turnEnds())}: ${emitted.map((e) => e.type).join(',')}`,
          ),
        )
      }, 2000)
      const check = (): void => {
        if (turnEnds() >= n) {
          clearTimeout(deadline)
          resolve()
        } else {
          waiters.push(check)
        }
      }
      check()
    })
  const current = (): Runtime => {
    const runtime = runtimes.at(-1)
    if (runtime === undefined) throw new Error('no query has been opened')
    return runtime
  }

  let ends = 0
  let disposed = false
  for (const step of script.steps) {
    switch (step.kind) {
      case 'send':
        renderer = reduceTranscript(renderer, {
          type: 'user-send',
          text: step.turn.text,
          turnId: step.turn.id,
        })
        session.send(step.turn.text)
        break
      case 'stop':
        renderer = reduceTranscript(renderer, { type: 'interrupt-requested' })
        // Sequential by construction: each step is the next thing that happens.
        // eslint-disable-next-line no-await-in-loop
        await session.interrupt()
        break
      case 'result':
        current().deliver(times(current().result(step.turn, step.subtype)))
        ends += 1
        // eslint-disable-next-line no-await-in-loop
        await untilTurnEnds(ends)
        break
      case 'stray':
        // A poison total no real subprocess would report: proof it is the open-turn count, not the
        // size of the number, that keeps it out of both ledgers.
        current().deliver(
          times({ type: 'result', uuid: 'r-stray', subtype: 'success', total_cost_usd: 9.99 }),
        )
        // Main still emits the (no-op) turn-end; both ledgers ignore it.
        ends += 1
        // eslint-disable-next-line no-await-in-loop
        await untilTurnEnds(ends)
        break
      case 'query-ends':
        current().end()
        ends += step.closes
        // eslint-disable-next-line no-await-in-loop
        await untilTurnEnds(ends)
        // eslint-disable-next-line no-await-in-loop
        await flush()
        break
      case 'query-throws':
        current().fail(new Error('read ECONNRESET'))
        ends += step.closes
        // eslint-disable-next-line no-await-in-loop
        await untilTurnEnds(ends)
        // eslint-disable-next-line no-await-in-loop
        await flush()
        break
      case 'set-cap':
        interruptReply = step.reply
        session.setBudgetCap(step.capUsd)
        if (step.reply !== null && step.reply.length > 0) {
          ends += 1
          // eslint-disable-next-line no-await-in-loop
          await untilTurnEnds(ends)
        } else {
          // eslint-disable-next-line no-await-in-loop
          await flush()
        }
        break
      case 'refused-send':
        renderer = reduceTranscript(renderer, { type: 'user-send', text: 'refused', turnId: 'TR' })
        renderer = reduceTranscript(renderer, { type: 'turn-refused', turnId: 'TR' })
        break
      case 'dispose':
        // eslint-disable-next-line no-await-in-loop
        await session.close()
        disposed = true
        break
    }
  }
  if (!disposed) await session.close()

  return {
    mainUsd: session.estimatedSpendUsd,
    mainOpen: session.openTurns,
    rendererUsd: renderer.cost.totalUsd,
    rendererOpen: renderer.cost.openTurns,
    rendererTurnState: renderer.turnState,
    starts: runtimes.length,
    ceilings,
    interrupts,
    budgetErrors: emitted.filter((e) => e.type === 'error' && e.kind === 'budget').length,
    networkErrors: emitted.filter((e) => e.type === 'error' && e.kind === 'network').length,
  }
}

/* -------------------------------------------------------------------------------------------- *
 * The matrix
 * -------------------------------------------------------------------------------------------- */

/** Every subset of `CONDITIONS` with at most `maxSize` members, the empty set first. */
function subsets(maxSize: number): Condition[][] {
  const out: Condition[][] = [[]]
  for (let size = 1; size <= maxSize; size += 1) {
    const walk = (start: number, picked: Condition[]): void => {
      if (picked.length === size) {
        out.push([...picked])
        return
      }
      for (let i = start; i < CONDITIONS.length; i += 1) {
        const next = CONDITIONS[i]
        if (next !== undefined) walk(i + 1, [...picked, next])
      }
    }
    walk(0, [])
  }
  return out
}

const CASES = subsets(3).map((conditions) => ({
  name: conditions.length === 0 ? 'plain' : conditions.join(' × '),
  conditions,
}))

describe('cost agreement — every pair and triple of conditions, against the spend model', () => {
  it('enumerates the conditions, all pairs, and all triples', () => {
    const n = CONDITIONS.length
    const pairs = (n * (n - 1)) / 2
    const triples = (n * (n - 1) * (n - 2)) / 6
    expect(CASES).toHaveLength(1 + n + pairs + triples)
  })

  it.each(CASES)('$name', async ({ conditions }) => {
    const active = new Set<Condition>(conditions)
    const script = compose(active)
    const outcome = await run(script, active.has('duplicate'))

    // The absolute oracle first: both ledgers must equal the money the script actually spent...
    expect(outcome.mainUsd).toBeCloseTo(script.expectedUsd, 10)
    expect(outcome.rendererUsd).toBeCloseTo(script.expectedUsd, 10)
    // ...and only then that they agree with each other, exactly, on both halves of the ledger.
    expect(outcome.mainUsd).toBe(outcome.rendererUsd)
    expect(outcome.mainOpen).toBe(script.expectedOpenAtEnd)
    expect(outcome.rendererOpen).toBe(script.expectedOpenAtEnd)

    // No churn: a cap edit never spawns a query; only a query ending re-arms one.
    expect(outcome.starts).toBe(script.expectedStarts)
    // Every query is opened with the ABSOLUTE cap in force, never a decaying remainder.
    for (const ceiling of outcome.ceilings) expect([CAP, 10, 1.5, 0.2]).toContain(ceiling)
    expect(outcome.ceilings[0]).toBe(CAP)

    // Cap stops go through interrupt(), only when the cap is genuinely below spend, and are told
    // once per crossing.
    expect(outcome.interrupts).toBe(script.expectedInterrupts)
    expect(outcome.budgetErrors).toBe(script.expectedBudgetErrors)
    expect(outcome.networkErrors).toBe(script.expectedNetworkErrors)

    // The composer never wedges: a session that was not disposed mid-turn is never left streaming.
    if (script.expectedOpenAtEnd === 0) expect(outcome.rendererTurnState).not.toBe('streaming')
  })
})
