/**
 * DrawingML slide part → slide-contract HTML (M4.5), best effort and honest about the effort.
 *
 * ## What this converts, and what it does not
 *
 * Converts:
 *  - **Text bodies** (`p:txBody`) — paragraphs, runs, explicit line breaks and fields, with per-run
 *    size, bold, italic, underline and colour, and per-paragraph alignment and a bullet glyph.
 *  - **Pictures** (`p:pic`) — the embedded relationship is resolved to a `data:` URI by the caller's
 *    media resolver, so the result satisfies SL-S02 with no external subresource.
 *  - **Autoshapes** (`p:sp` with `a:prstGeom`) — rectangle, rounded rectangle and ellipse become
 *    styled boxes with their fill, outline and corner radius; any other preset geometry becomes a
 *    plain box carrying the shape's text, which is the part a reader actually needs.
 *  - **Groups** (`p:grpSp`) — recursed with the child-offset transform applied, so nested geometry
 *    lands in the right place.
 *  - **Theme colours** — `srgbClr` literally, `schemeClr` through the theme's colour scheme, and the
 *    four slots sloodge has tokens for are emitted as `var(--sl-*)` so a later theme change moves
 *    them.
 *
 * Falls back, and says so in `notes`:
 *  - **Tables, charts, SmartArt and embedded objects** (`p:graphicFrame`) — the text is extracted
 *    into a bordered box at the right position; the structure is not rebuilt. A chart becomes a
 *    labelled placeholder, not a chart.
 *  - **Connectors** (`p:cxnSp`) — drawn as a plain line box; arrowheads and routing are dropped.
 *  - **Effects** — shadows, glows, 3-D, gradient and picture fills, and every non-solid line style.
 *  - **Fonts** — the contract permits the system stack only (SL-S03), so a run's typeface is
 *    recorded in `data-sl-pptx-font` and not applied. This is a contract requirement rather than a
 *    shortcut: PPTX embeds font *references* by name, so a web font would not survive the round
 *    trip either.
 *  - **Placeholder geometry inherited from a layout or master.** A title or body placeholder
 *    usually carries no `a:xfrm` of its own — the position lives on the layout, which lives on the
 *    master. Resolving that chain is a real piece of work and is not done here; instead a
 *    placeholder with no geometry is given a sensible default box by its `type`, which puts titles
 *    at the top and body text under them. Expect position drift on such shapes, and note that
 *    **this is exactly the loss retention exists to make harmless**: the original bytes are kept,
 *    so an unedited export is unaffected by anything on this list.
 *
 * ## Run provenance is the load-bearing detail
 *
 * Every `<a:t>` in the part is numbered in document order and its converted element carries
 * `data-sl-run="N"`. That number is what lets `rewrite.ts` push an edit back into the *original*
 * XML by substituting one text span, leaving every other byte of the part — and every other part —
 * untouched. Without it, an edited round-trip would have to regenerate the slide part from the
 * HTML, and the part-level passthrough guarantee of M4.6 would have nothing to stand on.
 */

import { CANVAS_HEIGHT, CANVAS_WIDTH } from '../../document/types'
import { FORBIDDEN_API_TOKENS, packForApiScan } from '../../document/slide-contract'
import { escapeHtml, renderThemeBlock, SLIDE_CONTRACT_VERSION } from '../../document/starter-slide'
import {
  attribute,
  childrenNamed,
  descendantsNamed,
  firstChildNamed,
  pathNamed,
  type XmlElement,
} from '../xml'
import { resolveSchemeColor, type PptxTheme } from './theme'
import type { OpcRelationships } from './opc'
import type { SlideSizeEmu } from './opc'

export const EMU_PER_INCH = 914_400

