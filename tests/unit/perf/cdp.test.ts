/**
 * `waitFor` against a fake client. No socket: what is pinned is which deadline each tick is given,
 * what the failure message carries, and which errors end the wait at once. Real-peer behaviour
 * (SIGKILL, SIGSTOP) is probed by hand against a Node inspector; see perf/README.md.
 */

import { describe, expect, it } from 'vitest'
import { CdpClosedError, waitFor, type CdpClient } from '../../../perf/harness/cdp'

type Tick = (expression: string, timeoutMs: number | undefined) => Promise<unknown>

function fake(tick: Tick): Pick<CdpClient, 'evaluate'> {
  return {
    evaluate: <T>(expression: string, timeoutMs?: number) =>
      tick(expression, timeoutMs) as Promise<T>,
  }
}

describe('waitFor', () => {
  it('resolves once the expression is true', async () => {
    let calls = 0
    const client = fake(() => {
      calls += 1
      return Promise.resolve(calls >= 2)
    })
    await waitFor(client, 'ready', 5000, 1)
    expect(calls).toBe(2)
  })

  it('bounds every tick by what is left of its own deadline, not the per-call default', async () => {
    // A frozen renderer used to turn a 2.5 s wait into a 30 s one, because each tick waited the
    // full per-call deadline and the loop only noticed its own afterwards.
    const budgets: number[] = []
    const client = fake((_expression, timeoutMs) => {
      budgets.push(timeoutMs ?? Number.POSITIVE_INFINITY)
      return Promise.resolve(false)
    })
    await expect(waitFor(client, 'ready', 40, 5)).rejects.toThrow(/Timed out after 40 ms/)
    expect(budgets.length).toBeGreaterThan(0)
    expect(budgets.every((ms) => ms >= 1 && ms <= 40)).toBe(true)
  })

  it('names the last swallowed error in the timeout message', async () => {
    const client = fake(() =>
      Promise.reject(new Error('CDP call Runtime.evaluate (id 3) got no reply in 40 ms')),
    )
    await expect(waitFor(client, '1 === 2', 40, 5)).rejects.toThrow(
      'Timed out after 40 ms waiting for: 1 === 2; last error: CDP call Runtime.evaluate (id 3) got no reply in 40 ms',
    )
  })

  it('rethrows a closed socket at once instead of polling a corpse until the deadline', async () => {
    let calls = 0
    const client = fake(() => {
      calls += 1
      return Promise.reject(new CdpClosedError('code 1006'))
    })
    await expect(waitFor(client, 'ready', 60_000, 1)).rejects.toBeInstanceOf(CdpClosedError)
    expect(calls).toBe(1)
  })

  it('lets the guard end the wait before the first tick', async () => {
    const client = fake(() => Promise.resolve(false))
    await expect(
      waitFor(client, 'ready', 60_000, 1, () => {
        throw new Error('app exited')
      }),
    ).rejects.toThrow('app exited')
  })
})
