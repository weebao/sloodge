/**
 * @vitest-environment happy-dom
 *
 * M8b.3 surface 3 (ui-design-audit.md §4.5, §7 row 3): the property panel, the colour controls and
 * the arrange bar stay on the role tokens and the M8b.2 primitives, and the five findings the row
 * names — T3, U3, U6, U7, U11 — stay closed.
 *
 * Two halves, because neither can see the other's regression:
 *
 *  - **The file gate, run as a test** — `tests/unit/design/migrated-files-check.test.ts` spawns
 *    `node scripts/design-inventory.mjs --check` once over every migrated file, these three among
 *    them, so a retired token, a `dark:` twin, a palette colour, an alpha suffix or an arbitrary
 *    value coming back reds `pnpm test`.
 *  - **The rendered class of each finding's element.** The gate cannot see a *role* token that is
 *    the wrong role: `bg-surface` on a field instead of `bg-field` is U3 back at 1.04:1 with every
 *    column still 0, `border-line` on a control instead of `border-line-strong` is U6 back at
 *    1.27:1, a `border` back on the arrange bar is U7 back on top of its shadow, `bg-surface-sunken`
 *    on the chip is a grey label where the accent tint was. So each element is rendered and its
 *    class list read — the same shape as `chat-panel-design.test.tsx`, for the same reason.
 *
 * **What this file pins, exactly:** the five §3.1 rows above, each on the element the row names
 * (T3 the element tag; U3 every `prop-*` field; U6 every field, the swatch input, the theme swatch,
 * and the three transform buttons; U7 the arrange bar; U11 the "Ask Claude" chip), plus the four
 * things §4.5's work list changed that no §3.1 row covers and that `--check` cannot see either: the
 * dock is `bg-surface-raised` at `h-inspector`, the theme swatch's hover is a lift and its selected
 * state is the ring (with `aria-pressed`, so it is never colour alone), the eyedropper is an SVG on
 * a `ToolbarButton`, and the arrange bar's buttons are `ToolbarButton`s at `h-control w-control`.
 * **What it knowingly does not catch:** a wrong-role token on an element that is none of the
 * above — the refusal message losing `text-danger` for `text-text`, the field labels losing
 * `text-text-muted`, `tabular-nums` dropped from the numeric labels, the arrange bar's label losing
 * `text-caption`. Each keeps `--check` green and this file green; a later pass that wants them
 * pinned adds a row per element here, not a wider assertion.
 *
 * Mutations, each run on this branch (one at a time, the file restored between): the tag's
 * `text-text-muted` → `text-text-muted/80` (T3: this file reds on the `/` and the gate reds
 * `alpha = 1`); `<Input` → a raw `<input className="… bg-white …">` (U3: reds here on `bg-field`
 * and in the gate on `palette`); the textarea's `bg-field` → `bg-surface` (U3 on the Content
 * field, gate green); the swatch input's `border-line-strong` → `border-line` (U6, gate green); the
 * transform buttons' `variant="subtle"` → `"link"` (U6: reds on `hover:bg-hover`); the arrange
 * bar's class + `border border-line-strong` (U7, gate green) and `shadow-floating` → `shadow-raised`
 * (U7); the chip's `bg-accent-soft` → `bg-surface-sunken` (U11, gate green) and + `border
 * border-accent` (U11); the swatch's `ring-2 ring-accent` deleted (selected state); the pipette
 * `<svg>` → the old `💧` span; the arrange bar's `<ToolbarButton` → a raw `<button>`; and
 * `h-inspector` → `h-64` on the dock (this file and `slide-canvas-dock.test.tsx`).
 *
 * What neither half can show: that the tokens paint the ratios the audit measured. happy-dom applies
 * no stylesheet; the values are the census's business (`--check`, rows 40–48), not this file's.
 */

import { cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { SlHit } from '../../../src/shared/design/bridge-protocol'
import { buildSlideMap } from '../../../src/shared/design/slide-map'
import type { ElementSpan } from '../../../src/shared/design/types'
import { ArrangeBar } from '../../../src/renderer/src/features/design/ArrangeBar'
import { PropertyPanel } from '../../../src/renderer/src/features/design/PropertyPanel'
import { useDesignStore } from '../../../src/renderer/src/features/design/designStore'
import {
  createStarterDeck,
  getSlideHtml,
  useDeckStore,
  type SlideView,
} from '../../../src/renderer/src/stores/deckStore'

/** Written out, not imported from `focusRing.ts`: the assertion must not track the drift it guards. */
const RING = [
  'focus-visible:outline-2',
  'focus-visible:outline-focus',
  'focus-visible:outline-offset-2',
] as const

const NOW = 1_700_000_000_000
/** `#4c8dff` is the default theme's Accent swatch, so that swatch is the selected one. */
const SOURCE = '<h1 style="color: #4c8dff; font-size: 44px">Hello</h1>'
const SHAPES = `<!doctype html><html><body>
<div class="slide" data-sl-slide="X">
  <div class="a" style="position:absolute;left:10px;top:20px;width:100px;height:40px">A</div>
  <div class="b" style="position:absolute;left:200px;top:60px;width:80px;height:40px">B</div>
  <div class="c" style="position:absolute;left:400px;top:100px;width:60px;height:40px">C</div>
</div>
</body></html>`
const PICKER = { pickColor: (): Promise<string | null> => Promise.resolve(null) }
const FIELDS = [
  'text',
  'fontSize',
  'fontWeight',
  'color',
  'fill',
  'stroke',
  'x',
  'y',
  'width',
  'height',
]
const TRANSFORM = ['transform-flip-h', 'transform-flip-v', 'transform-duplicate']

let slideId: string

const classes = (el: Element): string[] => el.className.split(/\s+/).filter(Boolean)

function currentSlide(): SlideView {
  return {
    id: slideId,
    title: 'Slide',
    html: getSlideHtml(useDeckStore.getState().slideHtml, slideId)!,
  }
}

function hit(slId: string, tag: string): SlHit {
  return {
    slId,
    tag,
    id: null,
    classes: [],
    rect: { x: 0, y: 0, width: 100, height: 40 },
    ancestors: [],
  }
}

function seed(html: string): void {
  useDeckStore.setState(createStarterDeck(NOW))
  slideId = useDeckStore.getState().currentSlideId!
  useDeckStore.getState().setSlideHtml(slideId, html, slideId, 'seed')
}

function mountPanel(): void {
  seed(SOURCE)
  const map = buildSlideMap(slideId, SOURCE)
  useDesignStore.setState({ enabled: true, hover: null, selection: hit(map.order[0]!, 'h1') })
  render(<PropertyPanel slide={currentSlide()} picker={PICKER} />)
}

function mountBar(): void {
  seed(SHAPES)
  const map = buildSlideMap(slideId, SHAPES)
  const hits: SlHit[] = []
  for (const [id, span] of map.byId as ReadonlyMap<string, ElementSpan>) {
    if (/^<div class="[abc]"/.test(SHAPES.slice(span.outer.start, span.outer.end))) {
      hits.push(hit(id, 'div'))
    }
  }
  expect(hits).toHaveLength(3)
  useDesignStore.getState().setSelections(hits)
  render(<ArrangeBar slideId={slideId} />)
}

beforeEach(() => {
  useDesignStore.setState({ enabled: true, hover: null, selection: null })
})

afterEach(cleanup)

describe('M8b.3 surface 3 — the property panel on the design tokens', () => {
  it('the dock is the opaque raised surface at the named inspector height (work-list item 1)', () => {
    mountPanel()
    const klass = classes(screen.getByTestId('property-panel'))
    expect(klass).toContain('bg-surface-raised')
    expect(klass, 'the panel edge is a divider (line), not a control border').toContain(
      'border-line',
    )
    expect(klass, 'h-inspector is the 256px h-64 was').toContain('h-inspector')
    expect(
      klass.filter((c) => c.includes('/')),
      'opaque: the /95 tint bought nothing',
    ).toEqual([])
  })

  it('T3 — the element tag is muted text with no alpha', () => {
    mountPanel()
    const klass = classes(screen.getByTestId('property-panel-tag'))
    expect(klass, 'T3: text-text-muted (6.41 / 5.81 on surface-raised)').toContain(
      'text-text-muted',
    )
    expect(
      klass.filter((c) => c.includes('/')),
      'T3: `/80` was 3.70 / 4.31',
    ).toEqual([])
  })

  it('U3 / U6 — every field is a `field` with a strong border and the one focus ring', () => {
    mountPanel()
    for (const name of FIELDS) {
      const klass = classes(screen.getByTestId(`prop-${name}`))
      expect(klass, `U3: prop-${name} is bg-field`).toContain('bg-field')
      expect(klass, `U6: prop-${name} is border-line-strong`).toContain('border-line-strong')
      for (const part of RING) expect(klass, `prop-${name} is missing ${part}`).toContain(part)
      expect(
        klass.filter((c) => c.startsWith('focus:')),
        `prop-${name}: focus:border-accent was the 1px colour swap (R6)`,
      ).toEqual([])
    }
  })

  it('U6 — the swatch input and the theme swatch carry the strong border; the transform buttons are subtle', () => {
    mountPanel()
    for (const id of ['swatch-color', 'theme-color-accent']) {
      const klass = classes(screen.getByTestId(id))
      expect(klass, `U6: ${id} is border-line-strong`).toContain('border-line-strong')
      expect(klass, `${id}: rounded-control, not the 4px \`rounded\` alias`).toContain(
        'rounded-control',
      )
    }
    for (const id of TRANSFORM) {
      const klass = classes(screen.getByTestId(id))
      expect(klass, `${id}: Button's subtle recipe`).toContain('hover:bg-hover')
      expect(
        klass.filter((c) => c.startsWith('border')),
        `${id}: a subtle button in a row has no edge at rest (Button.tsx)`,
      ).toEqual([])
      expect(
        klass.filter((c) => c.startsWith('hover:border')),
        `${id}: hover:border-accent (C2)`,
      ).toEqual([])
    }
  })

  it('the theme swatch lifts on hover, and the one matching the source is ringed and pressed (item 4)', () => {
    mountPanel()
    const accent = screen.getByTestId('theme-color-accent')
    const other = screen.getByTestId('theme-color-bg')
    expect(classes(accent)).toContain('ring-2')
    expect(classes(accent)).toContain('ring-accent')
    expect(accent.getAttribute('aria-pressed'), 'selected is stated, not only drawn').toBe('true')
    expect(classes(other)).not.toContain('ring-2')
    expect(other.getAttribute('aria-pressed')).toBe('false')
    for (const el of [accent, other]) {
      expect(classes(el)).toContain('hover:shadow-raised')
      expect(
        classes(el).filter((c) => c.startsWith('hover:ring')),
        'hover:ring-2 was the sixth hover mechanism',
      ).toEqual([])
    }
  })

  it('the eyedropper is an SVG on a ToolbarButton, not an emoji', () => {
    mountPanel()
    const button = screen.getByTestId('eyedrop-color')
    expect(button.querySelector('svg')).not.toBeNull()
    expect(button.textContent).not.toContain('💧')
    expect(classes(button)).toContain('h-control')
    expect(screen.getByRole('button', { name: 'Sample Text color with the eyedropper' })).toBe(
      button,
    )
  })

  it('U11 — "Ask Claude" is the accent tint with no border and no alpha', () => {
    mountPanel()
    const klass = classes(screen.getByTestId('ask-claude-element'))
    expect(klass, 'U11: bg-accent-soft (15.03 / 10.03 under text)').toContain('bg-accent-soft')
    expect(klass, 'interactive chip: hover:bg-hover').toContain('hover:bg-hover')
    expect(
      klass.filter((c) => c.startsWith('border')),
      'U11: `border-accent/60` was 2.49 / 1.82; a label chip has no border (R4)',
    ).toEqual([])
    expect(
      klass.filter((c) => c.includes('/')),
      'U11: no alpha improvisation (R3)',
    ).toEqual([])
    for (const part of RING) expect(klass).toContain(part)
  })
})

describe('M8b.3 surface 3 — the arrange bar on the design tokens', () => {
  it('U7 — the bar floats on shadow-floating alone, on the panel z-index', () => {
    mountBar()
    const klass = classes(screen.getByTestId('arrange-bar'))
    expect(klass, 'U7: the separation is the shadow').toContain('shadow-floating')
    expect(
      klass.filter((c) => c.startsWith('border')),
      'U7: `border-chrome-line` on top of a shadow was 1.30 / 1.24',
    ).toEqual([])
    expect(klass).toContain('bg-surface-raised')
    expect(klass).toContain('rounded-panel')
    expect(klass).toContain('z-panel')
    expect(
      klass.filter((c) => /^(bg|border|shadow)-[a-z-]+\//.test(c)),
      'no alpha on a token (R3)',
    ).toEqual([])
  })

  it('the eight buttons are ToolbarButtons at the one control size, still named', () => {
    mountBar()
    const bar = screen.getByTestId('arrange-bar')
    const buttons = within(bar).getAllByRole('button')
    expect(buttons).toHaveLength(8)
    for (const button of buttons) {
      const klass = classes(button)
      expect(klass).toContain('h-control')
      expect(klass).toContain('w-control')
      expect(klass).toContain('hover:bg-hover')
      expect(klass).toContain('disabled:opacity-50')
    }
    expect(within(bar).getByRole('button', { name: 'Align left' })).toBeTruthy()
    expect(within(bar).getByRole('button', { name: 'Distribute vertically' })).toBeTruthy()
    expect(
      bar.querySelector('.w-px'),
      'groups are separated by gap, not a hairline (Divider)',
    ).toBeNull()
  })
})
