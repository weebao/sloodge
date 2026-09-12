/**
 * @vitest-environment happy-dom
 *
 * M8b.3 surface 5 (ui-design-audit.md §4.3, §7 row 5): the canvas, the selection overlay and the
 * refused-edit notice stay on the role tokens, and the four findings the row names — T2, T6, U8,
 * U19 — stay closed.
 *
 * Two halves, because neither can see the other's regression:
 *
 *  - **The file gate, run as a test** — `tests/unit/design/migrated-files-check.test.ts` spawns
 *    `node scripts/design-inventory.mjs --check` once over every migrated file, these three among
 *    them, so a retired token, a `dark:` twin, a palette colour, an alpha suffix or an arbitrary
 *    value coming back reds `pnpm test`.
 *  - **The rendered class of each finding's element — this file.** The gate cannot see a *role*
 *    token that is the wrong role: `text-text-muted` on the empty-state caption is T6 back at 4.34:1
 *    with every column still 0 (rule R5); `border-accent` on the editing frame is U19's *distinct*
 *    frame gone while the ratio still passes; `bg-hud` on the editing label instead of `bg-edit`, or
 *    the lock badge on `bg-accent`, keeps the columns at 0 while the mode cues merge. So each element
 *    is rendered and its class list read — the same shape as `chat-panel-design.test.tsx`,
 *    `app-shell-design.test.tsx` and `settings-design.test.tsx`.
 *
 * A third thing this file pins that the earlier surfaces did not need to: **nothing on the canvas or
 * the overlay animates** (audit §4.3 item 6, M8b.0 §3.1). The selection box, the eight handles, the
 * rotate handle, the hover outline, the marquee and the smart guides are direct-manipulation
 * affordances at 100+ uses a day — a transition on the box makes the handles lag the cursor during a
 * drag, and a fade on a guide means the guide arrives after the snap it exists to explain — and the
 * canvas's fit scale is driven by a continuous `ResizeObserver`, so any transition there lags every
 * window drag by its own duration. The overlay is the most tempting place in the app to add motion
 * and the one place the audit refuses it, so the refusal is asserted on the rendered tree in each of
 * the eight overlay states that draw a distinct element — hover, single selection, breadcrumb with
 * ancestors, editing, group, locked, marquee, mid-drag with guides — and on the canvas with Design
 * Mode on, off and with no slides at all, sweeping from the render root so a wrapper is inside it: no motion utility on any
 * element (`utilityOf` sets the variants aside unparsed, so `[&:not(:hover)]:transition`,
 * `hover:!transition-opacity`, `data-[state=open]:transition` and `duration-(--x)` all read as what
 * they are), and no inline style property in the `transition*` / `animation*` families —
 * `transitionDuration` alone animates `all`. Review r1 found the first cut skipped the marquee and
 * locked states and missed three spellings; r2 found seven more shapes a variant grammar had not
 * enumerated, the wrapper outside the sweep root and the breadcrumb state unvisited — hence a
 * detector that never reads variants, and `it('the motion detector …')` below, which is its own
 * mutation subject; r3 found the value grammar four functional spellings short (`(--x,fallback)`,
 * `(type:--x)`), no vendor prefixes, three negations (`transition-none`, `animate-none`,
 * `duration-initial`) flagged as motion, and the empty-deck canvas outside every sweep. The
 * three `requestAnimationFrame` sites in the gesture hooks (`useDragGesture.ts:206`,
 * `useRotateGesture.ts:96`, `useMarqueeGesture.ts:101`) are pointer-event coalescing, not motion,
 * and are not this file's subject.
 *
 * **What this file pins, exactly:** the mat (item 1, C7), the slide frame (item 1, U8), the four HUD
 * pills and the HUD hover (item 2, C6), the guides (item 3, C9), the editing frame and its label
 * (item 3, U19, T2), the hover label and the size / rotation badge (T7, kept), the handle fills, the
 * member outline and the marquee (item 3 — the two alpha sites), the breadcrumb (item 3, §2.8), the
 * lock badge, the empty state (item 4, T6), the `Notice` (item 5, T2), and the still tree (item 6).
 * **What it knowingly does not catch:** the values — happy-dom applies no stylesheet, so nothing here
 * shows that the tokens paint the ratios the audit measured (the census does that, `--check` pairs
 * 7, 14, 18–19, 21, 31–34, 47, 49–50, 63); and a hand-rolled element that spells the *right* tokens
 * in place of the `Notice` primitive would keep the class assertions green while losing the sr-only
 * tone word — which `notice.test.tsx` guards at the primitive and the "Warning:" assertion below
 * guards here.
 *
 * Mutations, each run on this branch with `--check` printing `RESULT: pass` throughout unless noted,
 * recorded in the PR: mat `bg-canvas` → `bg-surface` (1 failed); frame `shadow-floating` →
 * `shadow-raised` (1); live hint `text-hud-fg` → `text-on-fill` (1); caption `text-text` →
 * `text-text-muted` (1 — T6 back, gate green); guides `bg-guide` → `bg-accent` (1); editing frame
 * `border-edit` → `border-accent` (1 — U19's cue gone, gate green); editing label `bg-edit` →
 * `bg-hud` (1); lock badge `bg-warning` → `bg-accent` (1); handle `bg-surface-raised` → `bg-surface`
 * (1); breadcrumb parent `text-hud-fg/70` → `opacity-80` (1); clear `hover:bg-hud-strong` →
 * `hover:bg-hud` (1); clear `${FOCUS_RING}` deleted (1); `Notice tone="warning"` → `"info"` (1);
 * lock badge `rounded-control` → `rounded` (1); ✕ `rounded-full` → `rounded` (1); `icon="⚠"`
 * deleted (1); the `pointer-events-auto` wrapper dropped (1); a `transition-colors` on the
 * selection box, on the marquee box, on the marquee tint and on the lock badge, a `transition` on
 * the mat, an inline `transition: 'left 100ms'` and an inline `transitionDuration: '150ms'` on the
 * handle style, a `[transition:opacity_100ms]` and a `transition!` on the selection box each red a
 * still-tree case (gate green — the gate has no motion column); so do `[&::before]:transition`,
 * `hover:!transition-opacity`, `data-[state=open]:transition`, `[@media(hover:hover)]:transition`,
 * `[&:not(:hover)]:transition`, `duration-(--x)`, `transition-(--x)`, `md:[&>span]:!duration-300` and
 * `supports-[display:grid]:animate-working` on the selection box, a `transition` on the notice's
 * `pointer-events-auto` wrapper and an inline `transitionDuration` on a breadcrumb parent (1 each);
 * `duration-(--x,150ms)`, `transition-(--x,opacity)`, `duration-(length:--x)`, `duration-(time:--x)`
 * and `[-webkit-transition:opacity_1s]` on the selection box, an inline `WebkitTransition` on the
 * handles and a `transition` on the empty deck's "No slides" line (1 each);
 * member `border-accent` →
 * `border-accent/70` and marquee fill `bg-accent opacity-10` → `bg-accent/10` red here AND the
 * shared gate (`alpha = 1`).
 */

