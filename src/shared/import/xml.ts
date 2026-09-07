/**
 * A deliberately small, non-validating XML reader for OOXML parts (M4.5).
 *
 * ## Why not a dependency
 *
 * The repo's rule is zero new deps where the job is small and the input is hostile, and both hold
 * here. The XML this must read is machine-generated OOXML: elements, attributes, character data,
 * the five predefined entities, numeric character references, CDATA, comments and processing
 * instructions. It is not general XML — there are no DTDs to honour, no namespace fixups to
 * perform, no schema to validate against — and the general-purpose parsers that would cover those
 * cases are precisely the ones that ship the features this parser must *refuse*.
 *
 * ## The refusals are the point
 *
 * A `.pptx` is a zip a user downloaded from anywhere, so every part inside it is attacker
 * controlled. The two classic XML attacks both live in the prolog:
 *
 *  - **Entity expansion** ("billion laughs"): nested `<!ENTITY>` definitions that expand
 *    exponentially and exhaust memory. There is no safe budget for this — a parser that expands
 *    custom entities at all has to get the accounting exactly right forever — so `<!DOCTYPE` is
 *    rejected outright, before it is even scanned. OOXML parts never carry one.
 *  - **XXE** (external entity / external DTD subset): the same rejection covers it, because the
 *    only syntax that can name an external resource is inside the doctype. This parser has no I/O
 *    of any kind, so even a missed doctype could not fetch anything; refusing it removes the
 *    question rather than answering it.
 *
 * Entity handling is therefore a closed set: `&lt; &gt; &amp; &apos; &quot;` plus numeric
 * references, which are bounded by construction (a numeric reference produces exactly one code
 * point) and validated against the XML 1.0 character range. An unknown `&foo;` is left as literal
 * text rather than resolved or rejected — it cannot expand, so it cannot be an attack, and
 * refusing the whole part over one stray ampersand would reject files PowerPoint itself accepts.
 *
 * The remaining hazards are quantitative, and are capped rather than reasoned about: input size,
 * nesting depth (a million `<a>` opens is a stack overflow in a recursive parser and an unbounded
 * array here), total node count, and attributes per element. All four are injectable so the tests
 * prove each guard with a small crafted string instead of a large one.
 *
 * ## Shape of the tree
 *
 * Elements carry their *element* children plus the concatenation of their direct character data.
 * Mixed content ordering is discarded, and that is sufficient for OOXML by construction: text in
 * DrawingML lives only in leaf `<a:t>` elements, which have no element children of their own. A
 * general XML tree would need interleaved nodes; this one would only pay for them.
 *
 * Namespace prefixes are kept verbatim and elements are looked up by **local name**. OOXML in
 * practice always binds `a:`/`p:`/`r:` to the DrawingML/PresentationML/Relationships namespaces,
 * but the prefix is technically the document's choice, so matching `a:t` literally would break on
 * a legal file that spells it `drawing:t`. Local-name matching reads such a file correctly; the
 * cost is that it cannot distinguish two same-named elements from different namespaces, which
 * OOXML's schema never places in the same parent position.
 */

/** Every rejection this parser can raise. Callers turn it into an import error value. */
export class XmlParseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'XmlParseError'
  }
}

export type XmlAttributes = Readonly<Record<string, string>>

export type XmlElement = {
  /** The qualified name exactly as written, e.g. `a:t`. */
  readonly name: string
  /** The part after the colon, e.g. `t`. Lookups match on this. */
  readonly local: string
  /** The part before the colon, or `''` when the name is unprefixed. */
  readonly prefix: string
  /** Attributes keyed by qualified name. A null-prototype map: keys are untrusted strings. */
  readonly attributes: XmlAttributes
  readonly children: readonly XmlElement[]
  /** The concatenation of this element's direct character data (CDATA included). */
  readonly text: string
}

export type ParseXmlOptions = {
  /** Characters of source. OOXML slide parts are kilobytes; the default is ~3 orders above. */
  maxLength?: number
  /** Maximum element nesting. DrawingML groups nest a handful deep in the worst real files. */
  maxDepth?: number
  /** Total elements in the document. */
  maxNodes?: number
  /** Attributes on any one element. */
  maxAttributes?: number
}

