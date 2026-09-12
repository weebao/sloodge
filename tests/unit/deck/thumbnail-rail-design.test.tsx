/**
 * @vitest-environment happy-dom
 *
 * M8b.3 surface 6 (ui-design-audit.md §4.2, §7 row 6): the thumbnail rail, its previews and its
 * context menu stay on the role tokens and the M8b.2 primitives, and the two findings the row names
 * stay closed — **U5** (the card's and "+ New"'s `chrome-line` edges at 1.24:1) and **the halo**
 * (`focus-visible:ring-offset-1` with no offset colour, which is Tailwind's `#fff` around a focused
 * thumbnail on the dark rail) — together with the one motion rejection the work list carries, **F4**
 * (the selection ring must not fade in behind an instant canvas swap).
 *
 * Two halves, because neither can see the other's regression:
 *
 *  - **The file gate, run as a test** — `tests/unit/design/migrated-files-check.test.ts` spawns
 *    `node scripts/design-inventory.mjs --check` once over every migrated file, these three among
 *    them, so a retired token, a `dark:` twin, a palette colour, an alpha suffix or an arbitrary
 *    value coming back reds `pnpm test`.
 *  - **The rendered class of each finding's element — this file.** `--check` reads source text and
 *    counts six columns; it cannot see a role token of the wrong role, a `ring-offset-1` (a declared
 *    utility in every column), a `transition-colors` (motion is not a column), a `z-50` where `z-menu`
 *    belongs, or an `outline-none` beside the shared ring. On that last one, precisely: the shipped
 *    ring was a box-shadow `ring-2`, which `outline-none` does not touch, so it was alive; it is the
 *    outline-based `FOCUS_RING` this PR adopts that a leftover `outline-none` would kill — Tailwind v4's
 *    `outline-none` sets `--tw-outline-style: none` and `outline-2` reads it back as its style
 *    (`tests/unit/design/outline-none-conflict.test.ts` guards the pair tree-wide). Each of those keeps
 *    every column 0 and only this half sees it.
 *
 * **What this file pins, exactly:** the halo, on **every** focusable the rail renders — the three card
 * buttons, the two menu items and "+ New" (asserted directly, not only class-equal to `Button`, since an
 * `outline-none` written into the primitive's own variant keeps that equality) — through one helper
 * (`FOCUS_RING` present; no `ring-offset*`, no focus-variant `ring*`, no `outline-none` **or
 * `outline-hidden`** in any variant, no `focus:`); F4 and item 7 (no element in
 * the rail — selection ring, live drop indicator or open menu — carries a motion class behind any
 * variant chunk, or an inline `transition` / `animation`; the detector is surface 5's, lifted into
 * `tests/unit/design/motion-detector.tsx` and imported by both, so the two surfaces share one idea of
 * what motion is — `(…)` functional values, vendor prefixes and the `-none`/`-initial`/`-0`
 * negations included); item 1 (the card
 * is `bg-surface-raised shadow-raised rounded-control`, borderless at rest, `ring-2 ring-accent` when
 * selected, `hover:shadow-floating`); U5 / item 5 ("+ New" is `<Button variant="subtle">` in a
 * `border-dashed border-line-strong` frame); T4 (slide number `text-accent` / `text-text-muted` on
 * `bg-surface`); item 3 (the placeholder is `text-caption line-clamp-2`, not 9px); item 4 (the heading
 * is `PanelHeading` level 2); item 6 (the menu is `z-menu rounded-overlay shadow-floating
 * bg-surface-raised p-1`, items `rounded-control hover:bg-hover disabled:text-text-muted` with the
 * shared ring, no accent hover fill); and the §1.2 discipline — no class or inline style derived from
 * a slide id, **and** the focus-return effect matching by attribute comparison: a deck whose id is
 * shaped like a selector injection (`X"],[data-slide-index="0`) still gets focus back on its own card.
 *
 * **What it knowingly does not catch:** the `<li>`'s own classes (`border-y-2 border-transparent`, the
 * `border-t-accent` / `border-b-accent` indicator and `opacity-40`, which `thumbnail-rail.test.tsx`
 * pins by name); the menu's flip and dismissal logic (the same file); and the values — happy-dom
 * applies no stylesheet, so nothing here shows that the tokens paint the ratios the audit measured or
 * that the ring is visible on the ground; the census (`--check`) and `focus-ring-compiles.test.ts` do
 * that. Layout that is not a token escapes both halves by declaration: the scroller's `pt-0.5` (which
 * keeps the first card's ring inside the clip) and the heading wrapper's `px-3 py-2` — dropping either
 * keeps this file and `--check` green.
 *
 * Mutations, each run on this branch from `scratchpad/m8b3s6-mutations.py` / `-r2.py` with the old
 * text asserted present exactly once before writing and the file restored from a copy afterwards:
 * `${FOCUS_RING}` → `outline-none focus-visible:ring-2 focus-visible:ring-accent
 * focus-visible:ring-offset-1` (the shipped halo) reds the halo case **with `--check` still
 * `RESULT: pass`**; `focus-visible:ring-offset-1` appended, `outline-none` appended, and
 * `focus-visible:ring-2 focus-visible:ring-accent` appended each red it — on the card **and**, run
 * again against the menu item, on the item (round 1 pinned the card only and all three passed there);
 * `outline-hidden` beside the card's ring and `focus-visible:outline-hidden` on the item red it too
 * (round 2 matched `none` only and both passed); `outline-none` written into `Button.tsx`'s
 * `VARIANT.subtle` reds the "+ New" assertion (round 2 held only class-equality, which that mutation
 * satisfies, and every suite stayed green while the ring was dead on every subtle button);
 * `transition-colors` restored on the card box reds the F4 case naming the element (`--check` pass);
 * `transition` on the menu, `transition-opacity` on the `<li>`, `*:transition-colors` and
 * `@md:transition` on the box, and `transition: 'box-shadow 120ms'` in `THUMBNAIL_BOX_STYLE` red the
 * same sweep; `ring-2 ring-accent` → `ring-1 ring-accent` and `shadow-raised` → `shadow-floating` red
 * item 1; `border border-line` on the box reds item 1's no-border assertion; `variant="subtle"` →
 * `"secondary"` and `border-line-strong` → `border-line` on the frame red item 5; `text-text-muted` →
 * `text-text` on the unselected number reds T4; `line-clamp-2` dropped and `text-caption` →
 * `text-ui-sm` red item 3; the heading spelled by hand with PanelHeading's own classes but `text-text`
 * reds item 4; `z-menu` → `z-50`, `hover:bg-hover` → `hover:bg-accent hover:text-on-fill` (the
 * pre-migration fill; `--check` pass, `semantic-contrast` pass) and `${FOCUS_RING}` dropped from the
 * item red item 6; `className={\`card-${slide.id}\`}` on the `<li>` reds the id case; the focus-return
 * loop replaced by `querySelector(\`[data-slide-id="${currentSlideId}"]\`)` reds the selector case
 * with focus on card 0 (the injected selector's first match). Gate-only mutations on the three files:
 * `text-chrome-muted dark:text-ink-muted` → `legacy = 2, dark: = 1`; `bg-white` → `palette = 1`;
 * `border-line/50` → `alpha = 1`; `min-w-[140px]` → `arbitrary = 1`; `text-txt` → `unknown = 1`.
 */

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Button, PanelHeading } from '../../../src/renderer/src/components/ui'
import { movingParts } from '../design/motion-detector'
import { ThumbnailRail } from '../../../src/renderer/src/features/deck/ThumbnailRail'
import type { SlideView } from '../../../src/renderer/src/stores/deckStore'
import type { SlideId } from '../../../src/shared/document/types'

