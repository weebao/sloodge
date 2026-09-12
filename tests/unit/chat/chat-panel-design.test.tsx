/**
 * @vitest-environment happy-dom
 *
 * M8b.3 surface 1 (ui-design-audit.md §4.4, §7 row 1): the chat panel stays on the role tokens and
 * the M8b.2 primitives, the six findings it closed — U2, U4, U10, U12, U13, U18 — stay closed, and
 * the one behaviour change the surface carried (M8b.0 §3.2 #12, the live region) stays landed.
 *
 * Two halves, because neither can see the other's regression:
 *
 *  - **The file gate, run as a test** — `tests/unit/design/migrated-files-check.test.ts` spawns
 *    `node scripts/design-inventory.mjs --check` once over every migrated file, `ChatPanel.tsx`
 *    among them, so a retired token, a `dark:` twin, a palette colour, an alpha suffix or an
 *    arbitrary value coming back reds `pnpm test` (a `.ts` file, because `.tsx` tests are
 *    typechecked under the web tsconfig, which has no Node types to spawn with).
 *  - **The rendered class of each finding's element.** The gate cannot see a *role* token that is
 *    the wrong role: `bg-surface` on the composer instead of `bg-field` is U2 back at 1.04:1 with
 *    every column still 0, `border-line` instead of `border-line-strong` is U4 back at 1.27:1, and
 *    a deleted `FOCUS_RING` is U10 back with no ring at all. So each element is rendered and its
 *    class list read — the same shape as `focus-ring.test.tsx`, for the same reason.
 *
 * **What this file pins, exactly:** the six §3.1 rows above, each on the one element the row names,
 * plus the live-region shape. **What it knowingly does not catch** — wrong-role regressions on
 * elements that are not a §3.1 row escape both halves, and were shown to in review: the empty
 * context pill `border-line-strong` → `border-line` (a U5 site; 3.79 → 1.27 on the panel), the
 * assistant bubble `bg-surface-raised` → `bg-surface` (work-list item 3; only `shadow-raised`'s ring
 * would then separate it from the panel), and Send `variant="primary"` → `"secondary"`. Each keeps
 * `--check` green and this file green. They are outside the six findings this guard is named for;
 * a later pass that wants them pinned adds a row per element here, not a wider assertion.
 *
 * Mutations, each run on this branch: `bg-field` → `bg-surface` (U2), `border-line-strong` →
 * `border-line` (U4), `${FOCUS_RING}` → `focus:border-accent` (U10), the context chip's
 * `tone="accent"` → `"neutral"` (U12), the gate's `border-accent` → `border-line` (U13), the error
 * notice's `tone="danger"` → `"warning"` (U18) — each reds its row here while `--check` stays green;
 * `bg-surface` → `bg-surface dark:bg-ink` on the aside reds the shared gate's `ChatPanel.tsx` row
 * (`legacy = 1, dark: = 1`, `RESULT: FAIL (2)`). Live region: deleting `aria-busy={streaming}` and
 * the announcer paragraph together reds the #12 case on the explicit-`aria-live` count (`expected
 * +0 to be 1` — the announcer was the one) and the outcome case on `aria-busy` (`expected null to
 * be 'false'`); putting `aria-live="polite"` back on the log reds the count the other way
 * (`expected 2 to be 1`); restoring the `streaming`-only derivation reds the outcome case on Stop
 * (`expected 'Claude has finished responding' to be 'Response stopped'`). Before these two cases,
 * review deleted the whole change and `tests/unit/chat` + `tests/unit/design` stayed at 2488 passed.
 *
 * What neither half can show: that the tokens paint the ratios the audit measured. happy-dom applies
 * no stylesheet; the values are the census's business (`--check`, rows 40–48), not this file's.
 */

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChatPanel } from '../../../src/renderer/src/features/chat/ChatPanel'
import { useChatContextStore } from '../../../src/renderer/src/features/chat/chatContextStore'
import { createStarterDeck, useDeckStore } from '../../../src/renderer/src/stores/deckStore'
import { useAuthStore } from '../../../src/renderer/src/stores/authStore'
import type { AgentBridge } from '../../../src/preload/agentBridge'
import type { AgentEvent, ApiKeyStatus } from '../../../src/shared/agent/types'
import type { AuthStatus } from '../../../src/shared/agent/auth'
import { DEFAULT_ENDPOINT } from '../../../src/shared/agent/endpoint'
import { buildSlideMap } from '../../../src/shared/design/slide-map'
import {
  buildElementContextBundle,
  type ElementContextBundle,
} from '../../../src/shared/design/element-context'

/** Written out, not imported from `focusRing.ts`: the assertion must not track the drift it guards. */
const RING = [
  'focus-visible:outline-2',
  'focus-visible:outline-focus',
  'focus-visible:outline-offset-2',
] as const

