/**
 * Persistence for the spend cap (M2.5, §10). Driven against an in-memory filesystem — no temp dirs,
 * no `electron` — because everything interesting here is about what happens to a file that is
 * missing, malformed, or written by a different version.
 */

import { describe, expect, it, vi } from 'vitest'
import {
  createBudgetStore,
  parseBudgetFile,
  serializeBudgetFile,
  type BudgetFs,
} from '../../../src/main/agent/budget-store'
import { DEFAULT_BUDGET_CAP_USD } from '../../../src/shared/agent/budget'

const PATH = '/userData/budget.json'

function memoryFs(initial?: string): BudgetFs & { files: Map<string, string> } {
  const files = new Map<string, string>()
  if (initial !== undefined) files.set(PATH, initial)
  return {
    files,
    readFile: async (file) => {
      const value = files.get(file)
      if (value === undefined) throw new Error('ENOENT')
      return value
    },
    writeFile: async (file, data) => {
      files.set(file, data)
    },
    rename: async (from, to) => {
      const value = files.get(from)
      if (value === undefined) throw new Error('ENOENT')
      files.delete(from)
      files.set(to, value)
    },
  }
}

const store = (fs: BudgetFs) => createBudgetStore({ fs, resolvePath: () => PATH })

describe('parseBudgetFile', () => {
  it('reads a stored cap', () => {
    expect(parseBudgetFile('{"capUsd": 5}')).toBe(5)
  })

  it('honours an explicit null — the user choosing no limit must survive the round trip', () => {
    expect(parseBudgetFile('{"capUsd": null}')).toBeNull()
  })

  it('defaults rather than throwing on anything unusable', () => {
    // A preferences file is not a trust boundary worth failing the app over, and the failure mode of
    // a budget guard must never be "the chat box does not work".
    for (const raw of ['', 'not json', '[]', 'null', '{}', '{"capUsd": "5"}', '{"capUsd": -1}']) {
      expect(parseBudgetFile(raw)).toBe(DEFAULT_BUDGET_CAP_USD)
    }
  })

  it('round-trips through serialize', () => {
    for (const cap of [2, 12.5, null]) {
      expect(parseBudgetFile(serializeBudgetFile(cap))).toBe(cap)
    }
  })
})

describe('createBudgetStore', () => {
  it('starts at the documented default when nothing is stored', async () => {
    expect(await store(memoryFs()).load()).toBe(DEFAULT_BUDGET_CAP_USD)
  })

  it('reads a persisted cap back', async () => {
    expect(await store(memoryFs('{"capUsd": 7.5}')).load()).toBe(7.5)
  })

  it('persists through a scratch file and a rename, never a torn in-place write', async () => {
    const fs = memoryFs()
    const s = store(fs)
    expect(await s.save(4)).toBe(4)
    expect(fs.files.get(PATH)).toContain('"capUsd": 4')
    // The scratch file is gone: a crash leaves the old cap or the new one, never a half-file.
    expect(fs.files.has(`${PATH}.tmp`)).toBe(false)
    expect(await store(fs).load()).toBe(4)
  })

  it('persists "no limit" as null rather than as an absent field', async () => {
    const fs = memoryFs()
    await store(fs).save(null)
    expect(await store(fs).load()).toBeNull()
  })

  it('caches after the first read — the send path consults this on every turn', async () => {
    const fs = memoryFs('{"capUsd": 3}')
    const readFile = vi.fn(fs.readFile)
    const s = store({ ...fs, readFile })
    expect(await s.load()).toBe(3)
    expect(await s.load()).toBe(3)
    expect(readFile).toHaveBeenCalledTimes(1)
  })

  it('serves a saved cap from the cache without re-reading', async () => {
    const fs = memoryFs()
    const s = store(fs)
    await s.save(9)
    // Corrupt the file behind the store's back; `save` is the only writer in the process, so the
    // cache is authoritative and must not be invalidated by an external edit we do not expect.
    fs.files.set(PATH, 'garbage')
    expect(await s.load()).toBe(9)
  })

  it('propagates a write failure instead of silently reporting success', async () => {
    const fs = memoryFs()
    const failing: BudgetFs = {
      ...fs,
      writeFile: async () => {
        throw new Error('EACCES')
      },
    }
    await expect(store(failing).save(5)).rejects.toThrow('EACCES')
  })
})
