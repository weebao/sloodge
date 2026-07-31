/**
 * A ~40-line store with Zustand's shape, built on React's own `useSyncExternalStore`.
 *
 * 10-architecture.md names Zustand for renderer state, and this deliberately matches its surface —
 * `create(set => …)` returning a hook that is also `{ getState, setState, subscribe }` — so that
 * adopting the real package later is an import swap, not a rewrite of every call site. It exists
 * rather than the dependency because M1.3 needs exactly this much: one deck, one selection, and a
 * subscription. `useSyncExternalStore` is the same primitive Zustand builds on, and it is the piece
 * that makes external state safe under concurrent rendering; what the package adds on top —
 * middleware, `subscribeWithSelector`, devtools, persistence, vanilla/React split — is what M1.4's
 * command and undo layer should be evaluated against, with a real workload to judge it by.
 *
 * ## Selector contract
 *
 * A selector must return a value that is `Object.is`-stable while the state it reads is unchanged:
 * a state slice, or something derived from one. Returning a fresh object or array literal
 * (`s => s.deck.slideOrder.map(…)`) makes `getSnapshot` return a new reference every call, which
 * React treats as "the store changed" and re-renders forever. Derive in a `useMemo` over a
 * subscribed slice instead — see `AppShell`.
 */

import { useSyncExternalStore } from 'react'

export type StatePatch<T> = Partial<T> | ((state: T) => Partial<T>)
export type SetState<T> = (patch: StatePatch<T>) => void

export type StoreApi<T> = {
  getState: () => T
  setState: SetState<T>
  /** Returns an unsubscribe function. */
  subscribe: (listener: () => void) => () => void
}

export type UseBoundStore<T> = (<U>(selector: (state: T) => U) => U) & StoreApi<T>

export function createStore<T extends object>(
  initializer: (set: SetState<T>, get: () => T) => T,
): UseBoundStore<T> {
  const listeners = new Set<() => void>()
  let state: T

  const getState = (): T => state

  const setState: SetState<T> = (patch) => {
    const next = typeof patch === 'function' ? patch(state) : patch
    const keys = Object.keys(next) as (keyof T)[]
    // A no-op patch must not notify: every subscriber would re-render to render the same thing,
    // and in the rail that means re-running the memo comparison for every live slide frame.
    if (keys.every((key) => Object.is(next[key], state[key]))) return
    state = { ...state, ...next }
    // Copied because a listener may unsubscribe (or subscribe) during the notification pass.
    for (const listener of new Set(listeners)) listener()
  }

  const subscribe = (listener: () => void): (() => void) => {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  }

  state = initializer(setState, getState)

  function useBoundStore<U>(selector: (state: T) => U): U {
    const getSnapshot = (): U => selector(state)
    // The third argument is the server snapshot. There is no SSR in an Electron renderer, but
    // `useSyncExternalStore` uses it during hydration and passing the same reader is correct.
    return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  }

  return Object.assign(useBoundStore, { getState, setState, subscribe })
}