const KEY_SET: ApiKeyStatus = { configured: true, last4: 'aXY9' }
const KEY_UNSET: ApiKeyStatus = { configured: false, last4: null }
const CONFIGURED: AuthStatus = {
  mode: 'api-key',
  apiKey: KEY_SET,
  subscription: KEY_UNSET,
  endpoint: DEFAULT_ENDPOINT,
}
const NO_AUTH: AuthStatus = {
  mode: 'not-configured',
  apiKey: KEY_UNSET,
  subscription: KEY_UNSET,
  endpoint: DEFAULT_ENDPOINT,
}
const NOW = 1_700_000_000_000

type Emit = (event: AgentEvent) => void

function makeFakeBridge(status: AuthStatus): { bridge: AgentBridge; emit: Emit } {
  const listeners = new Set<(e: AgentEvent) => void>()
  const bridge: AgentBridge = {
    setApiKey: vi.fn(async () => KEY_SET),
    clearApiKey: vi.fn(async () => KEY_UNSET),
    getApiKeyStatus: vi.fn(async () => status.apiKey),
    setSubscriptionToken: vi.fn(async () => status),
    clearSubscriptionToken: vi.fn(async () => status),
    getAuthStatus: vi.fn(async () => status),
    sendMessage: vi.fn(async () => ({ accepted: true, reason: null })),
    interrupt: vi.fn(async () => true),
    onAgentEvent: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    onDeckUpdated: () => () => undefined,
    onAgentEditRequest: () => () => undefined,
    sendAgentEditResult: () => undefined,
    getBudgetCap: vi.fn(async () => 2),
    setBudgetCap: vi.fn(async (cap: number | null) => cap),
  }
  const emit: Emit = (event) => {
    act(() => {
      for (const listener of listeners) listener(event)
    })
  }
  return { bridge, emit }
}

const HTML =
  '<section class="slide"><div class="card"><h3 class="card-title">Q3 Revenue</h3></div></section>'

function h3Bundle(): ElementContextBundle {
  const id = useDeckStore.getState().currentSlideId ?? 's04'
  const map = buildSlideMap(id, HTML)
  let slId = ''
  for (const [sid, span] of map.byId) if (span.tagName === 'h3') slId = sid
  const bundle = buildElementContextBundle({
    map,
    slId,
    slide: { index: 3, title: 'Q3 Revenue' },
    computedStyles: { color: '#0f172a' },
    rect: { x: 10, y: 20, width: 320, height: 84 },
  })
  if (bundle === null) throw new Error('bundle build failed')
  return bundle
}

const composer = (): HTMLTextAreaElement =>
  screen.getByPlaceholderText('Ask Claude…') as HTMLTextAreaElement
const classes = (el: Element): string[] => el.className.split(/\s+/).filter(Boolean)
function ancestors(el: Element): Element[] {
  const out: Element[] = []
  for (let e = el.parentElement; e !== null; e = e.parentElement) out.push(e)
  return out
}

async function mountConfigured(status: AuthStatus): Promise<Emit> {
  const { bridge, emit } = makeFakeBridge(status)
  window.sloodge = { onMenuAction: () => () => undefined, agent: bridge }
  render(<ChatPanel />)
  await waitFor(() => expect(useAuthStore.getState().loaded).toBe(true))
  return emit
}

beforeEach(() => {
  act(() => useDeckStore.setState(createStarterDeck(NOW)))
  act(() => useChatContextStore.getState().clear())
  act(() => useAuthStore.getState().reset())
})

afterEach(() => {
  cleanup()
  act(() => useChatContextStore.getState().clear())
  delete window.sloodge
  vi.restoreAllMocks()
})

