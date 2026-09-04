/**
 * Load repo TypeScript from a plain Node process.
 *
 * The perf tooling is written in TypeScript so it is covered by `pnpm typecheck` and by oxlint like
 * the rest of the repo, but there is no `tsx`/`ts-node` in devDependencies and adding one would put
 * a dependency on the CI install path for tooling CI is forbidden to run. Vite is already a
 * devDependency and its SSR module runner resolves the repo's extensionless, `bundler`-resolution
 * imports exactly as the app's own build does — so this is the loader with the smallest footprint
 * and the fewest ways to disagree with production resolution.
 *
 * Local-only by construction: nothing in `.github/workflows` invokes it.
 */

import { createServer } from 'vite'

/**
 * @param {string} root Absolute repo root.
 * @param {string} entry Module path to load, relative to `root` or absolute.
 * @returns {Promise<{ mod: Record<string, unknown>, close: () => Promise<void> }>}
 */
export async function loadTs(root, entry) {
  const server = await createServer({
    configFile: false,
    root,
    logLevel: 'error',
    appType: 'custom',
    server: { middlewareMode: true, hmr: false, watch: null },
    optimizeDeps: { noDiscovery: true },
  })
  try {
    const mod = await server.ssrLoadModule(entry)
    return {
      mod,
      close: async () => {
        await server.close()
      },
    }
  } catch (error) {
    await server.close()
    throw error
  }
}
