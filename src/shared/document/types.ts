/**
 * The `.sloodge` manifest schema — the normative form of §2 of
 * `.claude/plans/init/30-slide-format.md`.
 *
 * Two layers live here:
 *
 *  1. **Shape** — zod mirrors of the published JSON Schema (`deck-1.json`), including the
 *     `additionalProperties: true` posture: every object that the spec marks open is a
 *     `z.looseObject`, so unknown keys written by a newer Sloodge survive a parse → save
 *     round-trip through this one (§5.2 "unknown fields are preserved").
 *  2. **Cross-field invariants** — the four rules the spec calls out as "checked on load, not
 *     expressible in JSON Schema" (§2.2), encoded as refinements so a manifest is either valid
 *     or rejected with a pointed issue path. That includes the `slideOrder` permutation rule,
 *     the `slides[k].id === k` rule, and archive-path shape checks that reject zip-slip.
 *
 * `src/shared` stays free of Node and Electron: everything below is pure data validation.
 */

import { z } from 'zod'

/** Highest `formatVersion` this build can read and write (§5.2). */
export const MAX_FORMAT_VERSION = 1

/** v1 canvas is fixed; the object exists so v2 can relax it. */
export const CANVAS_WIDTH = 1280
export const CANVAS_HEIGHT = 720

/** Spec defaults. Kept as constants rather than zod `.default()`s so that parsing never */
/** injects keys the file did not contain — that fidelity is what makes round-trips exact. */
export const DEFAULT_SLIDE_KIND = 'content'
export const DEFAULT_SLIDE_HIDDEN = false
export const DEFAULT_THEME_PATH = 'theme/theme.json'
export const MANIFEST_ENTRY = 'manifest.json'
export const MIMETYPE_ENTRY = 'mimetype'
export const DECK_MIMETYPE = 'application/vnd.sloodge.deck+zip'

/** Crockford base32, ULID alphabet (no I, L, O, U). */
const ULID_BODY = '[0-9A-HJKMNP-TV-Z]{26}'

export const DECK_ID_PATTERN = new RegExp(`^d_${ULID_BODY}$`)
export const SLIDE_ID_PATTERN = new RegExp(`^s_${ULID_BODY}$`)
export const ASSET_ID_PATTERN = new RegExp(`^a_${ULID_BODY}$`)
export const THEME_ID_PATTERN = new RegExp(`^t_${ULID_BODY}$`)

export const SLIDE_FILE_PATTERN = new RegExp(`^slides/s_${ULID_BODY}\\.html$`)
export const NOTES_FILE_PATTERN = new RegExp(`^notes/s_${ULID_BODY}\\.md$`)

/**
 * §1.1: zip entry names are forward-slash, relative, and never escape the archive root.
 * This is the zip-slip gate — it runs on every path the manifest references and, in the
 * store, on every entry name actually present in the archive.
 *
 * `__proto__` is rejected as a path segment on top of the spec's list. It is not a traversal
 * risk, it is a *pollution* risk: an archive entry, manifest key or asset path named
 * `__proto__` mutates the prototype of any plain object it is assigned into, in this codebase
 * and in every downstream consumer that keys a map by archive path. Every other
 * `Object.prototype` name (`constructor`, `toString`, `valueOf`, …) is a perfectly legal file
 * name and is *not* rejected — those are handled by keying with null-prototype maps and
 * `Object.hasOwn`, never by `in` or a bare index. See store.ts.
 */
export function isSafeArchivePath(value: string): boolean {
  if (value.length === 0 || value.length > 1024) return false
  if (value.includes('\\')) return false // backslash separators / UNC
  if (value.includes('\0')) return false
  if (value.startsWith('/')) return false // absolute
  if (/^[a-zA-Z]:/.test(value)) return false // windows drive letter
  if (value.endsWith('/')) return false // directory entry, not a file
  return value
    .split('/')
    .every(
      (segment) => segment !== '' && segment !== '.' && segment !== '..' && segment !== '__proto__',
    )
}

