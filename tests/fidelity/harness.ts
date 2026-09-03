/**
 * PPTX export round-trip harness (M4.8a; research/pptx-export-fidelity.md §5.2). Runs as an
 * Electron main script — see `run.ts` — and, per corpus slide:
 *
 *  1. **Ground truth** in the real export window: the independent oracle (`lib/truth.ts`) and a
 *     Chromium screenshot of the settled slide (`NN.ref.png`).
 *  2. **The real export path**, unmodified: `installSlideProtocol` → `createOffscreenPptxRenderer`
 *     → `buildSlidesPptx` → `createPptxWriter`, in both `auto` and `editable`, writing
 *     `NN.auto.pptx` / `NN.editable.pptx`. The renderer seam is wrapped only to *record* the
 *     measurement pass it produced, so the committed fixtures are exactly what production saw.
 *  3. **Structural read-back** of the emitted file against the ground truth (`lib/assess.ts`).
 *  4. **Pixel diff**: render the `.pptx` back to PNG via an external renderer and diff against the
 *     reference. Fails closed when no renderer is installed (`lib/renderer.ts`).
 *
 * Local only — never CI. Exit codes: 0 all targets met and pixel step ran; 1 a structural target
 * failed; 2 structural targets met but the pixel step could not run (renderer missing).
 *
 * `--record` refreshes `tests/fidelity/corpus/recorded/*.json`, the fixtures the vitest corpus
 * test consumes. Re-run it whenever `slideMeasurementScript` changes; the test fails closed until
 * you do.
 */

import { createHash } from 'node:crypto'
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { app, BrowserWindow, nativeImage } from 'electron'
import { installSlideProtocol, registerSlideSchemePrivileges } from '../../src/main/slide/protocol'
import { createExportWindow, loadAndSettleSlide } from '../../src/main/export/electron-renderer'
import {
  createOffscreenPptxRenderer,
  type SlidePptxRenderer,
} from '../../src/main/export/pptx-renderer'
import { buildSlidesPptx } from '../../src/main/export/pptx-export'
import { createPptxWriter } from '../../src/main/export/pptx-writer'
import { slideMeasurementScript, type MeasureResult } from '../../src/shared/export/pptx/node'
import type { PptxFidelity } from '../../src/shared/export/pptx/types'
import { SLIDE_HEIGHT_PX, SLIDE_WIDTH_PX } from '../../src/shared/export/types'
import { slideDocumentUrl } from '../../src/shared/slide-protocol'
import { wrapSlideHtml } from '../../src/renderer/src/features/canvas/wrapSlideHtml'
import {
  assessSlide,
  formatSlides,
  formatSummary,
  summarize,
  BOX_TOLERANCE_PCT,
  type SlideAssessment,
} from './lib/assess'
import { CORPUS, recordedFileName, type RecordedSlide } from './lib/corpus'
import { readbackPptx } from './lib/readback'
import {
  PIXEL_DIFF_MAX_FRACTION,
  RENDERER_ENV,
  diffPixels,
  renderPptxToPng,
  resolvePptxRenderer,
} from './lib/renderer'
import { groundTruthScript, type GroundTruth } from './lib/truth'

const print = (line: string): void => {
  process.stdout.write(`${line}\n`)
}

function argValue(name: string): string | undefined {
  const i = process.argv.indexOf(name)
  return i === -1 ? undefined : process.argv[i + 1]
}

const root = resolve(argValue('--root') ?? process.cwd())
const fidelityDir = join(root, 'tests', 'fidelity')
const corpusDir = join(fidelityDir, 'corpus')
const recordedDir = join(corpusDir, 'recorded')
const outDir = resolve(argValue('--out') ?? join(fidelityDir, 'out'))
const record = process.argv.includes('--record')

const MODES: readonly PptxFidelity[] = ['auto', 'editable']

type PixelResult = { file: string; fraction: number; ok: boolean }
type PixelStep = { status: 'ran'; results: PixelResult[] } | { status: 'not-run'; reason: string }

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/** Fraction of pixels that are not the top-left pixel's colour — a blank capture is a harness bug. */
function nonUniformFraction(bitmap: Buffer, width: number, height: number): number {
  const total = width * height
  let differing = 0
  for (let i = 1; i < total; i += 1) {
    const o = i * 4
    if (bitmap[o] !== bitmap[0] || bitmap[o + 1] !== bitmap[1] || bitmap[o + 2] !== bitmap[2])
      differing += 1
  }
  return differing / total
}

