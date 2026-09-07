/**
 * The edit ledger and the round-trip planner (M4.5 / M4.6), tested as the pure functions they are.
 *
 * The design claim under test: dirtiness is **derived from content**, never declared. No test here
 * marks anything dirty, because nothing in the production code can.
 */

import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { strToU8 } from 'fflate'
import {
  buildLedger,
  LEDGER_VERSION,
  parseLedger,
  planRoundTrip,
  type ImportLedger,
} from '../../../src/shared/import/pptx/ledger'

const hash = (input: string | Uint8Array): string =>
  createHash('sha256')
    .update(typeof input === 'string' ? Buffer.from(input, 'utf8') : Buffer.from(input))
    .digest('hex')

const S1 = 's_01H8XQZ4P7K2M9NB3VYRTC6FDA'
const S2 = 's_01H8XR0M5S8T1WQZ9C4XKB7GEH'

function fixtureLedger(): ImportLedger {
  return buildLedger({
    format: 'pptx',
    fileName: 'deck.pptx',
    archiveBytes: strToU8('ARCHIVE'),
    parts: {
      '[Content_Types].xml': strToU8('<Types/>'),
      'ppt/presentation.xml': strToU8('<p/>'),
      'ppt/slides/slide1.xml': strToU8('<s1/>'),
      'ppt/slides/slide2.xml': strToU8('<s2/>'),
    },
    slides: [
      { slideId: S1, part: 'ppt/slides/slide1.xml', html: '<html>one</html>' },
      { slideId: S2, part: 'ppt/slides/slide2.xml', html: '<html>two</html>' },
    ],
    importedAt: '2026-08-01T00:00:00.000Z',
    hash,
  })
}

const CURRENT = {
  slideOrder: [S1, S2],
  slideHtml: { [S1]: '<html>one</html>', [S2]: '<html>two</html>' },
}

describe('buildLedger', () => {
  it('records a hash and size for every part and every slide', () => {
    const ledger = fixtureLedger()
    expect(ledger.version).toBe(LEDGER_VERSION)
    expect(ledger.source).toMatchObject({ format: 'pptx', fileName: 'deck.pptx', bytes: 7 })
    expect(ledger.source.sha256).toBe(hash(strToU8('ARCHIVE')))
    expect(Object.keys(ledger.parts)).toHaveLength(4)
    expect(ledger.parts['ppt/slides/slide1.xml']).toEqual({
      sha256: hash(strToU8('<s1/>')),
      bytes: 5,
    })
    expect(ledger.slidePart[S1]).toBe('ppt/slides/slide1.xml')
    expect(ledger.slideHtml[S1]).toBe(hash('<html>one</html>'))
    expect(ledger.slideOrder).toEqual([S1, S2])
  })

  it('keeps its name-keyed maps off the prototype chain', () => {
    const ledger = fixtureLedger()
    expect(Object.getPrototypeOf(ledger.parts)).toBeNull()
    expect(Object.getPrototypeOf(ledger.slidePart)).toBeNull()
    expect(Object.getPrototypeOf(ledger.slideHtml)).toBeNull()
  })
})

