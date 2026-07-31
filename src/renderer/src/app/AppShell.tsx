import { useMemo, type JSX } from 'react'
import { SlideCanvas } from '../features/canvas/SlideCanvas'
import { ChatPanel } from '../features/chat/ChatPanel'
import { ThumbnailRail } from '../features/deck/ThumbnailRail'
import { FormatBar } from '../features/format/FormatBar'
import { MenuTabStrip } from '../features/format/MenuTabStrip'
import { StatusBar } from '../features/statusbar/StatusBar'
import { selectCurrentIndex, selectSlideViews, useDeckStore } from '../stores/deckStore'
import { menuOwnsEditAccelerators, useMenuActions } from './useMenuActions'
import { useUndoRedoKeys } from './useUndoRedoKeys'

/**
 * The PowerPoint-like frame (20-ui-wireframes.md): tab strip + format bar on top, thumbnail rail /
 * canvas / chat in the middle, status bar at the bottom.
 *
 * The shell is the only component that talks to the store; the rail and the canvas take plain
 * props. That keeps them renderable in a test (and later in a Present window, which has its own
 * state) without standing up a store, and it puts every subscription in one reviewable place.
 *
 * Each `useDeckStore` call selects a *stable slice*, never a derived value — see the selector
 * contract in `stores/createStore.ts`. The derivations happen in `useMemo` below.
 */
export function AppShell(): JSX.Element {
  const deck = useDeckStore((state) => state.deck)
  const slideHtml = useDeckStore((state) => state.slideHtml)
  const currentSlideId = useDeckStore((state) => state.currentSlideId)
  const selectSlide = useDeckStore((state) => state.selectSlide)
  const addSlide = useDeckStore((state) => state.addSlide)
  const deleteSlide = useDeckStore((state) => state.deleteSlide)
  const duplicateSlide = useDeckStore((state) => state.duplicateSlide)
  const moveSlide = useDeckStore((state) => state.moveSlide)
  const undo = useDeckStore((state) => state.undo)
  const redo = useDeckStore((state) => state.redo)

  // Undo/redo has one owner per host, never two: the native Edit menu in Electron (its items own
  // the accelerators, and their intent arrives here as `app:menu`), the window keydown handler in a
  // menu-less browser host. See useMenuActions.ts for why that is a static choice, not a race.
  const editHandlers = useMemo(() => ({ undo, redo }), [undo, redo])
  useMenuActions(editHandlers)
  useUndoRedoKeys(undo, redo, !menuOwnsEditAccelerators())

  const slides = useMemo(() => selectSlideViews(deck, slideHtml), [deck, slideHtml])
  const currentIndex = selectCurrentIndex(deck, currentSlideId)
  const currentSlide = currentIndex === -1 ? null : (slides[currentIndex] ?? null)

  return (
    <div
      id="sloodge-shell"
      className="flex h-screen w-screen flex-col overflow-hidden bg-shell-bg text-shell-fg dark:bg-ink dark:text-ink-fg"
    >
      <MenuTabStrip />
      <FormatBar />
      <div className="flex min-h-0 flex-1">
        <ThumbnailRail
          slides={slides}
          currentSlideId={currentSlideId}
          onSelectSlide={selectSlide}
          onAddSlide={addSlide}
          onDuplicateSlide={duplicateSlide}
          onDeleteSlide={deleteSlide}
          onMoveSlide={moveSlide}
        />
        <SlideCanvas slide={currentSlide} />
        <ChatPanel />
      </div>
      <StatusBar
        currentSlide={currentIndex + 1}
        slideCount={slides.length}
        themeName="Ocean"
        issueCount={0}
        sessionCost="$0.00"
      />
    </div>
  )
}
