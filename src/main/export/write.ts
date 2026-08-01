/**
 * Atomic PDF output (M4.2 / 60-export.md §1.4). Everything is written to `<outPath>.partial` and
 * `rename`d into place on success, so a failed or cancelled export never leaves a half-written PDF
 * where the user expects a deck. Mirrors the `.tmp` + `rename` discipline in `document/store.ts`,
 * kept as its own tiny function so it is testable against a real temp dir without a window.
 */

import { open as fsOpen, rename, rm } from 'node:fs/promises'

/** The staging path for `outPath`. Exported so a caller/test can assert nothing is left behind. */
export function partialPathFor(outPath: string): string {
  return `${outPath}.partial`
}

/**
 * Write `bytes` to `outPath` atomically: staging file → fsync → rename. The staging file is removed
 * on any failure, so a full disk or a permission error leaves the user's chosen path untouched
 * rather than holding a truncated file.
 */
export async function writePdfAtomic(outPath: string, bytes: Uint8Array): Promise<void> {
  const partial = partialPathFor(outPath)
  try {
    const handle = await fsOpen(partial, 'w')
    try {
      await handle.writeFile(bytes)
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(partial, outPath)
  } catch (error) {
    await rm(partial, { force: true }).catch(() => undefined)
    throw error
  }
}
