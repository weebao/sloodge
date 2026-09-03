/**
 * Bundle `harness.ts` for Electron's main process and run it: `node tests/fidelity/run.ts [--record]`.
 *
 * The harness imports the shipped `src/main/**` modules, which use extension-less TypeScript
 * imports Node cannot resolve on its own, so it is bundled with vite's build API (already a dev
 * dependency) into `tests/fidelity/out/bundle/harness.mjs` with node_modules left external, then
 * launched under the repo's own Electron binary. This file itself is plain erasable TypeScript so
 * Node 24 runs it directly.
 */

import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..', '..')
const bundleDir = join(here, 'out', 'bundle')

await build({
  configFile: false,
  root,
  logLevel: 'warn',
  build: {
    ssr: join(here, 'harness.ts'),
    outDir: bundleDir,
    emptyOutDir: true,
    target: 'node22',
    minify: false,
    rollupOptions: { output: { format: 'es', entryFileNames: 'harness.mjs' } },
  },
  ssr: { target: 'node' },
})

// `electron`'s CJS entry exports the binary path; the package's types describe the runtime API
// instead, so resolve it through `require` rather than a typed import.
const electronPath = createRequire(import.meta.url)('electron') as string

const child = spawn(
  electronPath,
  [join(bundleDir, 'harness.mjs'), '--root', root, ...process.argv.slice(2)],
  { cwd: root, stdio: 'inherit' },
)
child.on('exit', (code) => {
  process.exitCode = code ?? 1
})
