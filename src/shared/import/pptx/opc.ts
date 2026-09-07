/**
 * The OPC (Open Packaging Conventions) layer of PPTX import (M4.5): part naming, `[Content_Types]`,
 * relationships, and the walk from the package root to an ordered list of slide parts.
 *
 * The zip *container* is already handled — `src/main/document/archive.ts` validated entry names,
 * sizes and symlinks before a byte was inflated, so everything here operates on an entry map that
 * has passed M1.1's eight rounds of hardening. What is left is the hazards OPC adds on top of zip,
 * and they are real:
 *
 *  - **Relationship targets are a second path language.** A `.rels` file names its target
 *    *relative to the referencing part's directory*, so `../media/image1.png` inside
 *    `ppt/slides/_rels/slide1.xml.rels` legitimately resolves to `ppt/media/image1.png`. That
 *    means `..` is normal here, and the zip layer's flat "no `..` in an entry name" rule does not
 *    transfer: resolution has to happen, and then the *result* has to be checked for escaping the
 *    package root. `resolveRelationshipTarget` is that check, and it returns `null` rather than a
 *    sanitized path so a caller cannot accidentally proceed with something almost-safe.
 *  - **A target may be external.** `TargetMode="External"` names a URL — a hyperlink, a linked
 *    image, a remote OLE object. Those are never fetched (this module has no I/O) and never become
 *    subresources: the slide contract's SL-S01 forbids off-document references outright, so an
 *    external target is recorded and dropped.
 *  - **Part names are object keys.** Same discipline as the zip layer: null-prototype maps,
 *    `Object.hasOwn` lookups, never `name in map`.
 *  - **The graph can be adversarial.** Relationship counts, `sldIdLst` length and the number of
 *    parts are all capped, and slide resolution deduplicates: a presentation naming the same slide
 *    part a thousand times must not produce a thousand slides.
 *
 * Everything here is pure — entries in, structure out — so the whole layer is unit-testable
 * without touching a filesystem.
 */

import {
  attribute,
  childrenNamed,
  descendantsNamed,
  parseXml,
  XmlParseError,
  type ParseXmlOptions,
  type XmlElement,
} from '../xml'

export const CONTENT_TYPES_PART = '[Content_Types].xml'
export const PACKAGE_RELS_PART = '_rels/.rels'

/** The relationship types this importer follows. */
export const RT_OFFICE_DOCUMENT =
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument'
export const RT_SLIDE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide'
export const RT_SLIDE_MASTER =
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster'
export const RT_THEME = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme'

/** The content types that mark a package as a presentation (`.pptx`) or a template (`.potx`). */
export const CT_PRESENTATION_MAIN =
  'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml'
export const CT_TEMPLATE_MAIN =
  'application/vnd.openxmlformats-officedocument.presentationml.template.main+xml'
export const CT_SLIDESHOW_MAIN =
  'application/vnd.openxmlformats-officedocument.presentationml.slideshow.main+xml'

export type OpcLimits = {
  /** Relationships in any one `.rels` part. */
  maxRelationships: number
  /** Entries in `sldIdLst`, i.e. slides the presentation claims. */
  maxSlides: number
  /** Content-type Default/Override rules. */
  maxContentTypeRules: number
}

export const DEFAULT_OPC_LIMITS: OpcLimits = {
  maxRelationships: 4096,
  maxSlides: 2048,
  maxContentTypeRules: 4096,
}

export class OpcError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'OpcError'
  }
}

export type OpcRelationship = {
  readonly id: string
  readonly type: string
  /** The raw `Target` attribute, unresolved. */
  readonly target: string
  readonly external: boolean
  /**
   * The target resolved against the source part's directory and checked for escaping the package
   * root — `null` for an external target, and `null` for one that escaped (which is a rejection,
   * not a silent repair; `readSlideGraph` refuses a package containing one).
   */
  readonly resolved: string | null
}

export type OpcRelationships = {
  readonly bySourcePart: string
  readonly all: readonly OpcRelationship[]
  readonly byId: Readonly<Record<string, OpcRelationship>>
}

function emptyMap<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>
}

function getOwn<T>(map: Record<string, T>, key: string): T | undefined {
  return Object.hasOwn(map, key) ? map[key] : undefined
}

/**
 * The `.rels` part that describes a given part's outgoing relationships:
 * `ppt/presentation.xml` → `ppt/_rels/presentation.xml.rels`, and the package root
 * (`''`) → `_rels/.rels`.
 */
export function relationshipsPartFor(partName: string): string {
  if (partName === '') return PACKAGE_RELS_PART
  const slash = partName.lastIndexOf('/')
  const dir = slash < 0 ? '' : partName.slice(0, slash + 1)
  const base = slash < 0 ? partName : partName.slice(slash + 1)
  return `${dir}_rels/${base}.rels`
}

