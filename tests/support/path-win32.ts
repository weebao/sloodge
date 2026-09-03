/**
 * Windows path shim, used only by `vitest.win32.config.ts`, which explains why the simulation
 * exists. Aliasing `node:path`/`path` here makes every `path.join` in `src/` and in the tests
 * behave as it does on `windows-latest` while still running on Linux.
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
