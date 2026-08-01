/**
 * PPTX / POTX import (M4.5): a `.pptx` on disk becomes a `DeckBundle` whose slides are contract
 * HTML and whose `extras` retain the source archive verbatim.
 *
 * ## The shape of the milestone
 *
 * Three things happen here and the order matters:
 *
 *  1. **The archive is read through M1.1's hardened reader** (`../document/archive.ts`) — the same
 *     one `.sloodge` uses, not a second one. A `.pptx` is a zip a user downloaded from anywhere, so
 *     zip-slip, symlink members, decompression bombs, ZIP64 divergence, aliased local headers and
 *     prototype-pollution entry names all apply exactly as they do to a deck, and all are already
 *     handled. Nothing in this file re-implements a gate; `readArchiveFile` either hands back a
 *     validated entry map or an error value.
 *  2. **The slides are converted best effort** to contract HTML, and every converted document is
 *     put through the Tier-1 validator before it is allowed into the deck. A slide that fails is
 *     replaced by a text-only fallback rather than admitted — the contract is what the rest of the
 *     app (the sandboxed iframe, the export renderer, Design Mode) is entitled to assume, and an
 *     importer that can weaken it is a hole in all three.
 *  3. **The original archive is retained byte-for-byte** at `import/original.pptx`, with a per-part
 *     ledger at `import/ledger.json`. Both ride in `bundle.extras`, which `store.ts` round-trips
 *     verbatim by design (§5.2), so they survive save-and-reopen without the manifest schema
 *     needing to know they exist.
 *
 * Point 3 is what makes point 2 affordable. Conversion is lossy and always will be; retention means
 * the loss is confined to what the user *looks at*, never to what they export. An unedited
 * import→export round-trip re-emits the retained bytes and is byte-identical to the file that came
 * in (M4.6), so the fidelity of the converter is a UX question rather than a data-integrity one.
 *
 * ## Templates
 *
 * A `.potx` is the same package with a different main content type and (usually) no slides — its
 * value is the masters, layouts and theme. Import treats it as a theme source: the colour scheme
 * and typeface names become the deck's `theme/theme.json`, and a starter slide is created so the
 * deck is not empty. The archive is retained just the same, so a template that *does* carry slides
 * round-trips like any other package.
 */

import { basename } from 'node:path'
import { createHash } from 'node:crypto'
import { strFromU8 } from 'fflate'
import { readArchiveFile, type ArchiveError, type ReadArchiveOptions } from '../document/archive'
import type { DeckBundle } from '../document/store'
import {
  createEmptyDeck,
  createSlideEntry,
  newSlideId,
  newThemeId,
} from '../../shared/document/deck'
import { contractErrorSummary, validateSlideContract } from '../../shared/document/slide-contract'
import {
  createStarterSlideHtml,
  DEFAULT_THEME_TOKENS,
  escapeHtml,
  SYSTEM_FONT_STACK,
} from '../../shared/document/starter-slide'
import {
  CANVAS_HEIGHT,
  CANVAS_WIDTH,
  DEFAULT_THEME_PATH,
  type DeckManifest,
  type SlideEntry,
  type Theme,
} from '../../shared/document/types'
import { parseXml, XmlParseError, descendantsNamed, type XmlElement } from '../../shared/import/xml'
import {
  contentTypeOf,
  OpcError,
  parseRelationships,
  readSlideGraph,
  readSlideSize,
  relationshipsPartFor,
  type OpcRelationships,
  type SlideGraph,
} from '../../shared/import/pptx/opc'
import { convertSlide, defuseForbiddenTokens } from '../../shared/import/pptx/convert'
import {
  FALLBACK_THEME,
  readTheme,
  themeTokens,
  type PptxTheme,
} from '../../shared/import/pptx/theme'
import {
  buildLedger,
  LEDGER_ENTRY,
  ORIGINAL_ARCHIVE_ENTRY,
  type ImportLedger,
  type ImportSourceFormat,
} from '../../shared/import/pptx/ledger'

