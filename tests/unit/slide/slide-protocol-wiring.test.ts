import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * `protocol.ts` is the file that holds the milestone's security configuration — the scheme
 * privileges, the response wiring, the IPC validation, and the renderer-teardown hooks — and it was
 * the one file the suite could not reach: it imports `electron` at module scope, so a plain import
 * threw before any assertion. An independent review mutation-tested it and found seven mutants
 * surviving a fully green run, including **dropping the `headers` from the served `Response`**, which
 * ships every slide with no CSP header.
 *
 * `vi.mock('electron')` closes that. `WebContents` is a type-only import in the module under test, so
 * it erases and nothing but `protocol`/`ipcMain` needs a fake. `installSlideProtocol` already takes
 * an injectable registry, so there is no production restructuring — the seam was there.
 */
const mocks = vi.hoisted(() => ({
  registerSchemesAsPrivileged: vi.fn(),
  protocolHandle: vi.fn(),
  ipcHandle: vi.fn(),
}))

vi.mock('electron', () => ({
  protocol: {
    registerSchemesAsPrivileged: mocks.registerSchemesAsPrivileged,
    handle: mocks.protocolHandle,
  },
  ipcMain: { handle: mocks.ipcHandle },
}))

const { installSlideProtocol, registerSlideSchemePrivileges } =
  await import('../../../src/main/slide/protocol')
const { SlideRegistry } = await import('../../../src/main/slide/registry')
const { SLIDE_PUBLISH_CHANNEL, SLIDE_REVOKE_CHANNEL } =
  await import('../../../src/shared/ipc-contract')
const { SLIDE_CSP, SLIDE_SCHEME, isSlideDocumentId, slideDocumentUrl } =
  await import('../../../src/shared/slide-protocol')

type Listener = (...args: unknown[]) => void

/** A stand-in `WebContents`: a stable id plus an `on` that records every listener by event name. */
function fakeSender(id: number): {
  id: number
  on: ReturnType<typeof vi.fn>
  listeners: Map<string, Listener[]>
  emit: (event: string, ...args: unknown[]) => void
} {
  const listeners = new Map<string, Listener[]>()
  const on = vi.fn((event: string, listener: Listener) => {
    const bucket = listeners.get(event) ?? []
    bucket.push(listener)
    listeners.set(event, bucket)
  })
  return {
    id,
    on,
    listeners,
    emit: (event, ...args) => {
      for (const listener of listeners.get(event) ?? []) listener(...args)
    },
  }
}

type ProtocolHandler = (request: { url: string; method?: string }) => Response
type IpcHandler = (
  event: { sender: unknown },
  payload: unknown,
) => { id?: string; revoked?: boolean }

/** Reset the fakes, install against a fresh registry, and hand back the captured callbacks. */
function install(registry = new SlideRegistry()): {
  registry: InstanceType<typeof SlideRegistry>
  protocolHandler: ProtocolHandler
  publish: IpcHandler
  revoke: IpcHandler
} {
  mocks.protocolHandle.mockClear()
  mocks.ipcHandle.mockClear()
  installSlideProtocol(registry)

  const protocolHandler = mocks.protocolHandle.mock.calls.at(-1)?.[1] as ProtocolHandler
  const byChannel = new Map<string, IpcHandler>(
    mocks.ipcHandle.mock.calls.map((call) => [call[0] as string, call[1] as IpcHandler]),
  )
  return {
    registry,
    protocolHandler,
    publish: byChannel.get(SLIDE_PUBLISH_CHANNEL)!,
    revoke: byChannel.get(SLIDE_REVOKE_CHANNEL)!,
  }
}

afterEach(() => {
  vi.clearAllMocks()
})

describe('registerSlideSchemePrivileges', () => {
  beforeEach(() => {
    mocks.registerSchemesAsPrivileged.mockClear()
  })

  /**
   * The whole privileges object, asserted literally — the cheapest way to pin all of the security
   * negatives at once. `bypassCSP`, `supportFetchAPI`, `corsEnabled` and `allowServiceWorkers` are
   * defence in depth rather than the operative boundary (the slide's own CSP is), but a silent flip
   * of any of them is exactly the kind of drift a literal assertion exists to catch.
   */
  it('registers the scheme with the exact privilege set', () => {
    registerSlideSchemePrivileges()

    expect(mocks.registerSchemesAsPrivileged).toHaveBeenCalledWith([
      {
        scheme: SLIDE_SCHEME,
        privileges: {
          standard: true,
          secure: true,
          supportFetchAPI: false,
          corsEnabled: false,
          bypassCSP: false,
          allowServiceWorkers: false,
          stream: false,
        },
      },
    ])
  })
})