export const DEFAULT_XML_LIMITS = {
  maxLength: 16 * 1024 * 1024,
  maxDepth: 256,
  maxNodes: 500_000,
  maxAttributes: 256,
} as const

/** A null-prototype map: attribute names come from the file and are used as object keys. */
function emptyAttributes(): Record<string, string> {
  return Object.create(null) as Record<string, string>
}

const PREDEFINED_ENTITIES: Readonly<Record<string, string>> = Object.freeze(
  Object.assign(Object.create(null) as Record<string, string>, {
    lt: '<',
    gt: '>',
    amp: '&',
    apos: "'",
    quot: '"',
  }),
)

/**
 * XML 1.0 §2.2: the code points a document may contain. A numeric reference naming anything else
 * (a C0 control, a surrogate half, U+FFFE/U+FFFF, or a value past the Unicode range) is not
 * resolved — it is left as literal text, the same treatment an unknown named entity gets, so a
 * malformed reference degrades to visible junk in one text run instead of failing the import.
 */
function isXmlChar(code: number): boolean {
  return (
    code === 0x9 ||
    code === 0xa ||
    code === 0xd ||
    (code >= 0x20 && code <= 0xd7ff) ||
    (code >= 0xe000 && code <= 0xfffd) ||
    (code >= 0x1_0000 && code <= 0x10_ffff)
  )
}

/**
 * Resolve the five predefined entities and numeric character references. Anything else is left
 * exactly as written: an unresolvable reference cannot expand, so it is a rendering nuisance
 * rather than a resource attack, and rejecting the part over it would refuse files PowerPoint
 * reads happily.
 */
export function decodeXmlEntities(value: string): string {
  if (!value.includes('&')) return value
  return value.replace(/&(#x[0-9a-fA-F]+|#\d+|[A-Za-z][A-Za-z0-9]*);/g, (match, body: string) => {
    if (body.startsWith('#')) {
      const code = body.startsWith('#x')
        ? Number.parseInt(body.slice(2), 16)
        : Number.parseInt(body.slice(1), 10)
      if (!Number.isFinite(code) || !isXmlChar(code)) return match
      return String.fromCodePoint(code)
    }
    return PREDEFINED_ENTITIES[body] ?? match
  })
}

type MutableElement = {
  name: string
  local: string
  prefix: string
  attributes: Record<string, string>
  children: XmlElement[]
  textParts: string[]
}

function finish(node: MutableElement): XmlElement {
  return {
    name: node.name,
    local: node.local,
    prefix: node.prefix,
    attributes: node.attributes,
    children: node.children,
    text: node.textParts.join(''),
  }
}

function splitName(name: string): { local: string; prefix: string } {
  const colon = name.indexOf(':')
  if (colon < 0) return { local: name, prefix: '' }
  return { prefix: name.slice(0, colon), local: name.slice(colon + 1) }
}

const NAME_START = /[A-Za-z_:]/
const NAME_CHAR = /[-A-Za-z0-9_:.]/

/**
 * Parse an OOXML part into its root element. Iterative (an explicit stack, not recursion) so that
 * `maxDepth` is a cap on an array rather than on the JS call stack: a depth guard enforced by
 * catching a `RangeError` is not a guard.
 */