export type PptxImportErrorCode =
  | ArchiveError['code']
  /** The zip opened but is not a readable OPC presentation package. */
  | 'not-a-presentation'
  /** Conversion produced nothing that could satisfy the slide contract. */
  | 'unconvertible'

export type PptxImportError = { code: PptxImportErrorCode; message: string }

export type PptxImportReport = {
  readonly sourcePath: string
  readonly format: ImportSourceFormat
  readonly slideCount: number
  /** Slides that were converted structurally rather than replaced by the text-only fallback. */
  readonly convertedCount: number
  readonly fallbackCount: number
  /** sha256 of the retained archive, hex. The identity assertion's reference value. */
  readonly sourceSha256: string
  readonly retainedBytes: number
  readonly partCount: number
  readonly warnings: readonly string[]
  /** Everything the converter could not represent, deduplicated. */
  readonly conversionNotes: readonly string[]
}

export type PptxImportResult =
  | { ok: true; bundle: DeckBundle; ledger: ImportLedger; report: PptxImportReport }
  | { ok: false; error: PptxImportError }

/**
 * Ceilings on what conversion will inline. Distinct from the archive limits, which bound what is
 * *read*: these bound what ends up in the deck, because a `data:` URI costs ~4/3 of the source
 * image in every slide document that carries it, and slide HTML is held in memory by both
 * processes and re-serialized on every save.
 */
export type ImportLimits = {
  /** Largest single image inlined as a `data:` URI. Larger ones become placeholder boxes. */
  maxInlineImageBytes: number
  /** Total inlined image bytes across the deck. */
  maxTotalInlineImageBytes: number
  /** Slides converted. A longer deck imports its first `maxSlides` and warns. */
  maxSlides: number
}

export const DEFAULT_IMPORT_LIMITS: ImportLimits = {
  maxInlineImageBytes: 4 * 1024 * 1024,
  maxTotalInlineImageBytes: 48 * 1024 * 1024,
  maxSlides: 500,
}

export type ImportPptxOptions = {
  archive?: ReadArchiveOptions
  limits?: Partial<ImportLimits>
  /** Injectable for deterministic tests. */
  now?: number
}

function sha256Hex(input: string | Uint8Array): string {
  return createHash('sha256')
    .update(typeof input === 'string' ? Buffer.from(input, 'utf8') : Buffer.from(input))
    .digest('hex')
}

function getOwn<T>(map: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.hasOwn(map, key) ? (map as Record<string, T>)[key] : undefined
}

function emptyMap<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>
}

/** `.potx` by extension or by declared content type; everything else imports as a presentation. */
function formatOf(path: string, graph: SlideGraph): ImportSourceFormat {
  if (graph.kind === 'template') return 'potx'
  return path.toLowerCase().endsWith('.potx') ? 'potx' : 'pptx'
}

/** The deck title: `docProps/core.xml`'s `dc:title` when it is non-empty, else the file name. */
function deckTitleFrom(entries: Readonly<Record<string, Uint8Array>>, path: string): string {
  const core = getOwn(entries, 'docProps/core.xml')
  if (core !== undefined) {
    try {
      const root = parseXml(strFromU8(core))
      const title = descendantsNamed(root, 'title')[0]?.text.trim()
      if (title !== undefined && title !== '' && title.length <= 200) return title
    } catch {
      // A malformed docProps part is not worth failing an import over; fall through to the name.
    }
  }
  const name = basename(path).replace(/\.(pptx|potx|ppsx)$/i, '')
  return name === '' ? 'Imported deck' : name.slice(0, 200)
}

/** The sloodge `theme.json` derived from the package's theme part. */
/** A validated `#rrggbb`, or the fallback: theme values come from an untrusted archive. */
function hex(value: string | undefined, fallback: string): string {
  return value !== undefined && /^#[0-9a-f]{6}$/.test(value) ? value : fallback
}

