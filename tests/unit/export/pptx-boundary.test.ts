import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

/**
 * The structural half of the XML-sanitization invariant (M4.3, review round 3).
 *
 * Rounds 1–3 each found the same defect class through a new door — slide text, then the deck
 * metadata, then a text run's `fontFace` — because "sanitize everything you hand pptxgenjs" was a rule
 * maintained by review rather than by construction. It is now a boundary: `main/export/safe-pptx.ts`
 * is the sole module allowed to touch pptxgenjs, and it deep-sanitizes every string it forwards.
 *
 * A boundary is only worth anything if crossing it fails the build, so this test greps the source tree
 * and fails if any other module imports or constructs pptxgenjs. Mutation check: add
 * `import PptxGenJS from 'pptxgenjs'` to any other file under `src/` and this test reds.
 */

const SRC_ROOT = join(process.cwd(), 'src')
/** The one module permitted to import pptxgenjs, repo-relative and separator-normalized. */
const ADAPTER = join('src', 'main', 'export', 'safe-pptx.ts')

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      out.push(...sourceFiles(full))
    } else if (/\.(ts|tsx|mts|cts|js|mjs|cjs)$/.test(entry)) {
      out.push(full)
    }
  }
  return out
}

/**
 * Any reference that would pull the library in: a static import or re-export (`from 'pptxgenjs'`),
 * `require('pptxgenjs')`, or a dynamic `import('pptxgenjs')`. All three quote styles are matched,
 * including backticks.
 *
 * **Residual, deliberately accepted:** a specifier assembled at runtime (`'pptx' + 'genjs'`, or a
 * variable) defeats any regex. That is not the failure mode this guards — it guards the ordinary
 * accident of a developer importing the library directly in a new module — and a contributor
 * assembling the string dynamically has evidently decided to route around the boundary, which review
 * catches. Making this airtight would need a resolver-level check (walking the module graph), which is
 * disproportionate here.
 */
