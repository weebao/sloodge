import { describe, expect, it, vi } from 'vitest'
import {
  createControlsAutoHide,
  type Schedule,
} from '../../../src/renderer/src/features/present/controlsAutoHide'

type ManualClock = {
  schedule: Schedule
  /** Run the pending callback, if any. */
  fire: () => void
  /** Whether a callback is currently armed. */
  pending: () => boolean
  /** How many armed timers were cancelled. */
  cancelled: () => number
}

/**
 * A manual clock: `schedule` records the pending callback; `fire()` runs it. Injecting this is the
 * whole point of the controller — the timing rules are assertions, not `advanceTimersBy` races.
 */
function manualClock(): ManualClock {
  let fn: (() => void) | null = null
  let cancelled = 0
  return {
    schedule: (callback) => {
      fn = callback
      return () => {
        cancelled += 1
        fn = null
      }
    },
    fire: () => {
      const current = fn
      fn = null
      current?.()
    },
    pending: () => fn !== null,
    cancelled: () => cancelled,
  }
}

describe('createControlsAutoHide', () => {
  it('shows on poke and hides after the timeout fires', () => {
    const clock = manualClock()
    const onChange = vi.fn()
    const controller = createControlsAutoHide({
      timeoutMs: 2500,
      schedule: clock.schedule,
      onChange,
    })

    controller.poke()
    expect(onChange).toHaveBeenLastCalledWith(true)

    clock.fire()
    expect(onChange).toHaveBeenLastCalledWith(false)
  })

  it('resets the countdown on a fresh poke rather than piling up timers', () => {
    const clock = manualClock()
    const onChange = vi.fn()
    const controller = createControlsAutoHide({
      timeoutMs: 2500,
      schedule: clock.schedule,
      onChange,
    })

    controller.poke()
    controller.poke()
    // The first timer was cancelled before the second was armed.
    expect(clock.cancelled()).toBe(1)
    expect(clock.pending()).toBe(true)
  })

  it('fires onChange only on a real transition, not for repeated pokes while visible', () => {
    const clock = manualClock()
    const onChange = vi.fn()
    const controller = createControlsAutoHide({
      timeoutMs: 2500,
      schedule: clock.schedule,
      onChange,
    })

    controller.poke()
    controller.poke()
    controller.poke()
    // Three pokes, one visibility change.
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenCalledWith(true)
  })

  it('hideNow hides immediately and cancels any pending fade', () => {
    const clock = manualClock()
    const onChange = vi.fn()
    const controller = createControlsAutoHide({
      timeoutMs: 2500,
      schedule: clock.schedule,
      onChange,
    })

    controller.poke()
    onChange.mockClear()
    controller.hideNow()

    expect(onChange).toHaveBeenCalledWith(false)
    expect(clock.pending()).toBe(false)
    expect(clock.cancelled()).toBe(1)
  })

  it('dispose cancels the pending timer without touching visibility', () => {
    const clock = manualClock()
    const onChange = vi.fn()
    const controller = createControlsAutoHide({
      timeoutMs: 2500,
      schedule: clock.schedule,
      onChange,
    })

    controller.poke()
    onChange.mockClear()
    controller.dispose()

    expect(onChange).not.toHaveBeenCalled()
    expect(clock.pending()).toBe(false)
  })
})
