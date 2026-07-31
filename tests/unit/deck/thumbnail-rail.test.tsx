/**
 * @vitest-environment happy-dom
 *
 * The rail's M1.4 interactions: `[+ New]`, the right-click menu, and drag-to-reorder.
 *
 * The rail is deliberately a props-only component, so these tests are about the *gestures* — which
 * handler a right-click, a drop or Alt+Arrow ends up calling, with which indices. What those
 * handlers then do to the document is `deck-crud.test.ts`'s job.
 */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ThumbnailRail } from '../../../src/renderer/src/features/deck/ThumbnailRail'
import type { SlideView } from '../../../src/renderer/src/stores/deckStore'
import type { SlideId } from '../../../src/shared/document/types'

const ids = ['s_a', 's_b', 's_c'] as unknown as SlideId[]
const slides: SlideView[] = ids.map((id, index) => ({
  id,
  title: `Slide ${String(index + 1)}`,
  html: '<!doctype html><html lang="en"><body></body></html>',
}))

function setup(overrides: Partial<Parameters<typeof ThumbnailRail>[0]> = {}) {
  const handlers = {
    onSelectSlide: vi.fn(),
    onAddSlide: vi.fn(),
    onDuplicateSlide: vi.fn(),
    onDeleteSlide: vi.fn(),
    onMoveSlide: vi.fn(),
  }
  render(
    <ThumbnailRail slides={slides} currentSlideId={ids[0] ?? null} {...handlers} {...overrides} />,
  )
  return handlers
}

/** The `<li>` for a 0-based slide position — the drag/drop target. */
function card(index: number): HTMLElement {
  const element = document.querySelector(`[data-slide-index="${String(index)}"]`)
  if (!(element instanceof HTMLElement)) throw new Error(`no card at ${String(index)}`)
  return element
}

/** A drag needs a data transfer; happy-dom has no `DataTransfer`, and the rail only writes to it. */
function dataTransfer() {
  return { setData: vi.fn(), getData: vi.fn(), effectAllowed: 'none', dropEffect: 'none' }
}