function buildTheme(source: PptxTheme, name: string, now: number): Theme {
  const bg = hex(source.colors['lt1'], '#ffffff')
  // `mode` drives nothing structural, but a wrong value makes later theme edits fight the deck:
  // derive it from the background's luminance rather than assuming.
  const light = relativeLuminance(bg) > 0.5
  return {
    formatVersion: 1,
    id: newThemeId(now),
    name: name.slice(0, 200),
    mode: light ? 'light' : 'dark',
    tokens: {
      color: {
        bg,
        fg: hex(source.colors['dk1'], '#000000'),
        accent: hex(source.colors['accent1'], '#4472c4'),
        muted: hex(source.colors['dk2'], '#44546a'),
      },
      // The contract permits the system stack only (SL-S03), so the source typefaces are recorded
      // in the deck's theme for provenance but the stack itself is what slides use.
      font: { sans: SYSTEM_FONT_STACK },
      size: {},
      space: {},
    },
    version: 1,
  }
}

function relativeLuminance(color: string): number {
  const value = color.slice(1)
  const channel = (offset: number): number => {
    const raw = Number.parseInt(value.slice(offset, offset + 2), 16) / 255
    return raw <= 0.03928 ? raw / 12.92 : ((raw + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4)
}

/**
 * A minimal contract-clean slide carrying just the source text. Used when structural conversion
 * produced HTML the Tier-1 validator rejects: the deck must never contain a slide that violates the
 * contract, and losing layout is strictly better than losing the guarantee.
 *
 * The `data-sl-run` markers are preserved, so an edit to a fallback slide is still expressible as a
 * text substitution on the original part and the round-trip stays in `patched` mode.
 */
function fallbackSlideHtml(
  slideId: string,
  title: string,
  texts: readonly string[],
  tokens: Readonly<Record<string, string>>,
): string {
  // Same SL-S04 defusing as the structural converter: this fallback exists precisely because the
  // structural output was rejected, so it must not be rejected for the same reason.
  const body = texts
    .map(
      (text, index) =>
        `  <p class="sl-tx" data-sl-id="e_${(index + 2).toString(16).padStart(3, '0')}" style="font-size:24px;line-height:1.4;margin:0 0 12px"><span data-sl-run="${String(index)}">${defuseForbiddenTokens(escapeHtml(text))}</span></p>`,
    )
    .join('\n')
  const declarations = Object.entries(tokens)
    .filter(([name, value]) => /^--[a-z0-9-]+$/.test(name) && !/[<>{};@\\()]|\/\*|\*\//.test(value))
    .map(([name, value]) => `    ${name}: ${value};`)
    .join('\n')
  return `<!doctype html>
<html lang="en" data-sl-slide="${escapeHtml(slideId)}" data-sl-contract="1" data-sl-origin="pptx-fallback">
<head>
<meta charset="utf-8">
<title>${defuseForbiddenTokens(escapeHtml(title))}</title>
<style>
  /* sl:theme:start v=1 */
  :root {
${declarations}
  }
  /* sl:theme:end */
  *, *::before, *::after { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; background: var(--sl-bg); }
  .slide {
    width: ${String(CANVAS_WIDTH)}px;
    height: ${String(CANVAS_HEIGHT)}px;
    overflow: hidden;
    position: relative;
    box-sizing: border-box;
    padding: 48px;
    background: var(--sl-bg);
    color: var(--sl-fg);
    font-family: var(--sl-font);
  }
  .sl-tx { margin: 0; }
  [data-sl-freeze] * { animation-play-state: paused !important; }
</style>
</head>
<body>
<div class="slide" data-sl-id="e_root">
${body}
</div>
</body>
</html>
`
}

/** Read a package's theme part, falling back to OOXML's stock scheme when it is absent or broken. */
function loadTheme(
  entries: Readonly<Record<string, Uint8Array>>,
  graph: SlideGraph,
  warnings: string[],
): PptxTheme {
  if (graph.themePart === null) {
    warnings.push('package declares no theme part; using the default Office colour scheme')
    return FALLBACK_THEME
  }
  const bytes = getOwn(entries, graph.themePart)
  if (bytes === undefined) return FALLBACK_THEME
  try {
    return readTheme(parseXml(strFromU8(bytes)))
  } catch (error) {
    warnings.push(`${graph.themePart} could not be parsed (${String(error)}); using defaults`)
    return FALLBACK_THEME
  }
}

export async function importPptx(
  path: string,
  options: ImportPptxOptions = {},
): Promise<PptxImportResult> {
  const limits: ImportLimits = { ...DEFAULT_IMPORT_LIMITS, ...options.limits }
  const now = options.now ?? Date.now()

  const archive = await readArchiveFile(path, options.archive)
  if (!archive.ok) return { ok: false, error: archive.error }
  const entries = archive.entries

  let graph: SlideGraph
  try {
    graph = readSlideGraph(entries)
  } catch (error) {
    if (error instanceof OpcError || error instanceof XmlParseError) {
      return { ok: false, error: { code: 'not-a-presentation', message: error.message } }
    }
    return {
      ok: false,
      error: {
        code: 'not-a-presentation',
        message: `${path} could not be read as OPC: ${String(error)}`,
      },
    }
  }

  const warnings = [...graph.warnings]
  const conversionNotes = new Set<string>()

  // The retained archive is the file's own bytes, not a re-zip of the entry map: re-zipping would
  // change compression, ordering and timestamps, and the identity guarantee is about *these* bytes.
  const originalBytes = archive.bytes
  const sourceSha256 = sha256Hex(originalBytes)

  const presentationBytes = getOwn(entries, graph.presentationPart)
  let presentation: XmlElement | null = null
  if (presentationBytes !== undefined) {
    try {
      presentation = parseXml(strFromU8(presentationBytes))
    } catch {
      warnings.push(`${graph.presentationPart} could not be parsed; using the default slide size`)
    }
  }
  const size = presentation
    ? readSlideSize(presentation)
    : { widthEmu: 12_192_000, heightEmu: 6_858_000 }

  const pptxTheme = loadTheme(entries, graph, warnings)
  const tokens = themeTokens(pptxTheme, DEFAULT_THEME_TOKENS)
  const deckTitle = deckTitleFrom(entries, path)
  const theme = buildTheme(pptxTheme, deckTitle, now)

  let slideParts = graph.slideParts
  if (slideParts.length > limits.maxSlides) {
    warnings.push(
      `package has ${String(slideParts.length)} slides; imported the first ${String(limits.maxSlides)}`,
    )
    slideParts = slideParts.slice(0, limits.maxSlides)
  }

  let inlinedBytes = 0
  const slides = emptyMap<string>()
  const slideEntries: SlideEntry[] = []
  const ledgerSlides: { slideId: string; part: string; html: string }[] = []
  let convertedCount = 0
  let fallbackCount = 0

  for (const [index, part] of slideParts.entries()) {
    const bytes = getOwn(entries, part)
    if (bytes === undefined) continue
    const slideId = newSlideId(now + index)

    let slideXml: XmlElement
    try {
      slideXml = parseXml(strFromU8(bytes))
    } catch (error) {
      warnings.push(`${part} is not well-formed XML and was skipped (${String(error)})`)
      continue
    }

    const relsBytes = getOwn(entries, relationshipsPartFor(part))
    let relationships: OpcRelationships
    try {
      relationships =
        relsBytes === undefined
          ? { bySourcePart: part, all: [], byId: emptyMap() }
          : parseRelationships(strFromU8(relsBytes), part)
    } catch (error) {
      warnings.push(`${part} has an unreadable relationships part (${String(error)})`)
      relationships = { bySourcePart: part, all: [], byId: emptyMap() }
    }

    const converted = convertSlide({
      slideId,
      slide: slideXml,
      relationships,
      theme: pptxTheme,
      size,
      tokens,
      media: (imagePart) => {
        const image = getOwn(entries, imagePart)
        if (image === undefined) return null
        if (image.length > limits.maxInlineImageBytes) {
          conversionNotes.add(
            `an image over ${String(limits.maxInlineImageBytes)} bytes was not inlined`,
          )
          return null
        }
        if (inlinedBytes + image.length > limits.maxTotalInlineImageBytes) {
          conversionNotes.add(
            'the deck exceeded the inline-image budget; later images were dropped',
          )
          return null
        }
        const mime = contentTypeOf(graph.contentTypes, imagePart)
        // Only raster/vector types a slide may legitimately carry. An unexpected content type is
        // not forwarded into a `data:` URI: SL-S02 would accept it and the browser would sniff it.
        if (mime === undefined || !/^image\/(png|jpeg|gif|webp|bmp|svg\+xml)$/.test(mime)) {
          conversionNotes.add(`an image with content type ${mime ?? '(none)'} was not inlined`)
          return null
        }
        inlinedBytes += image.length
        return `data:${mime};base64,${Buffer.from(image).toString('base64')}`
      },
    })
    for (const note of converted.notes) conversionNotes.add(note)

    // The contract gate. A slide that fails is never admitted; it degrades to text.
    let html = converted.html
    let validation = validateSlideContract(html, ['static'])
    if (!validation.ok) {
      const texts = descendantsNamed(slideXml, 't').map((node) => node.text)
      html = fallbackSlideHtml(slideId, converted.title, texts, tokens)
      const fallbackValidation = validateSlideContract(html, ['static'])
      if (!fallbackValidation.ok) {
        return {
          ok: false,
          error: {
            code: 'unconvertible',
            message: `slide ${part} could not be converted into contract-valid HTML: ${contractErrorSummary(fallbackValidation)}`,
          },
        }
      }
      warnings.push(`${part} converted to a text-only slide: ${contractErrorSummary(validation)}`)
      validation = fallbackValidation
      fallbackCount += 1
    } else {
      convertedCount += 1
    }

    slides[slideId] = html
    slideEntries.push(
      createSlideEntry({
        id: slideId,
        title: converted.title,
        kind: index === 0 ? 'title' : 'content',
        capabilities: ['static'],
        origin: { type: 'import' },
        now: now + index,
      }),
    )
    ledgerSlides.push({ slideId, part, html })
  }

  // A template (or a presentation whose every slide failed to parse) still opens: an empty deck is
  // not a usable document, so one starter slide is created. It carries no `data-sl-run` markers and
  // is not in the ledger, so its presence forces `rebuild` on export — which is correct, because
  // the archive it would round-trip to has no slide to match it.
  if (slideEntries.length === 0) {
    const slideId = newSlideId(now)
    const html = createStarterSlideHtml({ id: slideId, title: deckTitle, tokens })
    slides[slideId] = html
    slideEntries.push(
      createSlideEntry({
        id: slideId,
        title: deckTitle,
        kind: 'title',
        capabilities: ['static'],
        origin: { type: 'template' },
        now,
      }),
    )
    warnings.push(
      graph.kind === 'template'
        ? 'template imported: masters and theme became the deck theme, and a starter slide was created'
        : 'package contained no readable slides; created a starter slide',
    )
  }

  const manifest = buildManifest(deckTitle, slideEntries, now)

  const ledger = buildLedger({
    format: formatOf(path, graph),
    fileName: basename(path),
    archiveBytes: originalBytes,
    parts: entries,
    slides: ledgerSlides,
    importedAt: new Date(now).toISOString(),
    hash: sha256Hex,
  })

  const extras = emptyMap<Uint8Array>()
  extras[ORIGINAL_ARCHIVE_ENTRY] = originalBytes
  extras[LEDGER_ENTRY] = Buffer.from(`${JSON.stringify(ledger, null, 2)}\n`, 'utf8')

  return {
    ok: true,
    bundle: { manifest, slides, notes: emptyMap<string>(), theme, extras },
    ledger,
    report: {
      sourcePath: path,
      format: ledger.source.format,
      slideCount: slideEntries.length,
      convertedCount,
      fallbackCount,
      sourceSha256,
      retainedBytes: originalBytes.length,
      partCount: Object.keys(entries).length,
      warnings,
      conversionNotes: [...conversionNotes],
    },
  }
}

function buildManifest(title: string, entries: readonly SlideEntry[], now: number): DeckManifest {
  const deck = createEmptyDeck({ title, now, theme: DEFAULT_THEME_PATH })
  const slides = Object.create(null) as Record<string, SlideEntry>
  const slideOrder: string[] = []
  for (const entry of entries) {
    slides[entry.id] = entry
    slideOrder.push(entry.id)
  }
  return { ...deck, slides, slideOrder }
}
