/**
 * The HTML-export bundle builder (M4.4, 60-export.md §5) — pure, and the whole reason this export is
 * cheap to trust: `deck + range → { path: bytes }`. No filesystem, no zip, no Electron. The zip step
 * and the atomic write live in `src/main/export/html-export.ts` and operate on whatever this returns,
 * so every property worth asserting — paths, manifest/slide-count agreement, escaping, range
 * selection, per-slide error isolation — is a unit test over a plain object.
 *
 * ## Bundle layout
 *
 * ```
 * index.html              generated presenter shell, manifest inlined
 * deck.json               the same manifest, standalone, for tooling and re-import
 * slides/001-title.html   one file per exported slide, in presentation order
 * slides/002-agenda.html
 * ```
 *
 * The `NNN-` prefix is not decoration. It makes filenames **structurally collision-free** (two slides
 * both titled "Agenda" get `003-agenda.html` and `007-agenda.html`) and it makes the directory sort
 * in presentation order in any file manager, which is what a user who opens `slides/` expects.
 * Because uniqueness comes from the counter, the slug half can be lossy without consequence.
 *
 * ## No `assets/` directory, deliberately
 *
 * §5.1 sketches an `assets/` folder. It is not emitted, and the reason is the slide CSP: slides ship
 * with `img-src data: blob:` and `font-src data:` (`SLIDE_CSP`). A slide *cannot* reference a sibling
 * file — the policy that travels in its own bytes forbids it — so every image and font a slide uses
 * is already a `data:` URI inside the slide document. An `assets/` directory would contain files no
 * slide is permitted to load. When the deck model grows a real asset store whose files slides may
 * reference, the CSP has to change first; this layout follows that change rather than anticipating it.
 *
 * ## Slides are stored *wrapped*, not byte-identical to source
 *
 * §5.1 promised byte-identity with the stored slide HTML. That promise is knowingly traded here, and
 * it is the single most important decision in this milestone.
 *
 * Inside the app a slide's CSP arrives two ways: injected into the document by `wrapSlideHtml`, and
 * sent again as a `slide://` response header. Exported, **there is no response header** — the file is
 * opened from `file://` by a browser that has never heard of us. The injected meta is the only
 * policy left, so if the bundle stored raw author source, every exported slide would run with no CSP
 * at all: free network egress, free exfiltration of deck content, remote code on the viewer's
 * machine. Byte-identity is a nice property; shipping an unpoliced document to a third party is a
 * vulnerability. The wrapped bytes win.
 *
 * The trade costs less than it looks. `wrapSlideHtml` is a **constant-length prefix inserted at a
 * computed offset** and rewrites no author byte, so the original source is recoverable exactly by
 * removing that known prefix — a re-importer round-trips the deck losslessly, it just has to strip
 * before it compares. The fidelity-oracle role of §5.4 survives intact under the same subtraction.
 */

import { buildPresenterShell, type BundleManifest, type BundleSlideEntry } from './presenter-shell'
import { resolveRange } from './range'
import type { ExportHtmlReport, SlideExportInput, SlideExportOutcome, SlideRange } from './types'

/** Bundle-relative path of the presenter shell. */
export const BUNDLE_INDEX_PATH = 'index.html'
/** Bundle-relative path of the standalone manifest. */
export const BUNDLE_MANIFEST_PATH = 'deck.json'
/** Directory holding the slide documents. */
export const BUNDLE_SLIDES_DIR = 'slides'

/** Longest slug retained from a slide title, in characters. */
const MAX_SLUG_LENGTH = 40

/**
 * Turn a slide title into the filename-safe half of its bundle path.
 *
 * Deliberately conservative: lowercase ASCII alphanumerics and `-`, nothing else. Titles are model-
 * and user-authored and land in a path that will be written to the viewer's filesystem, so anything
 * that could be read as a path segment, a shell metacharacter, or a Windows reserved character is
 * dropped rather than transliterated. Non-Latin titles legitimately reduce to nothing, hence the
 * `slide` fallback — the `NNN-` prefix is what carries identity, and the slug is a convenience.
 */
export function slugifySlideTitle(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/-+$/, '')
  return slug === '' ? 'slide' : slug
}

/**
 * The bundle-relative path for the `position`-th (0-based) exported slide.
 *
 * Padded to at least three digits so a normal deck sorts lexicographically; a deck past 999 slides
 * grows a fourth digit and simply sorts correctly from there, which is better than truncating.
 */