/** Written out, not imported from `focusRing.ts`: the assertion must not track the drift it guards. */
const RING = [
  'focus-visible:outline-2',
  'focus-visible:outline-focus',
  'focus-visible:outline-offset-2',
] as const

/** Distinctive enough that a class or style derived from one cannot be a coincidence. */
const ids = ['sl_q7zk2m', 'sl_v3hx9p', 'sl_n8wd4r'] as unknown as SlideId[]
const slides: SlideView[] = ids.map((id, index) => ({
  id,
  title: `Quarterly review ${String(index + 1)} — a title long enough to wrap`,
  html: '<!doctype html><html lang="en"><body></body></html>',
}))

const classes = (el: Element | null | undefined): string[] => {
  expect(el, 'the element under test is mounted').toBeTruthy()
  return el!.className.split(/\s+/).filter(Boolean)
}

function mount(overrides: Partial<Parameters<typeof ThumbnailRail>[0]> = {}): void {
  render(
    <ThumbnailRail
      slides={slides}
      currentSlideId={ids[1] ?? null}
      onSelectSlide={vi.fn()}
      onAddSlide={vi.fn()}
      onDuplicateSlide={vi.fn()}
      onDeleteSlide={vi.fn()}
      onMoveSlide={vi.fn()}
      {...overrides}
    />,
  )
}