describe('the slide:// response handler', () => {
  it('serves a published document as a 200 carrying the CSP header', async () => {
    const { registry, protocolHandler } = install()
    const result = registry.publish('<!doctype html><html><body>hi</body></html>')
    if (!result.ok) throw new Error('publish failed')

    const response = protocolHandler({ url: slideDocumentUrl(result.id), method: 'GET' })

    expect(response.status).toBe(200)
    // The mutant the review flagged sharpest: dropping `headers` from the Response ships slides with
    // no policy at all and passed every prior test. This is what kills it.
    expect(response.headers.get('Content-Security-Policy')).toBe(SLIDE_CSP)
    expect(response.headers.get('Content-Type')).toBe('text/html; charset=utf-8')
    expect(await response.text()).toContain('hi')
  })

  it('404s an unknown id', () => {
    const { protocolHandler } = install()
    const response = protocolHandler({ url: slideDocumentUrl('a'.repeat(32)), method: 'GET' })

    expect(response.status).toBe(404)
    expect(response.headers.get('Content-Security-Policy')).toBeNull()
  })
})

describe('the publish IPC handler', () => {
  it('publishes a valid document and returns its id', () => {
    const { registry, publish } = install()
    const sender = fakeSender(1)

    const response = publish({ sender }, { html: '<html>x</html>' })

    expect(isSlideDocumentId(response.id)).toBe(true)
    expect(registry.get(response.id!)).toBe('<html>x</html>')
  })

  /**
   * The owner-threading mutant: drop the `event.sender.id` argument and every document publishes as
   * `UNOWNED`, so `revokeOwner` reclaims nothing and the aggregate budget fills forever. Pinned by
   * publishing as sender 1 and proving the document is owned by 1 — a revoke as sender 2 is refused,
   * a revoke as sender 1 succeeds.
   */
  it('scopes the published document to the sender', () => {
    const { registry, publish } = install()
    const response = publish({ sender: fakeSender(1) }, { html: '<html>owned</html>' })

    expect(registry.revoke(response.id, 2)).toBe(false)
    expect(registry.revoke(response.id, 1)).toBe(true)
  })

  it.each([
    ['a non-string html', { html: 42 }],
    ['a missing html', {}],
    ['a null payload', null],
    ['an oversized html', { html: 'a'.repeat(64 * 1024 * 1024 + 1) }],
  ])('throws on %s', (_label, payload) => {
    const { publish } = install()
    expect(() => publish({ sender: fakeSender(1) }, payload)).toThrow()
  })
})

describe('the revoke IPC handler', () => {
  it('revokes a document the same sender published', () => {
    const { publish, revoke } = install()
    const sender = fakeSender(1)
    const { id } = publish({ sender }, { html: '<html>x</html>' })

    expect(revoke({ sender }, { id }).revoked).toBe(true)
  })

  it('refuses to revoke another sender document', () => {
    const { registry, publish, revoke } = install()
    const { id } = publish({ sender: fakeSender(1) }, { html: '<html>x</html>' })

    expect(revoke({ sender: fakeSender(2) }, { id }).revoked).toBe(false)
    expect(registry.get(id!)).toBe('<html>x</html>')
  })

  it.each([
    ['a malformed id', { id: 'nope' }],
    ['a missing id', {}],
    ['a null payload', null],
  ])('throws on %s', (_label, payload) => {
    const { revoke } = install()
    expect(() => revoke({ sender: fakeSender(1) }, payload)).toThrow()
  })
})

describe('renderer teardown', () => {
  /**
   * The confirmed defect this replaces: `did-start-navigation` fired for navigations that never
   * committed (a `will-navigate` block, an anchor click), wiping the whole registry while the page
   * stayed put. The fix keys teardown on `did-navigate`, which fires only after a main-frame
   * navigation commits — so a blocked navigation must NOT have been registered as a drop trigger.
   */
  it('hooks committed navigation, destruction and crash — never did-start-navigation', () => {
    const { publish } = install()
    const sender = fakeSender(1)
    publish({ sender }, { html: '<html>x</html>' })

    expect([...sender.listeners.keys()].toSorted()).toEqual([
      'destroyed',
      'did-navigate',
      'render-process-gone',
    ])
    expect(sender.listeners.has('did-start-navigation')).toBe(false)
  })

  it('drops a committed navigation, and only the navigating renderer', () => {
    const { registry, publish } = install()
    const one = fakeSender(1)
    const two = fakeSender(2)
    publish({ sender: one }, { html: '<html>one</html>' })
    const kept = publish({ sender: two }, { html: '<html>two</html>' })
    expect(registry.size).toBe(2)

    one.emit('did-navigate')

    expect(registry.size).toBe(1)
    expect(registry.get(kept.id!)).toBe('<html>two</html>')
  })

  it('drops on destruction and on a crashed render process', () => {
    for (const event of ['destroyed', 'render-process-gone']) {
      const { registry, publish } = install()
      const sender = fakeSender(1)
      publish({ sender }, { html: '<html>x</html>' })
      expect(registry.size).toBe(1)

      sender.emit(event)

      expect(registry.size).toBe(0)
    }
  })

  it('registers the teardown hooks once per renderer across many publishes', () => {
    const { publish } = install()
    const sender = fakeSender(1)
    publish({ sender }, { html: '<html>a</html>' })
    publish({ sender }, { html: '<html>b</html>' })
    publish({ sender }, { html: '<html>c</html>' })

    // One listener per event, not one per publish — otherwise a busy renderer accumulates handlers.
    expect(sender.listeners.get('did-navigate')).toHaveLength(1)
  })
})
