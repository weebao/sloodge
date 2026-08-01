/**
 * **M4.6 — the acceptance gate.** These are the tests that make M4.5's retention strategy
 * load-bearing rather than decorative.
 *
 * ## What makes these assertions real rather than tautological
 *
 * The obvious way to write an "identity" test is to compare the retained bytes to themselves, which
 * proves only that a buffer equals itself. Every test here instead runs the **full production
 * path** and compares against **the original input file on disk**:
 *
 *   fixture.pptx on disk
 *     → importPptx()                       (hardened zip read, OPC parse, conversion)
 *     → writeDeck() to a real .sloodge     (zip write: deflate, atomic rename)
 *     → readDeck() back off disk           (hardened zip read again)
 *     → exportPptxRoundTrip()
 *     → write the result to out.pptx
 *     → read out.pptx back off disk
 *     → sha256(out.pptx) === sha256(fixture.pptx)
 *
 * The retained archive therefore survives a complete deflate/inflate cycle inside another zip, two
 * independent trips through the hardened reader, and JSON serialization of its ledger — and the
 * comparison is against a file this test never wrote. If retention were dropped, mangled,
 * re-compressed, or re-zipped from its inflated members at any step, the hashes would part company.
 *
 * The edited round trip is asserted where the guarantee actually lives: not on the container (two
 * zips holding identical parts legitimately differ in compression, ordering and timestamps) but on
 * **each part's inflated bytes**, read back out of both packages through the hardened reader.
 *
 * ## Mutation coverage
 *
 * Three tests at the bottom exist purely to prove the assertions above can fail. Each one feeds the
 * verifier the exact defect the milestone names — an untouched part re-serialized, a ledger that
 * marks nothing dirty, a malicious part name — and asserts it is *detected*. Without them, a
 * verifier that returned `{ ok: true }` unconditionally would leave this whole file green.
 */

import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'
import { beforeAll, describe, expect, it } from 'vitest'
import { importPptx } from '../../../src/main/import/pptx-import'
import {
  exportPptxRoundTrip,
  readRetainedImport,
  verifyPassthrough,
} from '../../../src/main/export/pptx-roundtrip'
import { readDeck, writeDeck, type DeckBundle } from '../../../src/main/document/store'
import { planRoundTrip, LEDGER_ENTRY } from '../../../src/shared/import/pptx/ledger'
import {
  filePartNames,
  fixturePath,
  HOSTILE_XML_STRINGS,
  PPTX_FIXTURES,
  readFixture,
  sha256Hex,
} from './fixtures'
import { hasXmlIllegalChars } from '../../../src/shared/export/pptx/sanitize'

const NOW = 1_770_000_000_000

let dir = ''

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'sloodge-roundtrip-'))
})

/**
 * The production path, end to end: import a `.pptx`, persist it as a real `.sloodge` on disk, and
 * read it back. Everything downstream operates on the *reloaded* bundle, never on the in-memory one
 * the importer returned — a retention scheme that only works before a save is not a retention
 * scheme.
 */
async function importAndPersist(
  fixtureName: string,
): Promise<{ bundle: DeckBundle; deckPath: string; sourceBytes: Uint8Array }> {
  const sourceBytes = await readFixture(fixtureName)
  const imported = await importPptx(fixturePath(fixtureName), { now: NOW })
  if (!imported.ok) throw new Error(`import failed: ${imported.error.message}`)

  const deckPath = join(dir, `${fixtureName}.sloodge`)
  const written = await writeDeck(deckPath, imported.bundle)
  expect(written.ok).toBe(true)

  const reloaded = await readDeck(deckPath)
  if (!reloaded.ok) throw new Error(`reload failed: ${reloaded.error.message}`)
  return { bundle: reloaded.bundle, deckPath, sourceBytes }
}

