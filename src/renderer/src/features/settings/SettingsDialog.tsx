/**
 * The Settings dialog (M2.7) — opened from File ▸ Settings… and `Ctrl/⌘+,`.
 *
 * Drawn on the `Dialog` primitive since M8b.3 surface 4 (ui-design-audit.md §4.8 item 1), which
 * owns the scrim, Escape, the focus trap and restore, and `inert` on the shell; this file owns what
 * the primitive cannot know — a dirty draft survives an accidental dismissal. Every close path
 * (Escape, scrim click, the Close button) goes through the reducer's `request-close`, which either
 * closes or swaps the footer for the discard confirmation, so the three are identical by
 * construction rather than by three handlers agreeing.
 *
 * Auth (M2.7) and Budget (M2.5) are the substance. Model and About remain honest stubs — each says
 * what it will hold and which milestone fills it, rather than rendering a control that silently does
 * nothing.
 *
 * Tokens and primitives only (M8b.3 surface 4): `Button` for Close / Keep editing / Discard, role
 * tokens with no `dark:` twin (R1), no palette colour, no arbitrary value. The tab strip is not a
 * primitive — no surface but this one has tabs — so it imports the shared `FOCUS_RING` rather than
 * spelling a ring of its own (R6), the same arrangement the chat composer has.
 */

import {
  useCallback,
  useEffect,
  useMemo,
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
import { Button, Dialog, FOCUS_RING } from '../../components/ui'
import { selectAuthStatus, useAuthStore } from '../../stores/authStore'

export type SettingsDialogProps = {
  open: boolean
  /** Which tab to land on. The chat gate deep-links `auth`. */
  initialTab?: SettingsTab
  onClose: () => void
}

/**
 * One tab of the strip. `-mb-px` sits the tab's 2px underline on the strip's 1px baseline rather
 * than 1px above it; the selected state is the accent underline plus weight, the idle state is
 * muted text that comes up to full on hover (§4.8 item 2).
 */
const TAB = `-mb-px shrink-0 cursor-pointer rounded-t-control border-b-2 px-3 py-1.5 text-ui ${FOCUS_RING}`
const TAB_SELECTED = `${TAB} border-accent font-medium text-text`
const TAB_IDLE = `${TAB} border-transparent text-text-muted hover:text-text`

export function SettingsDialog({ open, initialTab, onClose }: SettingsDialogProps): JSX.Element {
  const [state, dispatch] = useReducer(settingsReducer, INITIAL_SETTINGS_STATE)
  const status = useAuthStore(selectAuthStatus)

  // Mirror the parent's `open` into the reducer, which owns tab + dirty.
  useEffect(() => {
    if (open) dispatch({ type: 'open', ...(initialTab !== undefined ? { tab: initialTab } : {}) })
  }, [open, initialTab])

  // `request-close` may be swallowed by the dirty guard, so the parent is only told once the reducer
  // actually closes. Watching the reducer (not the click) keeps Escape, backdrop, and Close identical.
  const wasOpen = useRef(false)
  useEffect(() => {
    if (wasOpen.current && !state.open) onClose()
    wasOpen.current = state.open
  }, [state.open, onClose])

  const onDirtyChange = useCallback((dirty: boolean) => {
    dispatch({ type: 'set-dirty', dirty })
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

  // Rendered closed rather than returned as null: `Dialog` holds its DOM for the exit transition,
  // and an early `null` here would unmount it before that frame is drawn.
  const isOpen = open && state.open

  // Memoised so the `Dialog` sees one footer identity per state, not a new tree every render.
  const footer = useMemo(
    () =>
      state.confirmingDiscard ? (
        <>
          <span className="grow text-ui-sm text-text">Discard the credential you typed?</span>
          <Button variant="subtle" onClick={cancelDiscard}>
            Keep editing
          </Button>
          <Button variant="primary" onClick={confirmDiscard}>
            Discard
          </Button>
        </>
      ) : (
        <Button onClick={requestClose}>Close</Button>
      ),
    [state.confirmingDiscard, cancelDiscard, confirmDiscard, requestClose],
  )

  return (
    <Dialog open={isOpen} title="Settings" onClose={requestClose} footer={footer}>
      <div className="flex min-h-0 flex-1 flex-col gap-4">
        <div
          role="tablist"
          aria-label="Settings sections"
          className="flex shrink-0 gap-1 border-b border-line"
        >
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
                className={selected ? TAB_SELECTED : TAB_IDLE}
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
          className="min-h-0 flex-1 overflow-y-auto"
        >
          {state.tab === 'auth' ? <AuthTab status={status} onDirtyChange={onDirtyChange} /> : null}
          {state.tab === 'model' ? <ModelTab /> : null}
          {state.tab === 'budget' ? <BudgetTab /> : null}
          {state.tab === 'about' ? <AboutTab /> : null}
        </div>
      </div>
    </Dialog>
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
      <p className="text-ui-sm text-text-muted">
        Sloodge currently runs every turn on the default model. Switching mid-session needs the
        model seam wired through IPC; until then this lists what is available.
      </p>
      <ul className="flex flex-col gap-1">
        {AGENT_MODEL_IDS.map((id) => (
          <li key={id} className="flex items-baseline gap-2 text-ui text-text">
            <span className="font-medium">{labels[id] ?? id}</span>
            {id === DEFAULT_AGENT_MODEL ? (
              <span className="text-caption text-text-muted">in use</span>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  )
}

function AboutTab(): JSX.Element {
  return (
    <div className="flex flex-col gap-2 text-ui text-text">
      <p className="font-medium">Sloodge</p>
      <p className="text-ui-sm text-text-muted">
        An AI-native slide editor. Every slide is a self-contained HTML document.
      </p>
      <p className="text-ui-sm text-text-muted">Powered by Claude.</p>
    </div>
  )
}
