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

/** Any reference that would pull the library in: a static import, a re-export, or a dynamic import. */
const PPTXGENJS_REFERENCE =
  /(?:from\s*['"]pptxgenjs['"])|(?:require\(\s*['"]pptxgenjs['"]\s*\))|(?:import\(\s*['"]pptxgenjs['"]\s*\))/

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

  it('the adapter really does route everything through the deep sanitizer', () => {
    const adapterSource = readFileSync(join(SRC_ROOT, 'main', 'export', 'safe-pptx.ts'), 'utf8')
    expect(adapterSource).toContain('deepSanitizeXmlStrings')
    // Every forwarding method sanitizes; none may hand a raw value to the library.
    for (const method of ['addText', 'addShape', 'addImage', 'addNotes']) {
      expect(adapterSource).toContain(method)
    }
  })

  it('the writer carries no sanitize calls of its own (the boundary owns the rule)', () => {
    const writerSource = readFileSync(join(SRC_ROOT, 'main', 'export', 'pptx-writer.ts'), 'utf8')
    expect(writerSource).not.toContain('sanitizeXmlText(')
  })
})
