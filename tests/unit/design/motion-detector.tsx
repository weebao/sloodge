/**
 * The one motion detector for the rendered-tree tests (M8b.3 surfaces 5 and 6). Lifted verbatim from
 * `tests/unit/canvas/canvas-design.test.tsx` (#81), where it was written and mutation-tested — the
 * `(…)` functional values, the `[transition:…]` arbitrary properties, vendor prefixes, the
 * `-none` / `-initial` / `-0` negations and the un-enumerated `WebkitTransition` own key are all its
 * findings — and shared so two surfaces cannot ship two ideas of what motion is (review r4 of #80).
 * `thumbnail-rail-design.test.tsx` imports it as well; a third surface should too. A `.tsx` with no JSX
 * because the web tsconfig (the one with the DOM lib) includes the `.tsx` files under `tests/unit` and
 * the node config takes the `.ts` ones — a `.ts` here would have no `Element` type.
 */

import { expect } from 'vitest'

const classes = (el: Element): string[] =>
  (el.getAttribute('class') ?? '').split(/\s+/).filter(Boolean)

/**
 * The utility a class token names, with its variants set aside — never parsed. Bracketed and
 * parenthesised groups are masked first (`[&:not(:hover)]`, `[@media(hover:hover)]`,
 * `data-[state=open]` all carry `:` inside them), the token is split on the `:` that remain, the last
 * segment is the utility, and the important modifier is dropped from either end (`!transition` is
 * v4's still-accepted legacy spelling, `transition!` the current one). Review r1 and r2 of this file
 * each found variant shapes a variant *grammar* had not enumerated; a grammar that never reads the
 * variants has nothing left to enumerate.
 */
function utilityOf(token: string): {
  readonly utility: string
  readonly variants: readonly string[]
} {
  const segments: string[] = []
  let depth = 0
  let start = 0
  for (let i = 0; i < token.length; i += 1) {
    const c = token[i]
    if (c === '[' || c === '(') depth += 1
    else if (c === ']' || c === ')') depth = Math.max(0, depth - 1)
    else if (c === ':' && depth === 0) {
      segments.push(token.slice(start, i))
      start = i + 1
    }
  }
  segments.push(token.slice(start))
  const raw = segments.pop() ?? ''
  return { utility: raw.replace(/^!/, '').replace(/!$/, ''), variants: segments }
}

/**
 * A utility value in the three v4 shapes: a name, a `(…)` functional value — `(--x)`, the
 * `(--x,fallback)` form and the `(type:--x)` type-hint form all included, which is why the group is
 * `[^)]*` and not a bare `--var` (review r3 found the other two forms compiling to real transitions)
 * — or a `[…]` literal.
 */
const VALUE = String.raw`(?:[\w.%/-]+|\([^)]*\)|\[[^\]]*\])`
/** `-webkit-` and friends, on an arbitrary property or an inline style name. */
const VENDOR = String.raw`(?:-?(?:webkit|moz|ms|o)-?)?`
/**
 * Every Tailwind utility that moves something over time: `transition` and `transition-*`,
 * `duration-*`, `delay-*`, `ease-*`, `animate-*` (each in the three value spellings — a lone
 * `duration-(--x)` animates `all`, like a lone inline `transitionDuration`), and the
 * `[transition:…]` / `[animation:…]` arbitrary properties. `starting:` is a variant that only exists
 * to feed a transition, so it is caught on the variants side.
 */
const MOTION_UTILITY = new RegExp(
  `^(?:transition(?:-${VALUE})?|(?:duration|delay|ease|animate)-${VALUE}|\\[${VENDOR}(?:transition|animation)[^\\]]*\\])$`,
)
/**
 * The NEGATION of motion, which must not be reported as motion: `transition-none`, `animate-none`,
 * `duration-initial` and kin. Three spellings the bare `-none|-initial` suffix cannot see, all
 * unused today and all found by review r4 as false positives: a zero (`duration-0`), the bracketed
 * form (`duration-[initial]`), and an arbitrary property whose value is itself off
 * (`[transition:none]`). A guard that reds legitimate code is the one that gets deleted.
 */
const MOTION_OFF =
  /-(?:none|initial|0)$|-\[(?:none|initial|0s?|0ms)\]$|^\[[^\]]*:\s*(?:none|initial|0s|0ms)\]$/
export const isMotion = (token: string): boolean => {
  const { utility, variants } = utilityOf(token)
  return (
    (MOTION_UTILITY.test(utility) && !MOTION_OFF.test(utility)) || variants.includes('starting')
  )
}

/**
 * Every inline style property that moves something over time, vendor-prefixed or not. React writes
 * `WebkitTransition` as an own property that happy-dom does NOT enumerate — see the note in
 * `movingParts`, which is why the own keys are read as well. `transitionDuration` alone
 * is enough — `transition-property` defaults to `all` — so the shorthand is not the only spelling to
 * refuse.
 */
const MOTION_STYLE = /^(?:webkit|moz|ms|o)?(?:transition|animation)/i

/** Every motion utility and inline transition/animation under `root`, `root` included — `[]` when still. */
export function movingParts(root: Element): string[] {
  const moving: string[] = []
  for (const el of [root, ...root.querySelectorAll('*')]) {
    for (const klass of classes(el)) if (isMotion(klass)) moving.push(`${el.tagName}.${klass}`)
    const style = (el as HTMLElement).style
    // `style` enumerates the properties that are SET on the element (React writes each one) …
    for (let i = 0; i < style.length; i += 1) {
      const name = style[i] ?? ''
      const camel = name.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())
      if (MOTION_STYLE.test(camel)) {
        moving.push(`${el.tagName} style.${camel}=${style.getPropertyValue(name)}`)
      }
    }
    // … except a vendor-prefixed one: React assigns `style.WebkitTransition = …`, which a browser
    // turns into the `-webkit-transition` declaration but happy-dom's CSSStyleDeclaration keeps as a
    // plain own property — not enumerated, not in `cssText`, not in the attribute (probed in review
    // r3). So the own keys are read too; in a browser they are the same declarations twice.
    for (const [key, value] of Object.entries(style as unknown as Record<string, unknown>)) {
      if (MOTION_STYLE.test(key) && typeof value === 'string' && value !== '') {
        moving.push(`${el.tagName} style.${key}=${value}`)
      }
    }
  }
  return moving
}

export function expectStill(root: Element, what: string): void {
  expect(movingParts(root), `${what} must not animate (audit §4.3 item 6, M8b.0 §3.1)`).toEqual([])
}
