import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

/**
 * The structural half of "one path for text into slide HTML" (M4.5, review round 3).
 *
 * Rounds 1, 2 and 3 each found text that was escaped but not defused — a run, then the typeface
 * attribute, then the template's `dc:title` reaching the starter slide. Round 2 answered with a
 * table of emission sites in `convert.test.ts`; round 3 showed the table only covered the sites
 * someone had thought of, because the starter slide was built by a module the table never drove.
 *
 * So the rows here come from the source, not from memory. Every module under `src/` that names
 * the contract attribute `data-sl-contract` is treated as a producer, and inside each one every
 * `escapeHtml(` call is read off the text. Text must go through `slideText`; a bare `escapeHtml(`
 * is permitted only for an argument in `NOT_TEXT` below, each with the reason it is provably not
 * archive- or user-supplied text. A new `escapeHtml(x)` in any producer — or a new producer that
 * never calls `slideText` — reds until it is classified, which is the question the round-3 defect
 * needed asked.
 *
 * The mark is the bare attribute name, not `data-sl-contract="`: round 4 planted a producer that
 * spelt the attribute through a constant and one that built the document with `setAttribute`, and
 * the narrower mark saw neither. The bare name also sweeps in any future *reader* of the attribute
 * (today the validator and the frame script read `data-sl-slide` only), which then reds on the
 * producer list until it is classified — a question worth asking once, not a false alarm.
 *
 * Behavioural coverage is the other half: `convert.test.ts` drives every forbidden token through
 * the converter's sites, `starter-slide.test.ts` through the starter slide, and
 * `pptx-import.test.ts` through a `.potx` title end to end. Residuals, stated: (1) a value
 * interpolated with no escaper at all inside an existing producer is invisible here — there is no
 * call to read; (2) a producer that never spells `data-sl-contract` (`dataset.slContract`, a name
 * assembled from pieces) is never walked. Both are markup-injection bugs the hostile-text tests
 * catch, and the `SlideGate` refuses the document regardless.
 */

const SRC_ROOT = join(process.cwd(), 'src')
const PRODUCER_MARK = 'data-sl-contract'

/** `escapeHtml(<arg>)` arguments that are provably not text, and why. */
const NOT_TEXT: Readonly<Record<string, string>> = {
  'options.id': 'starter slide: a ULID this app generated',
  'args.slideId': 'converter: a ULID this app generated',
  slideId: 'importer fallback: a ULID this app generated',
  dataUrl: 'converter: `data:` URI whose MIME type was allow-listed and whose body is base64',
}

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full))
    else if (/\.(ts|tsx)$/.test(entry)) out.push(full)
  }
  return out
}

/**
 * Source files (repo-relative, `/`-separated) that *declare* any of `names`.
 *
 * A declaration is `function`, `const`, `let`, `var` or `class` immediately followed by the name, so
 * a second copy written as an arrow is caught as well as one written as a `function` — round 8
 * showed `const foldForScan = (t: string): string => t` left the `function`-only spelling green, and
 * round 9 showed `var` left the four-keyword one green (`no-var` is not among the oxlint categories
 * this repo enables, so nothing else refuses that spelling either). An `import { name }` is not a
 * declaration and does not match, which is the point: the one file that defines each name is named
 * below, and every other file may only import it.
 *
 * Residual, stated: a copy written as a class method or an object property (`{ foldForScan() {} }`)
 * has no declaration keyword and is invisible here. #58's `preload-bundle-deps` guard reads esbuild
 * bindings and does not share that blind spot; the behavioural tests are the net until it lands.
 */
function definers(names: readonly string[]): string[] {
  const pattern = new RegExp(`(?:function|const|let|var|class)\\s+(?:${names.join('|')})\\b`)
  return sourceFiles(SRC_ROOT)
    .filter((file) => pattern.test(readFileSync(file, 'utf8')))
    .map((file) => relative(process.cwd(), file).split(sep).join('/'))
}

function producers(): { file: string; source: string }[] {
  return sourceFiles(SRC_ROOT)
    .map((file) => ({
      file: relative(process.cwd(), file).split(sep).join('/'),
      source: readFileSync(file, 'utf8'),
    }))
    .filter(({ source }) => source.includes(PRODUCER_MARK))
    .toSorted((a, b) => a.file.localeCompare(b.file))
}

describe('text into slide HTML goes through slideText', () => {
  const found = producers()

  it('finds the slide-document producers (the walk is not vacuous)', () => {
    expect(found.map((p) => p.file)).toEqual([
      'src/main/import/pptx-import.ts',
      'src/shared/document/starter-slide.ts',
      'src/shared/import/pptx/convert.ts',
    ])
  })

  it('every producer emits text through slideText', () => {
    for (const { file, source } of found) {
      expect(source, file).toContain('slideText(')
    }
  })

  it('every bare escapeHtml( in a producer is classified as not-text', () => {
    const offenders: string[] = []
    for (const { file, source } of found) {
      for (const match of source.matchAll(/\bescapeHtml\(([^()]*)\)/g)) {
        const argument = match[1]?.trim() ?? ''
        if (!Object.hasOwn(NOT_TEXT, argument)) offenders.push(`${file}: escapeHtml(${argument})`)
      }
    }
    // Route it through `slideText`, or add it to NOT_TEXT with the reason it cannot carry text.
    expect(offenders).toEqual([])
  })

  it('nothing respells the pair by hand', () => {
    // `defuseForbiddenTokens(escapeHtml(x))` is `slideText(x)` written out; two spellings of the
    // path is how round 3's third exception arrived.
    for (const { file, source } of found) {
      expect(source, file).not.toContain('defuseForbiddenTokens(')
    }
  })

  it('escapeHtml and the defuser are defined once, in slide-text.ts', () => {
    expect(definers(['escapeHtml', 'defuseForbiddenTokens', 'slideText'])).toEqual([
      'src/shared/document/slide-text.ts',
    ])
  })

  it('the SL-S04 matcher is defined once, in forbidden-apis.ts', () => {
    // Round 5 lifted `foldForScan`/`forbiddenBreakPoints`/`tokenPattern` out of Design Mode's text
    // editor so the importer and the editor share one matcher; the rebase onto M3.11 completed that
    // dedupe. `text-edit.ts` and `slide-text.ts` import `forbiddenBreakPoints` from the leaf and
    // declare none of the three — `foldForScan` neither has a use for, and `tokenPattern` is
    // module-private there. Both writers of slide text therefore agree with the validator on
    // Unicode case folds by construction, and this pin reds if either grows a copy again:
    // enforced, not remembered.
    //
    // The path is the leaf, not `slide-contract.ts`, because #58's `forbidden-apis.ts` landed and
    // the matcher followed the token list into it — `tokenPattern` calls `packForApiScan` and
    // `TOKEN_PATTERNS` maps `FORBIDDEN_API_TOKENS`, so the matcher cannot stay behind without
    // importing back the very names `preload-bundle-deps.test.ts` counts. That was a deliberate
    // edit, which is the point.
    expect(definers(['foldForScan', 'forbiddenBreakPoints', 'tokenPattern'])).toEqual([
      'src/shared/document/forbidden-apis.ts',
    ])
  })
})
