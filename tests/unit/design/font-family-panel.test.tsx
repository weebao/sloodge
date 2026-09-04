/**
 * @vitest-environment happy-dom
 *
 * The font-family dropdown wired into the Properties panel (M3.10): a pick must patch the slide
 * source through the byte-span map, cost exactly one undo entry, and leave every element id intact
 * so the selection survives. The dropdown's own keyboard/ARIA/windowing behaviour lives in
 * `font-family-control.test.tsx`; this file is about what reaches the document.
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { SlHit } from '../../../src/shared/design/bridge-protocol'
import { buildSlideMap } from '../../../src/shared/design/slide-map'
import { validateSlideContract } from '../../../src/shared/document/slide-contract'
import { useDesignStore } from '../../../src/renderer/src/features/design/designStore'
import { PropertyPanel } from '../../../src/renderer/src/features/design/PropertyPanel'
import {
  createStarterDeck,
  getSlideHtml,
  useDeckStore,
  type SlideView,
} from '../../../src/renderer/src/stores/deckStore'
import type { SystemFontsResponse } from '../../../src/shared/ipc-contract'

const NOW = 1_700_000_000_000
const SOURCE = '<h1 style="color: #111; font-size: 44px">Hello</h1>'

const INSTALLED = ['Bodoni MT', 'Papyrus', 'Verdana']

/** Module-scoped so the prop is a stable reference across renders (react-perf). */
const LOAD_FONTS = async (): Promise<SystemFontsResponse> => ({
  families: INSTALLED,
  source: 'powershell',
})

/** A loader offering a name the allow-list refuses, as a hostile enumerator would. */
const LOAD_HOSTILE = async (): Promise<SystemFontsResponse> => ({
  families: ['Papyrus'],
  source: 'powershell',
})

let slideId: string

function currentSlide(): SlideView {
  return {
    id: slideId,
    title: 'Slide',
    html: getSlideHtml(useDeckStore.getState().slideHtml, slideId)!,
  }
}

function html(): string {
  return getSlideHtml(useDeckStore.getState().slideHtml, slideId)!
}

function h1Id(): string {
  return buildSlideMap(slideId, SOURCE).order[0]!
}

function select(): void {
  const hit: SlHit = {
    slId: h1Id(),
    tag: 'h1',
    id: null,
    classes: [],
    rect: { x: 0, y: 0, width: 100, height: 40 },
    ancestors: [],
  }
  useDesignStore.setState({ enabled: true, hover: null, selection: hit })
}

function undoDepth(): number {
  return useDeckStore.getState().history.summary().undoDepth
}

/** Open the dropdown and wait for the installed group to arrive. */
async function openDropdown(): Promise<void> {
  fireEvent.click(screen.getByTestId('prop-fontFamily'))
  await waitFor(() => {
    expect(screen.getByTestId('font-option-Bodoni MT')).toBeTruthy()
  })
}

beforeEach(() => {
  useDeckStore.setState(createStarterDeck(NOW))
  slideId = useDeckStore.getState().currentSlideId!
  useDeckStore.getState().setSlideHtml(slideId, SOURCE, slideId, 'seed')
  useDesignStore.setState({ enabled: true, hover: null, selection: null })
})

afterEach(cleanup)

