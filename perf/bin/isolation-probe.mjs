#!/usr/bin/env node
/** Thin shim: load the isolation probe through Vite's SSR runner and hand it argv. */
import { loadTs } from './_load.mjs'

const { mod, close } = await loadTs(process.cwd(), '/perf/cli/isolation-probe.ts')
try {
  await mod.main(process.argv.slice(2))
} finally {
  await close()
}
