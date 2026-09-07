/**
 * `importPptx` end to end (M4.5), over the two committed fixtures and over hostile packages.
 *
 * The security block is the point of the "reuse M1.1's reader" decision: a `.pptx` is a zip from
 * anywhere, and every gate M1.1 spent eight review rounds building has to apply to it. These tests
 * drive those gates through the *import* entry point, so a future refactor that quietly routed
 * import around the hardened reader would fail here rather than in the deck tests.
 */

import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'
import { beforeAll, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { importPptx, SlideGate } from '../../../src/main/import/pptx-import'
import { createSlideEntry } from '../../../src/shared/document/deck'
import { validateSlideContract } from '../../../src/shared/document/slide-contract'
import { createStarterSlideHtml } from '../../../src/shared/document/starter-slide'
import { parseManifest } from '../../../src/shared/document/types'
import { LEDGER_ENTRY, ORIGINAL_ARCHIVE_ENTRY } from '../../../src/shared/import/pptx/ledger'
import { fixturePath, PPTX_FIXTURES, readFixture } from './fixtures'
import { handRolledZip } from '../../support/hand-rolled-zip'

const NOW = 1_770_000_000_000

let dir = ''

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'sloodge-import-'))
})

async function writeArchive(name: string, parts: Record<string, Uint8Array>): Promise<string> {
  const path = join(dir, name)
  await writeFile(path, zipSync(parts, { level: 6 }))
  return path
}

/** Slide HTML with the (random, per-import) ULID masked, so two imports are comparable. */
function normaliseSlideIds(result: Awaited<ReturnType<typeof importPptx>>): string[] {
  if (!result.ok) return []
  return result.bundle.manifest.slideOrder.map((id) =>
    result.bundle.slides[id]!.replaceAll(id, '<SLIDE_ID>'),
  )
}

/** The fixture's parts, so hostile variants differ from a *valid* package in exactly one way. */
async function fixtureParts(): Promise<Record<string, Uint8Array>> {
  return unzipSync(await readFixture(PPTX_FIXTURES[0]!.name))
}

