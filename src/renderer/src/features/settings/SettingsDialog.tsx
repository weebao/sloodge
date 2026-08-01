/**
 * The Settings dialog (M2.7) — opened from File ▸ Settings… and `Ctrl/⌘+,`.
 *
 * A lightweight controlled overlay rather than a Radix dialog, matching `ExportPptxDialog` (M4.3):
 * the app still has no dialog primitive and this milestone adds zero UI dependencies. It goes further
 * than that one in three places the export dialog can get away with skipping, because this dialog
 * holds a text field a user can lose work in: Escape closes, focus moves into the dialog on open and
 * returns to the opener on close, and a dirty draft survives an accidental dismissal.
 *
 * Auth (M2.7) and Budget (M2.5) are the substance. Model and About remain honest stubs — each says
 * what it will hold and which milestone fills it, rather than rendering a control that silently does
 * nothing.
 */

import {
  useCallback,
  useEffect,
  useReducer,
  useRef,
  type JSX,
  type KeyboardEvent,
  type MouseEvent,
} from 'react'
import { AuthTab } from './AuthTab'
import { BudgetTab } from './BudgetTab'
import {
  INITIAL_SETTINGS_STATE,
  isSettingsTab,
  nextTab,
  settingsReducer,
  SETTINGS_TABS,
  SETTINGS_TAB_LABELS,
  type SettingsTab,
} from './settingsState'
import { AGENT_MODEL_IDS, DEFAULT_AGENT_MODEL } from '../../../../shared/agent/types'
import { selectAuthStatus, useAuthStore } from '../../stores/authStore'

export type SettingsDialogProps = {
  open: boolean
  /** Which tab to land on. The chat gate deep-links `auth`. */
  initialTab?: SettingsTab
  onClose: () => void
}

export function SettingsDialog({
  open,
  initialTab,
  onClose,
}: SettingsDialogProps): JSX.Element | null {
  const [state, dispatch] = useReducer(settingsReducer, INITIAL_SETTINGS_STATE)
  const status = useAuthStore(selectAuthStatus)
  const panelRef = useRef<HTMLDivElement | null>(null)
  const openerRef = useRef<Element | null>(null)

  // Mirror the parent's `open` into the reducer, which owns tab + dirty. Recording the opener here
  // (rather than in the focus effect) captures it before the dialog steals focus.
  useEffect(() => {
    if (open) {
      openerRef.current = document.activeElement
      dispatch({ type: 'open', ...(initialTab !== undefined ? { tab: initialTab } : {}) })
    }
  }, [open, initialTab])

  // A dialog that opens without focus leaves the keyboard stranded on the page behind it.
  useEffect(() => {
    if (state.open) panelRef.current?.focus()
  }, [state.open])

  const close = useCallback(() => {
    const opener = openerRef.current
    // Restore focus before the parent unmounts us, or the browser drops it on <body>.
    if (opener instanceof HTMLElement) opener.focus()
    onClose()
  }, [onClose])

  // `request-close` may be swallowed by the dirty guard, so the parent is only told once the reducer
  // actually closes. Watching the reducer (not the click) keeps Escape, backdrop, and Close identical.
  const wasOpen = useRef(false)
  useEffect(() => {
    if (wasOpen.current && !state.open) close()
    wasOpen.current = state.open
  }, [state.open, close])

  const onDirtyChange = useCallback((dirty: boolean) => {
    dispatch({ type: 'set-dirty', dirty })
  }, [])

  const onKeyDown = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.stopPropagation()
      dispatch({ type: 'request-close' })
    }
  }, [])

  /**
   * The tab strip's handlers read their target from `data-tab` rather than closing over the mapped
   * value. A closure per tab per render would be a new prop identity every time — a wasted render and
   * an oxlint `react-perf` violation; one stable handler for the whole strip beats memoising four.
   */
  const onTabClick = useCallback((event: MouseEvent<HTMLButtonElement>) => {
    const tab = event.currentTarget.dataset['tab']
    if (isSettingsTab(tab)) dispatch({ type: 'select-tab', tab })
  }, [])

  const onTabKeyDown = useCallback((event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return
    const tab = event.currentTarget.dataset['tab']
    if (!isSettingsTab(tab)) return
    event.preventDefault()
    dispatch({ type: 'select-tab', tab: nextTab(tab, event.key === 'ArrowRight' ? 1 : -1) })
  }, [])

  const requestClose = useCallback(() => {
    dispatch({ type: 'request-close' })
  }, [])

  const cancelDiscard = useCallback(() => {
    dispatch({ type: 'cancel-discard' })
  }, [])

  const confirmDiscard = useCallback(() => {
    dispatch({ type: 'confirm-discard' })
  }, [])

  /** The backdrop closes; a click inside the panel must not bubble out to it. */
  const stopPropagation = useCallback((event: MouseEvent<HTMLDivElement>) => {
    event.stopPropagation()
  }, [])

  if (!open || !state.open) return null

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      role="presentation"
      onClick={requestClose}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        tabIndex={-1}
        onKeyDown={onKeyDown}
        onClick={stopPropagation}
        className="flex max-h-[85vh] w-[34rem] max-w-[92vw] flex-col rounded-lg border border-chrome-line bg-chrome shadow-xl outline-none dark:border-ink-line dark:bg-ink"
      >
        <header className="border-b border-chrome-line px-5 py-3 dark:border-ink-line">
          <h2
            id="settings-title"
            className="text-[15px] font-semibold text-shell-fg dark:text-ink-fg"
          >
            Settings
          </h2>
        </header>

        <div role="tablist" aria-label="Settings sections" className="flex gap-1 px-4 pt-3">
          {SETTINGS_TABS.map((tab) => {
            const selected = state.tab === tab
            return (
              <button
                key={tab}
                type="button"
                role="tab"
                id={`settings-tab-${tab}`}
                aria-selected={selected}
                aria-controls={`settings-panel-${tab}`}
                // Roving tabindex: one stop for the whole strip, arrows move within it.
                tabIndex={selected ? 0 : -1}
                data-tab={tab}
                onKeyDown={onTabKeyDown}
                onClick={onTabClick}
                className={
                  selected
                    ? 'rounded-t border-b-2 border-accent px-3 py-1.5 text-[13px] font-medium text-shell-fg dark:text-ink-fg'
                    : 'rounded-t border-b-2 border-transparent px-3 py-1.5 text-[13px] text-chrome-muted hover:text-shell-fg dark:text-ink-muted dark:hover:text-ink-fg'
                }
              >
                {SETTINGS_TAB_LABELS[tab]}
              </button>
            )
          })}
        </div>

        <div
          role="tabpanel"
          id={`settings-panel-${state.tab}`}
          aria-labelledby={`settings-tab-${state.tab}`}
          className="min-h-0 flex-1 overflow-y-auto px-5 py-4"
        >
          {state.tab === 'auth' ? <AuthTab status={status} onDirtyChange={onDirtyChange} /> : null}
          {state.tab === 'model' ? <ModelTab /> : null}
          {state.tab === 'budget' ? <BudgetTab /> : null}
          {state.tab === 'about' ? <AboutTab /> : null}
        </div>

        <footer className="flex items-center justify-end gap-2 border-t border-chrome-line px-5 py-3 dark:border-ink-line">
          {state.confirmingDiscard ? (
            <>
              <span className="mr-auto text-[12px] text-shell-fg dark:text-ink-fg">
                Discard the credential you typed?
              </span>
              <button
                type="button"
                onClick={cancelDiscard}
                className="rounded px-3 py-1 text-[13px] text-chrome-muted dark:text-ink-muted"
              >
                Keep editing
              </button>
              <button
                type="button"
                onClick={confirmDiscard}
                className="rounded bg-accent px-3 py-1 text-[13px] font-medium text-white"
              >
                Discard
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={requestClose}
              className="rounded border border-chrome-line px-3 py-1 text-[13px] text-shell-fg dark:border-ink-line dark:text-ink-fg"
            >
              Close
            </button>
          )}
        </footer>
      </div>
    </div>
  )
}

