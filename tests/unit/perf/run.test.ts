/**
 * `perf:run` must measure the deck `deck-hashes.json` describes, or its report is mislabelled: a
 * `perf/decks/` left behind by an older generator would be published under the committed seed and
 * hash. Real files through the shipped writer and reader, because the check is about what is on
 * disk, not about the generator's in-memory output.
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { generateDeck, type DeckHashEntry } from '../../../perf/cli/generate'
import { abortUnusableRun, loadStressDeck, writeRunArtifacts } from '../../../perf/cli/run'
import { buildStressDeck, type DeckContent } from '../../../perf/lib/deck'
import { PerfReportSchema } from '../../../perf/lib/report'
import baseline from '../../../perf/results/baseline-main.json'
import { writeDeck } from '../../../src/main/document/store'

const SLIDES = 6
const SEED = 11

/** Change one character of one slide without changing its length. */
function nudge(slides: Record<string, string>, id: string): Record<string, string> {
  const html = slides[id] ?? ''
  const at = html.indexOf('<div')
  return { ...slides, [id]: `${html.slice(0, at + 1)}dvi${html.slice(at + 4)}` }
}

describe('loadStressDeck', () => {
  let dir = ''
  let record: DeckHashEntry

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'sloodge-perf-run-'))
    const generated = await generateDeck(dir, SLIDES, SEED)
    record = {
      seed: SEED,
      slideCount: SLIDES,
      contentSha256: generated.contentSha256,
      archiveBytes: generated.archiveBytes,
      totalSlideBytes: generated.totalSlideBytes,
      archetypeCounts: generated.archetypeCounts,
    }
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('accepts the deck the record describes and returns the shipped reader’s bundle', async () => {
    const loaded = await loadStressDeck(dir, record)
    expect(loaded.bundle.manifest.slideOrder).toHaveLength(SLIDES)
    expect(loaded.payloadPath).toBe(join(dir, `stress-${String(SLIDES)}.deck-update.json`))
  })

  it('refuses a payload whose slide content differs from the record by one byte', async () => {
    const payloadPath = join(dir, `stress-${String(SLIDES)}.deck-update.json`)
    const payload = JSON.parse(await readFile(payloadPath, 'utf8')) as DeckContent
    const first = payload.manifest.slideOrder[0] ?? ''
    await writeFile(
      payloadPath,
      JSON.stringify({ ...payload, slides: nudge(payload.slides, first) }),
      'utf8',
    )
    await expect(loadStressDeck(dir, record)).rejects.toThrow(/run pnpm perf:generate/)
  })

  it('refuses a .sloodge whose slides differ from the payload by one byte', async () => {
    // Same length, so a byte-count comparison would pass it; the slides are compared outright.
    const deck = buildStressDeck({ slideCount: SLIDES, seed: SEED })
    const last = deck.manifest.slideOrder[SLIDES - 1] ?? ''
    const written = await writeDeck(join(dir, `stress-${String(SLIDES)}.sloodge`), {
      ...deck,
      slides: nudge(deck.slides, last),
    })
    expect(written.ok).toBe(true)
    await expect(loadStressDeck(dir, record)).rejects.toThrow(/run pnpm perf:generate/)
  })

  it('refuses a record whose hash belongs to another seed', async () => {
    await expect(
      loadStressDeck(dir, { ...record, contentSha256: 'not-the-recorded-digest' }),
    ).rejects.toThrow(/run pnpm perf:generate/)
  })

  it('tells a fresh clone to generate the decks instead of surfacing ENOENT', async () => {
    await expect(loadStressDeck(join(dir, 'never-generated'), record)).rejects.toThrow(
      /run pnpm perf:generate \(no generated deck on disk\)/,
    )
  })
})

