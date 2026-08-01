import { useCallback, useMemo, useRef, useState, type JSX } from 'react'
import { SlideCanvas } from '../features/canvas/SlideCanvas'
import { ChatPanel } from '../features/chat/ChatPanel'
import { ThumbnailRail } from '../features/deck/ThumbnailRail'
import { FormatBar } from '../features/format/FormatBar'
import { MenuTabStrip } from '../features/format/MenuTabStrip'
import { PresentSurface } from '../features/present/PresentSurface'
import { useExportPdf } from '../features/export/useExportPdf'
import { useExportPptx } from '../features/export/useExportPptx'
import { ExportPptxDialog } from '../features/export/ExportPptxDialog'
import { useExportHtml } from '../features/export/useExportHtml'
import { SettingsDialog } from '../features/settings/SettingsDialog'
import { StatusBar } from '../features/statusbar/StatusBar'
import { useDesignStore } from '../features/design/designStore'
import { useDesignModeKey } from '../features/design/useDesignModeKey'
import { selectCurrentIndex, selectSlideViews, useDeckStore } from '../stores/deckStore'
import { selectBudgetCap, selectBudgetLoaded, useBudgetStore } from '../stores/budgetStore'
import {
  selectSessionCostUsd,
  selectSessionSkills,
  useSessionMeterStore,
} from '../stores/sessionMeterStore'
import { evaluateBudget } from '../../../shared/agent/budget'
import { useAgentDeckEditor } from './useAgentDeckEditor'
import { useAgentDeckSync } from './useAgentDeckSync'
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
  // The status bar's live segments (M2.5). Published by `useChatSession` into two small stores
  // rather than lifted through props: `ChatPanel` owns the session and is a *sibling* of the bar, so
  // hoisting it here would re-render the canvas and the rail on every streamed token.
  const sessionCostUsd = useSessionMeterStore(selectSessionCostUsd)
  const sessionSkills = useSessionMeterStore(selectSessionSkills)
  const budgetCap = useBudgetStore(selectBudgetCap)
  const budgetLoaded = useBudgetStore(selectBudgetLoaded)
  // Derived in a memo, never in the selector — `evaluateBudget` returns a fresh object, which as a
  // selector result would make `getSnapshot` report a change on every call (createStore's contract).
  const budget = useMemo(
    () => evaluateBudget(sessionCostUsd, budgetLoaded ? budgetCap : null),
    [sessionCostUsd, budgetCap, budgetLoaded],
  )
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

  const toggleDesign = useDesignStore((state) => state.toggle)
  useDesignModeKey(toggleDesign)
  const setDesignEnabled = useDesignStore((state) => state.setEnabled)

  // Agent tool edits (M2.6) apply through the authoritative history so they are undoable by the same
  // Ctrl/⌘+Z as a manual edit; the full-snapshot `deck:updated` sync is doc:open/full-reload only.
  useAgentDeckEditor()
  useAgentDeckSync()

  const slides = useMemo(() => selectSlideViews(deck, slideHtml), [deck, slideHtml])
  const currentIndex = selectCurrentIndex(deck, currentSlideId)

  // PDF export (M4.2): File ▸ Export ▸ PDF arrives as an `app:menu` action; this trigger gathers the
  // wrapped slide HTML and asks main to run the save dialog + offscreen print. See useExportPdf.ts.
  const exportPdf = useExportPdf({
    slides,
    currentIndex: Math.max(0, currentIndex),
    deckTitle: deck.title,
  })

  // PPTX export (M4.3): File ▸ Export ▸ PowerPoint opens the fidelity dialog (structured vs raster),
  // then hands the wrapped slide HTML + fidelity to main. See useExportPptx.ts / ExportPptxDialog.tsx.
  const runExportPptx = useExportPptx({
    slides,
    currentIndex: Math.max(0, currentIndex),
    deckTitle: deck.title,
  })

  // HTML export (M4.4): File ▸ Export ▸ HTML. Same deck, same wrapped slide HTML, but main zips a
  // presenter shell + the slide documents instead of printing — so animation and interactivity
  // survive the export. See useExportHtml.ts.
  const exportHtml = useExportHtml({
    slides,
    currentIndex: Math.max(0, currentIndex),
    deckTitle: deck.title,
  })
  const [pptxDialogOpen, setPptxDialogOpen] = useState(false)

  // Settings (M2.7). Both openers are stable callbacks: `openSettings` is a `useMenuActions`
  // dependency, so a fresh identity each render would resubscribe `app:menu` on every keystroke.
  const [settingsOpen, setSettingsOpen] = useState(false)
  const openSettings = useCallback(() => {
    setSettingsOpen(true)
  }, [])
  const closeSettings = useCallback(() => {
    setSettingsOpen(false)
  }, [])
  const openPptxDialog = useCallback(() => {
    setPptxDialogOpen(true)
  }, [])
  const closePptxDialog = useCallback(() => {
    setPptxDialogOpen(false)
  }, [])
  const confirmPptxExport = useCallback(
    (fidelity: Parameters<typeof runExportPptx>[0]) => {
      setPptxDialogOpen(false)
      runExportPptx(fidelity)
    },
    [runExportPptx],
  )

  // Undo/redo has one owner per host, never two: the native Edit menu in Electron (its items own
  // the accelerators, and their intent arrives here as `app:menu`), the window keydown handler in a
  // menu-less browser host. See useMenuActions.ts for why that is a static choice, not a race.
  const editHandlers = useMemo(() => ({ undo, redo }), [undo, redo])
  useMenuActions(editHandlers, exportPdf, openPptxDialog, exportHtml, openSettings)
  useUndoRedoKeys(undo, redo, !menuOwnsEditAccelerators())

  // Present mode (M4.1) lives beside the shell rather than in the deck store: it is view state, never
  // persisted or undone, and it has its own navigation cursor so advancing the talk does not move the
  // editor's selection. `null` = not presenting; a number is the slide index Present opened on.
  const [presentFrom, setPresentFrom] = useState<number | null>(null)
  // Design Mode is force-disabled while presenting (40-design-mode.md §: "Present always forces
  // Design Mode off"), but the default idle state is Design-Mode-on, so leaving it off after a talk
  // would silently drop the user out of the mode they were editing in. Capture it on entry and
  // restore it on exit, so Present is transparent to the editing session it interrupts.
  const designWasEnabledRef = useRef(false)
  const startPresent = useCallback(() => {
    designWasEnabledRef.current = useDesignStore.getState().enabled
    setDesignEnabled(false)
    setPresentFrom(currentIndex === -1 ? 0 : currentIndex)
  }, [currentIndex, setDesignEnabled])
  const exitPresent = useCallback(() => {
    setPresentFrom(null)
    setDesignEnabled(designWasEnabledRef.current)
  }, [setDesignEnabled])
  const canPresent = slides.length > 0

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
        <SlideCanvas slides={slides} currentIndex={currentIndex} />
        <ChatPanel onOpenAuthSettings={openSettings} />
      </div>
      <StatusBar
        currentSlide={currentIndex + 1}
        slideCount={slides.length}
        themeName="Ocean"
        issueCount={0}
        sessionCostUsd={sessionCostUsd}
        budget={budget}
        skills={sessionSkills}
        {...(canPresent ? { onPresent: startPresent } : {})}
      />
      {presentFrom !== null ? (
        <PresentSurface slides={slides} startIndex={presentFrom} onExit={exitPresent} />
      ) : null}
      <SettingsDialog open={settingsOpen} initialTab="auth" onClose={closeSettings} />
      <ExportPptxDialog
        open={pptxDialogOpen}
        slideCount={slides.length}
        onCancel={closePptxDialog}
        onExport={confirmPptxExport}
      />
    </div>
  )
}