describe('M4.6 — no-edit round trip is byte-identical to the source archive', () => {
  for (const fixture of PPTX_FIXTURES) {
    it(`${fixture.name} (${fixture.provenance}) survives import → save → reopen → export`, async () => {
      const { bundle, sourceBytes } = await importAndPersist(fixture.name)

      const result = await exportPptxRoundTrip(bundle)
      expect(result.mode).toBe('identity')
      expect(result.plan.dirtySlideIds).toEqual([])
      expect(result.plan.rewriteParts).toEqual([])
      expect(result.bytes).not.toBeNull()

      // Round the bytes through the filesystem: this is what an export actually does, and a
      // comparison made only in memory would not catch an encoding fault on write.
      const outPath = join(dir, `${fixture.name}.roundtrip.pptx`)
      await writeFile(outPath, result.bytes!)
      const outBytes = new Uint8Array(await readFile(outPath))

      const inputHash = sha256Hex(sourceBytes)
      const outputHash = sha256Hex(outBytes)

      // The headline assertion: the exported file is the file that was opened.
      expect(outputHash).toBe(inputHash)
      expect(result.sha256).toBe(inputHash)
      expect(outBytes.length).toBe(sourceBytes.length)
      expect(Buffer.compare(Buffer.from(outBytes), Buffer.from(sourceBytes))).toBe(0)

      // And every part passes through, not merely the container.
      const verification = await verifyPassthrough(outBytes, sourceBytes, [])
      expect(verification.differing).toEqual([])
      expect(verification.missing).toEqual([])
      expect(verification.ok).toBe(true)
      expect(verification.identical.length).toBe(filePartNames(unzipSync(sourceBytes)).length)
    })
  }

  it('records the source hash in the report and in the ledger', async () => {
    const fixture = PPTX_FIXTURES[0]!
    const sourceBytes = await readFixture(fixture.name)
    const imported = await importPptx(fixturePath(fixture.name), { now: NOW })
    if (!imported.ok) throw new Error(imported.error.message)
    expect(imported.report.sourceSha256).toBe(sha256Hex(sourceBytes))
    expect(imported.ledger.source.sha256).toBe(sha256Hex(sourceBytes))
    expect(imported.ledger.source.bytes).toBe(sourceBytes.length)
  })
})