const archivePath = z
  .string()
  .refine(isSafeArchivePath, { message: 'archive path escapes the deck root or is malformed' })

export const SlideIdSchema = z.string().regex(SLIDE_ID_PATTERN, 'not a slide id (s_ + ULID)')
export const DeckIdSchema = z.string().regex(DECK_ID_PATTERN, 'not a deck id (d_ + ULID)')
export const AssetIdSchema = z.string().regex(ASSET_ID_PATTERN, 'not an asset id (a_ + ULID)')

export const TransitionSchema = z.enum(['none', 'fade', 'slide-left', 'slide-right', 'zoom'])

export const SlideKindSchema = z.enum([
  'title',
  'content',
  'comparison',
  'chart',
  'animation',
  'section',
  'blank',
  'custom',
])

export const CapabilitySchema = z.enum([
  'static',
  'css-animation',
  'smil-animation',
  'interactive-js',
])

export const ValidationIssueSchema = z.looseObject({
  rule: z.string().regex(/^SL-[A-Z]\d{2}$/, 'not a lint rule id (SL-X00)'),
  severity: z.enum(['error', 'warn', 'info']),
  message: z.string(),
  selector: z.string().optional(),
  line: z.number().int().min(1).optional(),
})

export const SlideValidationSchema = z.looseObject({
  status: z.enum(['pass', 'warn', 'fail', 'unknown']),
  checkedAt: z.iso.datetime().optional(),
  contentHash: z
    .string()
    .regex(/^sha256:[0-9a-f]{64}$/, 'contentHash must be sha256:<64 hex>')
    .optional(),
  issues: z.array(ValidationIssueSchema).optional(),
})

export const SlideOriginSchema = z.looseObject({
  type: z.enum(['agent', 'user', 'import', 'template']).optional(),
  skill: z.enum(['slide-deck', 'svg-animation', 'interactive-graph']).optional(),
  sessionId: z.string().optional(),
  prompt: z.string().max(4000).optional(),
})

export const AdvanceSchema = z.looseObject({
  mode: z.enum(['manual', 'auto']).optional(),
  afterMs: z.number().int().min(250).max(600_000).optional(),
})

export const SlideEntrySchema = z
  .looseObject({
    id: SlideIdSchema,
    file: z.string().regex(SLIDE_FILE_PATTERN, 'slide file must be slides/<slideId>.html'),
    title: z.string().max(200),
    kind: SlideKindSchema.optional(),
    capabilities: z.array(CapabilitySchema).optional(),
    notes: z.string().regex(NOTES_FILE_PATTERN, 'notes file must be notes/<slideId>.md').optional(),
    thumb: archivePath.optional(),
    createdAt: z.iso.datetime().optional(),
    updatedAt: z.iso.datetime().optional(),
    origin: SlideOriginSchema.optional(),
    validation: SlideValidationSchema.optional(),
    hidden: z.boolean().optional(),
    transition: TransitionSchema.optional(),
    advance: AdvanceSchema.optional(),
  })
  .superRefine((slide, ctx) => {
    if (slide.capabilities && new Set(slide.capabilities).size !== slide.capabilities.length) {
      ctx.addIssue({
        code: 'custom',
        path: ['capabilities'],
        message: 'capabilities must be unique',
      })
    }
    if (slide.file !== `slides/${slide.id}.html`) {
      ctx.addIssue({
        code: 'custom',
        path: ['file'],
        message: `file must be slides/${slide.id}.html`,
      })
    }
    if (slide.notes !== undefined && slide.notes !== `notes/${slide.id}.md`) {
      ctx.addIssue({
        code: 'custom',
        path: ['notes'],
        message: `notes must be notes/${slide.id}.md`,
      })
    }
  })

