/**
 * @vitest-environment happy-dom
 *
 * The modal contract the two shipped overlays never had (ui-design-audit.md §5.6, §4.6, §4.8):
 * Escape closes, Tab is trapped, focus is restored to whatever opened the dialog, and the shell
 * behind the scrim is `inert` — not merely covered by it.
 *
 * `inert` is the assertion worth stating plainly, because a scrim looks identical with and without
 * it: without `inert` the app behind a modal is still reachable by Tab and still exposed to a screen
 * reader's virtual cursor, which is exactly the state both shipped dialogs are in today. The portal
 * is what makes `inert` usable — a dialog rendered inside `#sloodge-shell` would inert itself — so
 * the portal is asserted here too, as the mechanism rather than as a styling detail.
 *
 * Mutations: drop the `shell.setAttribute('inert')` line → the inert test reds; drop the Escape
 * branch → the Escape test reds; drop the `restoreTo.focus()` line → the restore test reds; return
 * the tree without `createPortal` → the inert test reds, because the dialog inerts itself.
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Button } from '../../../src/renderer/src/components/ui/Button'
import { Dialog } from '../../../src/renderer/src/components/ui/Dialog'

afterEach(() => {
  cleanup()
  document.getElementById('sloodge-shell')?.remove()
})

/** The app shell the dialog must take out of the tab order, plus the control that opened it. */
function mountShell(): HTMLButtonElement {
  const shell = document.createElement('div')
  shell.id = 'sloodge-shell'
  const opener = document.createElement('button')
  opener.textContent = 'Open'
  shell.append(opener)
  document.body.append(shell)
  opener.focus()
  return opener
}

const body = (
  <>
    <input aria-label="First" />
    <input aria-label="Last" />
  </>
)

const footer = <Button>Done</Button>

describe('Dialog', () => {
  it('renders nothing until it is open', () => {
    render(
      <Dialog open={false} title="Export" onClose={vi.fn()}>
        {body}
      </Dialog>,
    )
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('inerts the shell while open and releases it on close', () => {
    mountShell()
    const view = render(
      <Dialog open title="Export" onClose={vi.fn()}>
        {body}
      </Dialog>,
    )
    const shell = document.getElementById('sloodge-shell')!
    expect(shell.hasAttribute('inert')).toBe(true)
    // The dialog is not inside the shell, or it would have inerted itself along with it.
    expect(shell.contains(screen.getByRole('dialog'))).toBe(false)

    view.rerender(
      <Dialog open={false} title="Export" onClose={vi.fn()}>
        {body}
      </Dialog>,
    )
    expect(shell.hasAttribute('inert')).toBe(false)
  })

  it('moves focus to the first focusable and restores it to the opener on close', () => {
    const opener = mountShell()
    const view = render(
      <Dialog open title="Export" onClose={vi.fn()}>
        {body}
      </Dialog>,
    )
    expect(document.activeElement).toBe(screen.getByLabelText('First'))

    view.rerender(
      <Dialog open={false} title="Export" onClose={vi.fn()}>
        {body}
      </Dialog>,
    )
    expect(document.activeElement).toBe(opener)
  })

  it('closes on Escape without letting the key reach the app behind it', () => {
    const onClose = vi.fn()
    const onShellKey = vi.fn()
    document.addEventListener('keydown', onShellKey)
    render(
      <Dialog open title="Export" onClose={onClose}>
        {body}
      </Dialog>,
    )
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    document.removeEventListener('keydown', onShellKey)

    expect(onClose).toHaveBeenCalledTimes(1)
    expect(onShellKey).not.toHaveBeenCalled()
  })

  it('wraps Tab and Shift+Tab inside the dialog', () => {
    render(
      <Dialog open title="Export" onClose={vi.fn()} footer={footer}>
        {body}
      </Dialog>,
    )
    const first = screen.getByLabelText('First')
    const last = screen.getByRole('button', { name: 'Done' })

    last.focus()
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Tab' })
    expect(document.activeElement).toBe(first)

    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(last)
  })

  it('names itself by its visible title', () => {
    render(
      <Dialog open title="Export to PowerPoint" onClose={vi.fn()}>
        {body}
      </Dialog>,
    )
    const dialog = screen.getByRole('dialog')
    expect(dialog.getAttribute('aria-modal')).toBe('true')
    const labelId = dialog.getAttribute('aria-labelledby')!
    expect(document.getElementById(labelId)?.textContent).toBe('Export to PowerPoint')
  })
})