describe('M4.6 — an edited round trip rewrites only the parts the edit touched', () => {
  for (const fixture of PPTX_FIXTURES) {
    it(`${fixture.name}: one edited slide rewrites one part, every other part byte-identical`, async () => {
      const { bundle, sourceBytes } = await importAndPersist(fixture.name)

      // Edit exactly one slide, through its provenance marker — the same substitution the editor
      // would produce for a user retyping that text run.
      const editedSlideId = bundle.manifest.slideOrder[0]!
      const before = bundle.slides[editedSlideId]!
      const after = before.replace(
        /(<span[^>]*data-sl-run="0"[^>]*>)([^<]*)(<\/span>)/,
        '$1EDITED BY THE ROUND-TRIP TEST$3',
      )
      expect(after).not.toBe(before) // the marker exists and the edit landed
      const edited: DeckBundle = {
        ...bundle,
        slides: { ...bundle.slides, [editedSlideId]: after },
      }

      const result = await exportPptxRoundTrip(edited)
      expect(result.mode).toBe('patched')
      expect(result.plan.dirtySlideIds).toEqual([editedSlideId])
      expect(result.bytes).not.toBeNull()

      const retained = readRetainedImport(edited)!
      expect(retained).not.toBeNull()

      // Exactly one part rewritten, and it is the slide part the ledger recorded for that slide.
      const expectedPart = retained.ledger.slidePart[editedSlideId]!
      expect(result.rewrittenParts).toEqual([expectedPart])

      const outPath = join(dir, `${fixture.name}.edited.pptx`)
      await writeFile(outPath, result.bytes!)
      const outBytes = new Uint8Array(await readFile(outPath))

      // The guarantee, asserted on inflated part bytes through the hardened reader.
      const verification = await verifyPassthrough(outBytes, sourceBytes, result.rewrittenParts)
      expect(verification.differing).toEqual([])
      expect(verification.missing).toEqual([])
      expect(verification.ok).toBe(true)

      const originalParts = unzipSync(sourceBytes)
      const exportedParts = unzipSync(outBytes)

      // Same part set: an edit must not add or drop a part. Compared over *file* entries, because
      // a re-zip does not reproduce the zero-length directory markers some writers emit — those
      // carry no content, are never referenced by OPC, and are exactly what `patched` mode's
      // part-level guarantee does not cover. (`identity` mode reproduces them, being the same
      // bytes; see the container-level assertions above.)
      expect(filePartNames(exportedParts)).toEqual(filePartNames(originalParts))

      // Everything that was supposed to pass through did.
      expect(verification.identical.length).toBe(filePartNames(originalParts).length - 1)

      // The rewritten part really did change, really does carry the new text, and differs from the
      // original *only* in that text — the byte splice, not a re-serialization.
      const originalXml = strFromU8(originalParts[expectedPart]!)
      const rewrittenXml = strFromU8(exportedParts[expectedPart]!)
      expect(rewrittenXml).not.toBe(originalXml)
      expect(rewrittenXml).toContain('EDITED BY THE ROUND-TRIP TEST')
      expect(originalXml).not.toContain('EDITED BY THE ROUND-TRIP TEST')

      // The splice property: removing the substituted text from both sides makes them equal again.
      const oldText = /(<span[^>]*data-sl-run="0"[^>]*>)([^<]*)(<\/span>)/.exec(before)?.[2] ?? ''
      expect(rewrittenXml.replace('EDITED BY THE ROUND-TRIP TEST', oldText)).toBe(originalXml)
    })
  }

  it('re-editing a slide back to its imported text returns the deck to identity mode', async () => {
    const fixture = PPTX_FIXTURES[0]!
    const { bundle } = await importAndPersist(fixture.name)
    const slideId = bundle.manifest.slideOrder[0]!
    const original = bundle.slides[slideId]!

    const edited: DeckBundle = {
      ...bundle,
      slides: { ...bundle.slides, [slideId]: original.replace('Quarterly', 'Annual') },
    }
    expect((await exportPptxRoundTrip(edited)).mode).toBe('patched')

    const reverted: DeckBundle = { ...bundle, slides: { ...bundle.slides, [slideId]: original } }
    expect((await exportPptxRoundTrip(reverted)).mode).toBe('identity')
  })

  it('declines to claim passthrough when a slide is removed', async () => {
    const fixture = PPTX_FIXTURES[0]!
    const { bundle } = await importAndPersist(fixture.name)
    const [dropped, ...rest] = bundle.manifest.slideOrder
    const slides = { ...bundle.slides }
    delete slides[dropped!]

    const result = await exportPptxRoundTrip({
      ...bundle,
      manifest: { ...bundle.manifest, slideOrder: rest },
      slides,
    })
    expect(result.mode).toBe('rebuild')
    expect(result.bytes).toBeNull()
    expect(result.passthroughParts).toEqual([])
    expect(result.plan.reasons.join(' ')).toContain('slide set or order changed')
  })

  it('declines when the slide order changes, rather than half-guaranteeing', async () => {
    const fixture = PPTX_FIXTURES[0]!
    const { bundle } = await importAndPersist(fixture.name)
    const reordered = bundle.manifest.slideOrder.toReversed()

    const result = await exportPptxRoundTrip({
      ...bundle,
      manifest: { ...bundle.manifest, slideOrder: reordered },
    })
    expect(result.mode).toBe('rebuild')
    expect(result.bytes).toBeNull()
  })

  it('declines when an edit destroys the run provenance markers', async () => {
    const fixture = PPTX_FIXTURES[0]!
    const { bundle } = await importAndPersist(fixture.name)
    const slideId = bundle.manifest.slideOrder[0]!
    // An agent rewriting the slide wholesale: valid contract HTML, no markers, no way to map it
    // back onto the original part.
    const rewritten = bundle.slides[slideId]!.replaceAll(/ data-sl-run="\d+"/g, '')

    const result = await exportPptxRoundTrip({
      ...bundle,
      slides: { ...bundle.slides, [slideId]: rewritten },
    })
    expect(result.mode).toBe('rebuild')
    expect(result.bytes).toBeNull()
    expect(result.plan.reasons.join(' ')).toContain('cannot be expressed as text substitution')
  })
})