/**
 * 50-agent-integration.md §11 specifies this picker, but no model id is plumbed through IPC yet —
 * `AgentService` takes `defaultModel` in its deps and `AgentSession.setModel` is unreachable from the
 * renderer. Listing the models read-only is the honest rendering: it shows what the app will offer
 * without pretending a click does anything.
 */
function ModelTab(): JSX.Element {
  const labels: Readonly<Record<string, string>> = {
    'claude-opus-5': 'Best — strongest design judgment (default)',
    'claude-sonnet-5': 'Balanced — long editing sessions',
    'claude-haiku-4-5': 'Fast — trivial edits, lowest latency',
  }
  return (
    <div className="flex flex-col gap-3">
      <p className="text-[12px] text-chrome-muted dark:text-ink-muted">
        Sloodge currently runs every turn on the default model. Switching mid-session needs the
        model seam wired through IPC; until then this lists what is available.
      </p>
      <ul className="flex flex-col gap-1">
        {AGENT_MODEL_IDS.map((id) => (
          <li key={id} className="text-[13px] text-shell-fg dark:text-ink-fg">
            <span className="font-medium">{labels[id] ?? id}</span>
            {id === DEFAULT_AGENT_MODEL ? (
              <span className="ml-2 text-[11px] text-chrome-muted dark:text-ink-muted">in use</span>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  )
}

function AboutTab(): JSX.Element {
  return (
    <div className="flex flex-col gap-2 text-[13px] text-shell-fg dark:text-ink-fg">
      <p className="font-medium">Sloodge</p>
      <p className="text-[12px] text-chrome-muted dark:text-ink-muted">
        An AI-native slide editor. Every slide is a self-contained HTML document.
      </p>
      <p className="text-[12px] text-chrome-muted dark:text-ink-muted">Powered by Claude.</p>
    </div>
  )
}