describe('planRoundTrip', () => {
  it('is identity when nothing changed, and passes every part through', () => {
    const plan = planRoundTrip(fixtureLedger(), CURRENT, hash)
    expect(plan.mode).toBe('identity')
    expect(plan.dirtySlideIds).toEqual([])
    expect(plan.rewriteParts).toEqual([])
    expect(plan.passthroughParts).toHaveLength(4)
  })

  it('is patched when a slide changed, rewriting only that slide part', () => {
    const plan = planRoundTrip(
      fixtureLedger(),
      { ...CURRENT, slideHtml: { ...CURRENT.slideHtml, [S2]: '<html>TWO EDITED</html>' } },
      hash,
    )
    expect(plan.mode).toBe('patched')
    expect(plan.dirtySlideIds).toEqual([S2])
    expect(plan.rewriteParts).toEqual(['ppt/slides/slide2.xml'])
    expect(plan.passthroughParts).toEqual([
      '[Content_Types].xml',
      'ppt/presentation.xml',
      'ppt/slides/slide1.xml',
    ])
    // Rewrite and passthrough partition the package: no part is in both, none is missing.
    expect([...plan.rewriteParts, ...plan.passthroughParts].toSorted()).toEqual(
      Object.keys(fixtureLedger().parts).toSorted(),
    )
  })

  it('detects every edited slide, not merely the first', () => {
    const plan = planRoundTrip(
      fixtureLedger(),
      { ...CURRENT, slideHtml: { [S1]: '<html>A</html>', [S2]: '<html>B</html>' } },
      hash,
    )
    expect(plan.dirtySlideIds).toEqual([S1, S2])
    expect(plan.rewriteParts).toEqual(['ppt/slides/slide1.xml', 'ppt/slides/slide2.xml'])
    expect(plan.passthroughParts).toEqual(['[Content_Types].xml', 'ppt/presentation.xml'])
  })

  it('rebuilds on a structural change: added, removed or reordered', () => {
    const added = planRoundTrip(
      fixtureLedger(),
      { slideOrder: [S1, S2, 's_new'], slideHtml: { ...CURRENT.slideHtml, s_new: '<html/>' } },
      hash,
    )
    expect(added.mode).toBe('rebuild')

    const removed = planRoundTrip(
      fixtureLedger(),
      { slideOrder: [S1], slideHtml: { [S1]: '<html>one</html>' } },
      hash,
    )
    expect(removed.mode).toBe('rebuild')

    const reordered = planRoundTrip(fixtureLedger(), { ...CURRENT, slideOrder: [S2, S1] }, hash)
    expect(reordered.mode).toBe('rebuild')
    expect(reordered.reasons.join(' ')).toContain('slide set or order changed')
  })

  it('claims nothing in rebuild mode', () => {
    const plan = planRoundTrip(fixtureLedger(), { ...CURRENT, slideOrder: [S2, S1] }, hash)
    expect(plan.passthroughParts).toEqual([])
    expect(plan.rewriteParts).toEqual([])
  })

  it('rebuilds when a dirty slide is not patchable', () => {
    const plan = planRoundTrip(
      fixtureLedger(),
      { ...CURRENT, slideHtml: { ...CURRENT.slideHtml, [S1]: '<html>edited</html>' } },
      hash,
      () => false,
    )
    expect(plan.mode).toBe('rebuild')
    expect(plan.dirtySlideIds).toEqual([S1])
    expect(plan.reasons.join(' ')).toContain('cannot be expressed as text substitution')
  })

  it('rebuilds rather than assuming "unchanged" when a slide has no HTML', () => {
    const plan = planRoundTrip(
      fixtureLedger(),
      { slideOrder: [S1, S2], slideHtml: { [S1]: '<html>one</html>' } },
      hash,
    )
    expect(plan.mode).toBe('rebuild')
    expect(plan.reasons.join(' ')).toContain('has no HTML')
  })

  it('rebuilds for a ledger from another version rather than guessing at it', () => {
    const plan = planRoundTrip({ ...fixtureLedger(), version: 99 }, CURRENT, hash)
    expect(plan.mode).toBe('rebuild')
    expect(plan.reasons.join(' ')).toContain('ledger version 99')
  })
})

describe('parseLedger', () => {
  const valid = JSON.parse(JSON.stringify(fixtureLedger())) as unknown

  it('accepts a ledger it produced', () => {
    const parsed = parseLedger(valid)
    expect(parsed).not.toBeNull()
    expect(parsed?.slideOrder).toEqual([S1, S2])
    expect(Object.getPrototypeOf(parsed!.parts)).toBeNull()
  })

  it('rejects every malformed shape rather than coercing it', () => {
    const bad: unknown[] = [
      null,
      'string',
      42,
      [],
      {},
      { ...(valid as object), version: 2 },
      { ...(valid as object), source: null },
      { ...(valid as object), source: { ...(valid as { source: object }).source, sha256: 'nope' } },
      { ...(valid as object), source: { ...(valid as { source: object }).source, format: 'docx' } },
      { ...(valid as object), source: { ...(valid as { source: object }).source, bytes: -1 } },
      { ...(valid as object), parts: 'not an object' },
      { ...(valid as object), parts: { 'a.xml': { sha256: 'short', bytes: 1 } } },
      { ...(valid as object), parts: { 'a.xml': { sha256: hash('x') } } },
      { ...(valid as object), slidePart: { [S1]: 42 } },
      { ...(valid as object), slideHtml: { [S1]: 'not-a-hash' } },
      { ...(valid as object), slideOrder: 'nope' },
      { ...(valid as object), slideOrder: [1, 2] },
    ]
    for (const value of bad) expect(parseLedger(value)).toBeNull()
  })

  it('rejects a ledger carrying a __proto__ key anywhere', () => {
    expect(
      parseLedger(
        JSON.parse(
          `{"version":1,"source":{"format":"pptx","sha256":"${hash('a')}","bytes":1,"importedAt":"x","fileName":"y"},"parts":{"__proto__":{"sha256":"${hash('a')}","bytes":1}},"slidePart":{},"slideHtml":{},"slideOrder":[]}`,
        ),
      ),
    ).toBeNull()
  })

  it('survives a JSON round trip without losing a field', () => {
    const parsed = parseLedger(JSON.parse(JSON.stringify(fixtureLedger())))!
    expect(parsed.source).toEqual(fixtureLedger().source)
    expect({ ...parsed.parts }).toEqual({ ...fixtureLedger().parts })
    expect({ ...parsed.slideHtml }).toEqual({ ...fixtureLedger().slideHtml })
  })
})