/**
 * Resolve a relationship `Target` against the part that declares it, and refuse anything that
 * leaves the package.
 *
 * `..` is *legal and normal* here, unlike in a zip entry name: OOXML writes `../media/image1.png`
 * from inside `ppt/slides/`. So the segments are walked and popped rather than pattern-matched,
 * and the rejection is on the *outcome* — a path that popped past the root, an absolute path that
 * still contains traversal, an empty result, or a segment named `__proto__` (a pollution vector
 * rather than a file name, matching `isSafeArchivePath` in the zip layer).
 *
 * Returns `null` for anything unsafe. There is deliberately no "sanitized" return: a caller that
 * gets a string back knows it is a real part name inside the package.
 */
export function resolveRelationshipTarget(sourcePart: string, target: string): string | null {
  if (target === '' || target.includes('\0') || target.includes('\\')) return null
  // A fragment-only or scheme-bearing target is not a part reference at all.
  if (target.startsWith('#')) return null
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(target)) return null

  const absolute = target.startsWith('/')
  const slash = sourcePart.lastIndexOf('/')
  const baseSegments = absolute || slash < 0 ? [] : sourcePart.slice(0, slash).split('/')

  const segments = [...baseSegments]
  for (const segment of (absolute ? target.slice(1) : target).split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') {
      // Popping an empty stack is an escape above the package root, not a no-op.
      if (segments.length === 0) return null
      segments.pop()
      continue
    }
    if (segment === '__proto__') return null
    segments.push(segment)
  }
  if (segments.length === 0) return null
  const resolved = segments.join('/')
  return resolved.length > 1024 ? null : resolved
}

/** Parse one `.rels` part. `sourcePart` is the part it belongs to, used to resolve targets. */
export function parseRelationships(
  xml: string,
  sourcePart: string,
  limits: OpcLimits = DEFAULT_OPC_LIMITS,
  xmlOptions?: ParseXmlOptions,
): OpcRelationships {
  const root = parseXml(xml, xmlOptions)
  const nodes = childrenNamed(root, 'Relationship')
  if (nodes.length > limits.maxRelationships) {
    throw new OpcError(
      `${sourcePart} declares ${String(nodes.length)} relationships, over the ${String(limits.maxRelationships)} limit`,
    )
  }

  const all: OpcRelationship[] = []
  const byId = emptyMap<OpcRelationship>()
  for (const node of nodes) {
    const id = attribute(node, 'Id')
    const type = attribute(node, 'Type')
    const target = attribute(node, 'Target')
    if (id === undefined || type === undefined || target === undefined) continue
    const external = (attribute(node, 'TargetMode') ?? 'Internal') === 'External'
    const relationship: OpcRelationship = {
      id,
      type,
      target,
      external,
      resolved: external ? null : resolveRelationshipTarget(sourcePart, target),
    }
    all.push(relationship)
    // First writer wins: a duplicate Id is malformed, and letting the later one shadow the earlier
    // would make which part an r:embed resolves to depend on document order.
    if (getOwn(byId, id) === undefined) byId[id] = relationship
  }
  return { bySourcePart: sourcePart, all, byId }
}

export type ContentTypes = {
  /** Lowercased extension → content type. */
  readonly defaults: Readonly<Record<string, string>>
  /** Part name (without the leading slash) → content type. */
  readonly overrides: Readonly<Record<string, string>>
}

export function parseContentTypes(
  xml: string,
  limits: OpcLimits = DEFAULT_OPC_LIMITS,
  xmlOptions?: ParseXmlOptions,
): ContentTypes {
  const root = parseXml(xml, xmlOptions)
  const defaults = emptyMap<string>()
  const overrides = emptyMap<string>()
  let rules = 0

  for (const node of root.children) {
    rules += 1
    if (rules > limits.maxContentTypeRules) {
      throw new OpcError(
        `[Content_Types].xml declares over ${String(limits.maxContentTypeRules)} rules`,
      )
    }
    if (node.local === 'Default') {
      const extension = attribute(node, 'Extension')
      const type = attribute(node, 'ContentType')
      if (extension !== undefined && type !== undefined) {
        // Normalise FIRST, then guard: the key written below is the lowercased form, so comparing
        // the raw attribute let `__PROTO__` past the check and then become the key `__proto__`.
        // Harmless today (null-prototype map, `getOwn` reads) but a guard that does not protect the
        // value it guards is a trap for the next reader. The `Override` branch already gets this
        // right, which is what made the inconsistency visible.
        const normalizedExtension = extension.toLowerCase()
        if (normalizedExtension !== '__proto__') defaults[normalizedExtension] = type
      }
    } else if (node.local === 'Override') {
      const partName = attribute(node, 'PartName')
      const type = attribute(node, 'ContentType')
      if (partName !== undefined && type !== undefined) {
        const normalized = partName.startsWith('/') ? partName.slice(1) : partName
        if (normalized !== '' && !normalized.split('/').includes('__proto__')) {
          overrides[normalized] = type
        }
      }
    }
  }
  return { defaults, overrides }
}