/**
 * One matcher per forbidden token, derived from `slide-contract.ts`'s **own** list and **own**
 * normalisation rather than a copy of either.
 *
 * The first version of this restated both, and got the normalisation wrong in exactly one place:
 * it split each token on characters and joined with `\s*`, so the literal space inside
 * `new Function(` became a *required* space. SL-S04 strips all whitespace before comparing, so it
 * matched `newFunction(` while the defuser did not — and a slide whose prose read
 * `Avoid newFunction( in modern JavaScript` failed conversion, failed the text-only fallback for
 * the same reason, and took the entire deck import down as `unconvertible`. One innocuous word,
 * one unopenable presentation.
 *
 * So the token is packed with `packForApiScan` first (which is what removes that space), and *then*
 * `\s*` is inserted between every remaining character — because the validator's normalisation means
 * arbitrary whitespace may sit anywhere inside a match. `i` covers the case fold. The list itself is
 * imported, so a token added to the rule later is defused without anyone remembering to mirror it.
 */
const FORBIDDEN_TOKEN_MATCHERS: readonly RegExp[] = FORBIDDEN_API_TOKENS.map(
  (token) =>
    new RegExp(
      packForApiScan(token)
        .split('')
        .map((char) => char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        .join('\\s*'),
      'gi',
    ),
)

/**
 * Defuse SL-S04 token matches in *text content*, without changing what the text says.
 *
 * SL-S04 forbids `fetch(`, `localStorage`, `eval(` and friends by scanning the whole slide source
 * with whitespace stripped and case folded. For an authored slide that is exactly right. For an
 * *imported* one it produces a false positive on ordinary prose: a deck about JavaScript whose
 * title reads "Use fetch() instead of XMLHttpRequest" is perfectly inert — the words sit in a text
 * node, there is no `<script>` in the document at all (`capabilities: ['static']`, and SL-H01/I02
 * enforce that separately) — but the scan cannot see context and rejects it. Before this, such a
 * deck failed conversion, failed the text-only fallback for the same reason, and failed the import
 * outright with `unconvertible`. That is a real deck a real user has.
 *
 * The fix is to make the *bytes* unmatchable while leaving the *rendering* identical: the first
 * character of each occurrence becomes a numeric character reference. `fetch(` is emitted as
 * `&#102;etch(`, which a browser renders as "fetch(" and a substring scan does not match. Nothing
 * is removed, nothing is altered on screen, and no rule is weakened — a document that genuinely
 * contained script would still carry `<script>`, which SL-H01 rejects independently.
 *
 * Matching mirrors the validator's own normalisation: whitespace between characters is optional
 * (the scan strips it, so "local storage" packs to "localstorage" and would match) and the compare
 * is case-insensitive. Applied only to text nodes and only after HTML escaping, so it can never
 * introduce markup.
 */
export function defuseForbiddenTokens(escaped: string): string {
  let out = escaped
  for (const matcher of FORBIDDEN_TOKEN_MATCHERS) {
    // `lastIndex` is per-RegExp state and these are module-level `g` objects, so it must be reset
    // before each use or a second call would resume mid-string and miss an early match.
    matcher.lastIndex = 0
    out = out.replace(matcher, (match) => {
      const first = match.codePointAt(0)
      if (first === undefined) return match
      return `&#${String(first)};${match.slice(String.fromCodePoint(first).length)}`
    })
  }
  return out
}

/** HTML-escape a text node, then make it unmatchable by SL-S04's substring scan. */
function slideText(value: string): string {
  return defuseForbiddenTokens(escapeHtml(value))
}

/** Resolves an image part name to a `data:` URI, or `null` when it cannot be inlined. */
export type MediaResolver = (partName: string) => string | null

export type ConvertSlideArgs = {
  readonly slideId: string
  /** The parsed `ppt/slides/slideN.xml` root. */
  readonly slide: XmlElement
  readonly relationships: OpcRelationships
  readonly media: MediaResolver
  readonly theme: PptxTheme
  readonly size: SlideSizeEmu
  /** `--sl-*` tokens to inline, already derived from the theme. */
  readonly tokens: Readonly<Record<string, string>>
  readonly themeVersion?: number
}

export type ConvertedSlide = {
  readonly html: string
  /** The first non-empty text line, for the rail label. Falls back to `Slide`. */
  readonly title: string
  /** How many `<a:t>` elements the part holds — the domain of the `data-sl-run` indices. */
  readonly runCount: number
  /** Everything that fell back rather than converted, for the import report. */
  readonly notes: readonly string[]
}

type Box = { left: number; top: number; width: number; height: number }

type Transform = {
  /** EMU → px. */
  readonly scale: number
  /** px offsets that centre a non-16:9 slide inside the 1280x720 canvas. */
  readonly offsetX: number
  readonly offsetY: number
  /** Group child-offset correction, in EMU, applied before scaling. */
  readonly shiftEmu: { x: number; y: number }
  readonly groupScale: { x: number; y: number }
}

function intAttr(element: XmlElement | undefined, name: string): number | null {
  if (!element) return null
  const raw = attribute(element, name)
  if (raw === undefined) return null
  const value = Number.parseInt(raw, 10)
  return Number.isFinite(value) ? value : null
}

/** Round to two decimals: enough for sub-pixel placement, short enough to keep the HTML small. */
function px(value: number): string {
  return `${String(Math.round(value * 100) / 100)}px`
}

const HEX6 = /^[0-9a-fA-F]{6}$/

/**
 * The four scheme slots sloodge has tokens for. A run coloured `accent1` becomes
 * `var(--sl-accent)` rather than a frozen hex, so retheming the deck moves it — which is what
 * "theme colors → theme tokens" in the roadmap asks for. Every other slot resolves to a literal.
 */
const SLOT_TOKENS: Readonly<Record<string, string>> = Object.freeze(
  Object.assign(Object.create(null) as Record<string, string>, {
    lt1: 'var(--sl-bg)',
    bg1: 'var(--sl-bg)',
    dk1: 'var(--sl-fg)',
    tx1: 'var(--sl-fg)',
    accent1: 'var(--sl-accent)',
    dk2: 'var(--sl-muted)',
    tx2: 'var(--sl-muted)',
  }),
)

/**
 * Resolve a DrawingML colour container (`a:solidFill`, `a:fgClr`, …) to a CSS colour. Returns
 * `null` for gradient/pattern/picture fills and for `a:noFill`, which the caller renders as
 * "no background" rather than guessing a colour.
 */
function colorOf(container: XmlElement | undefined, theme: PptxTheme): string | null {
  if (!container) return null
  const srgb = firstChildNamed(container, 'srgbClr')
  if (srgb) {
    const value = attribute(srgb, 'val')
    if (value !== undefined && HEX6.test(value)) return `#${value.toLowerCase()}`
  }
  const scheme = firstChildNamed(container, 'schemeClr')
  if (scheme) {
    const value = attribute(scheme, 'val')
    if (value !== undefined) {
      const token = Object.hasOwn(SLOT_TOKENS, value) ? SLOT_TOKENS[value] : undefined
      if (token !== undefined) return token
      const literal = resolveSchemeColor(theme, value)
      if (literal !== null) return literal
    }
  }
  return null
}

function solidFillColor(spPr: XmlElement | undefined, theme: PptxTheme): string | null {
  if (!spPr) return null
  return colorOf(firstChildNamed(spPr, 'solidFill'), theme)
}

/** Emu geometry from an `a:xfrm`, in the element's own coordinate space. */
function readXfrm(xfrm: XmlElement | undefined): {
  x: number
  y: number
  cx: number
  cy: number
} | null {
  if (!xfrm) return null
  const off = firstChildNamed(xfrm, 'off')
  const ext = firstChildNamed(xfrm, 'ext')
  const x = intAttr(off, 'x')
  const y = intAttr(off, 'y')
  const cx = intAttr(ext, 'cx')
  const cy = intAttr(ext, 'cy')
  if (x === null || y === null || cx === null || cy === null) return null
  return { x, y, cx, cy }
}

function toBox(emu: { x: number; y: number; cx: number; cy: number }, transform: Transform): Box {
  const left =
    transform.offsetX + (emu.x - transform.shiftEmu.x) * transform.groupScale.x * transform.scale
  const top =
    transform.offsetY + (emu.y - transform.shiftEmu.y) * transform.groupScale.y * transform.scale
  return {
    left,
    top,
    // A negative extent is malformed; clamping to zero keeps it from inverting the box.
    width: Math.max(0, emu.cx * transform.groupScale.x * transform.scale),
    height: Math.max(0, emu.cy * transform.groupScale.y * transform.scale),
  }
}

/**
 * The default box for a placeholder with no geometry of its own. Layout/master inheritance is not
 * resolved (see the module docblock), so a title lands in the upper band and everything else in the
 * content band, stacked so two bodies do not overlap exactly.
 */
function placeholderBox(kind: string | null, index: number): Box {
  const pad = 64
  if (kind === 'title' || kind === 'ctrTitle') {
    return { left: pad, top: 72, width: CANVAS_WIDTH - pad * 2, height: 150 }
  }
  if (kind === 'sldNum' || kind === 'ftr' || kind === 'dt') {
    return { left: pad, top: CANVAS_HEIGHT - 60, width: CANVAS_WIDTH - pad * 2, height: 32 }
  }
  const top = 240 + index * 24
  return {
    left: pad,
    top: Math.min(top, CANVAS_HEIGHT - 120),
    width: CANVAS_WIDTH - pad * 2,
    height: Math.max(80, CANVAS_HEIGHT - top - pad),
  }
}

type Emitter = {
  push: (html: string) => void
  nextId: () => string
  note: (message: string) => void
  runIndex: (node: XmlElement) => number | null
  readonly theme: PptxTheme
  readonly media: MediaResolver
  readonly relationships: OpcRelationships
  readonly pxPerInch: number
  titles: string[]
}

const ALIGN: Readonly<Record<string, string>> = Object.freeze(
  Object.assign(Object.create(null) as Record<string, string>, {
    l: 'left',
    ctr: 'center',
    r: 'right',
    just: 'justify',
    dist: 'justify',
  }),
)

/** Renders one `<a:p>` paragraph into a `<p>` element. */
function emitParagraph(
  emitter: Emitter,
  paragraph: XmlElement,
  defaultColor: string | null,
  fontPxFor: (hundredthsPt: number | null) => number,
): string {
  const pPr = firstChildNamed(paragraph, 'pPr')
  const align = pPr ? attribute(pPr, 'algn') : undefined
  const alignCss =
    align !== undefined && Object.hasOwn(ALIGN, align) ? `text-align:${String(ALIGN[align])};` : ''
  const level = Number.parseInt((pPr ? attribute(pPr, 'lvl') : undefined) ?? '0', 10)
  const indent = Number.isFinite(level) && level > 0 ? `padding-left:${px(level * 28)};` : ''

  // A bullet glyph is emitted as literal text rather than a list marker: `list-style` would need a
  // <ul> wrapper the source has no equivalent of, and the glyph must not consume a run index.
  const hasBullet =
    pPr !== undefined &&
    firstChildNamed(pPr, 'buNone') === undefined &&
    (firstChildNamed(pPr, 'buChar') !== undefined ||
      firstChildNamed(pPr, 'buAutoNum') !== undefined)
  const bullet = hasBullet ? '<span class="sl-bullet">• </span>' : ''

  const pieces: string[] = []
  let maxFont = 0
  for (const child of paragraph.children) {
    if (child.local === 'br') {
      pieces.push('<br>')
      continue
    }
    // `a:r` is a normal run; `a:fld` is a field (slide number, date) and also holds an `a:t`.
    if (child.local !== 'r' && child.local !== 'fld') continue
    const text = firstChildNamed(child, 't')
    if (!text) continue
    const index = emitter.runIndex(text)
    const rPr = firstChildNamed(child, 'rPr')

    const size = fontPxFor(intAttr(rPr, 'sz'))
    maxFont = Math.max(maxFont, size)
    const styles = [`font-size:${px(size)}`]
    if (rPr && attribute(rPr, 'b') === '1') styles.push('font-weight:700')
    if (rPr && attribute(rPr, 'i') === '1') styles.push('font-style:italic')
    const underline = rPr ? attribute(rPr, 'u') : undefined
    if (underline !== undefined && underline !== 'none') styles.push('text-decoration:underline')
    const color = colorOf(rPr ? firstChildNamed(rPr, 'solidFill') : undefined, emitter.theme)
    const resolved = color ?? defaultColor
    if (resolved !== null) styles.push(`color:${resolved}`)

    // Typeface is recorded, never applied — SL-S03 permits the system stack only.
    //
    // Through `slideText`, not `escapeHtml`, and for the same reason every other imported string on
    // this path goes through it: a typeface is archive-supplied text, so a font named `localStorage`
    // would put a forbidden token into the packed slide source and fail SL-S04. Harmless in practice
    // (the slide degrades to the text-only fallback rather than failing the import, and the quote is
    // escaped either way) but it is the one emission site that was still spelled differently from the
    // others, and "one path for imported strings" is only true if it has no exceptions.
    const latin = rPr ? firstChildNamed(rPr, 'latin') : undefined
    const typeface = latin ? attribute(latin, 'typeface') : undefined
    const fontAttr =
      typeface !== undefined && typeface !== '' && typeface.length <= 128
        ? ` data-sl-pptx-font="${slideText(typeface)}"`
        : ''

    const runAttr = index === null ? '' : ` data-sl-run="${String(index)}"`
    const value = text.text
    if (value.trim() !== '') emitter.titles.push(value.trim())
    pieces.push(
      `<span data-sl-id="${emitter.nextId()}"${runAttr}${fontAttr} style="${styles.join(';')}">${slideText(value)}</span>`,
    )
  }

  if (pieces.length === 0 && bullet === '') return ''
  // Line-height is set from the largest run so a mixed-size paragraph does not clip its tall runs.
  const lineHeight =
    maxFont > 0 ? `line-height:${String(Math.round(maxFont * 1.25 * 100) / 100)}px;` : ''
  return `<p class="sl-tx" data-sl-id="${emitter.nextId()}" style="${alignCss}${indent}${lineHeight}">${bullet}${pieces.join('')}</p>`
}

function emitTextBody(
  emitter: Emitter,
  txBody: XmlElement,
  defaultColor: string | null,
  fontPxFor: (hundredthsPt: number | null) => number,
): string {
  const bodyPr = firstChildNamed(txBody, 'bodyPr')
  const anchor = bodyPr ? attribute(bodyPr, 'anchor') : undefined
  const justify = anchor === 'ctr' ? 'center' : anchor === 'b' ? 'flex-end' : 'flex-start'
  const paragraphs = childrenNamed(txBody, 'p')
    .map((paragraph) => emitParagraph(emitter, paragraph, defaultColor, fontPxFor))
    .filter((html) => html !== '')
  if (paragraphs.length === 0) return ''
  return `<div class="sl-body" data-sl-id="${emitter.nextId()}" style="display:flex;flex-direction:column;justify-content:${justify}">${paragraphs.join('')}</div>`
}

/** The preset geometries that map onto a CSS box; everything else becomes a plain box. */
function radiusFor(preset: string | undefined, box: Box): string {
  if (preset === 'ellipse') return `border-radius:50%;`
  if (preset === 'roundRect') return `border-radius:${px(Math.min(box.width, box.height) * 0.12)};`
  return ''
}

function emitShape(emitter: Emitter, sp: XmlElement, transform: Transform, index: number): void {
  const spPr = firstChildNamed(sp, 'spPr')
  const nv = firstChildNamed(sp, 'nvSpPr')
  const ph = nv ? pathNamed(nv, 'nvPr', 'ph') : undefined
  const phType = ph ? (attribute(ph, 'type') ?? 'body') : null

  const emu = readXfrm(spPr ? firstChildNamed(spPr, 'xfrm') : undefined)
  const box = emu ? toBox(emu, transform) : placeholderBox(phType, index)
  if (!emu && phType !== null) {
    emitter.note(
      `placeholder "${phType}" has no explicit geometry; positioned with a default box (layout inheritance is not resolved)`,
    )
  }

  const fill = solidFillColor(spPr, emitter.theme)
  const noFill = spPr ? firstChildNamed(spPr, 'noFill') !== undefined : false
  const preset = spPr ? attribute(firstChildNamed(spPr, 'prstGeom') ?? sp, 'prst') : undefined
  if (spPr && firstChildNamed(spPr, 'gradFill') !== undefined) {
    emitter.note('gradient fill flattened (solid colour or none)')
  }
  if (spPr && firstChildNamed(spPr, 'blipFill') !== undefined) {
    emitter.note('picture fill on a shape is not converted')
  }

  const line = spPr ? firstChildNamed(spPr, 'ln') : undefined
  const lineColor = line ? colorOf(firstChildNamed(line, 'solidFill'), emitter.theme) : null
  const lineWidthEmu = intAttr(line, 'w')
  const border =
    lineColor !== null
      ? `border:${px(Math.max(1, (lineWidthEmu ?? 9525) * transform.scale))} solid ${lineColor};`
      : ''

  const styles =
    `position:absolute;left:${px(box.left)};top:${px(box.top)};` +
    `width:${px(box.width)};height:${px(box.height)};overflow:hidden;` +
    (fill !== null && !noFill ? `background:${fill};` : '') +
    radiusFor(preset, box) +
    border

  const txBody = firstChildNamed(sp, 'txBody')
  const fontPxFor = makeFontSizer(emitter.pxPerInch, phType)
  const inner = txBody ? emitTextBody(emitter, txBody, null, fontPxFor) : ''
  if (inner === '' && fill === null && lineColor === null) return // nothing visible to emit
  emitter.push(
    `<div class="sl-shape" data-sl-id="${emitter.nextId()}" style="${styles}">${inner}</div>`,
  )
}

function emitPicture(emitter: Emitter, pic: XmlElement, transform: Transform, index: number): void {
  const spPr = firstChildNamed(pic, 'spPr')
  const emu = readXfrm(spPr ? firstChildNamed(spPr, 'xfrm') : undefined)
  const box = emu ? toBox(emu, transform) : placeholderBox('pic', index)

  const blip = pathNamed(pic, 'blipFill', 'blip')
  const embed = blip ? attribute(blip, 'r:embed') : undefined
  let dataUrl: string | null = null
  if (embed !== undefined) {
    const rel = Object.hasOwn(emitter.relationships.byId, embed)
      ? emitter.relationships.byId[embed]
      : undefined
    if (rel === undefined) emitter.note(`picture references unknown relationship ${embed}`)
    else if (rel.external) emitter.note(`picture ${embed} is an external link and was dropped`)
    else if (rel.resolved !== null) dataUrl = emitter.media(rel.resolved)
  }

  const styles = `position:absolute;left:${px(box.left)};top:${px(box.top)};width:${px(box.width)};height:${px(box.height)};overflow:hidden;`
  if (dataUrl === null) {
    emitter.note('an image could not be inlined and was replaced with a placeholder box')
    emitter.push(
      `<div class="sl-shape sl-missing-image" data-sl-id="${emitter.nextId()}" style="${styles}border:1px dashed var(--sl-muted);"></div>`,
    )
    return
  }
  // `data:` only — SL-S02 rejects anything else, and the resolver never produces another scheme.
  emitter.push(
    `<img data-sl-id="${emitter.nextId()}" alt="" src="${escapeHtml(dataUrl)}" style="${styles}object-fit:contain;">`,
  )
}

function emitGraphicFrame(
  emitter: Emitter,
  frame: XmlElement,
  transform: Transform,
  index: number,
): void {
  const emu = readXfrm(firstChildNamed(frame, 'xfrm'))
  const box = emu ? toBox(emu, transform) : placeholderBox('body', index)
  const uri = pathNamed(frame, 'graphic', 'graphicData')
  const kind = uri ? (attribute(uri, 'uri') ?? '').split('/').pop() : undefined
  emitter.note(
    `graphic frame (${kind ?? 'unknown'}) converted to a text placeholder; tables, charts and SmartArt keep their text but not their structure`,
  )

  const fontPxFor = makeFontSizer(emitter.pxPerInch, null)
  // A graphicFrame's text still lives in `a:t` elements, so the run indices stay consistent with
  // the rest of the part — an edit inside a table cell is still expressible as a text substitution.
  const paragraphs = descendantsNamed(frame, 'p')
    .map((paragraph) => emitParagraph(emitter, paragraph, null, fontPxFor))
    .filter((html) => html !== '')
  const styles =
    `position:absolute;left:${px(box.left)};top:${px(box.top)};width:${px(box.width)};height:${px(box.height)};` +
    `overflow:hidden;border:1px solid var(--sl-muted);padding:8px;`
  emitter.push(
    `<div class="sl-shape sl-graphic" data-sl-id="${emitter.nextId()}" style="${styles}">${paragraphs.join('')}</div>`,
  )
}

/**
 * Default run sizes, in hundredths of a point, for text that declares none.
 *
 * A run's `sz` is optional and normally inherited from the placeholder's list style on the layout,
 * which inherits from the master. That chain is not resolved (see the module docblock), so a
 * missing `sz` needs a default — and one flat default is visibly wrong, because it renders a title
 * at body size and the slide reads as an undifferentiated wall of text. Keying the default off the
 * placeholder type recovers the *hierarchy* even though it cannot recover the exact value, which is
 * the part a reader actually needs. A run with an explicit `sz` is unaffected.
 */
const DEFAULT_SIZE_BY_PLACEHOLDER: Readonly<Record<string, number>> = Object.freeze(
  Object.assign(Object.create(null) as Record<string, number>, {
    ctrTitle: 4400,
    title: 4000,
    subTitle: 2400,
    body: 2000,
    sldNum: 1200,
    ftr: 1200,
    dt: 1200,
  }),
)

const DEFAULT_SIZE_HUNDREDTHS = 1800

function makeFontSizer(
  pxPerInch: number,
  placeholder: string | null,
): (hundredthsPt: number | null) => number {
  const fallback =
    placeholder !== null && Object.hasOwn(DEFAULT_SIZE_BY_PLACEHOLDER, placeholder)
      ? (DEFAULT_SIZE_BY_PLACEHOLDER[placeholder] ?? DEFAULT_SIZE_HUNDREDTHS)
      : DEFAULT_SIZE_HUNDREDTHS
  return (hundredthsPt) => {
    const points = (hundredthsPt ?? fallback) / 100
    // Clamped: a corrupt `sz` of 0 renders invisible text and a huge one blows the layout.
    const bounded = Math.min(Math.max(points, 1), 400)
    return (bounded / 72) * pxPerInch
  }
}

function walkTree(emitter: Emitter, parent: XmlElement, transform: Transform, depth: number): void {
  if (depth > 32) {
    emitter.note('shape tree nests deeper than 32 groups; the remainder was skipped')
    return
  }
  let index = 0
  for (const node of parent.children) {
    switch (node.local) {
      case 'sp':
        emitShape(emitter, node, transform, index)
        index += 1
        break
      case 'pic':
        emitPicture(emitter, node, transform, index)
        index += 1
        break
      case 'graphicFrame':
        emitGraphicFrame(emitter, node, transform, index)
        index += 1
        break
      case 'cxnSp': {
        // A connector is a shape without text; render its outline so the diagram still reads.
        emitShape(emitter, node, transform, index)
        emitter.note('connector rendered as a plain box; arrowheads and routing are dropped')
        index += 1
        break
      }
      case 'grpSp': {
        // A group's own `a:xfrm` carries both its placement (`off`/`ext`) and the coordinate space
        // its children are authored in (`chOff`/`chExt`). Children are therefore shifted by
        // `chOff` and scaled by `ext/chExt` before the slide-level transform applies.
        const grpSpPr = firstChildNamed(node, 'grpSpPr')
        const xfrm = grpSpPr ? firstChildNamed(grpSpPr, 'xfrm') : undefined
        const own = readXfrm(xfrm)
        const chOff = firstChildNamed(xfrm ?? node, 'chOff')
        const chExt = firstChildNamed(xfrm ?? node, 'chExt')
        const childX = intAttr(chOff, 'x') ?? 0
        const childY = intAttr(chOff, 'y') ?? 0
        const childCx = intAttr(chExt, 'cx')
        const childCy = intAttr(chExt, 'cy')
        const scaleX = own && childCx && childCx > 0 ? own.cx / childCx : 1
        const scaleY = own && childCy && childCy > 0 ? own.cy / childCy : 1
        const nested: Transform = {
          ...transform,
          shiftEmu: {
            x: childX - (own ? own.x / (scaleX || 1) : 0),
            y: childY - (own ? own.y / (scaleY || 1) : 0),
          },
          groupScale: {
            x: transform.groupScale.x * scaleX,
            y: transform.groupScale.y * scaleY,
          },
        }
        walkTree(emitter, node, nested, depth + 1)
        index += 1
        break
      }
      default:
        break
    }
  }
}

export function convertSlide(args: ConvertSlideArgs): ConvertedSlide {
  const notes = new Set<string>()
  const parts: string[] = []
  let idCounter = 0

  // Document-order index of every `<a:t>` in the part. `rewrite.ts` scans the raw source text for
  // the same elements in the same order, and a unit test pins the two scans against each other —
  // if they ever disagreed, an edit would be written into the wrong text span.
  const textNodes = descendantsNamed(args.slide, 't')
  const runIndexOf = new Map<XmlElement, number>()
  textNodes.forEach((node, index) => runIndexOf.set(node, index))

  const scale = Math.min(CANVAS_WIDTH / args.size.widthEmu, CANVAS_HEIGHT / args.size.heightEmu)
  const transform: Transform = {
    scale,
    offsetX: (CANVAS_WIDTH - args.size.widthEmu * scale) / 2,
    offsetY: (CANVAS_HEIGHT - args.size.heightEmu * scale) / 2,
    shiftEmu: { x: 0, y: 0 },
    groupScale: { x: 1, y: 1 },
  }

  const emitter: Emitter = {
    push: (html) => parts.push(html),
    nextId: () => {
      idCounter += 1
      return `e_${idCounter.toString(16).padStart(3, '0')}`
    },
    note: (message) => notes.add(message),
    runIndex: (node) => runIndexOf.get(node) ?? null,
    theme: args.theme,
    media: args.media,
    relationships: args.relationships,
    pxPerInch: EMU_PER_INCH * scale,
    titles: [],
  }

  const spTree = pathNamed(args.slide, 'cSld', 'spTree')
  if (spTree) walkTree(emitter, spTree, transform, 0)
  else notes.add('slide has no shape tree; imported as an empty slide')

  // Compared with a relative tolerance, not for equality. `Inches(13.333)` rounds to 12192019 EMU
  // rather than the exact 12192000, so an exact test calls a genuinely 16:9 deck non-16:9 and
  // attaches a misleading note to every import from python-pptx and from PowerPoint's own
  // "Widescreen" preset. 0.5% is far below a visible letterbox and far above any rounding.
  const sourceAspect = args.size.widthEmu / args.size.heightEmu
  const canvasAspect = CANVAS_WIDTH / CANVAS_HEIGHT
  if (Math.abs(sourceAspect - canvasAspect) / canvasAspect > 0.005) {
    notes.add(
      'source slide is not 16:9; content is scaled to fit and centred, leaving bars at the edges',
    )
  }

  const title = emitter.titles[0]?.slice(0, 200) ?? 'Slide'
  const themeVersion = args.themeVersion ?? 1

  const html = `<!doctype html>
<html lang="en" data-sl-slide="${escapeHtml(args.slideId)}" data-sl-contract="${String(SLIDE_CONTRACT_VERSION)}" data-sl-origin="pptx">
<head>
<meta charset="utf-8">
<title>${slideText(title)}</title>
<style>
${renderThemeBlock(args.tokens, themeVersion)}
  *, *::before, *::after { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; background: var(--sl-bg); }
  .slide {
    width: ${String(CANVAS_WIDTH)}px;
    height: ${String(CANVAS_HEIGHT)}px;
    overflow: hidden;
    position: relative;
    box-sizing: border-box;
    background: var(--sl-bg);
    color: var(--sl-fg);
    font-family: var(--sl-font);
  }
  .sl-tx { margin: 0; }
  .sl-bullet { opacity: 0.7; }
  [data-sl-freeze] * { animation-play-state: paused !important; }
</style>
</head>
<body>
<div class="slide" data-sl-id="e_root">
${parts.map((part) => `  ${part}`).join('\n')}
</div>
</body>
</html>
`

  return { html, title, runCount: textNodes.length, notes: [...notes] }
}
