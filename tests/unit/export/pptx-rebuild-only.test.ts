import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * The identity-preservation invariant (research/pptx-export-fidelity.md §5.3):
 *
 * > The structured exporter is only ever reached in `rebuild` mode. Improving it cannot change
 * > `identity` or `patched` output, and no M4.8 change may introduce a call path from an unedited
 * > imported deck into the walker.
 *
 * M4.5 (`src/shared/import/pptx/ledger.ts`, `src/main/export/pptx-roundtrip.ts`) re-emits the
 * retained archive for `identity`, splices parts for `patched`, and returns *no bytes* for `rebuild`
 * so the caller falls back to `buildSlidesPptx`. This file pins that from the exporter's side:
 *
 *  1. **Structurally** — the set of `src/` modules that import the structured exporter (walker,
 *     planner, scorer, orchestrator, writer, pptxgenjs adapter) is an explicit allow-list. Nothing
 *     under `src/*\/import/`, `src/main/document/`, or a round-trip module may appear in it. Adding a
 *     call path from import-side code into the walker reds this without anyone remembering to look.
 *  2. **Behaviourally** — once M4.5's ledger is on `main`, `planRoundTrip` on an unedited deck yields
 *     `identity` (every part passed through) and a text-only edit yields `patched`; neither is
 *     `rebuild`, so neither reaches the fallback. Until then that half is a visible `todo`, not a
 *     green no-op: it imports the ledger by path at runtime so this file compiles on `main` today.
 */

const ROOT = process.cwd()
const SRC_ROOT = join(ROOT, 'src')

/** The structured exporter: importing any of these puts a module in the walker's call graph. */
const STRUCTURED_EXPORTER = [
  'src/shared/export/pptx/walker.ts',
  'src/shared/export/pptx/plan.ts',
  'src/shared/export/pptx/confidence.ts',
  'src/main/export/pptx-export.ts',
  'src/main/export/pptx-writer.ts',
  'src/main/export/safe-pptx.ts',
]

/**
 * The only `src/` modules *outside* the exporter allowed to import it (its own modules import each
 * other freely). `install.ts` is the IPC entry that runs it; `pptx-renderer.ts` reads one predicate
 * (`paintsImage`) from the scorer to decide whether to take a background capture. A round-trip
 * dispatcher that falls back to `buildSlidesPptx` in `rebuild` mode belongs here too, added
 * deliberately, with its `mode === 'rebuild'` guard reviewed — that is the point of the list.
 */
const ALLOWED_EXTERNAL_IMPORTERS = [
  'src/main/export/install.ts',
  'src/main/export/pptx-renderer.ts',
].toSorted()

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full))
    else if (/\.(ts|tsx|mts|cts|js|mjs|cjs)$/.test(entry)) out.push(full)
  }
  return out
}