const PPTXGENJS_REFERENCE =
  /(?:from\s*['"`]pptxgenjs['"`])|(?:require\(\s*['"`]pptxgenjs['"`]\s*\))|(?:import\(\s*['"`]pptxgenjs['"`]\s*\))/

describe('pptxgenjs boundary', () => {
  const files = sourceFiles(SRC_ROOT)

  it('finds a non-trivial source tree to check (the grep is not vacuous)', () => {
    expect(files.length).toBeGreaterThan(20)
  })

  it('is imported by exactly one module — the sanitizing adapter', () => {
    const importers = files
      .filter((file) => PPTXGENJS_REFERENCE.test(readFileSync(file, 'utf8')))
      .map((file) => relative(process.cwd(), file).split(sep).join(sep))

    expect(importers).toEqual([ADAPTER])
  })

  // NOTE: there was a third check here asserting the adapter's source *contains* the string
  // `deepSanitizeXmlStrings` and the names of its forwarding methods. It was deleted in review round
  // 4: it proved only that some text appears in a file, and the reviewer demonstrated that the
  // sanitize call could be removed from four separate methods with that check — and the entire suite
  // — still green. Whether each method actually sanitizes is a behavioural question, and it is now
  // answered behaviourally in `safe-pptx.test.ts`, which drives every forwarding method against a
  // recording fake pptxgenjs and fails if any of them forwards an unsanitized string.

  it('the writer carries no sanitize calls of its own (the boundary owns the rule)', () => {
    const writerSource = readFileSync(join(SRC_ROOT, 'main', 'export', 'pptx-writer.ts'), 'utf8')
    expect(writerSource).not.toContain('sanitizeXmlText(')
  })

  /**
   * The second doorway, found in M4.5 review round 1.
   *
   * pptxgenjs is not the only way text reaches an OOXML part any more: M4.6's `patched`-mode splice
   * writes `ppt/slides/slideN.xml` directly, and its first version hand-rolled a three-character XML
   * escaper instead of calling the canonical sanitizer. Escaping is not sanitizing — a U+0001 or a
   * lone surrogate survived it and produced a part that real XML parsers reject — and nothing
   * upstream catches those, because Tier-1 is an HTML contract.
   *
   * ## Why an allow-list rather than a path pattern
   *
   * Round 1 scoped this guard by file path (`import/pptx`, `export/pptx`, `pptx-*`). Round 2 showed
   * that is evadable by filing alone: an identical escaper at `src/shared/import/ooxml-escape.ts`
   * left the guard green. A path pattern can only ever enumerate where the problem has appeared so
   * far, which is the same "list someone must remember to extend" that `sanitize.ts` argues against.
   *
   * So the scoping is inverted. Every module under `src/` that spells the escaped ampersand as a
   * string literal — `'&amp;'`, `'&#38;'` or `'&#x26;'`, in any quote style — must appear in
   * `ESCAPERS` below with a stated domain, and each one in the XML domain must import the canonical
   * sanitizer. A new escaper — under any name, in any directory — fails this test until someone adds
   * it, and adding it forces the one question that matters: is this HTML or is this XML? That is the
   * conversation the guard exists to cause.
   *
   * ## Why the net is the literal, not the call
   *
   * Round 2's net matched the *call shape* (`replace('&', '&amp;')` / `replace(/&/g, …)`), and
   * round 3 listed seven ordinary spellings it missed: `/&(?!amp;)/g` (the no-double-escape idiom),
   * `/&/gu`, `/[&]/g`, `'&#38;'`, `'&#x26;'`, `split('&').join('&amp;')` and
   * `new RegExp('&', 'g')`. Every one of them still has to *write the replacement down*, so the
   * literal is the invariant and the call is incidental. Matching the literal catches all seven with
   * no new declarations: the census today is exactly the four modules below.
   *
   * **Residual, deliberately accepted**, stated precisely: (1) a replacement assembled at runtime —
   * `'&a' + 'mp;'`, `String.fromCharCode`, a table built from numbers — is invisible to any regex;
   * (2) the walk covers `src/` only, so a helper under `tests/` that `src/` imports is out of range
   * (`src/` importing from `tests/` is its own smell). Neither is the failure mode this guards. It
   * guards the ordinary accident of someone typing a fresh escaper in a new module, which is exactly
   * how the round-1 defect arose; a contributor assembling the string dynamically has evidently
   * decided to route around the boundary, which review catches. The behavioural layer is the real
   * guarantee either way: `tests/unit/import/rewrite.test.ts` drives a hostile battery through the
   * splice with `hasXmlIllegalChars` as the oracle, and
   * `tests/unit/import/pptx-roundtrip-identity.test.ts` asserts it over every part of a whole
   * exported package. Round 2 confirmed the split is real by reproducing M4.3 round 4's failure
   * mode — keeping the import but neutering the call left this guard green while four behavioural
   * tests reded — which is precisely why no string-presence assertion lives here.
   */
  /** The escaped ampersand as a string literal, in any quote style, named or numeric. */
  const ESCAPED_AMPERSAND_LITERAL = /['"`]&(?:amp|#38|#x26);['"`]/
  const IMPORTS_SANITIZER = /from\s+['"][^'"]*export\/pptx\/sanitize['"]/

  /**
   * Every module permitted to hand-roll an escape, and the domain that justifies it. `xml: true`
   * means its output reaches an OOXML part and it must therefore route through `sanitizeXmlText`.
   */
  const ESCAPERS: Readonly<Record<string, { domain: string; xml: boolean }>> = {
    'src/shared/design/patch.ts': {
      domain: 'Design Mode byte-span patching — HTML source text',
      xml: false,
    },
    'src/shared/design/text-edit.ts': {
      domain: 'Design Mode caret edits — escapeAndNeutralizeText writes HTML text nodes (M3.11)',
      xml: false,
    },
    'src/shared/document/slide-text.ts': {
      domain: 'escapeHtml + slideText for generated slide HTML — HTML domain',
      xml: false,
    },
    'src/shared/export/html-escape.ts': {
      domain: 'HTML-bundle export — HTML domain, its own rules',
      xml: false,
    },
    'src/shared/import/pptx/rewrite.ts': {
      domain: "M4.6's OOXML splice — XML domain, must sanitize",
      xml: true,
    },
  }

  function escaperFiles(): string[] {
    return files
      .filter((file) => ESCAPED_AMPERSAND_LITERAL.test(readFileSync(file, 'utf8')))
      .map((file) => relative(process.cwd(), file).split(sep).join('/'))
      .toSorted()
  }

  it('every hand-rolled escaper in the tree is a declared one', () => {
    // Catches a new escaper under ANY name in ANY directory — the round-1 path pattern could not.
    expect(escaperFiles()).toEqual(Object.keys(ESCAPERS).toSorted())
  })

  it('every escaper in the XML domain routes through the canonical sanitizer', () => {
    const offenders = escaperFiles()
      .filter((rel) => ESCAPERS[rel]?.xml === true)
      .filter((rel) => !IMPORTS_SANITIZER.test(readFileSync(join(process.cwd(), rel), 'utf8')))

    expect(offenders).toEqual([])
  })

  it('declares an XML-domain escaper, so the rule above is not vacuous', () => {
    // If the splice ever stopped matching the escaper pattern, the check above would range over an
    // empty set and pass while covering nothing.
    const xmlEscapers = Object.entries(ESCAPERS)
      .filter(([, entry]) => entry.xml)
      .map(([rel]) => rel)
    expect(xmlEscapers).toEqual(['src/shared/import/pptx/rewrite.ts'])
    expect(escaperFiles()).toContain('src/shared/import/pptx/rewrite.ts')
  })
})