export const AssetEntrySchema = z.looseObject({
  file: archivePath,
  mime: z.string(),
  bytes: z.number().int().min(0).optional(),
  sha256: z.string().optional(),
})

export const CanvasSchema = z.looseObject({
  width: z.literal(CANVAS_WIDTH),
  height: z.literal(CANVAS_HEIGHT),
})

export const GeneratorSchema = z.looseObject({
  app: z.string(),
  version: z.string(),
})

export const PresentationSchema = z.looseObject({
  defaultTransition: TransitionSchema.optional(),
  loop: z.boolean().optional(),
  showSlideNumbers: z.boolean().optional(),
})

const DeckManifestShapeSchema = z.looseObject({
  $schema: z.string().optional(),
  formatVersion: z.literal(MAX_FORMAT_VERSION),
  id: DeckIdSchema,
  title: z.string().min(1).max(200),
  subtitle: z.string().max(300).optional(),
  authors: z.array(z.string()).optional(),
  createdAt: z.iso.datetime().optional(),
  updatedAt: z.iso.datetime().optional(),
  generator: GeneratorSchema.optional(),
  canvas: CanvasSchema,
  theme: archivePath.optional(),
  slideOrder: z.array(SlideIdSchema),
  slides: z.record(SlideIdSchema, SlideEntrySchema),
  assets: z.record(AssetIdSchema, AssetEntrySchema).optional(),
  presentation: PresentationSchema.optional(),
})

/**
 * The full manifest, shape + the cross-field invariants of §2.2 that JSON Schema cannot express.
 * Invariant 3 (referenced files exist) and 4 (no zip entry escapes the root) are archive-level
 * facts, so the *path shape* half lives here and the *existence* half lives in the store.
 */
export const DeckManifestSchema = DeckManifestShapeSchema.superRefine((manifest, ctx) => {
  const ids = Object.keys(manifest.slides)

  // Invariant 1: slideOrder is a permutation of Object.keys(slides).
  const seen = new Set<string>()
  for (const [index, id] of manifest.slideOrder.entries()) {
    if (seen.has(id)) {
      ctx.addIssue({
        code: 'custom',
        path: ['slideOrder', index],
        message: `duplicate slide id in slideOrder: ${id}`,
      })
    }
    seen.add(id)
    if (!Object.hasOwn(manifest.slides, id)) {
      ctx.addIssue({
        code: 'custom',
        path: ['slideOrder', index],
        message: `slideOrder references unknown slide: ${id}`,
      })
    }
  }
  for (const id of ids) {
    if (!seen.has(id)) {
      ctx.addIssue({
        code: 'custom',
        path: ['slideOrder'],
        message: `slide missing from slideOrder: ${id}`,
      })
    }
  }

  // Invariant 2: slides[k].id === k.
  for (const id of ids) {
    const slide = manifest.slides[id]
    if (slide && slide.id !== id) {
      ctx.addIssue({
        code: 'custom',
        path: ['slides', id, 'id'],
        message: `slide key ${id} does not match its id ${slide.id}`,
      })
    }
  }
})

export type SlideId = z.infer<typeof SlideIdSchema>
export type DeckId = z.infer<typeof DeckIdSchema>
export type AssetId = z.infer<typeof AssetIdSchema>
export type SlideKind = z.infer<typeof SlideKindSchema>
export type SlideCapability = z.infer<typeof CapabilitySchema>
export type SlideTransition = z.infer<typeof TransitionSchema>
export type SlideValidation = z.infer<typeof SlideValidationSchema>
export type SlideValidationIssue = z.infer<typeof ValidationIssueSchema>
export type SlideOrigin = z.infer<typeof SlideOriginSchema>
export type SlideEntry = z.infer<typeof SlideEntrySchema>
export type AssetEntry = z.infer<typeof AssetEntrySchema>
export type DeckCanvas = z.infer<typeof CanvasSchema>
export type DeckPresentation = z.infer<typeof PresentationSchema>
export type DeckManifest = z.infer<typeof DeckManifestSchema>

