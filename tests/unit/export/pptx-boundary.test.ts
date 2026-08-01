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
   * writes `ppt/slides/slideN.xml` directly, and its first version hand-rolled a three-character
   * XML escaper instead of calling the canonical sanitizer. Escaping is not sanitizing — a U+0001 or
   * a lone surrogate survived it and produced a part that real XML parsers reject — and nothing
   * upstream catches those, because Tier-1 is an HTML contract.
   *
   * So the boundary is widened from "one importer of pptxgenjs" to "nobody in the pptx domain
   * hand-rolls XML escaping without the sanitizer". This catches the *cause* rather than the symptom:
   * the way this defect arises is somebody writing `.replaceAll('&', '&amp;')` in a new module,
   * which is precisely what the pattern below looks for.
   *
   * Deliberately NOT a check that some file "contains the string sanitizeXmlText" — round 4 deleted
   * exactly that kind of assertion from this file after proving it could stay green while four
   * methods stopped sanitizing. Whether the sanitizer actually runs is a behavioural question, and it
   * is answered behaviourally in `tests/unit/import/rewrite.test.ts` (hostile battery, oracle =
   * `hasXmlIllegalChars`) and end-to-end over a whole exported package in
   * `tests/unit/import/pptx-roundtrip-identity.test.ts`.
   */
  it('no module in the pptx domain hand-rolls XML escaping without the canonical sanitizer', () => {
    /** `.replaceAll('&', '&amp;')` / `.replace(/&/g, '&amp;')` in any quote style. */
    const XML_ESCAPER = /replace(?:All)?\(\s*(?:['"`]&['"`]|\/&\/g)\s*,\s*['"`]&amp;['"`]/
    /** Anything that produces or consumes `.pptx` part content. */
    const PPTX_DOMAIN = /(?:^|[\\/])(?:import[\\/]pptx|export[\\/]pptx|pptx-[a-z]+)\.?/
    const IMPORTS_SANITIZER = /from\s+['"][^'"]*export\/pptx\/sanitize['"]/

    const offenders = files
      .map((file) => ({
        rel: relative(process.cwd(), file).split(sep).join('/'),
        source: readFileSync(file, 'utf8'),
      }))
      .filter(({ rel }) => PPTX_DOMAIN.test(rel))
      .filter(({ source }) => XML_ESCAPER.test(source))
      .filter(({ source }) => !IMPORTS_SANITIZER.test(source))
      .map(({ rel }) => rel)

    expect(offenders).toEqual([])
  })

  it('finds the splice via that rule, so the check above is not vacuous', () => {
    // If `rewrite.ts` ever stops matching the escaper pattern the guard silently covers nothing, so
    // pin that it is genuinely in scope today.
    const XML_ESCAPER = /replace(?:All)?\(\s*['"`]&['"`]\s*,\s*['"`]&amp;['"`]/
    const splice = readFileSync(join(SRC_ROOT, 'shared', 'import', 'pptx', 'rewrite.ts'), 'utf8')
    expect(XML_ESCAPER.test(splice)).toBe(true)
  })
})
