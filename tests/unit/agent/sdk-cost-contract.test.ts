/**
 * The pin behind `shared/agent/cost.ts`: the fold treats `result.total_cost_usd` as the CLI
 * subprocess's **cumulative** total, and banks a finished query's total because the SDK path never
 * restores the tracker on resume. Both facts were read out of the bundled CLI binary, not out of any
 * documentation, so they are only known to hold for the exact version they were read from.
 *
 * If either assertion below fails, do not bump the pin blindly. Re-verify against the new binary
 * (`node_modules/.pnpm/@anthropic-ai+claude-agent-sdk-<platform>@<ver>/.../claude`):
 *
 *  1. the cost tracker is still process-cumulative — in 2.1.220: `Jbi(e,t,r){...Ot.totalCostUSD+=e}`
 *     per API call, `vS(){return Ot.totalCostUSD}`, every result builder writes
 *     `total_cost_usd:vS()`, and the only reset `j2m()` has no callers;
 *  2. the SDK stream-json path still never persists `lastSessionId`/`lastCost` — in 2.1.220 the
 *     only writer is `nZu()`, reached from the `/clear` reset (`PSi()`) and the interactive REPL's
 *     React exit hook (`Vzf`), so `xws(id)` never matches and a resumed query starts at $0;
 *  3. the ceiling check is still `vS() >= maxBudgetUsd` (`zcr`) on that same tracker.
 *
 * Then update the pin and, if any of the three moved, `cost.ts` and 50-agent-integration.md §10.
 */

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SDK_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../node_modules/@anthropic-ai/claude-agent-sdk',
)

/** The versions the cumulative-cost evidence was read from. See the module docstring before changing. */
const VERIFIED = { sdk: '0.3.220', cli: '2.1.220' }

const read = (file: string): string => readFileSync(path.join(SDK_DIR, file), 'utf8')

describe('SDK cost contract — the runtime the fold was written against', () => {
  it('is the bundled CLI whose binary the cumulative semantics were read from', () => {
    const sdk = (JSON.parse(read('package.json')) as { version: string }).version
    const cli = (JSON.parse(read('manifest.json')) as { version: string }).version
    expect({ sdk, cli }).toEqual(VERIFIED)
  })

  it('result messages carry exactly one money field, and it is the cumulative one', () => {
    // A per-turn cost field appearing here would be the moment to revisit the fold: today the only
    // number the SDK gives is the running total, which is why the fold is a maximum, not a sum.
    const dts = read('sdk.d.ts')
    for (const name of ['SDKResultSuccess', 'SDKResultError']) {
      const body = new RegExp(`export declare type ${name} = \\{([\\s\\S]*?)\\n\\};`).exec(dts)?.[1]
      expect(body, `${name} declaration`).toBeDefined()
      const fields = [...(body ?? '').matchAll(/^\s+([a-zA-Z_]+)\??:/gm)].map((m) => m[1])
      expect(fields).toContain('uuid')
      expect(fields.filter((f) => /cost|usd|price|spend|charge/i.test(f ?? ''))).toEqual([
        'total_cost_usd',
      ])
    }
  })
})