export type ManifestIssue = { path: string; message: string }

export type ParseManifestResult =
  { ok: true; manifest: DeckManifest } | { ok: false; issues: ManifestIssue[] }

/**
 * `JSON.parse` creates a genuine *own* `__proto__` property, unlike an object literal. Anything
 * downstream that spreads or index-assigns such a key (`{...slides}`, `out[id] = …`) mutates a
 * prototype instead of storing data — and zod itself drops the key silently rather than
 * reporting it, so validation alone would let it vanish. Reject the document instead: no legal
 * `.sloodge` needs the key, and a silent drop is data loss we would not be able to explain.
 *
 * Iterative rather than recursive so a deeply nested hostile document cannot blow the stack.
 */
function findProtoKey(value: unknown): string | null {
  const stack: { node: unknown; path: string }[] = [{ node: value, path: '' }]
  const seen = new Set<object>()
  while (stack.length > 0) {
    const { node, path } = stack.pop()!
    if (typeof node !== 'object' || node === null) continue
    if (seen.has(node)) continue
    seen.add(node)
    if (Array.isArray(node)) {
      for (const [index, item] of node.entries()) {
        stack.push({ node: item, path: `${path}${path ? '.' : ''}${String(index)}` })
      }
      continue
    }
    for (const key of Object.getOwnPropertyNames(node)) {
      const child = `${path}${path ? '.' : ''}${key}`
      if (key === '__proto__') return child
      stack.push({ node: (node as Record<string, unknown>)[key], path: child })
    }
  }
  return null
}

const PROTO_KEY_MESSAGE = '__proto__ is not a permitted key'

/**
 * zod hands back plain objects, so `manifest.slides` would arrive with `Object.prototype` on it
 * and `slides['constructor']` would resolve to a function. Re-key it into a null-prototype map at
 * the boundary, so that every consumer of a *parsed* manifest — deck.ts, the store, M1.2's
 * command layer — is safe by construction and not merely by discipline. See deck.ts's header.
 */
function withNullProtoSlides(manifest: DeckManifest): DeckManifest {
  const slides = Object.create(null) as Record<string, SlideEntry>
  for (const key of Object.keys(manifest.slides)) slides[key] = manifest.slides[key]!
  return { ...manifest, slides }
}

/** Parse an untrusted manifest value. Never throws; issues carry a dotted path for the UI. */
export function parseManifest(value: unknown): ParseManifestResult {
  const proto = findProtoKey(value)
  if (proto !== null) return { ok: false, issues: [{ path: proto, message: PROTO_KEY_MESSAGE }] }
  const result = DeckManifestSchema.safeParse(value)
  if (result.success) return { ok: true, manifest: withNullProtoSlides(result.data) }
  return {
    ok: false,
    issues: result.error.issues.map((issue) => ({
      path: issue.path.map(String).join('.'),
      message: issue.message,
    })),
  }
}

/**
 * Read just enough of an unknown manifest to decide whether we are allowed to open it at all
 * (§5.2). Runs *before* the full parse so a future v2 file yields "saved by a newer Sloodge"
 * rather than a wall of schema errors.
 */
export const FormatVersionProbeSchema = z.looseObject({
  formatVersion: z.number().int().min(1),
})

export function probeFormatVersion(value: unknown): number | null {
  const result = FormatVersionProbeSchema.safeParse(value)
  return result.success ? result.data.formatVersion : null
}

/* ------------------------------------------------------------------------------------------ *
 * theme/theme.json — §4.2
 * ------------------------------------------------------------------------------------------ */

/** Highest `formatVersion` this build can read in a `theme.json` (§4.2). */
export const MAX_THEME_FORMAT_VERSION = 1

/** §4.2: `#rgb`, `#rrggbb` or `#rrggbbaa`. */
export const HEX_COLOR_PATTERN = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/

