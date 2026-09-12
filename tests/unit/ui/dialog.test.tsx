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
 * The nesting row is the same assertion one level up. `inert` is a property of the shell, so a
 * boolean set on open and cleared on close is released by the FIRST dialog to unmount — close a
 * confirm over Settings and the app behind the still-painted scrim is Tab-reachable again, with
 * nothing on screen to say so. No surface stacks dialogs today; nine M8b.3 PRs adopt this primitive
 * without re-deriving its contract, and a confirm over a dialog is an ordinary thing for one of them
 * to build.
 *
 * Mutations: drop the `shell.setAttribute('inert')` line → the inert test reds; drop the Escape
 * branch → the Escape test reds; drop the `restoreTo.focus()` line → the restore test reds; return
 * the tree without `createPortal` → the inert test reds, because the dialog inerts itself; make the
 * cleanup remove the attribute unconditionally instead of at a zero refcount → the nesting test reds.
 *
 * Motion (M8b.3 surface 4): the arrival is `@starting-style` + token durations and the exit holds
 * the DOM only while a transition is running. happy-dom runs no transitions and has no
 * `getAnimations`, so the exit case stubs one onto the prototype with a `finished` promise it
 * controls — that is the only way to see the closing frame at all — and the fallback case is the
 * plain environment. Mutations: drop `starting:scale-98` from the panel → the arrival test reds;
 * make the exit reuse `duration-base` → the exit test reds on `duration-fast`; unmount on the
 * `open` edge without waiting → the exit test reds on the dialog being gone before `finished`
 * resolved; wait on a timer instead → the fallback test reds, because the dialog outlives the
 * closed render in an environment with nothing to wait for.
 *
 * Layout (M8b.3 surface 4, review r1): the two fixes that went to this primitive so every later
 * surface inherits them are pinned, because an inherited fix with no guard is undone silently.
 * The BODY is the scroll container and carries `overscroll-contain` — the first cut scrolled the
 * whole card, so Settings' Close button scrolled away under a long Budget tab — and title, body
 * and footer keep ui-design-audit.md §4.8 item 1's `px-5`. Mutations: move `overflow-y-auto
 * overscroll-contain` off the body → the layout test reds on `overscroll-contain`; `px-5` → `px-4`
 * on the three regions → it reds naming the region.
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
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

  it('keeps the shell inert until the LAST of two nested dialogs closes', () => {
    mountShell()
    const view = render(
      <>
        <Dialog open title="Settings" onClose={vi.fn()}>
          {body}
        </Dialog>
        <Dialog open title="Discard changes?" onClose={vi.fn()}>
          <Button>Discard</Button>
        </Dialog>
      </>,
    )
    const shell = document.getElementById('sloodge-shell')!
    expect(shell.hasAttribute('inert')).toBe(true)

    // Close the inner one only. The outer is still open and its scrim is still painted.
    view.rerender(
      <>
        <Dialog open title="Settings" onClose={vi.fn()}>
          {body}
        </Dialog>
        <Dialog open={false} title="Discard changes?" onClose={vi.fn()}>
          <Button>Discard</Button>
        </Dialog>
      </>,
    )
    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(shell.hasAttribute('inert')).toBe(true)

    view.rerender(
      <>
        <Dialog open={false} title="Settings" onClose={vi.fn()}>
          {body}
        </Dialog>
        <Dialog open={false} title="Discard changes?" onClose={vi.fn()}>
          <Button>Discard</Button>
        </Dialog>
      </>,
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

  it('arrives from @starting-style on token durations: scrim fast, panel base', () => {
    render(
      <Dialog open title="Export" onClose={vi.fn()}>
        {body}
      </Dialog>,
    )
    const panel = screen.getByRole('dialog')
    const klass = panel.className.split(/\s+/)
    for (const part of [
      'transition',
      'duration-base',
      'starting:opacity-0',
      'starting:translate-y-1.5',
      'starting:scale-98',
    ]) {
      expect(klass, `panel is missing ${part}`).toContain(part)
    }
    const scrim = panel.parentElement!.className.split(/\s+/)
    expect(scrim).toContain('transition-opacity')
    expect(scrim).toContain('duration-fast')
    expect(scrim).toContain('starting:opacity-0')
    expect(
      [...klass, ...scrim].filter((c) => /^(?:duration|ease)-\[|^duration-\d|^ease-in$/.test(c)),
      'durations are tokens and nothing eases in',
    ).toEqual([])
  })

  it('leaves faster than it came, inert and untouchable, and unmounts when the transition finishes', async () => {
    const opener = mountShell()
    let finish!: () => void
    const finished = new Promise<void>((resolve) => {
      finish = resolve
    })
    const proto = HTMLElement.prototype as { getAnimations?: () => Animation[] }
    proto.getAnimations = () => [{ finished } as unknown as Animation]
    try {
      const view = render(
        <Dialog open title="Export" onClose={vi.fn()}>
          {body}
        </Dialog>,
      )
      view.rerender(
        <Dialog open={false} title="Export" onClose={vi.fn()}>
          {body}
        </Dialog>,
      )
      // Still painted, on the exit recipe — and already out of the user's way: the shell is
      // released and focus is back on the opener before the fade has ended, not after.
      const panel = screen.getByRole('dialog', { hidden: true })
      const klass = panel.className.split(/\s+/)
      expect(klass, 'exit is the fast step').toContain('duration-fast')
      expect(klass, 'one duration, not two competing ones').not.toContain('duration-base')
      for (const part of ['opacity-0', 'translate-y-1.5', 'scale-98']) {
        expect(klass, `exit frame is missing ${part}`).toContain(part)
      }
      const scrim = panel.parentElement!
      expect(scrim.className.split(/\s+/)).toContain('pointer-events-none')
      expect(scrim.className.split(/\s+/)).toContain('opacity-0')
      expect(scrim.hasAttribute('inert'), 'the fading dialog is not in the tab order').toBe(true)
      expect(document.getElementById('sloodge-shell')!.hasAttribute('inert')).toBe(false)
      expect(document.activeElement).toBe(opener)

      finish()
      await waitFor(() => expect(screen.queryByRole('dialog', { hidden: true })).toBeNull())
    } finally {
      delete proto.getAnimations
    }
  })

  it('unmounts at once when nothing is animating (no stylesheet, or a zeroed duration)', () => {
    const view = render(
      <Dialog open title="Export" onClose={vi.fn()}>
        {body}
      </Dialog>,
    )
    view.rerender(
      <Dialog open={false} title="Export" onClose={vi.fn()}>
        {body}
      </Dialog>,
    )
    expect(screen.queryByRole('dialog', { hidden: true })).toBeNull()
  })

  it('scrolls in the body, not the panel, and keeps the px-5 rhythm on title, body and footer', () => {
    render(
      <Dialog open title="Export" onClose={vi.fn()} footer={footer}>
        {body}
      </Dialog>,
    )
    const panel = screen.getByRole('dialog')
    const bodyEl = screen.getByLabelText('First').parentElement!
    const title = document.getElementById(panel.getAttribute('aria-labelledby')!)!
    const footerEl = screen.getByRole('button', { name: 'Done' }).parentElement!
    expect(bodyEl.parentElement, 'the body is a direct child of the panel').toBe(panel)
    const bodyClass = bodyEl.className.split(/\s+/)
    expect(bodyClass, 'the body is the scroll container').toContain('overflow-y-auto')
    expect(bodyClass, 'a flick past the end must not scroll the deck behind').toContain(
      'overscroll-contain',
    )
    expect(bodyClass, 'it shrinks inside the capped panel instead of growing it').toContain(
      'min-h-0',
    )
    expect(
      panel.className.split(/\s+/).filter((c) => c.startsWith('overflow')),
      'the panel does not scroll — its title and footer stay put',
    ).toEqual([])
    for (const [name, el] of [
      ['title', title],
      ['body', bodyEl],
      ['footer', footerEl],
    ] as const) {
      expect(el.className.split(/\s+/), `${name} keeps §4.8's px-5 rhythm`).toContain('px-5')
    }
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
