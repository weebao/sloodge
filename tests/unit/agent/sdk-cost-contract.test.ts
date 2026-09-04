/**
 * The pin behind `shared/agent/cost.ts`: the fold treats `result.total_cost_usd` as the CLI
 * subprocess's **cumulative** total, banks a finished query's total, and banks again whenever that
 * total is seen to drop. Every one of those facts was read out of the bundled CLI binary, not out of
 * any documentation, so they are only known to hold for the exact version they were read from —
 * verified against the binary whose sha256 equals this manifest's `linux-x64` checksum.
 *
 * Three rounds of review have now stated a *negative* fact about this binary ("the tracker is always
 * restored on resume", "a stream-json subprocess never writes the key", "the restore runs on the
 * non-interactive resume path") and been wrong. Prefer positive, structural guarantees; that is why
 * every resume is forked rather than trusted (`client.ts`).
 *
 * If an assertion below fails, do not bump the pin blindly. Re-verify against the new binary. It is
 * ~275 MB, so a broad regex will not finish; work in fixed-string byte offsets:
 *
 *     BIN=$(find node_modules/.pnpm -name claude -type f -path '*claude-agent-sdk-linux-x64*')
 *     sha256sum "$BIN"                                           # == manifest.json's linux-x64 checksum
 *     grep -abo -F 'lEo(' "$BIN" | cut -d: -f1                   # every site, as byte offsets
 *     dd if="$BIN" bs=1 skip=$((OFFSET - 200)) count=500 status=none   # read one site in context
 *
 * The offsets quoted below are for sha256 `674f61f2…` only and move on any rebuild — re-derive them,
 * never trust them. Then check that:
 *
 *  1. the cost tracker is still process-cumulative — in 2.1.220: `Jbi(e,t,r){...Ot.totalCostUSD+=e}`
 *     per API call, `vS(){return Ot.totalCostUSD}`, every result builder writes
 *     `total_cost_usd:vS()`, and the only *per-turn* reset `j2m()` has no callers;
 *  2. a live subprocess can still have that tracker zeroed under it — in 2.1.220
 *     `Att(){Ot.totalCostUSD=0,...}`, reached from the `/clear` command (`type:"local"`,
 *     `aliases:["reset","new"]`, `supportsNonInteractive:!0`). This is what the fold's reset branch
 *     and `isLocalCommandText` exist for; if `Att` ever stops being reachable from a
 *     non-interactive turn, they are belt-and-braces rather than load-bearing — do not delete them
 *     on that basis alone, since the guard is also what keeps the command list from mattering;
 *  3. the resume restore is still out of reach on our path. That is **not** the same claim as "every
 *     restore site is fork-gated", which is false — believing it is the trap this step exists to
 *     spring. In 2.1.220 each symbol has exactly three sites:
 *       `lEo(`  253843367 definition · 264561799 `cdi()` startup resume, in `if(!t.forkSession)` ·
 *               267491669 resume picker, in `if(Me.sessionId&&!f)` where `f` is forkSession
 *       `xws(`  253842867 definition · 253843380 inside `lEo` · 267254355 `let tf=xws(_t)`
 *       `Y$r(`  246916429 definition · 253843409 inside `lEo` · 267255672 `if(tf)Y$r(tf)`
 *     Both `lEo` call sites are fork-gated. The third `xws`/`Y$r` pair is a *separate* restore in an
 *     interactive React callback (`kr.useCallback(async(_t,dr,Nr)=>{` at 267252935, emitting
 *     `tengu_session_resumed`), and it is **not** fork-gated — `if(tf)Y$r(tf)` runs for `Nr==="fork"`
 *     and `Nr==="resume"` alike. It is unreachable for us only because the Ink TUI's session picker
 *     is the sole thing that drives it. So what has to keep holding is the pair: `sHm`
 *     (`loadInitialMessages`, the loader `--print` uses — definition at 267923531, `LBe` and `Zk` in
 *     its `tengu_continue_print` branch) contains none of the nine sites, and `--fork-session` keeps
 *     the process on the fresh uuid it minted at startup (`LBe`: `sessionId: forkSession ? kt() : s`)
 *     so no stale `lastSessionId` can match, which also gates out both `lEo` calls;
 *  4. the ceiling check is still `vS() >= maxBudgetUsd` (`zcr`) on that same tracker.
 *
 * Then update the pin and, if any of the four moved, `cost.ts` and 50-agent-integration.md §10.
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

  it('declares only the result variants whose money fields have been read', () => {
    // The scan below inspects the two concrete result types by name. A new variant carrying its own
    // cost field would slip past it silently, so the *set* is pinned too: adding one reds this test
    // and sends whoever added it to the fold. `SDKResultMessage` is the union of the other two.
    const names = [
      ...read('sdk.d.ts').matchAll(/^export declare type (SDKResult[A-Za-z]*) =/gm),
    ].map((m) => m[1])
    expect([...new Set(names)].toSorted()).toEqual([
      'SDKResultError',
      'SDKResultMessage',
      'SDKResultSuccess',
    ])
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
