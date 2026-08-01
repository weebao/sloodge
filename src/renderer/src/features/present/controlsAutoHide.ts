/**
 * Auto-hiding controls timing for Present mode (M4.1), as a controller with the timer *injected*.
 *
 * The wireframe (20-ui-wireframes.md § Present mode) wants the nav controls to appear on mouse move
 * and fade after a spell of inactivity. That is a stateful timer dance — the exact kind of thing
 * that rots into an untestable `setTimeout` buried in a component. Pulling it out here, with
 * `schedule` supplied by the caller, makes "shown on poke, hidden after the timeout, and a fresh
 * poke cancels the pending hide" three assertions against a fake clock rather than a flaky
 * `vi.advanceTimersByTime` race.
 *
 * `schedule` returns its own cancel function rather than an opaque handle so the controller never has
 * to know whether it is driving `window.setTimeout`, Node timers, or a test stub — it just cancels
 * what it last scheduled.
 */

/** Cancels a scheduled callback that has not fired yet. Calling it after the callback fired is a no-op. */
export type CancelScheduled = () => void

/** Schedule `fn` to run in `ms`; returns a canceller. The seam that makes the timer injectable. */
export type Schedule = (fn: () => void, ms: number) => CancelScheduled

export type ControlsAutoHide = {
  /** Mouse moved (or nav happened): show the controls and (re)start the fade countdown. */
  poke: () => void
  /** Hide immediately and cancel any pending fade — used when the surface unmounts mid-countdown. */
  hideNow: () => void
  /** Cancel any pending timer without changing visibility. Call on teardown. */
  dispose: () => void
}

export type ControlsAutoHideOptions = {
  /** Idle time before the controls fade, in ms. */
  readonly timeoutMs: number
  /** The timer seam; defaulted by the hook to `window.setTimeout`, replaced by tests. */
  readonly schedule: Schedule
  /** Called only when visibility actually flips, so a component setState never fires for a no-op. */
  readonly onChange: (visible: boolean) => void
}

/**
 * Build a controller. It starts hidden; the first `poke` shows the controls and arms the fade.
 * `onChange` fires only on a real transition, so poking repeatedly while already visible just resets
 * the countdown without a storm of identical `true`s.
 */
export function createControlsAutoHide(options: ControlsAutoHideOptions): ControlsAutoHide {
  const { timeoutMs, schedule, onChange } = options
  let cancel: CancelScheduled | null = null
  let visible = false

  const clearPending = (): void => {
    if (cancel !== null) {
      cancel()
      cancel = null
    }
  }

  const set = (next: boolean): void => {
    if (next !== visible) {
      visible = next
      onChange(next)
    }
  }

  return {
    poke: () => {
      clearPending()
      set(true)
      cancel = schedule(() => {
        cancel = null
        set(false)
      }, timeoutMs)
    },
    hideNow: () => {
      clearPending()
      set(false)
    },
    dispose: () => {
      clearPending()
    },
  }
}