describe('font family pick — write-back', () => {
  it('writes the stack as a minimal splice, leaving the other declarations alone', async () => {
    select()
    render(<PropertyPanel slide={currentSlide()} loadFonts={LOAD_FONTS} />)
    await openDropdown()
    fireEvent.click(screen.getByTestId('font-option-Papyrus'))

    await waitFor(() => {
      expect(html()).not.toBe(SOURCE)
    })
    expect(html()).toBe(
      '<h1 style="color: #111; font-size: 44px; font-family: Papyrus, Segoe UI, system-ui, sans-serif">Hello</h1>',
    )
  })

  it('survives a second edit to another property without corrupting the style attribute', async () => {
    // The regression this pins: a quoted family would be written as `&quot;…&quot;`, whose
    // semicolons split `parseDeclarations`, and the next edit would re-serialise the wreckage.
    select()
    const { rerender } = render(<PropertyPanel slide={currentSlide()} loadFonts={LOAD_FONTS} />)
    await openDropdown()
    fireEvent.click(screen.getByTestId('font-option-Papyrus'))
    await waitFor(() => {
      expect(html()).toContain('Papyrus')
    })

    rerender(<PropertyPanel slide={currentSlide()} loadFonts={LOAD_FONTS} />)
    const size = screen.getByTestId('prop-fontSize')
    fireEvent.change(size, { target: { value: '60' } })
    fireEvent.blur(size)

    await waitFor(() => {
      expect(html()).toContain('font-size: 60px')
    })
    expect(html()).toBe(
      '<h1 style="color: #111; font-size: 60px; font-family: Papyrus, Segoe UI, system-ui, sans-serif">Hello</h1>',
    )
  })

  it('reads its own write back, rather than an HTML-escaped fragment of it', async () => {
    select()
    const { rerender } = render(<PropertyPanel slide={currentSlide()} loadFonts={LOAD_FONTS} />)
    await openDropdown()
    fireEvent.click(screen.getByTestId('font-option-Papyrus'))
    await waitFor(() => {
      expect(html()).toContain('Papyrus')
    })

    rerender(<PropertyPanel slide={currentSlide()} loadFonts={LOAD_FONTS} />)
    // The trigger shows the face, not `&quot` — the symptom a quoted write produced.
    expect(screen.getByTestId('prop-fontFamily').textContent).toContain('Papyrus')
  })

  it('keeps the map id set identical, so the selection is not invalidated', async () => {
    select()
    const before = buildSlideMap(slideId, html()).order
    render(<PropertyPanel slide={currentSlide()} loadFonts={LOAD_FONTS} />)
    await openDropdown()
    fireEvent.click(screen.getByTestId('font-option-Papyrus'))

    await waitFor(() => {
      expect(html()).not.toBe(SOURCE)
    })
    expect(buildSlideMap(slideId, html()).order).toEqual(before)
  })

  it('introduces no new contract issue', async () => {
    // The seeded fragment is not a whole slide, so it never satisfies the geometry rules; what
    // matters is that the pick adds nothing. Contract validity of a real, complete slide after a
    // pick is proven in `tests/unit/fonts/family.test.ts`.
    select()
    const before = validateSlideContract(SOURCE).issues.map((issue) => issue.rule)
    render(<PropertyPanel slide={currentSlide()} loadFonts={LOAD_FONTS} />)
    await openDropdown()
    fireEvent.click(screen.getByTestId('font-option-Papyrus'))

    await waitFor(() => {
      expect(html()).not.toBe(SOURCE)
    })
    expect(validateSlideContract(html()).issues.map((issue) => issue.rule)).toEqual(before)
  })

  it('replaces the declaration rather than appending a second one on a re-pick', async () => {
    select()
    const { rerender } = render(<PropertyPanel slide={currentSlide()} loadFonts={LOAD_FONTS} />)
    await openDropdown()
    fireEvent.click(screen.getByTestId('font-option-Papyrus'))
    await waitFor(() => {
      expect(html()).toContain('Papyrus')
    })

    rerender(<PropertyPanel slide={currentSlide()} loadFonts={LOAD_FONTS} />)
    await openDropdown()
    fireEvent.click(screen.getByTestId('font-option-Verdana'))
    await waitFor(() => {
      expect(html()).toContain('Verdana')
    })

    expect(html().match(/font-family/g)).toHaveLength(1)
    expect(html()).not.toContain('Papyrus')
  })
})