describe('importPptx over the committed fixtures', () => {
  for (const fixture of PPTX_FIXTURES) {
    it(`${fixture.name} (${fixture.provenance})`, async () => {
      const result = await importPptx(fixturePath(fixture.name), { now: NOW })
      if (!result.ok) throw new Error(result.error.message)

      expect(result.report.slideCount).toBe(fixture.slideCount)
      expect(result.report.fallbackCount).toBe(0)
      expect(result.report.convertedCount).toBe(fixture.slideCount)
      expect(result.report.warnings).toEqual([])

      // The manifest is schema-valid, which `writeDeck` would otherwise refuse.
      const parsed = parseManifest(result.bundle.manifest)
      expect(parsed.ok).toBe(true)
      expect(result.bundle.manifest.slideOrder).toHaveLength(fixture.slideCount)
      expect(result.bundle.manifest.canvas).toEqual({ width: 1280, height: 720 })

      // Every slide is contract-valid and marked as imported.
      for (const id of result.bundle.manifest.slideOrder) {
        expect(validateSlideContract(result.bundle.slides[id]!, ['static']).ok).toBe(true)
        expect(result.bundle.manifest.slides[id]?.origin?.type).toBe('import')
        expect(result.bundle.manifest.slides[id]?.capabilities).toEqual(['static'])
      }

      // Retention is present and complete.
      expect(result.bundle.extras[ORIGINAL_ARCHIVE_ENTRY]).toBeDefined()
      expect(result.bundle.extras[LEDGER_ENTRY]).toBeDefined()
      expect(result.report.retainedBytes).toBe((await readFixture(fixture.name)).length)
      expect(Object.keys(result.ledger.parts)).toHaveLength(result.report.partCount)
      expect(result.ledger.slideOrder).toEqual(result.bundle.manifest.slideOrder)
    })
  }

  /**
   * Review round 5: `Try WebSoc\u212Aet today` in a run failed the structural gate *and* the
   * text-only fallback — both defuse through `slideText`, whose `i`-flag case fold missed the
   * Kelvin sign that the validator's `toLowerCase()` folds to `k` — and the whole import returned
   * `unconvertible`. Mutation: rebuild the matcher with `'gi'` and no fold, and this reds.
   */
  it('imports a run whose forbidden API is spelled with a Unicode case fold', async () => {
    const parts = await fixtureParts()
    const slide = new TextDecoder().decode(parts['ppt/slides/slide1.xml']!)
    const text = 'Try WebSoc\u212Aet today'
    const crafted = slide.replace('<a:t>Quarterly Business Review</a:t>', `<a:t>${text}</a:t>`)
    expect(crafted).not.toBe(slide)
    parts['ppt/slides/slide1.xml'] = strToU8(crafted)
    const path = await writeArchive('kelvin.pptx', parts)

    const result = await importPptx(path, { now: NOW })
    if (!result.ok) throw new Error(result.error.message)
    expect(result.report.fallbackCount).toBe(0)
    const html = result.bundle.slides[result.bundle.manifest.slideOrder[0]!]!
    expect(validateSlideContract(html, ['static']).ok).toBe(true)
    expect(html).not.toContain(text)
    expect(
      html.replace(/&#(\d+);/g, (_m, code: string) => String.fromCodePoint(Number(code))),
    ).toContain(`>${text}<`)
  })

  it('derives the deck title from docProps and the theme from the package theme part', async () => {
    const result = await importPptx(fixturePath('python-pptx-deck.pptx'), { now: NOW })
    if (!result.ok) throw new Error(result.error.message)
    // The fixture sets no dc:title, so the file name is the fallback.
    expect(result.bundle.manifest.title).toBe('python-pptx-deck')
    // Office's stock scheme, read out of theme1.xml rather than assumed.
    expect(result.bundle.theme?.tokens.color.accent).toBe('#4f81bd')
    expect(result.bundle.theme?.mode).toBe('light')
    expect(result.bundle.theme?.tokens.font?.sans).toContain('-apple-system')
  })

  it('reports the fidelity it did not achieve rather than staying silent', async () => {
    const result = await importPptx(fixturePath('python-pptx-deck.pptx'), { now: NOW })
    if (!result.ok) throw new Error(result.error.message)
    const notes = result.report.conversionNotes.join(' ')
    expect(notes).toContain('layout inheritance is not resolved')
    expect(notes).toContain('graphic frame ("table")')
  })

  it('inlines the fixture picture as a data: URI', async () => {
    const result = await importPptx(fixturePath('python-pptx-deck.pptx'), { now: NOW })
    if (!result.ok) throw new Error(result.error.message)
    const html = Object.values(result.bundle.slides).join('')
    expect(html).toContain('src="data:image/png;base64,')
  })

  it('replaces an oversized image with a placeholder instead of inlining it', async () => {
    const result = await importPptx(fixturePath('python-pptx-deck.pptx'), {
      now: NOW,
      limits: { maxInlineImageBytes: 8 },
    })
    if (!result.ok) throw new Error(result.error.message)
    expect(result.report.conversionNotes.join(' ')).toContain('was not inlined')
    for (const id of result.bundle.manifest.slideOrder) {
      expect(validateSlideContract(result.bundle.slides[id]!, ['static']).ok).toBe(true)
    }
  })

  it('caps the number of slides imported and says so', async () => {
    const result = await importPptx(fixturePath('python-pptx-deck.pptx'), {
      now: NOW,
      limits: { maxSlides: 1 },
    })
    if (!result.ok) throw new Error(result.error.message)
    expect(result.report.slideCount).toBe(1)
    expect(result.report.warnings.join(' ')).toContain('imported the first 1')
  })

  it('produces identical content across runs, with fresh ids each time', async () => {
    const a = await importPptx(fixturePath('sloodge-export.pptx'), { now: NOW })
    const b = await importPptx(fixturePath('sloodge-export.pptx'), { now: NOW })
    if (!a.ok || !b.ok) throw new Error('import failed')

    // Slide ids are ULIDs, so their random component differs by design — two imports of one file
    // are two distinct documents, and reusing ids across them would be the bug.
    expect(a.bundle.manifest.slideOrder).not.toEqual(b.bundle.manifest.slideOrder)

    // Everything that is not an id is identical, including the HTML once the embedded id is
    // normalised away.
    expect(a.report.conversionNotes).toEqual(b.report.conversionNotes)
    expect(a.report.sourceSha256).toBe(b.report.sourceSha256)
    expect({ ...a.ledger.parts }).toEqual({ ...b.ledger.parts })

    expect(normaliseSlideIds(a)).toEqual(normaliseSlideIds(b))
  })
})

/** The fixture re-declared as a template with no slide list, which is what a real .potx is. */
async function templateParts(title?: string): Promise<Record<string, Uint8Array>> {
  const parts = await fixtureParts()
  parts['[Content_Types].xml'] = strToU8(
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Default Extension="jpeg" ContentType="image/jpeg"/><Default Extension="bin" ContentType="application/octet-stream"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.template.main+xml"/></Types>`,
  )
  parts['ppt/presentation.xml'] = strToU8(
    '<p:presentation><p:sldSz cx="12192000" cy="6858000"/></p:presentation>',
  )
  if (title !== undefined) {
    parts['docProps/core.xml'] = strToU8(
      `<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>${title}</dc:title></cp:coreProperties>`,
    )
  }
  return parts
}

describe('templates', () => {
  it('imports a .potx as a theme source with a starter slide', async () => {
    const path = await writeArchive('template.potx', await templateParts())

    const result = await importPptx(path, { now: NOW })
    if (!result.ok) throw new Error(result.error.message)
    expect(result.report.format).toBe('potx')
    // Not empty: a deck with no slides is not a usable document.
    expect(result.bundle.manifest.slideOrder).toHaveLength(1)
    expect(result.report.warnings.join(' ')).toContain('template imported')
    // The theme still came out of the package's own theme part.
    expect(result.bundle.theme?.tokens.color.accent).toBe('#4f81bd')
    // The starter slide is not in the ledger, so an export honestly falls back to a rebuild.
    expect(result.ledger.slideOrder).toEqual([])
  })

  /**
   * Review round 3: these five ordinary template titles each imported `ok: true` with a starter
   * slide that failed SL-S04 — `dc:title` is archive text, the starter slide escaped it but did not
   * defuse it, and the template branch skipped the validator. Now the title goes through
   * `slideText` and the slide through the gate. Mutation: revert `createStarterSlideHtml` to
   * `escapeHtml` and every title below fails with `unconvertible`.
   */
  it('imports a .potx whose dc:title mentions a forbidden API, contract-valid', async () => {
    const titles = [
      'Using localStorage wisely',
      'How to fetch(data)',
      'Eval(uation) rubric',
      'WebSocket demo deck',
      'Our document.cookie policy',
      // Round 5: the validator folds U+212A KELVIN SIGN to `k`; the defuser's `i` flag did not.
      'Try WebSoc\u212Aet today',
      'Our document.coo\u212Aie policy',
    ]
    const results = await Promise.all(
      titles.map(async (title, index) => {
        const path = await writeArchive(`titled-${String(index)}.potx`, await templateParts(title))
        return [title, await importPptx(path, { now: NOW })] as const
      }),
    )
    for (const [title, result] of results) {
      if (!result.ok) throw new Error(`${title}: ${result.error.message}`)
      expect(result.bundle.manifest.title).toBe(title)
      expect(result.bundle.manifest.slideOrder).toHaveLength(1)
      for (const id of result.bundle.manifest.slideOrder) {
        const html = result.bundle.slides[id] ?? ''
        expect(validateSlideContract(html, ['static']).ok, title).toBe(true)
        // Still the same words on screen once entities resolve.
        expect(
          html.replace(/&#(\d+);/g, (_m, code: string) => String.fromCodePoint(Number(code))),
        ).toContain(`class="title">${title}</h1>`)
      }
    }
  })
})

describe('SlideGate — the one door into the deck', () => {
  const entry = createSlideEntry({ now: NOW, title: 'x' })

  it('refuses a document that fails the contract and admits nothing', () => {
    const gate = new SlideGate()
    const result = gate.admit(
      '<!doctype html><html><body><div>no .slide root</div></body></html>',
      entry,
    )
    expect(result.ok).toBe(false)
    expect(Object.keys(gate.slides)).toEqual([])
    expect(gate.entries).toEqual([])
  })

  it('admits a contract-valid document under its entry id', () => {
    const gate = new SlideGate()
    const html = createStarterSlideHtml({ id: entry.id, title: 'ok' })
    expect(gate.admit(html, entry).ok).toBe(true)
    expect(gate.slides[entry.id]).toBe(html)
    expect(gate.entries).toEqual([entry])
  })

  it('is the only writer into the slide map in the importer', () => {
    // The gate is only a choke point if nothing writes around it. Round 3 found the template branch
    // doing exactly that; this pins the spellings a fourth branch would reach for: an indexed
    // write, a push, a bulk `Object.assign`, or handing the bundle a different map. Residual, stated:
    // `Reflect.set` / `defineProperty`, or a spread copy mutated before the bundle, pass this net;
    // the behavioural tests above (a rejected document never reaches the bundle) are the net for those.
    const source = readFileSync(join(process.cwd(), 'src/main/import/pptx-import.ts'), 'utf8')
    const writes = [...source.matchAll(/\bslides\[[^\]]+\]\s*=/g)].map((m) => m[0])
    expect(writes).toEqual(['slides[entry.id] ='])
    expect(source.match(/\bentries\.push\(/g)).toHaveLength(1)
    expect(source).not.toMatch(/Object\.assign\(\s*gate\.slides/)
    expect(source).toContain('slides: gate.slides')
    // ...and validation happens there, not per branch.
    expect(source.match(/validateSlideContract\(/g)).toHaveLength(1)
  })
})

describe('rejections — a .pptx is an untrusted zip', () => {
  it('rejects a zip-slip entry name', async () => {
    const parts = await fixtureParts()
    parts['../../../../etc/passwd'] = strToU8('root::0:0::/:/bin/sh\n')
    const result = await importPptx(await writeArchive('slip.pptx', parts), { now: NOW })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('unsafe-entry')
  })

  it('rejects an absolute entry name', async () => {
    const parts = await fixtureParts()
    parts['/etc/shadow'] = strToU8('x')
    const result = await importPptx(await writeArchive('abs.pptx', parts), { now: NOW })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('unsafe-entry')
  })

  it('rejects a __proto__ entry name', async () => {
    const parts = await fixtureParts()
    parts['ppt/__proto__/x.xml'] = strToU8('<x/>')
    const result = await importPptx(await writeArchive('proto.pptx', parts), { now: NOW })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('unsafe-entry')
  })

  it('rejects a package over the entry-count cap', async () => {
    const parts = await fixtureParts()
    const result = await importPptx(await writeArchive('many.pptx', parts), {
      now: NOW,
      archive: { limits: { maxEntries: 3 } },
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('too-large')
  })

  it('rejects a decompression bomb before inflating it', async () => {
    const parts = await fixtureParts()
    parts['ppt/media/bomb.bin'] = new Uint8Array(2 * 1024 * 1024)
    const result = await importPptx(await writeArchive('bomb.pptx', parts), {
      now: NOW,
      archive: { limits: { maxEntryBytes: 64 * 1024 } },
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('too-large')
  })

  it('rejects a file that is not a zip at all', async () => {
    const path = join(dir, 'not-a-zip.pptx')
    await writeFile(path, 'This is a plain text file pretending to be a deck.')
    const result = await importPptx(path, { now: NOW })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('not-a-zip')
  })

  it('reports a missing file rather than throwing', async () => {
    const result = await importPptx(join(dir, 'nope.pptx'), { now: NOW })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('not-found')
  })

  it('rejects a package whose central directory names a slide part twice', async () => {
    // Round 8's differential, through the real import path. Before the reader refused it, this
    // 44-entry archive imported with zero warnings and `partCount` 43, rendered the *second* copy
    // of slide 1, and a patched export then emitted 43 entries while `verifyPassthrough` and
    // M4.6's identity test both answered `ok` with an empty `missing` list — because both compare
    // part-name sets, which cannot see a shadowed duplicate. The retained-archive guarantee is over
    // bytes, so a reader that silently drops a part while every check says "identical" is the one
    // failure retention exists to prevent.
    //
    // `zipSync` takes an object, so duplicate keys collapse before it runs; the archive has to be
    // written by hand.
    const parts = await fixtureParts()
    const entries = Object.entries(parts).map(([name, bytes]) => ({ name, bytes }))
    const slide = entries.find((entry) => entry.name === 'ppt/slides/slide1.xml')
    if (slide === undefined) throw new Error('fixture has no ppt/slides/slide1.xml')

    const shadow = strFromU8(slide.bytes).replace(
      /Quarterly Business Review/g,
      'DUPLICATE SECOND ENTRY',
    )
    expect(shadow).not.toBe(strFromU8(slide.bytes)) // the duplicate must differ, or it proves nothing

    const path = join(dir, 'duplicate-part.pptx')
    await writeFile(path, handRolledZip([...entries, { name: slide.name, bytes: strToU8(shadow) }]))

    const result = await importPptx(path, { now: NOW })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('not-a-zip')
    expect(result.error.message).toContain('ppt/slides/slide1.xml')
    expect(result.error.message).toContain('more than once')
  })

  it('imports the same hand-rolled package when every part name is unique', async () => {
    // The control: same writer, same STORED members, same part count as the duplicate case, so the
    // refusal above is about the repeated name rather than about a hand-rolled zip.
    const parts = await fixtureParts()
    const entries = Object.entries(parts).map(([name, bytes]) => ({ name, bytes }))
    const path = join(dir, 'hand-rolled-unique.pptx')
    await writeFile(path, handRolledZip(entries))

    const result = await importPptx(path, { now: NOW })
    if (!result.ok) throw new Error(result.error.message)
    expect(result.report.slideCount).toBe(3)
    expect(result.report.partCount).toBe(entries.length)
  })

  it('rejects a zip that is not an OPC presentation', async () => {
    const path = await writeArchive('plain.zip.pptx', { 'readme.txt': strToU8('hello') })
    const result = await importPptx(path, { now: NOW })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('not-a-presentation')
    expect(result.error.message).toContain('[Content_Types].xml')
  })

  it('rejects a package whose XML carries a DOCTYPE (entity expansion / XXE)', async () => {
    const parts = await fixtureParts()
    parts['ppt/presentation.xml'] = strToU8(
      `<!DOCTYPE p [<!ENTITY a "aa"><!ENTITY b "&a;&a;">]><p:presentation><p:sldIdLst/></p:presentation>`,
    )
    const result = await importPptx(await writeArchive('doctype.pptx', parts), { now: NOW })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('not-a-presentation')
    expect(result.error.message).toContain('DOCTYPE')
  })

  it('skips a slide part that is not well-formed XML rather than failing the whole import', async () => {
    const parts = await fixtureParts()
    parts['ppt/slides/slide2.xml'] = strToU8('<p:sld><unclosed>')
    const result = await importPptx(await writeArchive('badslide.pptx', parts), { now: NOW })
    if (!result.ok) throw new Error(result.error.message)
    expect(result.report.slideCount).toBe(2)
    expect(result.report.warnings.join(' ')).toContain('not well-formed XML')
  })

  it('never inlines a non-image content type into a data: URI', async () => {
    const parts = await fixtureParts()
    // An "image" relationship pointing at an HTML payload: sniffing would make this a script vector.
    parts['ppt/media/image1.png'] = strToU8('<html><script>alert(1)</script></html>')
    parts['[Content_Types].xml'] = strToU8(
      `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="text/html"/><Default Extension="jpeg" ContentType="image/jpeg"/><Default Extension="bin" ContentType="application/octet-stream"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/></Types>`,
    )
    const result = await importPptx(await writeArchive('sniff.pptx', parts), { now: NOW })
    if (!result.ok) throw new Error(result.error.message)
    const html = Object.values(result.bundle.slides).join('')
    expect(html).not.toContain('data:text/html')
    expect(result.report.conversionNotes.join(' ')).toContain(
      'content type text/html was not inlined',
    )
    for (const id of result.bundle.manifest.slideOrder) {
      expect(validateSlideContract(result.bundle.slides[id]!, ['static']).ok).toBe(true)
    }
  })
})
