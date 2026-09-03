/**
 * A minimal Chrome DevTools Protocol / Node-inspector client.
 *
 * Why hand-rolled rather than Playwright's `_electron.launch()`: the app measured must be the app
 * shipped. Driving it over CDP and the Node inspector needs **no production code change at all** —
 * no `SLOODGE_PERF` env hook in `src/main`, no `window.__deckStore` escape hatch in the renderer, no
 * dev-only branch that could drift from the real startup path. The alternative was a ~150 MB
 * Playwright devDependency on the same install CI runs, for a suite CI is forbidden to run.
 *
 * Node 22+ ships a global `WebSocket`, and CDP is plain JSON-RPC over one socket, so this is ~80
 * lines and zero dependencies.
 *
 * Two endpoints are used, and they are different protocols over the same wire format:
 *  - `--remote-debugging-port` → the **renderer**'s CDP (Runtime, Page, Performance, Tracing).
 *  - `--inspect` → the **main process**'s Node inspector (Runtime only, but with `process` and,
 *    via `process.mainModule.require`, the whole Electron main API).
 */

import { setTimeout as sleep } from 'node:timers/promises'

type PendingCall = {
  readonly resolve: (value: Record<string, unknown>) => void
  readonly reject: (error: Error) => void
}

export type CdpTarget = {
  readonly type: string
  readonly url: string
  readonly title: string
  readonly webSocketDebuggerUrl?: string
}

/** One CDP session over one WebSocket. */
export class CdpClient {
  #nextId = 1
  readonly #pending = new Map<number, PendingCall>()
  readonly #listeners = new Map<string, ((params: Record<string, unknown>) => void)[]>()

  readonly #socket: WebSocket

  private constructor(socket: WebSocket) {
    this.#socket = socket
    socket.addEventListener('message', (event: MessageEvent) => {
      const raw: unknown = typeof event.data === 'string' ? JSON.parse(event.data) : null
      if (raw === null || typeof raw !== 'object') return
      const message = raw as Record<string, unknown>
      const id = message['id']
      if (typeof id === 'number') {
        const call = this.#pending.get(id)
        if (call === undefined) return
        this.#pending.delete(id)
        const error = message['error']
        if (error !== undefined) {
          call.reject(new Error(`CDP error: ${JSON.stringify(error)}`))
        } else {
          call.resolve((message['result'] ?? {}) as Record<string, unknown>)
        }
        return
      }
      const method = message['method']
      if (typeof method === 'string') {
        const params = (message['params'] ?? {}) as Record<string, unknown>
        for (const listener of this.#listeners.get(method) ?? []) listener(params)
      }
    })
  }

  static async connect(webSocketUrl: string): Promise<CdpClient> {
    const socket = new WebSocket(webSocketUrl)
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener('open', () => {
        resolve()
      })
      socket.addEventListener('error', () => {
        reject(new Error(`Could not open a CDP socket at ${webSocketUrl}`))
      })
    })
    return new CdpClient(socket)
  }

  /** Subscribe to a CDP event. Returns an unsubscribe function. */
  on(method: string, listener: (params: Record<string, unknown>) => void): () => void {
    const list = this.#listeners.get(method) ?? []
    list.push(listener)
    this.#listeners.set(method, list)
    return () => {
      const current = this.#listeners.get(method) ?? []
      this.#listeners.set(
        method,
        current.filter((entry) => entry !== listener),
      )
    }
  }

  send(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const id = this.#nextId
    this.#nextId += 1
    this.#socket.send(JSON.stringify({ id, method, params }))
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject })
    })
  }

  /**
   * Evaluate an expression and return its value.
   *
   * The expression is wrapped in `JSON.stringify((() => (expr))())` and returned as a string rather
   * than relying on CDP's `returnByValue` object serializer. That is not stylistic: returning rich
   * objects (`app.getAppMetrics()`) by value from the *main process* inspector intermittently fails
   * with "Promise was collected", because the main process's message loop is Chromium's rather than
   * libuv's and the inspector's serializer can miss its window. Round-tripping through a JSON string
   * is one synchronous call and has been reliable across every run.
   */
  async evaluate<T>(expression: string): Promise<T> {
    const result = await this.send('Runtime.evaluate', {
      expression: `JSON.stringify((() => (${expression}))())`,
      returnByValue: true,
    })
    const details = result['exceptionDetails']
    if (details !== undefined) {
      const exception = (details as Record<string, unknown>)['exception']
      const description =
        exception !== null && typeof exception === 'object'
          ? ((exception as Record<string, unknown>)['description'] ?? JSON.stringify(details))
          : JSON.stringify(details)
      throw new Error(`Evaluation failed: ${String(description)}`)
    }
    const value = (result['result'] ?? {}) as Record<string, unknown>
    const json = value['value']
    if (typeof json !== 'string') return undefined as T
    return JSON.parse(json) as T
  }

  close(): void {
    this.#socket.close()
  }
}

/**
 * Poll a debugger's `/json/list` until a matching target appears.
 *
 * Polling rather than waiting on stdout: the "DevTools listening on…" line is written by Chromium
 * for the renderer port and by Node for the inspector port with different formats and at different
 * times, and on WSLg the renderer target is not immediately listed even once the port accepts.
 */
export async function waitForTarget(
  port: number,
  match: (target: CdpTarget) => boolean,
  timeoutMs = 30_000,
): Promise<CdpTarget> {
  const deadline = Date.now() + timeoutMs
  let lastError = 'no matching target'
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${String(port)}/json/list`)
      const targets = (await response.json()) as CdpTarget[]
      const found = targets.find(
        (target) => match(target) && target.webSocketDebuggerUrl !== undefined,
      )
      if (found !== undefined) return found
      lastError = `targets: ${targets.map((t) => t.type).join(', ') || 'none'}`
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
    }
    await sleep(200)
  }
  throw new Error(`Timed out waiting for a debug target on port ${String(port)} — ${lastError}`)
}

/**
 * Poll an expression in a CDP context until it returns true.
 *
 * `guard` is checked on every tick and is how a dead app surfaces as an error instead of a timeout.
 * Without it, a renderer that the OOM killer took mid-phase looked exactly like a slow one: the
 * evaluate call throws, the `.catch` swallows it as `false`, and the loop polls a corpse until the
 * deadline. That cost a 500-slide run twelve minutes of silence before failing with a message that
 * named the wrong problem.
 */
export async function waitFor(
  client: CdpClient,
  expression: string,
  timeoutMs = 60_000,
  intervalMs = 100,
  guard?: () => void,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    guard?.()
    const ok = await client.evaluate<boolean>(expression).catch(() => false)
    if (ok === true) return
    await sleep(intervalMs)
  }
  guard?.()
  throw new Error(`Timed out after ${String(timeoutMs)} ms waiting for: ${expression}`)
}