export function parseXml(source: string, options: ParseXmlOptions = {}): XmlElement {
  const maxLength = options.maxLength ?? DEFAULT_XML_LIMITS.maxLength
  const maxDepth = options.maxDepth ?? DEFAULT_XML_LIMITS.maxDepth
  const maxNodes = options.maxNodes ?? DEFAULT_XML_LIMITS.maxNodes
  const maxAttributes = options.maxAttributes ?? DEFAULT_XML_LIMITS.maxAttributes

  if (source.length > maxLength) {
    throw new XmlParseError(
      `xml part is ${String(source.length)} chars, over the ${String(maxLength)} limit`,
    )
  }

  const stack: MutableElement[] = []
  let root: XmlElement | null = null
  let nodes = 0
  let at = 0

  const pushText = (raw: string): void => {
    if (stack.length === 0) return // whitespace/junk outside the root element
    const top = stack[stack.length - 1]
    if (top) top.textParts.push(decodeXmlEntities(raw))
  }

  while (at < source.length) {
    const lt = source.indexOf('<', at)
    if (lt < 0) {
      pushText(source.slice(at))
      break
    }
    if (lt > at) pushText(source.slice(at, lt))

    // --- prolog / comment / CDATA -------------------------------------------------------------
    if (source.startsWith('<!--', lt)) {
      const end = source.indexOf('-->', lt + 4)
      if (end < 0) throw new XmlParseError('unterminated comment')
      at = end + 3
      continue
    }
    if (source.startsWith('<![CDATA[', lt)) {
      const end = source.indexOf(']]>', lt + 9)
      if (end < 0) throw new XmlParseError('unterminated CDATA section')
      // CDATA is literal by definition: no entity decoding.
      if (stack.length > 0) {
        const top = stack[stack.length - 1]
        if (top) top.textParts.push(source.slice(lt + 9, end))
      }
      at = end + 3
      continue
    }
    if (source.startsWith('<!DOCTYPE', lt) || source.startsWith('<!ENTITY', lt)) {
      // The entity-expansion and XXE surface, refused wholesale rather than budgeted. OOXML parts
      // never carry a doctype, so nothing legitimate is lost.
      throw new XmlParseError('DOCTYPE and ENTITY declarations are forbidden')
    }
    if (source.startsWith('<?', lt)) {
      const end = source.indexOf('?>', lt + 2)
      if (end < 0) throw new XmlParseError('unterminated processing instruction')
      at = end + 2
      continue
    }

    // --- closing tag --------------------------------------------------------------------------
    if (source.startsWith('</', lt)) {
      const end = source.indexOf('>', lt + 2)
      if (end < 0) throw new XmlParseError('unterminated closing tag')
      const name = source.slice(lt + 2, end).trim()
      const open = stack.pop()
      if (!open) throw new XmlParseError(`closing tag </${name}> with no open element`)
      if (open.name !== name) {
        throw new XmlParseError(`closing tag </${name}> does not match <${open.name}>`)
      }
      const element = finish(open)
      const parent = stack[stack.length - 1]
      if (parent) parent.children.push(element)
      else root = element
      at = end + 1
      continue
    }

    // --- opening tag --------------------------------------------------------------------------
    let cursor = lt + 1
    const first = source[cursor]
    if (first === undefined || !NAME_START.test(first)) {
      throw new XmlParseError(`malformed element name at offset ${String(lt)}`)
    }
    cursor += 1
    while (cursor < source.length) {
      const ch = source[cursor]
      if (ch === undefined || !NAME_CHAR.test(ch)) break
      cursor += 1
    }
    const name = source.slice(lt + 1, cursor)

    nodes += 1
    if (nodes > maxNodes) {
      throw new XmlParseError(`xml part has over ${String(maxNodes)} elements`)
    }

    const attributes = emptyAttributes()
    let attributeCount = 0
    let selfClosing = false

    // Attribute scan. Deliberately lenient about whitespace and quote style, strict about the
    // things that would let a value swallow the rest of the document (an unterminated quote).
    for (;;) {
      while (cursor < source.length && /\s/.test(source[cursor] ?? '')) cursor += 1
      const ch = source[cursor]
      if (ch === undefined) throw new XmlParseError(`unterminated tag <${name}>`)
      if (ch === '>') {
        cursor += 1
        break
      }
      if (ch === '/' && source[cursor + 1] === '>') {
        selfClosing = true
        cursor += 2
        break
      }
      if (!NAME_START.test(ch)) {
        throw new XmlParseError(`malformed attribute in <${name}> at offset ${String(cursor)}`)
      }
      const attributeStart = cursor
      cursor += 1
      while (cursor < source.length) {
        const c = source[cursor]
        if (c === undefined || !NAME_CHAR.test(c)) break
        cursor += 1
      }
      const attributeName = source.slice(attributeStart, cursor)
      while (cursor < source.length && /\s/.test(source[cursor] ?? '')) cursor += 1
      if (source[cursor] !== '=') {
        throw new XmlParseError(`attribute ${attributeName} in <${name}> has no value`)
      }
      cursor += 1
      while (cursor < source.length && /\s/.test(source[cursor] ?? '')) cursor += 1
      const quote = source[cursor]
      if (quote !== '"' && quote !== "'") {
        throw new XmlParseError(`attribute ${attributeName} in <${name}> is unquoted`)
      }
      const valueStart = cursor + 1
      const valueEnd = source.indexOf(quote, valueStart)
      if (valueEnd < 0) {
        throw new XmlParseError(`attribute ${attributeName} in <${name}> is unterminated`)
      }
      attributeCount += 1
      if (attributeCount > maxAttributes) {
        throw new XmlParseError(`<${name}> has over ${String(maxAttributes)} attributes`)
      }
      // Last writer wins on a duplicate, matching every mainstream parser. `__proto__` is a normal
      // key here because the map has a null prototype — that is the whole reason it has one.
      attributes[attributeName] = decodeXmlEntities(source.slice(valueStart, valueEnd))
      cursor = valueEnd + 1
    }

    const { local, prefix } = splitName(name)
    const element: MutableElement = {
      name,
      local,
      prefix,
      attributes,
      children: [],
      textParts: [],
    }

    if (selfClosing) {
      const parent = stack[stack.length - 1]
      if (parent) parent.children.push(finish(element))
      else if (root === null) root = finish(element)
      else throw new XmlParseError('document has more than one root element')
    } else {
      if (stack.length >= maxDepth) {
        throw new XmlParseError(`xml part nests deeper than ${String(maxDepth)} elements`)
      }
      if (root !== null && stack.length === 0) {
        throw new XmlParseError('document has more than one root element')
      }
      stack.push(element)
    }
    at = cursor
  }

  if (stack.length > 0) {
    throw new XmlParseError(`unclosed element <${stack[stack.length - 1]?.name ?? '?'}>`)
  }
  if (root === null) throw new XmlParseError('document has no root element')
  return root
}

