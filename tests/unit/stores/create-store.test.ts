import { describe, expect, it, vi } from 'vitest'
import { createStore } from '../../../src/renderer/src/stores/createStore'

type Counter = { count: number; label: string; bump: () => void }

function counterStore(): ReturnType<typeof createStore<Counter>> {
  return createStore<Counter>((set, get) => ({
    count: 0,
    label: 'a',
    bump: () => {
      set({ count: get().count + 1 })
    },
  }))
}

describe('createStore', () => {
  it('exposes the initial state and the actions built from set/get', () => {
    const store = counterStore()
    expect(store.getState().count).toBe(0)

    store.getState().bump()
    store.getState().bump()

    expect(store.getState().count).toBe(2)
  })

  it('replaces state immutably — the previous snapshot is untouched', () => {
    const store = counterStore()
    const before = store.getState()

    store.setState({ count: 5 })

    expect(before.count).toBe(0)
    expect(store.getState()).not.toBe(before)
    expect(store.getState().label).toBe('a')
  })

  it('accepts a functional patch', () => {
    const store = counterStore()
    store.setState((state) => ({ count: state.count + 10 }))
    expect(store.getState().count).toBe(10)
  })

  it('notifies subscribers, and stops on unsubscribe', () => {
    const store = counterStore()
    const listener = vi.fn()
    const unsubscribe = store.subscribe(listener)

    store.setState({ count: 1 })
    expect(listener).toHaveBeenCalledTimes(1)

    unsubscribe()
    store.setState({ count: 2 })
    expect(listener).toHaveBeenCalledTimes(1)
    expect(store.getState().count).toBe(2)
  })

  // A no-op patch that still notified would re-render every subscriber to paint the same pixels —
  // in the rail that is one memo comparison per live slide frame, for nothing.
  it('does not notify when the patch changes nothing', () => {
    const store = counterStore()
    const listener = vi.fn()
    store.subscribe(listener)

    store.setState({ count: 0 })
    store.setState({})
    store.setState((state) => ({ label: state.label }))

    expect(listener).not.toHaveBeenCalled()
    expect(store.getState().count).toBe(0)
  })

  it('survives a listener unsubscribing during the notification pass', () => {
    const store = counterStore()
    const second = vi.fn()
    const unsubscribeFirst = store.subscribe(() => {
      unsubscribeFirst()
    })
    store.subscribe(second)

    expect(() => {
      store.setState({ count: 1 })
    }).not.toThrow()
    expect(second).toHaveBeenCalledTimes(1)
  })
})