const IMPORT_SPECIFIER = /(?:from|import)\s*\(?\s*['"`](\.{1,2}\/[^'"`]+)['"`]/g

/** Repo-relative, `/`-separated paths of the local modules `file` imports (extension resolved). */
function localImports(file: string): string[] {
  const source = readFileSync(file, 'utf8')
  const out: string[] = []
  for (const m of source.matchAll(IMPORT_SPECIFIER)) {
    const target = resolve(dirname(file), m[1]!)
    const candidates = [target, `${target}.ts`, `${target}.tsx`, join(target, 'index.ts')]
    const hit = candidates.find((c) => existsSync(c) && statSync(c).isFile())
    if (hit !== undefined) out.push(relative(ROOT, hit).split(sep).join('/'))
  }
  return out
}

/**
 * Every local module reachable from `file` through any chain of imports. The direct-import check
 * above is what the allow-list is stated over; this is what "reaches" means for the import side —
 * `store.ts → pptx-renderer.ts → confidence.ts` is a path into the scorer whether or not the
 * middle hop is allow-listed (M4.8b r1).
 */
function transitiveImports(file: string): Set<string> {
  const seen = new Set<string>()
  const queue = [file]
  while (queue.length > 0) {
    const next = queue.pop()!
    for (const dep of localImports(next)) {
      if (seen.has(dep)) continue
      seen.add(dep)
      queue.push(join(ROOT, dep))
    }
  }
  return seen
}

describe('the structured exporter is reachable only from its allow-listed callers', () => {
  const files = sourceFiles(SRC_ROOT)
  const exporterSet = new Set(STRUCTURED_EXPORTER)

  it('scans a non-trivial tree and every exporter module exists (the grep is not vacuous)', () => {
    expect(files.length).toBeGreaterThan(20)
    for (const m of STRUCTURED_EXPORTER) expect(existsSync(join(ROOT, m)), m).toBe(true)
  })

  it('outside the exporter, exactly the allow-listed modules import the walker/planner/writer', () => {
    const importers = files
      .map((file) => relative(ROOT, file).split(sep).join('/'))
      .filter((file) => !exporterSet.has(file))
      .filter((file) => localImports(join(ROOT, file)).some((dep) => exporterSet.has(dep)))
      .toSorted()
    expect(importers).toEqual(ALLOWED_EXTERNAL_IMPORTERS)
  })

  it('no import-side or document module reaches the structured exporter, directly or transitively', () => {
    const importSide = files.filter((file) =>
      /[\\/]src[\\/](?:shared|main)[\\/]import[\\/]|[\\/]src[\\/]main[\\/]document[\\/]|pptx-roundtrip/.test(
        file,
      ),
    )
    expect(importSide.length).toBeGreaterThan(0)
    for (const file of importSide) {
      const reached = [...transitiveImports(file)].filter((dep) => exporterSet.has(dep)).toSorted()
      expect(reached, `${relative(ROOT, file)} must not reach the structured exporter`).toEqual([])
    }
  })
})

const LEDGER = join(ROOT, 'src', 'shared', 'import', 'pptx', 'ledger.ts')

type LedgerModule = {
  buildLedger: (args: {
    format: 'pptx'
    fileName: string
    archiveBytes: Uint8Array
    parts: Record<string, Uint8Array>
    slides: { slideId: string; part: string; html: string }[]
    importedAt: string
    hash: (input: string | Uint8Array) => string
  }) => unknown
  planRoundTrip: (
    ledger: unknown,
    current: { slideOrder: string[]; slideHtml: Record<string, string> },
    hash: (input: string | Uint8Array) => string,
    patchable?: (slideId: string) => boolean,
  ) => { mode: 'identity' | 'patched' | 'rebuild'; passthroughParts: readonly string[] }
}

/** A deterministic stand-in for sha256: the ledger only compares hashes for equality. */
const hash = (input: string | Uint8Array): string =>
  typeof input === 'string' ? `s:${input}` : `b:${Array.from(input).join(',')}`

describe('identity/patched plans never reach the rebuild fallback (behavioural half)', () => {
  if (!existsSync(LEDGER)) {
    it.todo(
      'M4.5 has not merged: `src/shared/import/pptx/ledger.ts` is absent. When it lands, this block ' +
        'runs `planRoundTrip` on an unedited and a text-edited deck and asserts neither is `rebuild`.',
    )
    return
  }

  it('an unedited imported deck plans as identity with every part passed through; a text edit as patched', async () => {
    const mod = (await import(/* @vite-ignore */ pathToFileURL(LEDGER).href)) as LedgerModule
    const parts = {
      '[Content_Types].xml': new Uint8Array([1]),
      'ppt/slides/slide1.xml': new Uint8Array([2]),
      'ppt/slides/slide2.xml': new Uint8Array([3]),
    }
    const ledger = mod.buildLedger({
      format: 'pptx',
      fileName: 'deck.pptx',
      archiveBytes: new Uint8Array([9, 9]),
      parts,
      slides: [
        { slideId: 'a', part: 'ppt/slides/slide1.xml', html: '<p>one</p>' },
        { slideId: 'b', part: 'ppt/slides/slide2.xml', html: '<p>two</p>' },
      ],
      importedAt: '2026-09-03T00:00:00.000Z',
      hash,
    })

    const unedited = mod.planRoundTrip(
      ledger,
      { slideOrder: ['a', 'b'], slideHtml: { a: '<p>one</p>', b: '<p>two</p>' } },
      hash,
    )
    expect(unedited.mode).toBe('identity')
    expect([...unedited.passthroughParts].toSorted()).toEqual(Object.keys(parts).toSorted())

    const edited = mod.planRoundTrip(
      ledger,
      { slideOrder: ['a', 'b'], slideHtml: { a: '<p>one!</p>', b: '<p>two</p>' } },
      hash,
      () => true,
    )
    expect(edited.mode).toBe('patched')

    const reordered = mod.planRoundTrip(
      ledger,
      { slideOrder: ['b', 'a'], slideHtml: { a: '<p>one</p>', b: '<p>two</p>' } },
      hash,
    )
    expect(reordered.mode).toBe('rebuild')
  })
})
