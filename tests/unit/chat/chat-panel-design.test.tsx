/**
 * @vitest-environment happy-dom
 *
 * M8b.3 surface 1 (ui-design-audit.md §4.4, §7 row 1): the chat panel stays on the role tokens and
 * the M8b.2 primitives, and the six findings it closed — U2, U4, U10, U12, U13, U18 — stay closed.
 *
 * Two halves, because neither can see the other's regression:
 *
 *  - **The file gate, run as a test** — `chat-panel-check.test.ts` next door spawns
 *    `node scripts/design-inventory.mjs --check <file>` over this one file, so a retired token, a
 *    `dark:` twin, a palette colour, an alpha suffix or an arbitrary value coming back reds
 *    `pnpm test` (it lives in a `.ts` file because `.tsx` tests are typechecked under the web
 *    tsconfig, which has no Node types to spawn with).
 *  - **The rendered class of each finding's element.** The gate cannot see a *role* token that is
 *    the wrong role: `bg-surface` on the composer instead of `bg-field` is U2 back at 1.04:1 with
 *    every column still 0, `border-line` instead of `border-line-strong` is U4 back at 1.27:1, and
 *    a deleted `FOCUS_RING` is U10 back with no ring at all. So each element is rendered and its
 *    class list read — the same shape as `focus-ring.test.tsx`, for the same reason.
 *
 * Mutations, each run on this branch: `bg-field` → `bg-surface` (U2), `border-line-strong` →
 * `border-line` (U4), `${FOCUS_RING}` → `focus:border-accent` (U10), the context chip's
 * `tone="accent"` → `"neutral"` (U12), the gate's `border-accent` → `border-line` (U13), the error
 * notice's `tone="danger"` → `"warning"` (U18) — each reds its row here while `--check` stays green;
 * `bg-surface` → `bg-surface dark:bg-ink` on the aside reds the sibling's gate row, `RESULT: FAIL (2)`.
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
})