describe('font family pick — undo', () => {
  it('costs exactly one undo entry', async () => {
    select()
    render(<PropertyPanel slide={currentSlide()} loadFonts={LOAD_FONTS} />)
    const before = undoDepth()
    await openDropdown()
    fireEvent.click(screen.getByTestId('font-option-Papyrus'))

    await waitFor(() => {
      expect(html()).not.toBe(SOURCE)
    })
    expect(undoDepth()).toBe(before + 1)
  })

  it('spends no undo entry on opening, filtering or arrowing around', async () => {
    select()
    render(<PropertyPanel slide={currentSlide()} loadFonts={LOAD_FONTS} />)
    const before = undoDepth()
    await openDropdown()
    const input = screen.getByTestId('font-filter')
    fireEvent.change(input, { target: { value: 'pap' } })
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    fireEvent.keyDown(input, { key: 'ArrowUp' })
    fireEvent.keyDown(input, { key: 'Escape' })

    expect(undoDepth()).toBe(before)
    expect(html()).toBe(SOURCE)
  })

  it('restores the exact original bytes on undo', async () => {
    select()
    render(<PropertyPanel slide={currentSlide()} loadFonts={LOAD_FONTS} />)
    await openDropdown()
    fireEvent.click(screen.getByTestId('font-option-Papyrus'))
    await waitFor(() => {
      expect(html()).not.toBe(SOURCE)
    })

    expect(useDeckStore.getState().undo()).toBe(true)
    expect(html()).toBe(SOURCE)
  })

  it('takes two picks back with two undos, never one', async () => {
    select()
    const { rerender } = render(<PropertyPanel slide={currentSlide()} loadFonts={LOAD_FONTS} />)
    await openDropdown()
    fireEvent.click(screen.getByTestId('font-option-Papyrus'))
    await waitFor(() => {
      expect(html()).toContain('Papyrus')
    })

    rerender(<PropertyPanel slide={currentSlide()} loadFonts={LOAD_FONTS} />)
    await openDropdown()
    fireEvent.click(screen.getByTestId('font-option-Verdana'))
    await waitFor(() => {
      expect(html()).toContain('Verdana')
    })

    // Two separate gestures are two separate entries: the first undo must land on Papyrus, not on
    // the seeded source. Coalescing the two would make this assertion fail.
    expect(useDeckStore.getState().undo()).toBe(true)
    expect(html()).toContain('Papyrus')
    expect(useDeckStore.getState().undo()).toBe(true)
    expect(html()).toBe(SOURCE)
  })
})

describe('font family pick — export-fidelity warning', () => {
  it('is absent before any pick', () => {
    select()
    render(<PropertyPanel slide={currentSlide()} loadFonts={LOAD_FONTS} />)
    expect(screen.queryByTestId('font-export-warning')).toBeNull()
  })

  it('appears after picking a face that will not travel', async () => {
    select()
    const { rerender } = render(<PropertyPanel slide={currentSlide()} loadFonts={LOAD_FONTS} />)
    await openDropdown()
    fireEvent.click(screen.getByTestId('font-option-Papyrus'))
    await waitFor(() => {
      expect(html()).toContain('Papyrus')
    })

    rerender(<PropertyPanel slide={currentSlide()} loadFonts={LOAD_FONTS} />)
    expect(screen.getByTestId('font-export-warning').textContent).toContain("Won't travel")
  })

  it('stays away after picking a system face', async () => {
    select()
    const { rerender } = render(<PropertyPanel slide={currentSlide()} loadFonts={LOAD_FONTS} />)
    await openDropdown()
    fireEvent.click(screen.getByTestId('font-option-Georgia'))
    await waitFor(() => {
      expect(html()).toContain('Georgia')
    })

    rerender(<PropertyPanel slide={currentSlide()} loadFonts={LOAD_FONTS} />)
    expect(screen.queryByTestId('font-export-warning')).toBeNull()
  })

  it('goes away again when the pick is undone', async () => {
    select()
    const { rerender } = render(<PropertyPanel slide={currentSlide()} loadFonts={LOAD_FONTS} />)
    await openDropdown()
    fireEvent.click(screen.getByTestId('font-option-Papyrus'))
    await waitFor(() => {
      expect(html()).toContain('Papyrus')
    })

    useDeckStore.getState().undo()
    rerender(<PropertyPanel slide={currentSlide()} loadFonts={LOAD_FONTS} />)
    expect(screen.queryByTestId('font-export-warning')).toBeNull()
  })
})

describe('font family pick — a hostile enumerator', () => {
  it('never offers a name the allow-list refused', async () => {
    select()
    render(<PropertyPanel slide={currentSlide()} loadFonts={LOAD_HOSTILE} />)
    fireEvent.click(screen.getByTestId('prop-fontFamily'))
    await waitFor(() => {
      expect(screen.getByTestId('font-option-Papyrus')).toBeTruthy()
    })
    // The dropdown is fed straight from the loader; only the vetted name is listed.
    const names = screen.queryAllByRole('option').map((el) => el.textContent)
    expect(names).toContain('Papyrus')
    for (const name of names) {
      expect(name).not.toContain('"')
      expect(name).not.toContain(';')
      expect(name).not.toContain('<')
    }
  })
})