const rail = (): HTMLElement => screen.getByRole('navigation', { name: 'Slides' })
const card = (index: number): HTMLElement => {
  const li = rail().querySelector(`[data-slide-index="${String(index)}"]`)
  if (!(li instanceof HTMLElement)) throw new Error(`no card at ${String(index)}`)
  return li
}
const cardButton = (index: number): HTMLElement => within(card(index)).getByRole('button')
/** The thumbnail box — the span that carries the card's surface, shadow and selection ring. */
const cardBox = (index: number): HTMLElement => {
  const box = card(index).querySelector('[data-thumbnail]')?.parentElement
  if (!(box instanceof HTMLElement)) throw new Error(`no thumbnail box at ${String(index)}`)
  return box
}
const everything = (root: Element): Element[] => [root, ...root.querySelectorAll('*')]
/** The one focus recipe (R6), and none of the shapes that made or would remake the halo. */
function expectOnlyTheSharedRing(el: Element, label: string): void {
  const klass = classes(el)
  for (const part of RING) expect(klass, `${label} is missing ${part}`).toContain(part)
  expect(
    klass.filter((c) => c.includes('ring-offset')),
    `${label}: ring-offset with no colour is Tailwind's #fff — the white halo on the dark rail`,
  ).toEqual([])
  expect(
    klass.filter((c) => /^(?:focus|focus-visible|focus-within):(?:[\w-]+:)*ring(?:-|$)/.test(c)),
    `${label}: a box-shadow ring on focus is the second focus recipe R6 forbids`,
  ).toEqual([])
  expect(
    klass.filter((c) => /^(?:[\w-]+:)*outline-(?:none|hidden)$/.test(c)),
    `${label}: outline-none and outline-hidden both set --tw-outline-style: none, which the outline-based shared ring reads back — it would paint no ring`,
  ).toEqual([])
  expect(
    klass.filter((c) => c.startsWith('focus:')),
    `${label}: only focus-visible: survives (R6)`,
  ).toEqual([])
}
/** A drag needs a data transfer; happy-dom has no `DataTransfer`, and the rail only writes to it. */
const dataTransfer = () => ({
  setData: vi.fn(),
  getData: vi.fn(),
  effectAllowed: 'none',
  dropEffect: 'none',
})

