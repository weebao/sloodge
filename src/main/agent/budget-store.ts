/**
 * Persistence for the spend cap (M2.5, 50-agent-integration.md §10).
 *
 * ## Why here, and not in the vault or the deck
 *
 * Not the **vault**: a budget cap is not a secret. `safeStorage` binds ciphertext to the OS user
 * account, which is exactly right for a credential and exactly wrong for a preference — a user who
 * moves their profile should keep their cap, and a keychain that is unavailable (the rare Linux dev
 * case `KeychainUnavailableError` covers) must not cost them their budget setting.
 *
 * Not the **deck file**, which is where §10 originally put it: the cap governs a *session* meter,
 * and a cap must be scoped at least as wide as the thing it caps. Sloodge has no durable per-deck
 * spend, so a per-deck budget would reset to unspent on every launch and never bind. See
 * `shared/agent/budget.ts` for the full argument; when durable spend lands, the cap moves with it.
 *
 * So: one small JSON file under `userData`, alongside the vault's slot files. Main owns it because
 * main is the process that must hand `maxBudgetUsd` to the SDK; the renderer mirrors it in a store
 * and edits it through IPC, the same shape auth uses.
 *
 * The decisions (parse, default, validation) are pure and live at the top of this file; the
 * `electron`/`fs` binding is the thin tail, injectable so the store is unit-tested against an
 * in-memory fake with no temp dirs.
 */

import { app } from 'electron'
import { readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { DEFAULT_BUDGET_CAP_USD, isBudgetCap, type BudgetCap } from '../../shared/agent/budget'

/** The file's name under `userData`. Sibling of the vault slots, deliberately not inside them. */
export const BUDGET_FILE_NAME = 'budget.json'

/**
 * Read a persisted cap.
 *
 * **Total** — malformed JSON, a missing field, a hostile number, or a file written by a future
 * version all resolve to the default rather than throwing. A preferences file is not a trust
 * boundary worth failing the app over, and the failure mode of a *budget guard* must never be "the
 * chat box does not work": defaulting to $2.00 is both safe and the documented starting value.
 *
 * `null` inside the file is honoured, because that is the user explicitly choosing no limit — the
 * one case where "no cap" must survive a round trip rather than being re-defaulted to $2.00.
 */
export function parseBudgetFile(raw: string): BudgetCap {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return DEFAULT_BUDGET_CAP_USD
    const value = (parsed as { capUsd?: unknown }).capUsd
    if (value === undefined) return DEFAULT_BUDGET_CAP_USD
    return isBudgetCap(value) ? value : DEFAULT_BUDGET_CAP_USD
  } catch {
    return DEFAULT_BUDGET_CAP_USD
  }
}

export function serializeBudgetFile(cap: BudgetCap): string {
  return `${JSON.stringify({ capUsd: cap }, null, 2)}\n`
}

/** The narrow filesystem surface the store needs, so tests supply a fake. */
export type BudgetFs = {
  readFile: (file: string) => Promise<string>
  writeFile: (file: string, data: string) => Promise<void>
  rename: (from: string, to: string) => Promise<void>
}

export const nodeBudgetFs: BudgetFs = {
  readFile: (file) => readFile(file, 'utf8'),
  writeFile: (file, data) => writeFile(file, data, 'utf8'),
  rename: (from, to) => rename(from, to),
}

export type BudgetStore = {
  /** The current cap, read from disk once and cached. Never rejects. */
  load: () => Promise<BudgetCap>
  /** Persist a new cap and return it. Rejects only if the write itself fails. */
  save: (cap: BudgetCap) => Promise<BudgetCap>
}

/**
 * Build a store over an injected filesystem and path.
 *
 * The cap is cached in memory after the first read because `AgentService.send` consults it on every
 * turn — a disk read per keystroke-driven send would be silly, and the cache cannot go stale since
 * `save` is the only writer in the process.
 */
export function createBudgetStore(deps: {
  readonly fs: BudgetFs
  readonly resolvePath: () => string
}): BudgetStore {
  let cached: BudgetCap | undefined
  let writeSeq = 0

  return {
    load: async () => {
      if (cached !== undefined) return cached
      let cap: BudgetCap = DEFAULT_BUDGET_CAP_USD
      try {
        cap = parseBudgetFile(await deps.fs.readFile(deps.resolvePath()))
      } catch {
        // No file yet (first run) or an unreadable one: the default is the right answer for both.
      }
      cached = cap
      return cap
    },

    save: async (cap) => {
      const target = deps.resolvePath()
      // Unique scratch name: only main writes and Settings commits on blur, so overlapping saves are
      // not reachable today — but a fixed `.tmp` would let two of them interleave write/rename and
      // land a half-written file under the real name, which is exactly what write-then-rename exists
      // to prevent.
      writeSeq += 1
      const scratch = `${target}.${String(process.pid)}.${String(writeSeq)}.tmp`
      // Write-then-rename, matching the vault: a crash mid-save leaves the old cap or the new one,
      // never a truncated file that would silently re-default the user's limit on next launch.
      await deps.fs.writeFile(scratch, serializeBudgetFile(cap))
      await deps.fs.rename(scratch, target)
      cached = cap
      return cap
    },
  }
}

let defaultStore: BudgetStore | undefined

/**
 * The app's budget store, resolved lazily so `app.getPath` is read after `app` is ready — the same
 * reason `vault.slotPath` is a function rather than a constant.
 */
export function budgetStore(): BudgetStore {
  defaultStore ??= createBudgetStore({
    fs: nodeBudgetFs,
    resolvePath: () => path.join(app.getPath('userData'), BUDGET_FILE_NAME),
  })
  return defaultStore
}