describe('M4.6 — a patched export is always a well-formed package', () => {
  /**
   * Review round 1, blocker 2, asserted at the level that matters: the whole exported `.pptx`, not
   * just the splice helper. A hostile edit reaches here through the ordinary editing path — Tier-1
   * accepts XML-illegal characters in slide text because it is an *HTML* contract — so without the
   * sanitizer the produced part is malformed and PowerPoint calls the file corrupt, silently, while
   * every count-based check still reports success.
   *
   * The oracle is `hasXmlIllegalChars`, the canonical predicate, applied to every part of the
   * package rather than the one that was edited.
   */
  it('emits no XML-illegal character in any part, however hostile the edit', async () => {
    const { bundle } = await importAndPersist(PPTX_FIXTURES[0]!.name)
    const slideId = bundle.manifest.slideOrder[0]!

    const edits = HOSTILE_XML_STRINGS.map((hostile) => {
      expect(hasXmlIllegalChars(hostile)).toBe(true) // the input really is hostile
      const edited: DeckBundle = {
        ...bundle,
        slides: {
          ...bundle.slides,
          [slideId]: bundle.slides[slideId]!.replace(
            /(<span[^>]*data-sl-run="0"[^>]*>)([^<]*)(<\/span>)/,
            `$1${hostile}$3`,
          ),
        },
      }
      return { hostile, edited }
    })

    const exported = await Promise.all(
      edits.map(async ({ hostile, edited }) => ({
        hostile,
        result: await exportPptxRoundTrip(edited),
      })),
    )

    for (const { hostile, result } of exported) {
      expect(result.mode).toBe('patched')
      expect(result.bytes).not.toBeNull()

      const parts = unzipSync(result.bytes!)
      for (const [name, data] of Object.entries(parts)) {
        if (!name.endsWith('.xml') && !name.endsWith('.rels')) continue
        expect(hasXmlIllegalChars(strFromU8(data)), `${name} for ${JSON.stringify(hostile)}`).toBe(
          false,
        )
      }
    }
  })
})

describe('M4.6 — retention survives the deck container', () => {
  it('keeps the retained archive byte-identical across a .sloodge save and reload', async () => {
    const fixture = PPTX_FIXTURES[0]!
    const sourceBytes = await readFixture(fixture.name)
    const { bundle } = await importAndPersist(fixture.name)

    const retained = readRetainedImport(bundle)
    expect(retained).not.toBeNull()
    // Deflated into the .sloodge, inflated back out, and still the same bytes.
    expect(Buffer.compare(Buffer.from(retained!.archiveBytes), Buffer.from(sourceBytes))).toBe(0)
  })

  it('refuses to round-trip a deck whose retained archive was swapped for another', async () => {
    const { bundle } = await importAndPersist(PPTX_FIXTURES[0]!.name)
    const other = await readFixture(PPTX_FIXTURES[1]!.name)

    // The ledger still describes the first archive; the payload is now the second. Proceeding
    // would splice edits into parts from a package the ledger never saw.
    const tampered: DeckBundle = {
      ...bundle,
      extras: { ...bundle.extras, 'import/original.pptx': other },
    }
    expect(readRetainedImport(tampered)).toBeNull()
    expect((await exportPptxRoundTrip(tampered)).mode).toBe('rebuild')
  })

  it('ignores a corrupt ledger rather than trusting it', async () => {
    const { bundle } = await importAndPersist(PPTX_FIXTURES[0]!.name)
    const payloads = ['not json at all', '{"version":99}', '{}', 'null', '[]']
    const tampered = payloads.map((payload): DeckBundle => ({
      ...bundle,
      extras: { ...bundle.extras, [LEDGER_ENTRY]: strToU8(payload) },
    }))
    for (const deck of tampered) expect(readRetainedImport(deck)).toBeNull()
    const modes = await Promise.all(
      tampered.map(async (deck) => (await exportPptxRoundTrip(deck)).mode),
    )
    expect(modes).toEqual(payloads.map(() => 'rebuild'))
  })
})