/** An Override wins over the extension Default, per OPC §10.1.2.2. */
export function contentTypeOf(types: ContentTypes, partName: string): string | undefined {
  const override = getOwn(types.overrides, partName)
  if (override !== undefined) return override
  const dot = partName.lastIndexOf('.')
  if (dot < 0) return undefined
  return getOwn(types.defaults, partName.slice(dot + 1).toLowerCase())
}

export type PackageKind = 'presentation' | 'template' | 'slideshow'

export type SlideGraph = {
  readonly kind: PackageKind
  readonly contentTypes: ContentTypes
  /** e.g. `ppt/presentation.xml`. */
  readonly presentationPart: string
  /** Slide parts in presentation order, deduplicated. */
  readonly slideParts: readonly string[]
  /** Slide-master parts reachable from the presentation, in declaration order. */
  readonly masterParts: readonly string[]
  /** The theme part the first master points at, when there is one. */
  readonly themePart: string | null
  readonly presentationRelationships: OpcRelationships
  /** Non-fatal observations worth surfacing in the import report. */
  readonly warnings: readonly string[]
}

/** Entry names → bytes, as `archive.ts` produced them. */
export type PartMap = Readonly<Record<string, Uint8Array>>

function decodePart(entries: PartMap, partName: string): string | undefined {
  const bytes = getOwn(entries as Record<string, Uint8Array>, partName)
  if (bytes === undefined) return undefined
  // OOXML parts are UTF-8. `fatal: false` so one bad byte in a comment does not fail the import;
  // the XML parser is what decides whether the result is well-formed.
  return new TextDecoder('utf-8').decode(bytes)
}

/**
 * Walk `[Content_Types].xml` → `_rels/.rels` → the presentation part → `sldIdLst` and produce the
 * ordered slide list. Throws `OpcError` (or `XmlParseError`) for a package that is not a readable
 * presentation; the caller turns that into an import error value.
 */