async function groundTruthPass(
  registry: ReturnType<typeof installSlideProtocol>,
  html: string,
  refPngPath: string,
): Promise<GroundTruth> {
  const win = createExportWindow()
  const ownerId = win.webContents.id
  const published = registry.publish(html, ownerId)
  if (!published.ok) throw new Error(`publish refused: ${published.refusal.reason}`)
  try {
    await loadAndSettleSlide(win.webContents, slideDocumentUrl(published.id))
    const truth = (await win.webContents.executeJavaScript(
      groundTruthScript(),
      true,
    )) as GroundTruth
    const image = await win.webContents.capturePage()
    const { width, height } = image.getSize()
    if (width !== SLIDE_WIDTH_PX || height !== SLIDE_HEIGHT_PX) {
      throw new Error(`reference capture is ${String(width)}×${String(height)}, expected 1280×720`)
    }
    const ink = nonUniformFraction(image.toBitmap(), width, height)
    if (ink < 0.02) throw new Error(`reference capture is blank (${(ink * 100).toFixed(2)}% ink)`)
    writeFileSync(refPngPath, image.toPNG())
    return truth
  } finally {
    registry.revoke(published.id, ownerId)
    win.destroy()
  }
}

type ExportPass = {
  bytes: Uint8Array
  measure: MeasureResult
  tier: 'structured' | 'raster'
  score: number
  reasons: string[]
}

async function exportPass(
  registry: ReturnType<typeof installSlideProtocol>,
  slides: readonly { title: string; html: string }[],
  fidelity: PptxFidelity,
): Promise<ExportPass[]> {
  const inner = createOffscreenPptxRenderer(registry)
  const measures: MeasureResult[] = []
  const recording: SlidePptxRenderer = {
    renderSlide: async (html, index) => {
      const rendered = await inner.renderSlide(html, index)
      measures.push(rendered.measure)
      return rendered
    },
    dispose: inner.dispose,
  }
  try {
    const { pptxBytes, report } = await buildSlidesPptx({
      slides,
      range: { kind: 'all' },
      currentIndex: 0,
      fidelity,
      outPath: '(memory)',
      deckTitle: `fidelity-${fidelity}`,
      renderer: recording,
      writer: createPptxWriter(),
    })
    if (pptxBytes === null) {
      const errors = report.slides.map((s) => `${s.title}: ${s.error ?? '?'}`).join('; ')
      throw new Error(`export produced nothing: ${errors}`)
    }
    return report.slides.map((outcome, i) => {
      if (outcome.status !== 'ok' || outcome.tier === undefined || outcome.confidence === undefined)
        throw new Error(`slide ${outcome.title} failed: ${outcome.error ?? 'unknown'}`)
      const measure = measures[i]
      if (measure === undefined) throw new Error(`no measurement recorded for ${outcome.title}`)
      return {
        bytes: pptxBytes,
        measure,
        tier: outcome.tier,
        score: outcome.confidence,
        reasons: outcome.notes,
      }
    })
  } finally {
    recording.dispose()
  }
}

async function pixelStep(
  refs: readonly { file: string; pptx: string; ref: string }[],
): Promise<PixelStep> {
  const renderer = resolvePptxRenderer()
  if (renderer.kind === 'missing') {
    return {
      status: 'not-run',
      reason: `renderer not installed — tried ${renderer.tried.join('; ')}. Install LibreOffice or set ${RENDERER_ENV}=/path/to/soffice.`,
    }
  }
  print(`pixel step: using ${renderer.path} (${renderer.source})`)
  const renderDir = join(outDir, 'render')
  mkdirSync(renderDir, { recursive: true })
  const results: PixelResult[] = []
  for (const { file, pptx, ref } of refs) {
    // oxlint-disable-next-line no-await-in-loop -- one renderer process at a time
    const png = await renderPptxToPng(renderer.path, pptx, renderDir)
    const size = { width: SLIDE_WIDTH_PX, height: SLIDE_HEIGHT_PX }
    const rendered = nativeImage.createFromPath(png).resize(size)
    const reference = nativeImage.createFromPath(ref).resize(size)
    const diff = diffPixels(rendered.toBitmap(), reference.toBitmap(), size.width, size.height)
    results.push({ file, fraction: diff.fraction, ok: diff.fraction <= PIXEL_DIFF_MAX_FRACTION })
  }
  return { status: 'ran', results }
}