/* ---------------------------------------------------------------------------------------------- *
 * Tree helpers. All match on local name — see the namespace note in the module docblock.
 * ---------------------------------------------------------------------------------------------- */

export function childrenNamed(element: XmlElement, local: string): XmlElement[] {
  return element.children.filter((child) => child.local === local)
}

export function firstChildNamed(element: XmlElement, local: string): XmlElement | undefined {
  return element.children.find((child) => child.local === local)
}

/** Follow a chain of local names, e.g. `path(sp, 'spPr', 'xfrm', 'off')`. */
export function pathNamed(
  element: XmlElement,
  ...locals: readonly string[]
): XmlElement | undefined {
  let current: XmlElement | undefined = element
  for (const local of locals) {
    if (!current) return undefined
    current = firstChildNamed(current, local)
  }
  return current
}

/** Attribute by qualified name (`r:embed`), then by local name (`embed`) if that missed. */
export function attribute(element: XmlElement, name: string): string | undefined {
  const direct = Object.hasOwn(element.attributes, name) ? element.attributes[name] : undefined
  if (direct !== undefined) return direct
  const wanted = splitName(name).local
  for (const key of Object.keys(element.attributes)) {
    if (splitName(key).local === wanted) return element.attributes[key]
  }
  return undefined
}

/** Every descendant with this local name, in document order, the element itself excluded. */
export function descendantsNamed(element: XmlElement, local: string): XmlElement[] {
  const out: XmlElement[] = []
  const stack: XmlElement[] = element.children.toReversed()
  while (stack.length > 0) {
    const node = stack.pop()
    if (!node) break
    if (node.local === local) out.push(node)
    for (let index = node.children.length - 1; index >= 0; index -= 1) {
      const child = node.children[index]
      if (child) stack.push(child)
    }
  }
  return out
}