describe('M4.6 — mutation coverage: the assertions can fail', () => {
  /**
   * The mutation the milestone names first: a writer that re-serializes an untouched part instead
   * of copying it. Here that mutation is applied to the *package* and the verifier is asked about
   * it — if `verifyPassthrough` were vacuous, this test would go green with `differing: []`.
   */
  it('detects an untouched part that was re-serialized rather than copied', async () => {
    const sourceBytes = await readFixture(PPTX_FIXTURES[0]!.name)
    const parts = unzipSync(sourceBytes)

    // A semantically equivalent re-serialization of one untouched part: whitespace between two
    // tags, exactly what a DOM round trip would introduce.
    const victim = 'ppt/presentation.xml'
    const original = strFromU8(parts[victim]!)
    const reserialized = original.replace('><', '>\n<')
    expect(reserialized).not.toBe(original)

    const mutated = zipSync({ ...parts, [victim]: strToU8(reserialized) }, { level: 6 })
    const verification = await verifyPassthrough(mutated, sourceBytes, [])

    expect(verification.differing).toEqual([victim])
    expect(verification.ok).toBe(false)
  })

  /**
   * The second named mutation: a ledger that marks nothing dirty. Modelled by handing the planner a
   * ledger whose recorded slide hashes match whatever the current HTML is — the exact behaviour a
   * broken comparison would produce — and asserting the plan wrongly claims `identity`. That is the
   * failure the edited-round-trip tests above would catch, and this pins *why* they catch it.
   */
  it('would mis-plan an edited deck as identity if the ledger never went dirty', async () => {
    const { bundle } = await importAndPersist(PPTX_FIXTURES[0]!.name)
    const retained = readRetainedImport(bundle)!
    const slideId = bundle.manifest.slideOrder[0]!
    const editedHtml = bundle.slides[slideId]!.replace('Quarterly', 'Annual')
    const slideHtml = { ...bundle.slides, [slideId]: editedHtml }

    // The real planner sees the edit.
    const honest = planRoundTrip(
      retained.ledger,
      { slideOrder: bundle.manifest.slideOrder, slideHtml },
      sha256Hex,
    )
    expect(honest.mode).toBe('patched')
    expect(honest.dirtySlideIds).toEqual([slideId])

    // Now the mutation: a ledger whose recorded hashes were re-derived from the *edited* HTML —
    // precisely the state a mark-based dirty-set lands in when an edit path forgets to mark. The
    // planner then reports `identity` and the export would re-emit the original bytes over the
    // user's change: silent data loss that looks like success.
    //
    // This is why dirtiness is *derived* from content rather than declared. The mutation is only
    // constructible by rewriting the ledger itself; no code path in the app can produce it.
    const staleLedger = {
      ...retained.ledger,
      slideHtml: Object.fromEntries(
        Object.entries(slideHtml).map(([id, html]) => [id, sha256Hex(html)]),
      ),
    }
    const blind = planRoundTrip(
      staleLedger,
      { slideOrder: bundle.manifest.slideOrder, slideHtml },
      sha256Hex,
    )
    expect(blind.mode).toBe('identity')
    expect(blind.dirtySlideIds).toEqual([])
  })

  /**
   * The third named mutation: a malicious part name. The `.pptx` is read through M1.1's hardened
   * reader, so a zip-slip entry is rejected before a byte is inflated — and it must be rejected at
   * *import*, not merely survived at export.
   */
  it('rejects a package carrying a zip-slip part name', async () => {
    const parts = unzipSync(await readFixture(PPTX_FIXTURES[0]!.name))
    const malicious = zipSync(
      { ...parts, '../../../../etc/cron.d/pwn': strToU8('* * * * * root sh -c evil\n') },
      { level: 6 },
    )
    const path = join(dir, 'zip-slip.pptx')
    await writeFile(path, malicious)

    const result = await importPptx(path, { now: NOW })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.error.code).toBe('unsafe-entry')
    expect(result.error.message).toContain('escapes the archive root')
  })
})