describe('writeRunArtifacts', () => {
  let dir = ''
  const report = PerfReportSchema.parse(baseline)

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'sloodge-perf-write-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('writes a complete report and its trace and finds no problem with it', async () => {
    const out = join(dir, 'run.json')
    const { tracePath, problems } = await writeRunArtifacts(report, [{ run: 0 }], out)
    expect(problems).toStrictEqual([])
    expect(tracePath).toBe(join(dir, 'run.trace.json'))
    expect(JSON.parse(await readFile(tracePath, 'utf8'))).toStrictEqual([{ run: 0 }])
    expect(PerfReportSchema.safeParse(JSON.parse(await readFile(out, 'utf8'))).success).toBe(true)
  })

  // `--out` is a free-form string, and the trace is named after the report. Each of these spellings
  // used to derive a trace path equal to the report path, so the trace landed on the report and a
  // multi-minute run was lost to its own raw series.
  it.each(['mine', 'mine.JSON', 'a.json.bak'])(
    'writes the trace beside the report rather than over it, for --out=%s',
    async (name) => {
      const out = join(dir, name)
      const { tracePath } = await writeRunArtifacts(report, [{ run: 0 }], out)
      expect(tracePath).not.toBe(out)
      expect(JSON.parse(await readFile(tracePath, 'utf8'))).toStrictEqual([{ run: 0 }])
      expect(PerfReportSchema.safeParse(JSON.parse(await readFile(out, 'utf8'))).success).toBe(true)
    },
  )

  it('keeps a run with no idle samples on disk as null, and reports it unfit for a baseline', async () => {
    // `--idle-dwell=0`: the file is written (a multi-minute run is not thrown away), the field is
    // an honest null rather than a NaN the schema refuses, and the caller learns at write time.
    const out = join(dir, 'run.json')
    const { problems } = await writeRunArtifacts(
      { ...report, metrics: { ...report.metrics, idleRamMb: Number.NaN } },
      [],
      out,
    )
    const written = JSON.parse(await readFile(out, 'utf8')) as { metrics: { idleRamMb: unknown } }
    expect(written.metrics.idleRamMb).toBeNull()
    expect(problems).toHaveLength(1)
    expect(problems[0]).toMatch(/metrics\.idleRamMb is null/)
  })
})

describe('abortUnusableRun', () => {
  let dir = ''
  let stdout = ''
  let stderr = ''
  const exitCodeBefore = process.exitCode
  const trace = [{ run: 0, samples: [] }]

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'sloodge-perf-unusable-'))
    stdout = ''
    stderr = ''
    vi.spyOn(console, 'log').mockImplementation((line: string) => {
      stdout += `${line}\n`
    })
    vi.spyOn(console, 'error').mockImplementation((line: string) => {
      stderr += `${line}\n`
    })
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    process.exitCode = exitCodeBefore
    await rm(dir, { recursive: true, force: true })
  })

  const abort = (allRam: number[], allSwitches: number[], outFile: string) =>
    abortUnusableRun({
      allRam,
      allSwitches,
      ramBasis: 'proc-pss-sum',
      trace,
      outFile,
    })

  it('lets a run with both series through without writing or failing anything', async () => {
    const out = join(dir, 'run.json')
    expect(await abort([120.5], [40], out)).toStrictEqual([])
    await expect(readFile(out, 'utf8')).rejects.toThrow()
    await expect(readFile(join(dir, 'run.trace.json'), 'utf8')).rejects.toThrow()
    expect(process.exitCode).toBe(exitCodeBefore)
  })

  it.each([
    { ram: [] as number[], switches: [40], causes: ['no-ram-samples'] },
    { ram: [120.5], switches: [] as number[], causes: ['no-measured-switches'] },
    {
      ram: [] as number[],
      switches: [] as number[],
      causes: ['no-ram-samples', 'no-measured-switches'],
    },
  ])(
    'keeps the trace and writes no report when the causes are $causes',
    async ({ ram, switches, causes }) => {
      const out = join(dir, 'run.json')
      expect(await abort(ram, switches, out)).toStrictEqual(causes)
      // The run is kept: a multi-minute session's raw samples survive a verdict of "unsummarizable",
      // and the operator is told where they are.
      const tracePath = join(dir, 'run.trace.json')
      expect(JSON.parse(await readFile(tracePath, 'utf8'))).toStrictEqual(trace)
      expect(stdout).toContain(tracePath)
      // One line per cause, so nothing is diagnosed as a single mystery.
      expect(stderr.match(/\n {2}\S/g)).toHaveLength(causes.length)
      // No report at all, rather than one summarizing an empty series: `perf:diff` can never be
      // handed a zeroed PASS, and the non-zero exit says the run failed.
      await expect(readFile(out, 'utf8')).rejects.toThrow()
      expect(process.exitCode).toBe(1)
    },
  )
})
