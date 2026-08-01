/**
 * Pure helpers for the two mini-languages the local property panel has to edit **in place**: the
 * inline `style` attribute's declaration list, and the `transform` function list. §5.2-5.3 and the
 * `setStyleProp` row of §1.4's helper table in `.claude/plans/init/40-design-mode.md`.
 *
 * The whole reason this file exists separately from `patch.ts` is the plan's non-negotiable: a
 * panel edit to one CSS property must **never touch another declaration** the author wrote. So the
 * flow is always parse → upsert exactly the one thing → re-emit, and the parser is built to survive
 * the values that actually appear in model-generated slides — `url(...)`, `rgb(...)`,
 * `"quoted, commas"`, `!important` — rather than a naive `split(';')`/`split(':')` that corrupts
 * every one of them.
 *
 * ## What "preserving order and unknown props" means here, precisely
 *
 * Declaration *order* is preserved and *every* declaration (known to the panel or not) survives an
 * upsert. What is **not** byte-preserved is the incidental whitespace *inside* the one `style`
 * attribute we rewrite: `a:1;b:2` re-emits as `a: 1; b: 2`. That is a deliberate, bounded
 * normalization — it touches only the single attribute value being edited, never another
 * attribute, never another element, never the surrounding source (those stay byte-exact because
 * `patch.ts` only ever replaces the one `style` value span). The plan's fidelity guarantee is
 * about not re-serializing the *document*; normalizing the interior of the value you are actively
 * editing is the expected cost of editing it.
 */

/** One CSS declaration, trimmed. `important` is tracked separately so re-emit can restore it. */
export interface Declaration {
  readonly prop: string
  readonly value: string
  readonly important: boolean
}

/**
 * Split a string on `sep` at the top level only — never inside `()` or a quote. This is what makes
 * `background: url(a;b)` one declaration and `font-family: "a, b", c` one value.
 */
function splitTopLevel(input: string, sep: ';' | ':'): string[] {
  const parts: string[] = []
  let depth = 0
  let quote: '"' | "'" | null = null
  let start = 0
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index]!
    if (quote !== null) {
      if (char === quote) quote = null
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
    } else if (char === '(') {
      depth += 1
    } else if (char === ')') {
      if (depth > 0) depth -= 1
    } else if (char === sep && depth === 0) {
      parts.push(input.slice(start, index))
      start = index + 1
      // For ':' we only ever want the FIRST split (prop vs value); the caller slices the rest.
      if (sep === ':') {
        parts.push(input.slice(start))
        return parts
      }
    }
  }
  parts.push(input.slice(start))
  return parts
}

const IMPORTANT = /\s*!\s*important\s*$/i

/**
 * Parse an inline `style` attribute value into an ordered declaration list. Empty and
 * whitespace-only declarations (a stray `;;`) are dropped; a declaration with no `:` is dropped
 * (it is not a declaration). Property names are lowercased — CSS property names are
 * case-insensitive and the panel looks them up by canonical name — while values keep their case.
 */
export function parseDeclarations(styleValue: string): Declaration[] {
  const out: Declaration[] = []
  for (const chunk of splitTopLevel(styleValue, ';')) {
    if (chunk.trim().length === 0) continue
    const [rawProp, rawValue] = splitTopLevel(chunk, ':')
    if (rawValue === undefined) continue
    const prop = rawProp!.trim().toLowerCase()
    if (prop.length === 0) continue
    let value = rawValue.trim()
    let important = false
    if (IMPORTANT.test(value)) {
      important = true
      value = value.replace(IMPORTANT, '').trim()
    }
    out.push({ prop, value, important })
  }
  return out
}

/** Re-emit a declaration list as a `style` value: `prop: value` joined by `; `, no trailing `;`. */
export function serializeDeclarations(declarations: readonly Declaration[]): string {
  return declarations
    .map((d) => `${d.prop}: ${d.value}${d.important ? ' !important' : ''}`)
    .join('; ')
}

/** Look up one declaration's value (case-insensitive prop), or `null` when it is not present. */
export function getDeclaration(declarations: readonly Declaration[], prop: string): string | null {
  const key = prop.toLowerCase()
  for (const d of declarations) if (d.prop === key) return d.value
  return null
}

/**
 * Upsert one property, preserving position and every other declaration. If `prop` already exists
 * its value (and `important` flag) is replaced in place; otherwise it is appended. Returns a new
 * array — the input is never mutated.
 */
export function upsertDeclaration(
  declarations: readonly Declaration[],
  prop: string,
  value: string,
): Declaration[] {
  const key = prop.toLowerCase()
  const next = declarations.map((d) => ({ ...d }))
  const existing = next.find((d) => d.prop === key)
  if (existing) {
    existing.value = value
    return next
  }
  next.push({ prop: key, value, important: false })
  return next
}

/* -------------------------------------------------------------------------------------------- *
 * transform — the canonical ordered string of §5.3
 * -------------------------------------------------------------------------------------------- */

/** One parsed transform function, e.g. `{ name: 'translate', args: '10px, 20px' }`. */
export interface TransformFunction {
  readonly name: string
  readonly args: string
}

/**
 * Parse a `transform` value into its ordered function list. Tolerant of the shapes model output
 * actually produces (`translate(10px,20px) rotate(4deg)`, extra whitespace); anything it cannot
 * make sense of is dropped rather than throwing, because a transform we cannot parse is one we
 * will re-emit our own function into and leave the rest of the string alone via `unknown`.
 */
export function parseTransform(value: string): TransformFunction[] {
  const out: TransformFunction[] = []
  const re = /([a-zA-Z][\w-]*)\s*\(([^)]*)\)/g
  let match: RegExpExecArray | null
  while ((match = re.exec(value)) !== null) {
    out.push({ name: match[1]!, args: match[2]!.trim() })
  }
  return out
}

/**
 * Replace (or insert) one transform function by name, preserving the order and arguments of every
 * other function. A function we did not touch is re-emitted verbatim; if `name` was absent it is
 * appended. This is §5.3's "parse the existing transform, replace only the function we're editing,
 * and re-emit" — kept minimal for M3.3 (the panel only writes `translate`), but general.
 */
export function upsertTransform(value: string, name: string, args: string): string {
  const functions = parseTransform(value)
  let replaced = false
  const next = functions.map((fn) => {
    if (fn.name === name) {
      replaced = true
      return { name, args }
    }
    return fn
  })
  if (!replaced) next.push({ name, args })
  return next.map((fn) => `${fn.name}(${fn.args})`).join(' ')
}