import type { CSSProperties } from 'react'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SlHit, SlRect } from '../../../src/shared/design/bridge-protocol'
import { buildSlideMap } from '../../../src/shared/design/slide-map'
import { SlideCanvas } from '../../../src/renderer/src/features/canvas/SlideCanvas'
import { DesignNotice } from '../../../src/renderer/src/features/design/DesignNotice'
import { useDesignStore } from '../../../src/renderer/src/features/design/designStore'
import { SelectionOverlay } from '../../../src/renderer/src/features/design/SelectionOverlay'
import {
  createStarterDeck,
  selectSlideViews,
  useDeckStore,
  type SlideView,
} from '../../../src/renderer/src/stores/deckStore'

/** Written out, not imported from `focusRing.ts`: the assertion must not track the drift it guards. */
const RING = [
  'focus-visible:outline-2',
  'focus-visible:outline-focus',
  'focus-visible:outline-offset-2',
] as const

const classes = (el: Element | null | undefined): string[] =>
  (el?.className ?? '').split(/\s+/).filter(Boolean)

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
const isMotion = (token: string): boolean => {
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
function movingParts(root: Element): string[] {
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

function expectStill(root: Element, what: string): void {
  expect(movingParts(root), `${what} must not animate (audit §4.3 item 6, M8b.0 §3.1)`).toEqual([])
}

/** Hoisted so the probe spans' props are not fresh objects (react-perf). */
const INLINE_MOTION: readonly (readonly [string, CSSProperties])[] = [
  ['transitionDuration', { transitionDuration: '150ms' }],
  ['transition', { transition: 'opacity 1s' }],
  ['animationName', { animationName: 'spin' }],
  ['WebkitTransition', { WebkitTransition: 'opacity 1s' }],
  ['WebkitAnimationDuration', { WebkitAnimationDuration: '1s' }],
]
const INLINE_STILL: readonly (readonly [string, CSSProperties])[] = [
  ['transform', { transform: 'rotate(90deg)' }],
  ['opacity', { opacity: 0.5 }],
  ['left', { left: '10px' }],
]

/** The one alpha rule R3 permits is `hud-fg/70`; every other colour utility with a `/` is a finding. */
function expectNoAlphaBut(root: Element, allowed: readonly string[], what: string): void {
  const alphas: string[] = []
  for (const el of [root, ...root.querySelectorAll('*')]) {
    for (const klass of classes(el)) {
      if (/^(?:[a-z-]+:)*(?:bg|text|border|outline|ring|fill|stroke)-[a-z-]+\/\d+$/.test(klass)) {
        if (!allowed.includes(klass)) alphas.push(klass)
      }
    }
  }
  expect(alphas, `${what}: an alpha on a role token is rule R3's forbidden shape`).toEqual([])
}

const frameRef = { current: null }

/** A selection hit for a `<div>` whose rendered rect and unrotated box coincide. */
function boxHit(slId: string, rect: SlRect): SlHit {
  return { slId, tag: 'div', id: null, classes: [], rect, box: rect, ancestors: [] }
}

/** One animation frame — the gesture hooks coalesce `pointermove` through `requestAnimationFrame`. */
const frame = (): Promise<void> =>
  act(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => resolve())
      }),
  )