async function main(): Promise<number> {
  // Electron drops the compositor once the last window closes, and the next hidden window then
  // fails to load. Production never has zero windows (the editor is open); the harness keeps one.
  const anchor = new BrowserWindow({ show: false, width: 100, height: 100 })
  anchor.removeMenu()
  mkdirSync(join(outDir, 'recorded'), { recursive: true })
  if (record) mkdirSync(recordedDir, { recursive: true })
  const registry = installSlideProtocol()
  const scriptHash = sha256(slideMeasurementScript())

  const byMode: Record<PptxFidelity, SlideAssessment[]> = { auto: [], editable: [], raster: [] }
  const pixelInputs: { file: string; pptx: string; ref: string }[] = []
  const wrapped: { title: string; html: string }[] = []

  for (const corpus of CORPUS) {
    const stem = corpus.file.replace(/\.html$/, '')
    const html = wrapSlideHtml(readFileSync(join(corpusDir, corpus.file), 'utf8'))
    wrapped.push({ title: corpus.file, html })
    const refPng = join(outDir, `${stem}.ref.png`)
    // oxlint-disable-next-line no-await-in-loop -- one window at a time, like production
    const truth = await groundTruthPass(registry, html, refPng)

    let recordedMeasure: MeasureResult | null = null
    for (const mode of MODES) {
      // oxlint-disable-next-line no-await-in-loop -- sequential renders, like production
      const [pass] = await exportPass(registry, [{ title: corpus.file, html }], mode)
      if (pass === undefined) throw new Error(`no pass for ${corpus.file}`)
      const pptxPath = join(outDir, `${stem}.${mode}.pptx`)
      writeFileSync(pptxPath, pass.bytes)
      if (mode === 'auto') pixelInputs.push({ file: corpus.file, pptx: pptxPath, ref: refPng })
      recordedMeasure ??= pass.measure
      const readback = readbackPptx(pass.bytes)[0]
      if (readback === undefined) throw new Error(`${pptxPath} has no slide part`)
      const assessment = assessSlide({
        corpus,
        truth,
        measure: pass.measure,
        readback,
        tier: pass.tier,
        score: pass.score,
        reasons: pass.reasons,
      })
      byMode[mode].push(assessment)
      print(
        `${corpus.file.padEnd(24)} ${mode.padEnd(8)} tier=${pass.tier.padEnd(10)} score=${String(pass.score).padStart(3)} text=${String(assessment.textKept)}/${String(assessment.textTotal)} rot=${String(assessment.rotationsOk)}/${String(assessment.rotationsExpected)} box=${assessment.boxWorstPct.toFixed(3)}%${assessment.silentLie ? '  SILENT LIE' : ''}${assessment.constructsLost.length > 0 ? `  lost: ${assessment.constructsLost.join('; ')}` : ''}`,
      )
    }

    if (recordedMeasure === null) throw new Error(`no measurement for ${corpus.file}`)
    const recorded: RecordedSlide = {
      file: corpus.file,
      measurementScriptSha256: scriptHash,
      measure: recordedMeasure,
      truth,
    }
    const recordedPath = join(outDir, 'recorded', recordedFileName(corpus.file))
    writeFileSync(recordedPath, JSON.stringify(recorded))
    if (record) copyFileSync(recordedPath, join(recordedDir, recordedFileName(corpus.file)))
  }

  // One whole-corpus deck too, for opening in a real PowerPoint by hand.
  const [deck] = await exportPass(registry, wrapped, 'auto')
  if (deck !== undefined) writeFileSync(join(outDir, 'corpus.auto.pptx'), deck.bytes)

  const summaries = { auto: summarize(byMode.auto), editable: summarize(byMode.editable) }
  const pixel = await pixelStep(pixelInputs)

  const structuralOk =
    summaries.auto.silentLies.length === 0 &&
    summaries.auto.rotationsOk === summaries.auto.rotationsExpected &&
    summaries.auto.bodyImagePreserved === summaries.auto.bodyImageSlides &&
    summaries.auto.colorExact === summaries.auto.colorTotal &&
    summaries.auto.sizeExact === summaries.auto.colorTotal &&
    summaries.auto.boxWorstPct <= BOX_TOLERANCE_PCT
  const pixelLine =
    pixel.status === 'ran'
      ? pixel.results
          .map(
            (r) =>
              `| ${r.file} | ${(r.fraction * 100).toFixed(2)}% differing | ${r.ok ? 'ok' : 'FAIL'} |`,
          )
          .join('\n')
      : `| (all) | **NOT RUN** | ${pixel.reason} |`

  const md = [
    '# PPTX fidelity harness',
    '',
    `Generated ${new Date().toISOString()} by tests/fidelity/harness.ts. Local only.`,
    '',
    '## auto',
    '',
    formatSummary('auto', summaries.auto),
    '',
    formatSlides(byMode.auto),
    '',
    '## editable',
    '',
    formatSummary('editable', summaries.editable),
    '',
    formatSlides(byMode.editable),
    '',
    `## pixel diff (ceiling ${String(PIXEL_DIFF_MAX_FRACTION * 100)}%, uncalibrated)`,
    '',
    '| Slide | Result | Note |',
    '| --- | --- | --- |',
    pixelLine,
    '',
  ].join('\n')
  writeFileSync(join(outDir, 'report.md'), md)
  writeFileSync(
    join(outDir, 'report.json'),
    JSON.stringify({ summaries, slides: byMode, pixel }, null, 1),
  )

  print('')
  print(md)
  if (pixel.status === 'not-run') {
    print('')
    print(`PIXEL DIFF NOT RUN: ${pixel.reason}`)
  }
  if (!structuralOk) return 1
  if (pixel.status === 'not-run') return 2
  return pixel.results.every((r) => r.ok) ? 0 : 1
}

registerSlideSchemePrivileges()
app.commandLine.appendSwitch('force-device-scale-factor', '1')

void app.whenReady().then(() =>
  main().then(
    (code) => app.exit(code),
    (error: unknown) => {
      print(
        `harness failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
      )
      app.exit(1)
    },
  ),
)
