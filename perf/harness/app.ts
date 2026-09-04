/**
 * Launch the built app and attach both debuggers.
 *
 * Every launch gets a **fresh `--user-data-dir`** in a temp directory. Two reasons, both of which
 * would otherwise corrupt a measurement: Electron's `requestSingleInstanceLock()` makes a second
 * launch quit silently if the developer already has Sloodge open, and a warm profile carries a
 * Chromium code cache and GPU shader cache that make the second cold start of a session materially
 * faster than the first.
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { assertBundleBuiltFromSource } from './bundle'
import { CdpClient, waitForTarget } from './cdp'

export type LaunchedApp = {
  readonly process: ChildProcess
  /** The renderer's CDP session. */
  readonly page: CdpClient
  /** The main process's Node-inspector session. */
  readonly main: CdpClient
  /** `Date.now()` captured immediately after `spawn` — the cold-start clock's zero. */
  readonly spawnedAtMs: number
  /**
   * Throws if the app process has exited. Passed to every polling wait so a crashed app fails the
   * run immediately, with the app's own output, instead of timing out minutes later.
   */
  assertAlive(): void
  dispose(): Promise<void>
}

/** Raised when the app process dies during a session. Carries the app's output for diagnosis. */
export class AppExitedError extends Error {
  readonly code: number | null
  readonly signal: NodeJS.Signals | null

  constructor(code: number | null, signal: NodeJS.Signals | null, output: string) {
    super(
      `The app exited during the session (code=${String(code)} signal=${String(signal)}). ` +
        `This is usually the OOM killer on a large deck — one renderer process per slide is the ` +
        `current architecture (see perf/README.md).\n--- app output (tail) ---\n${output.slice(-3000)}`,
    )
    this.name = 'AppExitedError'
    this.code = code
    this.signal = signal
  }
}

export type LaunchOptions = {
  readonly repoRoot: string
  readonly cdpPort: number
  readonly inspectPort: number
  /** WSLg's X socket. The ambient DISPLAY on this machine points at a VcXsrv that is not running. */
  readonly display: string
  readonly timeoutMs?: number
}

/** Resolve the Electron binary the way the `electron` package intends (it stores a `path.txt`). */
export function electronBinaryPath(repoRoot: string): string {
  const nodeRequire = createRequire(`${repoRoot}/`)
  const resolved: unknown = nodeRequire('electron')
  if (typeof resolved !== 'string') {
    throw new Error('The electron package did not resolve to a binary path')
  }
  return resolved
}

export async function launchApp(options: LaunchOptions): Promise<LaunchedApp> {
  const { repoRoot, cdpPort, inspectPort, display, timeoutMs = 60_000 } = options
  // Before anything is spawned: `out/` has to be what `src/` says, or the measurement describes
  // code nobody is reviewing.
  await assertBundleBuiltFromSource(repoRoot)
  const userDataDir = await mkdtemp(join(tmpdir(), 'sloodge-perf-'))
  const binary = electronBinaryPath(repoRoot)

  let stderrBuffer = ''
  const spawnedAtMs = Date.now()
  const child = spawn(
    binary,
    [
      `--remote-debugging-port=${String(cdpPort)}`,
      `--inspect=${String(inspectPort)}`,
      `--user-data-dir=${userDataDir}`,
      join(repoRoot, 'out', 'main', 'index.js'),
    ],
    {
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, DISPLAY: display },
    },
  )
  child.stdout?.on('data', (chunk: Buffer) => {
    stderrBuffer += chunk.toString()
  })
  child.stderr?.on('data', (chunk: Buffer) => {
    stderrBuffer += chunk.toString()
  })

  const dispose = async (): Promise<void> => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL')
      await sleep(400)
    }
    await rm(userDataDir, { recursive: true, force: true }).catch(() => {
      // A profile dir that will not delete is a temp-dir leak, not a failed measurement.
    })
  }

  try {
    const mainTarget = await waitForTarget(inspectPort, (t) => t.type === 'node', timeoutMs)
    const pageTarget = await waitForTarget(cdpPort, (t) => t.type === 'page', timeoutMs)
    const main = await CdpClient.connect(mainTarget.webSocketDebuggerUrl ?? '')
    const page = await CdpClient.connect(pageTarget.webSocketDebuggerUrl ?? '')
    await main.send('Runtime.enable')
    await page.send('Runtime.enable')
    await page.send('Page.enable')
    await page.send('Performance.enable')

    return {
      process: child,
      page,
      main,
      spawnedAtMs,
      assertAlive: () => {
        if (child.exitCode !== null || child.signalCode !== null) {
          throw new AppExitedError(child.exitCode, child.signalCode, stderrBuffer)
        }
      },
      dispose: async () => {
        main.close()
        page.close()
        await dispose()
      },
    }
  } catch (error) {
    await dispose()
    throw new Error(
      `Could not attach to the app: ${error instanceof Error ? error.message : String(error)}\n--- app output ---\n${stderrBuffer.slice(0, 4000)}`,
      { cause: error },
    )
  }
}
