/**
 * The pixel half of the round-trip harness: render an emitted `.pptx` back to a PNG through an
 * external renderer (LibreOffice headless, or whatever `SLOODGE_PPTX_RENDERER` points at) and
 * diff it against Chromium's screenshot of the same slide.
 *
 * ## Fail closed
 *
 * This repo's history has instruments that passed on no data. So when no renderer is installed the
 * step does not skip, soften, or report a pixel pass — `resolvePptxRenderer` says `missing`, the
 * harness prints that in its summary, and the process exits non-zero. Structural targets are still
 * measured and reported; only the pixel row is marked NOT RUN.
 */

import { accessSync, constants, existsSync, readdirSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { basename, delimiter, join } from 'node:path'

export const RENDERER_ENV = 'SLOODGE_PPTX_RENDERER'
const RENDERER_NAMES = ['soffice', 'libreoffice']

export type RendererResolution =
  { kind: 'found'; path: string; source: 'env' | 'PATH' } | { kind: 'missing'; tried: string[] }

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

export function resolvePptxRenderer(env: NodeJS.ProcessEnv = process.env): RendererResolution {
  const tried: string[] = []
  const override = env[RENDERER_ENV]
  if (override !== undefined && override !== '') {
    if (isExecutable(override)) return { kind: 'found', path: override, source: 'env' }
    tried.push(`${RENDERER_ENV}=${override} (not executable)`)
  }
  for (const dir of (env['PATH'] ?? '').split(delimiter).filter((d) => d !== '')) {
    for (const name of RENDERER_NAMES) {
      const candidate = join(dir, name)
      if (isExecutable(candidate)) return { kind: 'found', path: candidate, source: 'PATH' }
    }
  }
  tried.push(`${RENDERER_NAMES.join('/')} on PATH`)
  return { kind: 'missing', tried }
}

/**
 * Convert one `.pptx` to a PNG of its first slide. LibreOffice's `--convert-to png` renders only the
 * first slide, which is why the harness writes one single-slide package per corpus slide.
 *
 * Untested against a live renderer at the time of writing (none was installed on the authoring
 * machine): the argument shape follows `soffice --headless --convert-to png --outdir DIR FILE`.
 */
export async function renderPptxToPng(
  renderer: string,
  pptxPath: string,
  outDir: string,
): Promise<string> {
  const stderr: string[] = []
  const code = await new Promise<number>((resolve, reject) => {
    const child = spawn(
      renderer,
      ['--headless', '--convert-to', 'png', '--outdir', outDir, pptxPath],
      {
        stdio: ['ignore', 'ignore', 'pipe'],
      },
    )
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk.toString('utf8')))
    child.on('error', reject)
    child.on('exit', (exitCode) => resolve(exitCode ?? 1))
  })
  const expected = join(outDir, `${basename(pptxPath, '.pptx')}.png`)
  if (code !== 0 || !existsSync(expected)) {
    const produced = existsSync(outDir) ? readdirSync(outDir).join(', ') : '(no outdir)'
    throw new Error(
      `renderer exited ${String(code)} without producing ${expected}; outdir holds: ${produced}\n${stderr.join('')}`,
    )
  }
  return expected
}

export type PixelDiff = { differing: number; total: number; fraction: number }

/**
 * Fraction of pixels whose any-channel difference exceeds `tolerance`. Both buffers are 4-byte
 * per pixel (BGRA/RGBA — the channel order does not matter as long as both sides agree) at the
 * same dimensions; the alpha channel is ignored.
 */
export function diffPixels(
  a: Uint8Array,
  b: Uint8Array,
  width: number,
  height: number,
  tolerance = 32,
): PixelDiff {
  const total = width * height
  if (a.length < total * 4 || b.length < total * 4) {
    throw new Error(`pixel buffers too small for ${String(width)}×${String(height)}`)
  }
  let differing = 0
  for (let i = 0; i < total; i += 1) {
    const o = i * 4
    const d = Math.max(
      Math.abs(a[o]! - b[o]!),
      Math.abs(a[o + 1]! - b[o + 1]!),
      Math.abs(a[o + 2]! - b[o + 2]!),
    )
    if (d > tolerance) differing += 1
  }
  return { differing, total, fraction: total === 0 ? 0 : differing / total }
}

/**
 * Pixel-diff ceiling. **Uncalibrated**: no renderer was available when this harness was written, so
 * the value is a placeholder to be tuned on the first real run — it is deliberately loose (font
 * substitution alone moves glyph edges) and is reported, not silently applied.
 */
export const PIXEL_DIFF_MAX_FRACTION = 0.1