const BOX = 'position:absolute;left:100px;top:100px;width:200px;height:100px'
/** Text-only content, so the element is editable and the "double-click to edit" hint shows. */
const FREE = `<div style="${BOX}">A</div>`
const LOCKED = `<div data-sl-lock style="${BOX}">A</div>`

let slideId = ''
/** Hoisted so the props are not fresh arrays on every render (react-perf). */
let slides: SlideView[] = []
const NO_SLIDES: readonly SlideView[] = []

/** Install `html` as the deck's only slide with an empty undo stack, and select its first div. */
function seed(html: string): string {
  const base = createStarterDeck(0)
  const id = base.currentSlideId!
  const slideHtml = Object.assign(Object.create(null) as Record<string, string>, { [id]: html })
  base.history.reset({
    manifest: base.deck,
    slides: slideHtml,
    notes: Object.create(null) as Record<string, string>,
    theme: null,
  })
  useDeckStore.setState({
    history: base.history,
    deck: base.history.doc.manifest,
    slideHtml: base.history.doc.slides,
    currentSlideId: id,
    canUndo: base.history.canUndo,
    canRedo: base.history.canRedo,
  })
  slideId = id
  const slId = buildSlideMap(id, html).order[0]!
  const hit = boxHit(slId, { x: 100, y: 100, width: 200, height: 100 })
  useDesignStore.setState({ enabled: true, selection: hit, selections: [hit], hover: null })
  return slId
}

const overlay = (): HTMLElement =>
  render(<SelectionOverlay frameRef={frameRef} slideId={slideId} scale={1} />).container
    .firstElementChild as HTMLElement

beforeEach(() => {
  useDesignStore.setState({
    enabled: true,
    hover: null,
    selection: null,
    selections: [],
    editing: null,
    notice: null,
  })
})

afterEach(cleanup)