export const ThemeIdSchema = z.string().regex(THEME_ID_PATTERN, 'not a theme id (t_ + ULID)')

const hexColor = z
  .string()
  .regex(HEX_COLOR_PATTERN, 'must be a hex color (#rgb, #rrggbb or #rrggbbaa)')

/**
 * `additionalProperties: { pattern: hex }` in the published schema — so a v2 build may add
 * `tokens.color.info` and this build still accepts it, but only if it is really a color.
 */
export const ThemeColorsSchema = z
  .object({
    bg: hexColor,
    fg: hexColor,
    accent: hexColor,
    muted: hexColor,
    accentFg: hexColor.optional(),
    surface: hexColor.optional(),
    border: hexColor.optional(),
    ok: hexColor.optional(),
    warn: hexColor.optional(),
    danger: hexColor.optional(),
  })
  .catchall(hexColor)

export const ThemeFontsSchema = z.looseObject({
  sans: z.string().min(1).optional(),
  mono: z.string().min(1).optional(),
})

/** px sizes, bounded by the SL-C* type-scale rules of §3.2 — a theme cannot make slides fail lint. */
export const ThemeSizesSchema = z.looseObject({
  titleHero: z.number().int().min(64).max(88).optional(),
  title: z.number().int().min(40).max(48).optional(),
  heading: z.number().int().min(26).max(30).optional(),
  body: z.number().int().min(20).max(24).optional(),
  caption: z.number().int().min(16).max(18).optional(),
})

export const ThemeSpaceSchema = z.looseObject({
  pad: z.number().int().min(48).optional(),
  gap: z.number().int().min(8).optional(),
  radius: z.number().int().min(0).max(32).optional(),
})

export const ThemeTokensSchema = z.looseObject({
  color: ThemeColorsSchema,
  /** Categorical chart palette (§4.2): 3–8 entries, never red/green-only. */
  series: z.array(hexColor).min(3).max(8).optional(),
  font: ThemeFontsSchema,
  size: ThemeSizesSchema,
  space: ThemeSpaceSchema,
})

export const ThemeSchema = z.looseObject({
  $schema: z.string().optional(),
  formatVersion: z.literal(MAX_THEME_FORMAT_VERSION),
  id: ThemeIdSchema,
  name: z.string().min(1).max(200),
  mode: z.enum(['light', 'dark']),
  /** The accent hex the palette was derived from (§4.3). */
  derivedFrom: hexColor.optional(),
  tokens: ThemeTokensSchema,
  /** Bumped on every edit; matched against the `sl:theme` sentinel `v=` in slide CSS (§4.1). */
  version: z.number().int().min(1).optional(),
})

export type ThemeColors = z.infer<typeof ThemeColorsSchema>
export type ThemeTokens = z.infer<typeof ThemeTokensSchema>
export type Theme = z.infer<typeof ThemeSchema>

export type ParseThemeResult = { ok: true; theme: Theme } | { ok: false; issues: ManifestIssue[] }

/** Parse an untrusted `theme.json` value. Never throws; mirrors `parseManifest`. */
export function parseTheme(value: unknown): ParseThemeResult {
  const proto = findProtoKey(value)
  if (proto !== null) return { ok: false, issues: [{ path: proto, message: PROTO_KEY_MESSAGE }] }
  const result = ThemeSchema.safeParse(value)
  if (result.success) return { ok: true, theme: result.data }
  return {
    ok: false,
    issues: result.error.issues.map((issue) => ({
      path: issue.path.map(String).join('.'),
      message: issue.message,
    })),
  }
}

/** Canonical archive paths for a slide's satellite files. */
export function slideFilePath(id: SlideId): string {
  return `slides/${id}.html`
}

export function notesFilePath(id: SlideId): string {
  return `notes/${id}.md`
}

export function thumbFilePath(id: SlideId): string {
  return `thumbs/${id}.webp`
}
