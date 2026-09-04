import { act } from '@testing-library/react'
import { vi } from 'vitest'

/**
 * A hand-driven `IntersectionObserver` for the rail tests.
 *
 * happy-dom ships an `IntersectionObserver` whose `observe` is a `// TODO` — it never calls back,
 * so under it every thumbnail stays a placeholder and nothing about the gate can be shown. This
 * fake records what was observed and lets a test *declare* which targets are in view, which is
 * exactly the input the rail's tracker turns into live frames.
 *
 * Typed structurally rather than against the DOM lib's `IntersectionObserver*` names so it compiles
 * under both test tsconfigs; the tracker only ever reads `target` and `isIntersecting`.
 */
type Entry = { readonly target: Element; readonly isIntersecting: boolean }
type Callback = (entries: Entry[], observer: unknown) => void
type Init = { root?: Element | Document | null; rootMargin?: string }

export class FakeIntersectionObserver {
  static instances: FakeIntersectionObserver[] = []

  readonly targets = new Set<Element>()
  readonly root: Element | Document | null
  readonly rootMargin: string
  readonly #callback: Callback

  constructor(callback: Callback, options: Init = {}) {
    this.#callback = callback
    this.root = options.root ?? null
    this.rootMargin = options.rootMargin ?? '0px'
    FakeIntersectionObserver.instances.push(this)
  }

  observe(target: Element): void {
    this.targets.add(target)
  }

  unobserve(target: Element): void {
    this.targets.delete(target)
  }

  disconnect(): void {
    this.targets.clear()
  }

  /** Report visibility for some observed targets, the way the browser would on a scroll. */
  report(visible: ReadonlyMap<Element, boolean>): void {
    const entries = [...visible].map(([target, isIntersecting]) => ({ target, isIntersecting }))
    act(() => {
      this.#callback(entries, this)
    })
  }

  /** Every observed target at once. */
  reportAll(isIntersecting: boolean): void {
    this.report(new Map([...this.targets].map((target) => [target, isIntersecting])))
  }
}

/** Install the fake for one test; pair with `vi.unstubAllGlobals()` in `afterEach`. */
export function installFakeIntersectionObserver(): typeof FakeIntersectionObserver {
  FakeIntersectionObserver.instances = []
  vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver)
  return FakeIntersectionObserver
}