beforeEach(() => {
  // happy-dom cannot fetch a `blob:` URL, so the mini-frames are pointed at about:blank.
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('about:blank')
  vi.spyOn(URL, 'revokeObjectURL').mockReturnValue(undefined)
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('M8b.3 surface 6 — the thumbnail rail on the design tokens', () => {
  it('the halo — every focusable in the rail has the shared ring and nothing else: no ring-offset, no focus-visible:ring, no outline-none', () => {
    mount()
    for (const index of [0, 1, 2])
      expectOnlyTheSharedRing(cardButton(index), `card ${String(index)}`)
    // The menu items got the same ring in this PR, so they are the other place the halo could return.
    fireEvent.contextMenu(card(1), { clientX: 40, clientY: 120 })
    const items = screen.getAllByRole('menuitem')
    expect(items).toHaveLength(2)
    for (const item of items) expectOnlyTheSharedRing(item, `menu item ${item.textContent ?? ''}`)
    // "+ New" is the primitive's class list — asserted directly too, because class-equality with the
    // primitive is exactly what an `outline-none` written INTO the primitive's variant would satisfy.
    expectOnlyTheSharedRing(screen.getByRole('button', { name: '+ New' }), '"+ New"')
  })

  it('F4 / item 7 — nothing in the rail transitions: not the selection ring, the drop indicator or the menu', () => {
    mount()
    // Put every rejected-motion subject on screen at once: a selected card, a live drop indicator
    // on another, and the open menu — then sweep every element the rail renders.
    fireEvent.dragStart(card(2), { dataTransfer: dataTransfer() })
    fireEvent.dragOver(card(0), { dataTransfer: dataTransfer() })
    expect(card(0).className, 'the indicator is live, so the sweep sees it').toContain(
      'border-t-accent',
    )
    fireEvent.contextMenu(card(1), { clientX: 40, clientY: 120 })
    const menu = screen.getByRole('menu', { name: 'Slide actions' })
    expect(rail().contains(menu), 'the menu renders inside the rail, so the sweep sees it').toBe(
      true,
    )

    expect(
      movingParts(cardBox(1)),
      'the selection ring must be instant: selection is 100+/day navigation and the canvas swaps at once (F4)',
    ).toEqual([])
    expect(
      movingParts(rail()),
      'no transition anywhere in the rail — selection, the drop indicator and the menu are M8b.0 §3.1 rejections',
    ).toEqual([])
  })

  it('item 1 — the card is one raised surface: shadow ring at rest, accent ring when selected, a lifted shadow on hover, no border', () => {
    mount()
    const selected = classes(cardBox(1))
    expect(cardButton(1).getAttribute('aria-current'), 'card 1 is the selected one').toBe('true')
    expect(selected).toEqual(
      expect.arrayContaining([
        'bg-surface-raised',
        'shadow-raised',
        'rounded-control',
        'hover:shadow-floating',
        'ring-2',
        'ring-accent',
      ]),
    )
    expect(
      selected.filter((c) => /^(?:[\w-]+:)*border(?:-|$)/.test(c)),
      'no hairline on the card in any state — the shadow’s ring is its edge (U5: chrome-line was 1.24:1)',
    ).toEqual([])
    expect(selected.filter((c) => c.startsWith('bg-') && c !== 'bg-surface-raised')).toEqual([])

    const resting = classes(cardBox(0))
    expect(resting).toEqual(
      expect.arrayContaining(['bg-surface-raised', 'shadow-raised', 'hover:shadow-floating']),
    )
    expect(
      resting.filter((c) => /^(?:[\w-]+:)*ring(?:-|$)/.test(c)),
      'an unselected card carries no ring in any state',
    ).toEqual([])
    expect(
      resting.filter((c) => c.startsWith('hover:') && c !== 'hover:shadow-floating'),
      'hover is the lifted shadow and no colour change',
    ).toEqual([])
  })

  it('T4 — the slide number is accent when selected and muted otherwise, on the rail’s base surface', () => {
    mount()
    expect(classes(cardButton(1)), 'selected: text-accent (4.97 / 5.09 on surface)').toContain(
      'text-accent',
    )
    for (const index of [0, 2]) {
      const klass = classes(cardButton(index))
      expect(klass, `card ${String(index)}: text-text-muted`).toContain('text-text-muted')
      expect(klass).not.toContain('text-accent')
    }
    const nav = classes(rail())
    expect(nav, 'the rail is the base surface; its right edge is the panel hairline').toEqual(
      expect.arrayContaining(['bg-surface', 'border-r', 'border-line', 'w-rail']),
    )
  })

  it('item 3 — the placeholder is caption text clamped to two lines, not 9px', () => {
    mount()
    const box = card(0).querySelector('[data-thumbnail="placeholder"]')
    expect(box, 'with no observer report the card is a placeholder').toBeTruthy()
    const label = within(box as HTMLElement).getByText(slides[0]!.title)
    const klass = classes(label)
    expect(klass).toEqual(
      expect.arrayContaining(['text-caption', 'line-clamp-2', 'text-text-muted']),
    )
    expect(
      klass.filter((c) => /^text-\[|^leading-/.test(c)),
      'no arbitrary size and no hand-set leading — the text token carries both',
    ).toEqual([])
  })

  it('item 4 — the heading is the PanelHeading primitive at level 2', () => {
    mount()
    const heading = screen.getByRole('heading', { name: 'Slides', level: 2 })
    const reference = render(<PanelHeading level={2}>reference</PanelHeading>)
    const expected = reference.getByText('reference').className
    expect(expected, 'the primitive renders a class list at all').not.toBe('')
    expect(heading.className, 'the rail’s heading is exactly the primitive’s recipe').toBe(expected)
  })

  it('U5 / item 5 — "+ New" is the subtle Button, stretched by its wrapper, inside a dashed line-strong frame', () => {
    mount()
    const button = screen.getByRole('button', { name: '+ New' })
    const reference = render(<Button variant="subtle">reference</Button>)
    expect(button.className, 'the control is the primitive, class for class').toBe(
      reference.getByText('reference').className,
    )
    expectOnlyTheSharedRing(button, '"+ New"')
    const frame = classes(button.parentElement)
    expect(
      frame,
      'U5: the dashed edge is line-strong (3.79 / 3.52), not chrome-line (1.24)',
    ).toEqual(expect.arrayContaining(['grid', 'border', 'border-dashed', 'border-line-strong']))
    expect(frame.filter((c) => c.startsWith('border-') && c !== 'border-dashed')).toEqual([
      'border-line-strong',
    ])
  })

  it('item 6 — the menu is a floating overlay at z-menu; its items are quiet-hover rows with the shared ring', () => {
    mount()
    fireEvent.contextMenu(card(1), { clientX: 40, clientY: 120 })
    const menu = classes(screen.getByRole('menu', { name: 'Slide actions' }))
    expect(menu).toEqual(
      expect.arrayContaining([
        'z-menu',
        'rounded-overlay',
        'shadow-floating',
        'bg-surface-raised',
        'p-1',
        'text-ui-sm',
        'min-w-35',
      ]),
    )
    expect(
      menu.filter((c) => c.startsWith('z-')),
      'one z role — not the z-50 four surfaces claimed',
    ).toEqual(['z-menu'])
    expect(
      menu.filter((c) => /^border(?:-|$)/.test(c)),
      'no border and a floating shadow on the same element (§2.4)',
    ).toEqual([])

    const items = screen.getAllByRole('menuitem')
    expect(items).toHaveLength(2)
    for (const item of items) {
      const klass = classes(item)
      expect(klass).toEqual(
        expect.arrayContaining([
          'rounded-control',
          'text-text',
          'hover:bg-hover',
          'disabled:text-text-muted',
          'disabled:hover:bg-transparent',
        ]),
      )
      for (const part of RING)
        expect(klass, `${item.textContent ?? ''} is missing ${part}`).toContain(part)
      expect(
        klass.filter((c) => c.startsWith('hover:') && c !== 'hover:bg-hover'),
        'the hover is the quiet fill, not the accent (the full-fill hover was the app’s odd one out, C2)',
      ).toEqual([])
    }
  })

  it('§1.2 — the focus-return effect compares the id attribute; an id shaped like a selector cannot redirect it', () => {
    // If `[data-slide-id="${id}"]` were ever interpolated, this id closes the attribute selector and
    // opens another that matches card 0 first in document order — focus would land on the wrong slide.
    const hostile = ['sl_first', 'X"],[data-slide-index="0'] as unknown as SlideId[]
    const deck: SlideView[] = hostile.map((id, index) => ({
      id,
      title: `Deck ${String(index)}`,
      html: '<!doctype html><html lang="en"><body></body></html>',
    }))
    mount({ slides: deck, currentSlideId: hostile[1] ?? null })
    fireEvent.contextMenu(card(1), { clientX: 40, clientY: 120 })
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()
    expect(document.activeElement, 'focus returns to the card whose id matched by comparison').toBe(
      cardButton(1),
    )
    expect(document.activeElement).not.toBe(cardButton(0))
  })

  it('§1.2 — no class or inline style is derived from a slide id', () => {
    mount()
    fireEvent.contextMenu(card(1), { clientX: 40, clientY: 120 })
    const offenders: string[] = []
    for (const el of everything(rail())) {
      const klass = el.getAttribute('class') ?? ''
      const style = el.getAttribute('style') ?? ''
      for (const id of ids as unknown as string[]) {
        if (klass.includes(id)) offenders.push(`${el.tagName.toLowerCase()} class contains ${id}`)
        if (style.includes(id)) offenders.push(`${el.tagName.toLowerCase()} style contains ${id}`)
      }
    }
    // The data attribute is the sanctioned place: it is compared, never interpolated into a selector.
    expect(rail().querySelectorAll('[data-slide-id]')).toHaveLength(3)
    expect(
      offenders,
      'slide ids are attacker-influenced; a per-card hook derives from the index',
    ).toEqual([])
  })

  it('rendered twin of the gate — no dark: twin, retired token or arbitrary value on anything the rail renders', () => {
    mount()
    fireEvent.contextMenu(card(1), { clientX: 40, clientY: 120 })
    const bad = everything(rail())
      .flatMap((el) => classes(el))
      .filter((c) => /^dark:|(?:^|[-:])(?:chrome|ink|shell)(?:-|$)|\[/.test(c))
    expect(bad).toEqual([])
  })
})