describe('M8b.3 surface 1 — the chat panel on the design tokens', () => {
  it('U2 / U4 / U10 — the composer is a field with a strong border and the one focus ring', async () => {
    await mountConfigured(CONFIGURED)
    await waitFor(() => expect(composer().disabled).toBe(false))
    const klass = classes(composer())
    expect(klass, 'U2: field fill vs panel is identified by bg-field').toContain('bg-field')
    expect(klass, 'U4: a control border is line-strong (3.95 / 3.76 on field)').toContain(
      'border-line-strong',
    )
    for (const part of RING) expect(klass, `U10: composer is missing ${part}`).toContain(part)
    expect(
      klass.filter((c) => c.startsWith('focus:')),
      'U10: `focus:` recipes were the 2.91:1 ring; only focus-visible: survives (R6)',
    ).toEqual([])
  })

  it('U12 — the context chip is the accent tint with no border of its own', async () => {
    await mountConfigured(CONFIGURED)
    act(() => useChatContextStore.getState().attach(h3Bundle()))
    const chip = screen.getByTestId('chat-context-chip').firstElementChild
    expect(chip).not.toBeNull()
    const klass = classes(chip!)
    expect(klass, 'U12: the chip is bg-accent-soft (15.03 / 10.03 under text)').toContain(
      'bg-accent-soft',
    )
    expect(
      klass.filter((c) => c.startsWith('border')),
      'U12: `border-accent/50` was 2.17 / 1.67; a label chip has no border (R4)',
    ).toEqual([])
  })

  it('U13 — the auth gate is the accent tint with a full-strength accent border', async () => {
    await mountConfigured(NO_AUTH)
    const button = await screen.findByRole('button', { name: 'Open Settings' })
    const gate = ancestors(button).find((e) => classes(e).includes('border'))
    expect(gate, 'the gate box carries a border').toBeDefined()
    const klass = classes(gate!)
    expect(klass, 'U13: border-accent (4.52 / 3.87 on the tint)').toContain('border-accent')
    expect(klass, 'U13: bg-accent-soft, not bg-accent/5').toContain('bg-accent-soft')
    expect(
      klass.filter((c) => c.includes('/')),
      'U13: `border-accent/40 bg-accent/5` was 1.84 / 1.47',
    ).toEqual([])
  })

  it('U18 — the error bubble is the danger Notice', async () => {
    const emit = await mountConfigured(CONFIGURED)
    await waitFor(() => expect(composer().disabled).toBe(false))
    fireEvent.change(composer(), { target: { value: 'build it' } })
    fireEvent.click(screen.getByRole('button', { name: /send/i }))
    emit({ type: 'error', kind: 'auth', message: '401', recoverable: false })
    const klass = classes(screen.getByRole('alert'))
    expect(klass, 'U18: border-danger (5.88 / 5.58 on its tint)').toContain('border-danger')
    expect(klass, 'U18: bg-danger-soft, not red-50 / red-950').toContain('bg-danger-soft')
  })

  it('M8b.0 §3.2 #12 — the log is aria-busy while a turn streams and one stable region announces its boundaries', async () => {
    const emit = await mountConfigured(CONFIGURED)
    await waitFor(() => expect(composer().disabled).toBe(false))
    const log = screen.getByRole('log')
    // The item's first half is a removal: `role="log"` is polite already, and an explicit
    // `aria-live` on top of it is the per-delta re-read. So the panel carries exactly one explicit
    // live attribute, on the `sr-only` announcer — which is also how the announcer is found.
    const live = screen.getByLabelText('Chat').querySelectorAll('[aria-live]')
    expect(live.length, '#12: the log must not carry its own aria-live').toBe(1)
    const announcer = live[0]!
    expect(announcer).not.toBe(log)
    expect(announcer.getAttribute('aria-live')).toBe('polite')
    expect(classes(announcer)).toContain('sr-only')
    expect(log.getAttribute('aria-busy'), 'idle before the first turn').toBe('false')
    expect(announcer.textContent, 'mount says nothing').toBe('')

    fireEvent.change(composer(), { target: { value: 'build it' } })
    fireEvent.click(screen.getByRole('button', { name: /send/i }))
    expect(log.getAttribute('aria-busy'), '#12: aria-busy holds the log while it streams').toBe(
      'true',
    )
    expect(announcer.textContent).toBe('Claude is responding')

    emit({ type: 'turn-end', snapshotUsd: 0, generation: 0, subtype: 'success' })
    expect(log.getAttribute('aria-busy'), '#12: the log is released when the turn settles').toBe(
      'false',
    )
    expect(announcer.textContent).toBe('Claude has finished responding')
  })

  it('the announcer says how the turn ended: Stop is not a finish, and a failed turn leaves the alert to speak', async () => {
    const emit = await mountConfigured(CONFIGURED)
    await waitFor(() => expect(composer().disabled).toBe(false))
    const announcer = screen.getByLabelText('Chat').querySelector('[aria-live]')!
    const send = (): void => {
      fireEvent.change(composer(), { target: { value: 'build it' } })
      fireEvent.click(screen.getByRole('button', { name: /send/i }))
    }

    send()
    fireEvent.click(screen.getByRole('button', { name: /stop/i }))
    expect(screen.getByRole('log').getAttribute('aria-busy')).toBe('false')
    expect(
      announcer.textContent,
      'Stop settles the turn with no bubble; this is its only cue',
    ).toBe('Response stopped')

    send()
    expect(announcer.textContent).toBe('Claude is responding')
    emit({ type: 'error', kind: 'auth', message: '401', recoverable: false })
    expect(screen.getByRole('log').getAttribute('aria-busy')).toBe('false')
    expect(screen.getByRole('alert'), 'the error bubble is the announcement').toBeTruthy()
    expect(announcer.textContent, 'a failed turn is not read as a finish, and not read twice').toBe(
      '',
    )
  })
})