describe('M8b.3 surface 5 — the canvas on the design tokens', () => {
  beforeEach(() => {
    // happy-dom's `createObjectURL` has no blob store behind it; the frame's URL is irrelevant here.
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('about:blank')
    vi.spyOn(URL, 'revokeObjectURL').mockReturnValue(undefined)
    useDeckStore.setState(createStarterDeck(0))
    const state = useDeckStore.getState()
    slides = [selectSlideViews(state.deck, state.slideHtml)[0]!]
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('item 1 / C7 / U8 — the mat is bg-canvas; the slide is surface-raised with outline-line and shadow-floating', () => {
    useDesignStore.setState({ enabled: false })
    render(<SlideCanvas slides={slides} currentIndex={0} />)

    const mat = classes(screen.getByRole('main', { name: 'Slide canvas' }))
    expect(mat, 'C7: the mat is the one achromatic token, opaque in both modes').toContain(
      'bg-canvas',
    )
    expect(mat.some((k) => k.startsWith('dark:') || k.includes('/'))).toBe(false)

    const box = classes(screen.getByTitle(/^Slide: /).parentElement)
    expect(box, 'U8: the shadow does the separating, from the tokens').toContain('shadow-floating')
    expect(box, 'the outline is decorative once the shadow is dark-adjusted').toContain(
      'outline-line',
    )
    expect(box, 'census pairs 47 / 49 / 50 measure the overlay against this ground').toContain(
      'bg-surface-raised',
    )
    expect(box.some((k) => k.startsWith('shadow-[') || k === 'bg-white')).toBe(false)
  })

  it('item 2 — the Design-Mode-off hint is a HUD pill: bg-hud, text-hud-fg, text-caption, rounded-full', () => {
    useDesignStore.setState({ enabled: false })
    render(<SlideCanvas slides={slides} currentIndex={0} />)

    const hint = classes(screen.getByTestId('canvas-live-hint'))
    for (const k of ['bg-hud', 'text-hud-fg', 'text-caption', 'rounded-full']) {
      expect(hint, `HUD pill recipe (§4.3 item 2)`).toContain(k)
    }
    expect(hint).not.toContain('text-white')
  })

  it('item 4 / T6 — the empty state is text-title and body text, never muted on the mat (R5)', () => {
    render(<SlideCanvas slides={NO_SLIDES} currentIndex={-1} />)

    const title = classes(screen.getByText('No slides'))
    expect(title).toContain('text-title')
    expect(title).toContain('text-text')
    const caption = classes(screen.getByText(/ask Claude to draft this slide/))
    expect(
      caption,
      'T6: muted on canvas was 4.34:1; rule R5 says the mat is not a reading surface',
    ).toContain('text-text')
    expect(caption).toContain('text-ui-sm')
    expect(caption).not.toContain('text-text-muted')
  })

  it('item 6 — nothing under the canvas animates: Design Mode on, off, and the empty deck', () => {
    useDesignStore.setState({ enabled: false })
    const off = render(<SlideCanvas slides={slides} currentIndex={0} />)
    expectStill(screen.getByRole('main', { name: 'Slide canvas' }), 'the canvas (Design Mode off)')
    off.unmount()

    useDesignStore.setState({ enabled: true })
    const on = render(<SlideCanvas slides={slides} currentIndex={0} />)
    expectStill(screen.getByRole('main', { name: 'Slide canvas' }), 'the canvas (Design Mode on)')
    on.unmount()

    // The empty branch is its own tree (no stage, no overlay) — review r3 found it outside every sweep.
    render(<SlideCanvas slides={NO_SLIDES} currentIndex={-1} />)
    expectStill(screen.getByRole('main', { name: 'Slide canvas' }), 'the canvas (no slides)')
  })
})

describe('M8b.3 surface 5 — the selection overlay on the design tokens', () => {
  it('T7 (kept) — the hover outline stays accent and its label is bg-accent text-on-fill', () => {
    const hit = boxHit('s_x:1', { x: 10, y: 10, width: 50, height: 20 })
    useDesignStore.setState({ hover: hit })
    slideId = 's_x'
    overlay()

    const hover = screen.getByTestId('design-hover')
    expect(classes(hover)).toEqual(expect.arrayContaining(['border-dashed', 'border-accent']))
    const label = classes(hover.firstElementChild)
    for (const k of ['bg-accent', 'text-on-fill', 'text-caption', 'rounded-control']) {
      expect(label, 'hover label').toContain(k)
    }
    expect(label).not.toContain('text-white')
  })

  it('item 3 — a single selection: accent box, surface-raised handles, tabular badge, HUD pill hints', () => {
    seed(FREE)
    const root = overlay()

    const box = screen.getByTestId('design-selection')
    expect(classes(box)).toContain('border-accent')
    expect(classes(box)).not.toContain('border-dashed')

    // The size / rotation badge: `accent` fill with `on-fill` text in the same arm (T7), figures
    // that do not jitter as they change.
    const badge = box.firstElementChild
    expect(badge?.textContent).toBe('200 × 100')
    for (const k of [
      'bg-accent',
      'text-on-fill',
      'tabular-nums',
      'text-caption',
      'rounded-control',
    ]) {
      expect(classes(badge), 'size badge').toContain(k)
    }

    for (const key of ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']) {
      const handle = classes(screen.getByTestId(`design-handle-${key}`))
      expect(handle, `handle ${key}: census pair 47 is accent on surface-raised`).toContain(
        'bg-surface-raised',
      )
      expect(handle).toContain('border-accent')
      expect(handle).not.toContain('bg-white')
    }
    const rotateHandle = screen.getByTestId('design-handle-rotate')
    const rotate = classes(rotateHandle)
    expect(rotate).toContain('bg-surface-raised')
    expect(rotate).toContain('rounded-full')
    // The stalk between box and rotate handle is drawn in accent too — review of this file's first
    // cut found `border-line` on it left every case green.
    expect(classes(rotateHandle.previousElementSibling), 'rotate stalk').toContain('border-accent')

    const hint = classes(screen.getByTestId('design-edit-hint'))
    for (const k of ['bg-hud', 'text-hud-fg', 'text-caption', 'rounded-full']) {
      expect(hint, 'the double-click hint is a HUD pill').toContain(k)
    }

    const clear = classes(screen.getByTestId('design-clear-selection'))
    for (const k of ['bg-hud', 'text-hud-fg', 'text-caption', 'rounded-full', ...RING]) {
      expect(clear, 'Clear selection is a HUD pill with the one ring').toContain(k)
    }
    expect(clear, 'hover is the hud-strong token, never hud/85 (audit §4.3 item 2)').toContain(
      'hover:bg-hud-strong',
    )
    expect(clear.some((k) => k.startsWith('hover:bg-hud/'))).toBe(false)

    expectNoAlphaBut(root, ['text-hud-fg/70'], 'the overlay with a selection')
  })

  it('item 3 / §2.8 — the breadcrumb is a HUD pill whose parents are text-hud-fg/70, not opacity', () => {
    const hit: SlHit = {
      ...boxHit('s_x:5', { x: 100, y: 200, width: 320, height: 84 }),
      tag: 'rect',
      id: 'bar',
      classes: ['bar'],
      ancestors: [
        {
          slId: 's_x:2',
          tag: 'g',
          id: null,
          classes: ['bars'],
          rect: { x: 0, y: 0, width: 1, height: 1 },
        },
        {
          slId: 's_x:0',
          tag: 'section',
          id: null,
          classes: ['slide'],
          rect: { x: 0, y: 0, width: 1, height: 1 },
        },
      ],
    }
    useDesignStore.setState({ selection: hit, selections: [hit] })
    slideId = 's_x'
    const root = overlay()

    const nav = screen.getByRole('navigation', { name: 'Selection breadcrumb' })
    for (const k of ['bg-hud', 'text-hud-fg', 'text-caption', 'rounded-full']) {
      expect(classes(nav), 'breadcrumb pill').toContain(k)
    }
    const parents = within(nav).getAllByText(/^(section\.slide|g\.bars)$/)
    expect(parents).toHaveLength(2)
    for (const parent of parents) expect(classes(parent)).toEqual(['text-hud-fg/70'])
    const separators = within(nav).getAllByText('›')
    expect(separators).toHaveLength(2)
    for (const sep of separators) expect(classes(sep)).toEqual(['text-hud-fg/70'])
    expect(classes(within(nav).getByText('rect#bar.bar'))).toEqual(['font-semibold'])
    // No `opacity-*` anywhere in the pill: opacity composites the glyphs AND the fill behind them.
    for (const el of nav.querySelectorAll('*')) {
      expect(classes(el).some((k) => k.startsWith('opacity-'))).toBe(false)
    }
    expectStill(root, 'the overlay with an ancestor breadcrumb')
  })

  it('U19 / T2 — the editing frame is the edit role, dashed, and its label is bg-edit text-on-fill', () => {
    const slId = seed(FREE)
    useDesignStore.setState({ editing: slId })
    overlay()

    const box = screen.getByTestId('design-selection')
    expect(box.getAttribute('data-editing')).toBe('true')
    expect(classes(box), 'U19: amber-500 was 2.15:1 on a white slide; edit is 5.26 / 5.70').toEqual(
      expect.arrayContaining(['border-2', 'border-dashed', 'border-edit']),
    )
    expect(classes(box)).not.toContain('border-accent')

    const label = box.firstElementChild
    expect(label?.textContent).toBe('Editing — Enter or Esc to finish')
    expect(classes(label), 'T2: the label fill follows the frame into the edit role').toContain(
      'bg-edit',
    )
    expect(classes(label)).toContain('text-on-fill')
    expect(classes(label).some((k) => k === 'text-white' || k.startsWith('bg-amber'))).toBe(false)
    // Editing hides the transform handles and the double-click hint.
    expect(screen.queryByTestId('design-handle-se')).toBeNull()
    expect(screen.queryByTestId('design-edit-hint')).toBeNull()
  })

  it('the lock badge is the warning role with on-fill text (a status, so the status hue)', () => {
    seed(LOCKED)
    const root = overlay()

    const badge = classes(screen.getByTestId('design-transform-lock'))
    expect(badge).toContain('bg-warning')
    expect(badge).toContain('text-on-fill')
    expect(badge).toContain('text-caption')
    // `rounded` emits nothing since `--radius-*: initial`; the corner has to be the named step.
    expect(badge).toContain('rounded-control')
    expect(badge.some((k) => k === 'text-white' || k.startsWith('bg-amber'))).toBe(false)
    expect(screen.queryByTestId('design-handle-se')).toBeNull()
    expectStill(root, 'the overlay with a locked selection')
  })

  it('item 3 — multi-select: member outlines are full-strength accent, the group box dashed', () => {
    const members = [
      boxHit('s_x:1', { x: 0, y: 0, width: 100, height: 20 }),
      boxHit('s_x:2', { x: 0, y: 40, width: 100, height: 20 }),
    ]
    useDesignStore.setState({ selections: members, selection: members[1]! })
    slideId = 's_x'
    const root = overlay()

    const outlines = screen.getAllByTestId('design-member')
    expect(outlines).toHaveLength(2)
    for (const outline of outlines) {
      expect(classes(outline), 'member outline: border-accent, no /70').toContain('border-accent')
    }
    expect(classes(screen.getByTestId('design-group'))).toEqual(
      expect.arrayContaining(['border-2', 'border-dashed', 'border-accent']),
    )
    expectNoAlphaBut(root, ['text-hud-fg/70'], 'the overlay with a group')
  })

  it('item 3 — the marquee keeps a see-through tint without an alpha on the token', async () => {
    slideId = 's_x'
    const root = overlay()

    fireEvent.pointerDown(root, { clientX: 10, clientY: 10 })
    fireEvent.pointerMove(window, { clientX: 200, clientY: 150 })
    await frame()

    const marquee = screen.getByTestId('design-marquee')
    expect(classes(marquee)).toContain('border-accent')
    expect(
      classes(marquee).filter((k) => k.startsWith('bg-')),
      'the marquee box itself carries no fill — the tint is the child layer',
    ).toEqual([])
    // The tint is a child layer — `accent` at `opacity-10` is the same composite as `accent/10`,
    // and the edge above it stays full-strength.
    const tint = classes(marquee.firstElementChild)
    expect(tint).toEqual(expect.arrayContaining(['bg-accent', 'opacity-10']))
    expectNoAlphaBut(root, ['text-hud-fg/70'], 'the overlay while sweeping')
    expectStill(root, 'the overlay while sweeping a marquee')

    fireEvent.pointerUp(window, { clientX: 200, clientY: 150 })
  })

  it('item 3 / C9 — a smart guide is bg-guide, drawn the frame it snaps, with no transition', async () => {
    seed(FREE)
    const root = overlay()

    // Drag the 200-wide box so its centre lands on the slide's centre (640): the one snap target
    // that needs no elements from the frame.
    const body = screen.getByTestId('design-selection')
    fireEvent.pointerDown(body, { clientX: 150, clientY: 150 })
    fireEvent.pointerMove(window, { clientX: 590, clientY: 150 })
    await frame()

    const guides = screen.getAllByTestId('design-guide')
    expect(guides.length).toBeGreaterThan(0)
    for (const guide of guides) {
      expect(classes(guide), 'C9: fuchsia-500 was a palette colour for a real role').toEqual([
        'absolute',
        'bg-guide',
      ])
    }
    expectStill(root, 'the overlay mid-drag, guides showing')

    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByTestId('design-guide')).toBeNull()
  })

  it('item 6 — nothing on the overlay animates: selected, hovered, editing, grouped', () => {
    const slId = seed(FREE)
    useDesignStore.setState({
      hover: boxHit('s_y:9', { x: 500, y: 500, width: 40, height: 40 }),
    })
    const root = overlay()
    expectStill(root, 'the overlay with a selection and a hover')

    act(() => {
      useDesignStore.setState({ editing: slId })
    })
    expectStill(root, 'the overlay while editing')

    act(() => {
      const members = [
        boxHit('s_x:1', { x: 0, y: 0, width: 100, height: 20 }),
        boxHit('s_x:2', { x: 0, y: 40, width: 100, height: 20 }),
      ]
      useDesignStore.setState({ editing: null, selections: members, selection: members[1]! })
    })
    expectStill(root, 'the overlay with a group')
  })
})

describe('M8b.3 surface 5 — the refused-edit notice on the Notice primitive', () => {
  it('item 5 / T2 — a warning Notice: soft fill, warning edge, the tone word, role status, a ringed ✕', () => {
    useDesignStore.setState({ notice: { slideId: 'slide-1', text: 'That text is too long' } })
    const { container } = render(<DesignNotice slideId="slide-1" />)

    const notice = screen.getByTestId('design-notice')
    expect(notice.getAttribute('role')).toBe('status')
    const klass = classes(notice)
    for (const k of ['bg-warning-soft', 'border-warning', 'rounded-panel', 'text-text']) {
      expect(
        klass,
        'T2: white on amber-600 was 3.19:1; the Notice body is text on warning-soft',
      ).toContain(k)
    }
    expect(klass.some((k) => k.startsWith('bg-amber') || k === 'text-white')).toBe(false)
    // Status is not colour alone: the primitive's sr-only tone word leads the text.
    expect(notice.textContent).toMatch(/^Warning: /)
    expect(notice.textContent).toContain('That text is too long')

    // The visible half of "not colour alone": the primitive's icon slot, hidden from the reader
    // because the sr-only tone word already says it.
    const icon = notice.querySelector('[aria-hidden="true"]')
    expect(icon?.textContent, 'the ⚠ is the non-colour half of the status').toBe('⚠')

    const dismiss = screen.getByRole('button', { name: /dismiss/i })
    expect(classes(dismiss)).toEqual(expect.arrayContaining([...RING, 'hover:bg-hover']))
    // The Chip remove button's recipe: a pill, not the dead `rounded`.
    expect(classes(dismiss)).toContain('rounded-full')
    expect(classes(dismiss).some((k) => k.includes('/'))).toBe(false)
    // The canvas's live-region host is `pointer-events-none`; without this wrapper the ✕ cannot be
    // clicked in the real app (happy-dom's `fireEvent` does not honour pointer-events, so only the
    // class can be asserted).
    expect(classes(notice.parentElement), 'pointer-events-auto wrapper').toContain(
      'pointer-events-auto',
    )
    // From the render root, so the `pointer-events-auto` wrapper above the Notice is swept too.
    expectStill(container, 'the notice and its wrapper')
  })
})

/**
 * The detector is a test subject too: a guard that quietly reads a motion spelling as inert is the
 * house failure mode. Positive rows are the shapes review r1 / r2 found escaping (each compiled to a
 * real `transition-*` rule against the repo's Tailwind 4.3.3 by the reviewer) plus two invented here;
 * negative rows are things that carry a `:`/`[`/`!` but move nothing, and the `-none` / `-initial`
 * forms, which compile to the negation of motion (review r3: a guard that reds innocent code is the
 * guard that gets deleted). Mutations, observed: drop the
 * bracket masking from `utilityOf` and the two arbitrary-property rows red — `[transition:opacity_100ms]`
 * splits inside its own brackets and reads as the utility `opacity_100ms]` — and so do the two
 * `(type:--x)` rows, whose `:` sits inside the utility's own parentheses (the variant-shaped rows
 * survive that mutation, because the last segment of `[&:not(:hover)]:transition` is still
 * `transition`; the masking is for the utility's own brackets, not the variants'); strip only a
 * leading `!` and `transition!` reds; drop the `(--var)` spelling from `VALUE` and `duration-(--x)`
 * and `transition-(--x)` red.
 */
describe('M8b.3 surface 5 — the motion detector reads a utility through any variant chain', () => {
  it.each([
    'transition',
    'transition-colors',
    'transition!',
    '!transition',
    'hover:!transition-opacity',
    '[&::before]:transition',
    'data-[state=open]:transition',
    '[@media(hover:hover)]:transition',
    '[&:not(:hover)]:transition',
    'duration-(--x)',
    'transition-(--x)',
    'duration-[150ms]',
    'md:[&>span]:!duration-300',
    'supports-[display:grid]:animate-working',
    'group-hover:ease-out',
    'motion-safe:delay-75',
    'starting:opacity-0',
    '[transition:opacity_100ms]',
    '[animation:spin_1s_linear_infinite]',
    'duration-(--x,150ms)',
    'transition-(--x,opacity)',
    'duration-(length:--x)',
    'duration-(time:--x)',
    '[-webkit-transition:opacity_1s]',
    '[-webkit-animation:spin_1s]',
  ])('%s is motion', (token) => {
    expect(isMotion(token)).toBe(true)
  })

  it.each([
    'text-caption',
    'text-hud-fg/70',
    '-translate-x-1/2',
    'rounded-control',
    'motion-safe:opacity-50',
    "[&::before]:content-['']",
    '[mask-type:luminance]',
    'hover:bg-hud-strong',
    'data-[state=open]:bg-accent',
    'focus-visible:outline-2',
    'transition-none',
    'animate-none',
    'duration-initial',
    'ease-initial',
    'transitional',
    'durations-3',
  ])('%s is not', (token) => {
    expect(isMotion(token)).toBe(false)
  })

  /**
   * The inline-style side, through React, so the vendor-prefixed path is the one React actually
   * takes (an own property under happy-dom, a declaration in a browser). Mutation: drop the vendor
   * group from `MOTION_STYLE` and the `WebkitTransition` row reds; drop the own-key scan and it reds too.
   */
  it.each(INLINE_MOTION)('an inline %s is motion', (prop, style) => {
    const { container } = render(<span style={style}>x</span>)
    const found = movingParts(container)
    expect(found, `an inline ${prop} must be read as motion`).toHaveLength(1)
    expect(found[0]).toContain(`style.${prop}`)
  })

  it.each(INLINE_STILL)('an inline %s is not', (prop, style) => {
    const { container } = render(<span style={style}>x</span>)
    expect(movingParts(container), `an inline ${prop} moves nothing`).toEqual([])
  })

  /**
   * The CLASS branch of `movingParts`, and the walk that reaches it. The rows above prove `isMotion`
   * in isolation and the inline rows prove the style branch; until review r4 measured it, nothing
   * drove the class branch at all — deleting it, narrowing the walk from `querySelectorAll('*')` to
   * `children`, or filtering `transition` out of `classes()` each left this file at `63 passed`. The
   * motion class sits two levels down for that reason, and the still case keeps the pair honest.
   */
  it('a motion class is read on an element and on a descendant at any depth', () => {
    const { container } = render(
      <div className="transition-colors">
        <span className="text-caption">
          <b className="duration-(--x)">x</b>
        </span>
      </div>,
    )
    expect(movingParts(container)).toEqual(['DIV.transition-colors', 'B.duration-(--x)'])
  })

  it('a tree whose only classes are still reports nothing', () => {
    const { container } = render(
      <div className="rounded-control">
        <span className="text-caption">
          <b className="transition-none">x</b>
        </span>
      </div>,
    )
    expect(movingParts(container)).toEqual([])
  })
})