beforeEach(() => {
  // happy-dom cannot fetch a `blob:` URL, so the mini-frames are pointed at about:blank.
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('about:blank')
  vi.spyOn(URL, 'revokeObjectURL').mockReturnValue(undefined)
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('[+ New]', () => {
  it('is enabled and appends', () => {
    const { onAddSlide } = setup()
    const button = screen.getByRole('button', { name: '+ New' })

    expect(button.getAttribute('aria-disabled')).toBeNull()
    fireEvent.click(button)
    expect(onAddSlide).toHaveBeenCalledTimes(1)
  })
})

describe('the context menu', () => {
  it('opens on right-click, selects that slide, and offers duplicate and delete', () => {
    const { onSelectSlide } = setup()
    fireEvent.contextMenu(card(1), { clientX: 40, clientY: 120 })

    expect(onSelectSlide).toHaveBeenCalledWith(ids[1])
    const menu = screen.getByRole('menu', { name: 'Slide actions' })
    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map((item) => item.textContent),
    ).toEqual(['Duplicate', 'Delete'])
  })

  it('duplicates the slide it was opened on, then closes', () => {
    const { onDuplicateSlide } = setup()
    fireEvent.contextMenu(card(2))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Duplicate' }))

    expect(onDuplicateSlide).toHaveBeenCalledWith(ids[2])
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('deletes the slide it was opened on', () => {
    const { onDeleteSlide } = setup()
    fireEvent.contextMenu(card(0))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }))

    expect(onDeleteSlide).toHaveBeenCalledWith(ids[0])
  })

  it('disables Delete on the deck’s last slide', () => {
    const { onDeleteSlide } = setup({ slides: slides.slice(0, 1), currentSlideId: ids[0]! })
    fireEvent.contextMenu(card(0))

    const remove = screen.getByRole('menuitem', { name: 'Delete' })
    expect((remove as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(remove)
    expect(onDeleteSlide).not.toHaveBeenCalled()
    // Duplicate is still live — the guard is about emptying the deck, not about the menu.
    expect(
      (screen.getByRole('menuitem', { name: 'Duplicate' }) as HTMLButtonElement).disabled,
    ).toBe(false)
  })

  it('closes on Escape and on a press outside it', () => {
    setup()
    fireEvent.contextMenu(card(0))
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()

    fireEvent.contextMenu(card(0))
    fireEvent.mouseDown(document.body)
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('walks its items with the arrow keys, skipping disabled ones', () => {
    setup({ slides: slides.slice(0, 1) })
    fireEvent.contextMenu(card(0))
    const menu = screen.getByRole('menu')

    // Opening focuses the first enabled item, and Delete (disabled here) is not in the ring.
    expect(document.activeElement?.textContent).toBe('Duplicate')
    fireEvent.keyDown(menu, { key: 'ArrowDown' })
    expect(document.activeElement?.textContent).toBe('Duplicate')
  })
})

describe('drag to reorder', () => {
  it('moves the dragged slide to the card it is dropped on', () => {
    const { onMoveSlide } = setup()

    fireEvent.dragStart(card(0), { dataTransfer: dataTransfer() })
    fireEvent.dragOver(card(2), { dataTransfer: dataTransfer() })
    fireEvent.drop(card(2), { dataTransfer: dataTransfer() })

    expect(onMoveSlide).toHaveBeenCalledWith(0, 2)
  })

  it('shows the drop indicator on the edge the slide would arrive from', () => {
    setup()
    fireEvent.dragStart(card(2), { dataTransfer: dataTransfer() })
    fireEvent.dragOver(card(0), { dataTransfer: dataTransfer() })

    // Dragging upwards: the slide lands *before* the hovered card.
    expect(card(0).className).toContain('border-t-accent')
    expect(card(2).className).toContain('opacity-40')

    fireEvent.dragEnd(card(2))
    expect(card(0).className).not.toContain('border-t-accent')
    expect(card(2).className).not.toContain('opacity-40')
  })

  it('draws no indicator on the card being dragged', () => {
    setup()
    fireEvent.dragStart(card(1), { dataTransfer: dataTransfer() })
    fireEvent.dragOver(card(1), { dataTransfer: dataTransfer() })

    expect(card(1).className).not.toContain('border-t-accent')
    expect(card(1).className).not.toContain('border-b-accent')
  })

  it('does nothing when a slide is dropped on itself', () => {
    const { onMoveSlide } = setup()
    fireEvent.dragStart(card(1), { dataTransfer: dataTransfer() })
    fireEvent.drop(card(1), { dataTransfer: dataTransfer() })

    expect(onMoveSlide).not.toHaveBeenCalled()
  })

  it('ignores a drop that did not start in the rail', () => {
    const { onMoveSlide } = setup()
    fireEvent.drop(card(2), { dataTransfer: dataTransfer() })

    expect(onMoveSlide).not.toHaveBeenCalled()
  })
})

describe('keyboard reorder', () => {
  it('moves the focused slide with Alt+Arrow', () => {
    const { onMoveSlide } = setup()
    const thumbnail = screen.getByRole('button', { name: /Slide 2 thumbnail/ })

    fireEvent.keyDown(thumbnail, { key: 'ArrowDown', altKey: true })
    expect(onMoveSlide).toHaveBeenCalledWith(1, 2)

    fireEvent.keyDown(thumbnail, { key: 'ArrowUp', altKey: true })
    expect(onMoveSlide).toHaveBeenCalledWith(1, 0)
  })

  it('leaves the plain arrow keys to the browser', () => {
    const { onMoveSlide } = setup()
    fireEvent.keyDown(screen.getByRole('button', { name: /Slide 2 thumbnail/ }), {
      key: 'ArrowDown',
    })

    expect(onMoveSlide).not.toHaveBeenCalled()
  })
})
