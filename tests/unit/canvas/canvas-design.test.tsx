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
 * and the one place the audit refuses it, so the refusal is asserted on the rendered tree: no class
 * from the motion namespaces on any element, and no inline `transition` or `animation`. The three
 * `requestAnimationFrame` sites in the gesture hooks are pointer-event coalescing, not motion, and
 * are not this file's subject.
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
 * a `transition-colors` on the selection box, a `transition` on the mat and an inline
 * `transition: 'left 100ms'` on the handle style each red the still-tree case (1 each, gate green —
 * the gate has no motion column); member `border-accent` → `border-accent/70` and marquee fill
 * `bg-accent opacity-10` → `bg-accent/10` red here AND the shared gate (`alpha = 1`).
 */

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
 * Every Tailwind spelling that moves something over time, behind any variant chain: `transition`,
 * `transition-*`, `duration-*`, `delay-*`, `ease-*`, `animate-*`, and the `starting:` variant that
 * only exists to feed a transition. `motion-safe:` / `motion-reduce:` are variants, so they are
 * caught by whatever they prefix.
 */
const MOTION =
  /^(?:[\w[\]&>*@-]+:)*(?:transition(?:-[a-z-]+)?|duration-[\w-]+|delay-[\w-]+|ease-[\w-]+|animate-[\w-]+|starting:.+)$/

/** No class from the motion namespaces and no inline transition/animation anywhere under `root`. */
function expectStill(root: Element, what: string): void {
  const moving: string[] = []
  for (const el of [root, ...root.querySelectorAll('*')]) {
    for (const klass of classes(el)) if (MOTION.test(klass)) moving.push(`${el.tagName}.${klass}`)
    const style = (el as HTMLElement).style
    if (style.transition !== '' || style.transitionProperty !== '') {
      moving.push(`${el.tagName} style.transition=${style.transition || style.transitionProperty}`)
    }
    if (style.animation !== '' || style.animationName !== '') {
      moving.push(`${el.tagName} style.animation=${style.animation || style.animationName}`)
    }
  }
  expect(moving, `${what} must not animate (audit §4.3 item 6, M8b.0 §3.1)`).toEqual([])
}

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

  it('item 6 — nothing under the canvas animates, with Design Mode on or off', () => {
    useDesignStore.setState({ enabled: false })
    const off = render(<SlideCanvas slides={slides} currentIndex={0} />)
    expectStill(screen.getByRole('main', { name: 'Slide canvas' }), 'the canvas (Design Mode off)')
    off.unmount()

    useDesignStore.setState({ enabled: true })
    render(<SlideCanvas slides={slides} currentIndex={0} />)
    expectStill(screen.getByRole('main', { name: 'Slide canvas' }), 'the canvas (Design Mode on)')
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
    overlay()

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
    overlay()

    const badge = classes(screen.getByTestId('design-transform-lock'))
    expect(badge).toContain('bg-warning')
    expect(badge).toContain('text-on-fill')
    expect(badge).toContain('text-caption')
    expect(badge.some((k) => k === 'text-white' || k.startsWith('bg-amber'))).toBe(false)
    expect(screen.queryByTestId('design-handle-se')).toBeNull()
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
    render(<DesignNotice slideId="slide-1" />)

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

    const dismiss = screen.getByRole('button', { name: /dismiss/i })
    expect(classes(dismiss)).toEqual(expect.arrayContaining([...RING, 'hover:bg-hover']))
    expect(classes(dismiss).some((k) => k.includes('/'))).toBe(false)
    expectStill(notice, 'the notice')
  })
})