export function slidePathFor(position: number, title: string): string {
  const ordinal = String(position + 1).padStart(3, '0')
  return `${BUNDLE_SLIDES_DIR}/${ordinal}-${slugifySlideTitle(title)}.html`
}

export type BuildHtmlBundleArgs = {
  slides: readonly SlideExportInput[]
  range: SlideRange
  currentIndex: number
  /** Where the zip will land. Recorded in the report; the builder itself writes nothing. */
  outPath: string
  deckTitle: string
}

export type BuildHtmlBundleResult = {
  /**
   * The bundle, as bundle-relative path → UTF-8 bytes, in emission order. `null` when the range was
   * empty or every slide failed — there is nothing to zip and no file should be written.
   */
  files: ReadonlyMap<string, Uint8Array> | null
  manifest: BundleManifest | null
  report: ExportHtmlReport
}

const encoder = new TextEncoder()

/**
 * Build the bundle.
 *
 * Per-slide error isolation matches the PDF pipeline (60-export.md §6.3): a slide that cannot be
 * emitted is recorded as `failed`, excluded from the manifest, and the bundle of the remaining
 * slides is still produced. The manifest is therefore built *after* the loop from the slides that
 * actually succeeded, which is what keeps `manifest.slideCount`, `manifest.slides.length`, and the
 * number of files under `slides/` in agreement no matter what failed — the shell's embedded slide
 * list can never reference a file the bundle does not contain.
 *
 * A slide whose HTML is blank is a failure rather than an empty file: writing it would produce a
 * silently white slide in the middle of the user's deck, which is the degradation mode this project
 * least wants. Unexpected throws are caught too, so a pathological title or document cannot abort an
 * otherwise good export.
 */
export function buildHtmlBundle(args: BuildHtmlBundleArgs): BuildHtmlBundleResult {
  const { slides, range, currentIndex, outPath, deckTitle } = args

  const indices = resolveRange(range, slides.length, currentIndex)
  const outcomes: SlideExportOutcome[] = []
  const warnings: string[] = []
  const entries: BundleSlideEntry[] = []
  const slideFiles = new Map<string, Uint8Array>()

  if (indices.length === 0) {
    warnings.push('The selected range contains no slides.')
    return {
      files: null,
      manifest: null,
      report: { format: 'html', outPath, slideCount: 0, fileCount: 0, slides: [], warnings },
    }
  }

  for (const [position, slideIndex] of indices.entries()) {
    const slide = slides[slideIndex]
    // `resolveRange` only ever returns in-bounds indices, so this is a guard, not a live branch.
    if (slide === undefined) continue

    try {
      if (slide.html.trim() === '') {
        throw new Error('slide HTML is empty')
      }
      // `entries.length`, not `position`: numbering follows the slides that made it into the bundle,
      // so a failure in the middle does not leave a gap in the file sequence the shell walks.
      const file = slidePathFor(entries.length, slide.title)
      slideFiles.set(file, encoder.encode(slide.html))
      entries.push({
        index: entries.length,
        id: slide.id ?? '',
        title: slide.title,
        file,
      })
      outcomes.push({ index: position, title: slide.title, status: 'ok' })
    } catch (error) {
      outcomes.push({
        index: position,
        title: slide.title,
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
      })
      warnings.push(`Slide ${String(position + 1)} (${slide.title}) could not be exported.`)
    }
  }

  if (entries.length === 0) {
    warnings.push('No slides could be exported.')
    return {
      files: null,
      manifest: null,
      report: {
        format: 'html',
        outPath,
        slideCount: indices.length,
        fileCount: 0,
        slides: outcomes,
        warnings,
      },
    }
  }

  const manifest: BundleManifest = {
    formatVersion: 1,
    generator: 'sloodge',
    title: deckTitle,
    slideCount: entries.length,
    slides: entries,
  }

  const files = new Map<string, Uint8Array>()
  files.set(BUNDLE_INDEX_PATH, encoder.encode(buildPresenterShell(manifest)))
  files.set(BUNDLE_MANIFEST_PATH, encoder.encode(`${JSON.stringify(manifest, null, 2)}\n`))
  for (const [path, bytes] of slideFiles) files.set(path, bytes)

  return {
    files,
    manifest,
    report: {
      format: 'html',
      outPath,
      slideCount: indices.length,
      fileCount: files.size,
      slides: outcomes,
      warnings,
    },
  }
}
