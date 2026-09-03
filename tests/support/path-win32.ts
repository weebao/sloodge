/**
 * Windows path shim, used only by `vitest.win32.config.ts`.
 *
 * `pnpm test:win-paths` aliases `node:path`/`path` to this module, so every `path.join` in `src/`
 * and in the tests behaves as it does on `windows-latest` — backslash separators, drive-letter
 * semantics — while still running on Linux.
 *
 * Why this exists: M9.0's release job runs `pnpm test` on a Windows runner, and a suite that has
 * only ever run on Linux can hide assertions comparing `path.join` output against forward-slash
 * literals. That class reds the release job before packaging is reached. The `core.autocrlf=true`
 * clone used to validate the CRLF fix reproduces line endings faithfully but is *structurally*
 * blind to `path.sep`, so it could never have caught this. This shim is the missing half.
 *
 * NOTE the `createRequire` dance. A plain `import path from 'node:path'` here would be rewritten by
 * the very alias this module implements, so the shim would import *itself*, and every consumer got
 * `undefined`. `createRequire` resolves through Node directly, bypassing Vite's alias entirely.
 */
import { createRequire } from 'node:module'
import type nodePathType from 'node:path'

const nodePath = createRequire(import.meta.url)('node:path') as typeof nodePathType

export const {
  basename,
  delimiter,
  dirname,
  extname,
  format,
  isAbsolute,
  join,
  normalize,
  parse,
  relative,
  resolve,
  sep,
  toNamespacedPath,
} = nodePath.win32

export const posix = nodePath.posix
export const win32 = nodePath.win32
export default nodePath.win32