export function readSlideGraph(
  entries: PartMap,
  limits: OpcLimits = DEFAULT_OPC_LIMITS,
  xmlOptions?: ParseXmlOptions,
): SlideGraph {
  const warnings: string[] = []

  const contentTypesXml = decodePart(entries, CONTENT_TYPES_PART)
  if (contentTypesXml === undefined) {
    throw new OpcError(`package has no ${CONTENT_TYPES_PART} — not an OPC package`)
  }
  const contentTypes = parseContentTypes(contentTypesXml, limits, xmlOptions)

  const packageRelsXml = decodePart(entries, PACKAGE_RELS_PART)
  if (packageRelsXml === undefined) {
    throw new OpcError(`package has no ${PACKAGE_RELS_PART} — not an OPC package`)
  }
  const packageRels = parseRelationships(packageRelsXml, '', limits, xmlOptions)

  const documentRel = packageRels.all.find((rel) => rel.type === RT_OFFICE_DOCUMENT)
  if (!documentRel) throw new OpcError('package root declares no officeDocument relationship')
  if (documentRel.resolved === null) {
    throw new OpcError(`officeDocument relationship target is unusable: ${documentRel.target}`)
  }
  const presentationPart = documentRel.resolved
  if (getOwn(entries as Record<string, Uint8Array>, presentationPart) === undefined) {
    throw new OpcError(`officeDocument part ${presentationPart} is missing from the package`)
  }

  const mainType = contentTypeOf(contentTypes, presentationPart)
  let kind: PackageKind
  if (mainType === CT_TEMPLATE_MAIN) kind = 'template'
  else if (mainType === CT_SLIDESHOW_MAIN) kind = 'slideshow'
  else if (mainType === CT_PRESENTATION_MAIN) kind = 'presentation'
  else {
    // A missing or unexpected content type is not fatal: the part exists and parses, and refusing
    // here would reject files that open fine in PowerPoint. It is worth a warning, though.
    warnings.push(
      `main part ${presentationPart} declares content type ${mainType ?? '(none)'}; treating it as a presentation`,
    )
    kind = 'presentation'
  }

  const presentationXml = decodePart(entries, presentationPart)
  if (presentationXml === undefined) {
    throw new OpcError(`${presentationPart} could not be decoded as UTF-8 XML`)
  }
  let presentation: XmlElement
  try {
    presentation = parseXml(presentationXml, xmlOptions)
  } catch (error) {
    if (error instanceof XmlParseError) throw new OpcError(`${presentationPart}: ${error.message}`)
    throw error
  }

  const presentationRelsXml = decodePart(entries, relationshipsPartFor(presentationPart))
  if (presentationRelsXml === undefined) {
    throw new OpcError(`${presentationPart} has no relationships part`)
  }
  const presentationRelationships = parseRelationships(
    presentationRelsXml,
    presentationPart,
    limits,
    xmlOptions,
  )

  // `sldIdLst` is authoritative for slide *order*; the r:id on each entry names the part. A
  // presentation with no `sldIdLst` (a bare template) legitimately has zero slides.
  const slideIds = descendantsNamed(presentation, 'sldId')
  if (slideIds.length > limits.maxSlides) {
    throw new OpcError(
      `${presentationPart} declares ${String(slideIds.length)} slides, over the ${String(limits.maxSlides)} limit`,
    )
  }

  const slideParts: string[] = []
  const seen = new Set<string>()
  for (const node of slideIds) {
    const relId = attribute(node, 'r:id') ?? attribute(node, 'id')
    if (relId === undefined) {
      warnings.push('a sldId entry carries no relationship id and was skipped')
      continue
    }
    const rel = getOwn(presentationRelationships.byId, relId)
    if (!rel) {
      warnings.push(`sldId references unknown relationship ${relId}`)
      continue
    }
    if (rel.external) {
      warnings.push(`slide relationship ${relId} is external and was skipped`)
      continue
    }
    if (rel.resolved === null) {
      throw new OpcError(`slide relationship ${relId} escapes the package: ${rel.target}`)
    }
    if (getOwn(entries as Record<string, Uint8Array>, rel.resolved) === undefined) {
      warnings.push(`slide part ${rel.resolved} is missing from the package and was skipped`)
      continue
    }
    // Deduplicate: a presentation naming one part N times must not yield N slides.
    if (seen.has(rel.resolved)) {
      warnings.push(`slide part ${rel.resolved} is referenced more than once; kept the first`)
      continue
    }
    seen.add(rel.resolved)
    slideParts.push(rel.resolved)
  }

  const masterParts: string[] = []
  for (const rel of presentationRelationships.all) {
    if (rel.type !== RT_SLIDE_MASTER) continue
    if (rel.external) continue
    if (rel.resolved === null) {
      throw new OpcError(`slide-master relationship ${rel.id} escapes the package: ${rel.target}`)
    }
    if (
      getOwn(entries as Record<string, Uint8Array>, rel.resolved) !== undefined &&
      !masterParts.includes(rel.resolved)
    ) {
      masterParts.push(rel.resolved)
    }
  }

  // The theme hangs off a master, not off the presentation. Take the first master's.
  let themePart: string | null = null
  const firstMaster = masterParts[0]
  if (firstMaster !== undefined) {
    const masterRelsXml = decodePart(entries, relationshipsPartFor(firstMaster))
    if (masterRelsXml !== undefined) {
      const masterRels = parseRelationships(masterRelsXml, firstMaster, limits, xmlOptions)
      const themeRel = masterRels.all.find((rel) => rel.type === RT_THEME && !rel.external)
      const themeTarget = themeRel?.resolved
      if (
        themeTarget !== undefined &&
        themeTarget !== null &&
        getOwn(entries as Record<string, Uint8Array>, themeTarget) !== undefined
      ) {
        themePart = themeTarget
      }
    }
  }

  return {
    kind,
    contentTypes,
    presentationPart,
    slideParts,
    masterParts,
    themePart,
    presentationRelationships,
    warnings,
  }
}

/** Slide dimensions in EMU from `<p:sldSz>`, defaulting to 16:9 at 10 inches wide. */
export type SlideSizeEmu = { readonly widthEmu: number; readonly heightEmu: number }

export const DEFAULT_SLIDE_SIZE_EMU: SlideSizeEmu = { widthEmu: 12_192_000, heightEmu: 6_858_000 }

export function readSlideSize(presentation: XmlElement): SlideSizeEmu {
  const size = descendantsNamed(presentation, 'sldSz')[0]
  if (!size) return DEFAULT_SLIDE_SIZE_EMU
  const width = Number.parseInt(attribute(size, 'cx') ?? '', 10)
  const height = Number.parseInt(attribute(size, 'cy') ?? '', 10)
  // A zero or negative dimension would make the px scale factor infinite or negative; a
  // nonsensical size is safer replaced by the default than propagated into every shape's geometry.
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return DEFAULT_SLIDE_SIZE_EMU
  }
  return { widthEmu: width, heightEmu: height }
}
