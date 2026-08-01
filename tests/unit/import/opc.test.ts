/**
 * The OPC layer (M4.5). The interesting surface is relationship-target resolution: `..` is *legal*
 * there (OOXML writes `../media/image1.png` from inside `ppt/slides/`), so the zip layer's flat
 * "no `..` in an entry name" rule does not transfer and the check has to be on the resolved result.
 */

import { describe, expect, it } from 'vitest'
import { strToU8 } from 'fflate'
import {
  contentTypeOf,
  DEFAULT_OPC_LIMITS,
  OpcError,
  parseContentTypes,
  parseRelationships,
  readSlideGraph,
  readSlideSize,
  relationshipsPartFor,
  resolveRelationshipTarget,
  RT_OFFICE_DOCUMENT,
  RT_SLIDE,
} from '../../../src/shared/import/pptx/opc'
import { parseXml } from '../../../src/shared/import/xml'

describe('relationshipsPartFor', () => {
  it('maps a part to its sidecar .rels', () => {
    expect(relationshipsPartFor('ppt/presentation.xml')).toBe('ppt/_rels/presentation.xml.rels')
    expect(relationshipsPartFor('ppt/slides/slide1.xml')).toBe('ppt/slides/_rels/slide1.xml.rels')
    expect(relationshipsPartFor('doc.xml')).toBe('_rels/doc.xml.rels')
    expect(relationshipsPartFor('')).toBe('_rels/.rels')
  })
})

describe('resolveRelationshipTarget', () => {
  it('resolves relative targets against the source part directory', () => {
    expect(resolveRelationshipTarget('ppt/presentation.xml', 'slides/slide1.xml')).toBe(
      'ppt/slides/slide1.xml',
    )
    // `..` is normal and correct here — this is the shape OOXML actually writes.
    expect(resolveRelationshipTarget('ppt/slides/slide1.xml', '../media/image1.png')).toBe(
      'ppt/media/image1.png',
    )
    expect(resolveRelationshipTarget('ppt/slides/slide1.xml', './notesSlide1.xml')).toBe(
      'ppt/slides/notesSlide1.xml',
    )
    expect(resolveRelationshipTarget('', 'ppt/presentation.xml')).toBe('ppt/presentation.xml')
  })

  it('resolves an absolute target against the package root', () => {
    expect(resolveRelationshipTarget('ppt/slides/slide1.xml', '/ppt/media/x.png')).toBe(
      'ppt/media/x.png',
    )
  })

  it('refuses a target that escapes the package root', () => {
    expect(resolveRelationshipTarget('ppt/slides/slide1.xml', '../../../etc/passwd')).toBeNull()
    expect(resolveRelationshipTarget('ppt/presentation.xml', '../../evil')).toBeNull()
    expect(resolveRelationshipTarget('', '../evil')).toBeNull()
  })

  it('refuses prototype-pollution segments, backslashes, NULs and schemes', () => {
    expect(resolveRelationshipTarget('ppt/presentation.xml', '__proto__/x')).toBeNull()
    expect(resolveRelationshipTarget('ppt/presentation.xml', 'a\\b')).toBeNull()
    expect(resolveRelationshipTarget('ppt/presentation.xml', 'a\0b')).toBeNull()
    expect(resolveRelationshipTarget('ppt/presentation.xml', 'https://evil.example/x')).toBeNull()
    expect(resolveRelationshipTarget('ppt/presentation.xml', 'file:///etc/passwd')).toBeNull()
    expect(resolveRelationshipTarget('ppt/presentation.xml', '#fragment')).toBeNull()
    expect(resolveRelationshipTarget('ppt/presentation.xml', '')).toBeNull()
    expect(resolveRelationshipTarget('ppt/presentation.xml', `${'a/'.repeat(700)}b`)).toBeNull()
  })
})

describe('parseRelationships', () => {
  const xml = `<?xml version="1.0"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="${RT_SLIDE}" Target="slides/slide1.xml"/>
  <Relationship Id="rId2" Type="${RT_SLIDE}" Target="https://example.com/x" TargetMode="External"/>
  <Relationship Id="rId3" Type="${RT_SLIDE}" Target="../../escape.xml"/>
</Relationships>`

  it('reads ids, types and targets, and resolves internal ones', () => {
    const rels = parseRelationships(xml, 'ppt/presentation.xml')
    expect(rels.all).toHaveLength(3)
    expect(rels.byId['rId1']?.resolved).toBe('ppt/slides/slide1.xml')
    expect(rels.byId['rId2']?.external).toBe(true)
    expect(rels.byId['rId2']?.resolved).toBeNull()
    // Escaping target resolves to null; the graph walk is what turns that into a rejection.
    expect(rels.byId['rId3']?.resolved).toBeNull()
  })

  it('keeps the first of two relationships sharing an id', () => {
    const dupe = `<Relationships>
      <Relationship Id="rId1" Type="${RT_SLIDE}" Target="a.xml"/>
      <Relationship Id="rId1" Type="${RT_SLIDE}" Target="b.xml"/>
    </Relationships>`
    const rels = parseRelationships(dupe, 'ppt/presentation.xml')
    expect(rels.byId['rId1']?.target).toBe('a.xml')
  })

  it('caps the relationship count', () => {
    const many = `<Relationships>${`<Relationship Id="r" Type="t" Target="x"/>`.repeat(5)}</Relationships>`
    expect(() =>
      parseRelationships(many, 'p.xml', { ...DEFAULT_OPC_LIMITS, maxRelationships: 4 }),
    ).toThrow(OpcError)
  })
})

describe('parseContentTypes', () => {
  const xml = `<Types>
    <Default Extension="PNG" ContentType="image/png"/>
    <Default Extension="xml" ContentType="application/xml"/>
    <Override PartName="/ppt/presentation.xml" ContentType="application/pptx-main"/>
    <Override PartName="/__proto__/x.xml" ContentType="evil"/>
  </Types>`

  it('reads defaults case-insensitively and overrides without the leading slash', () => {
    const types = parseContentTypes(xml)
    expect(contentTypeOf(types, 'ppt/media/image1.png')).toBe('image/png')
    expect(contentTypeOf(types, 'ppt/media/IMAGE1.PNG')).toBe('image/png')
    expect(contentTypeOf(types, 'ppt/slides/slide1.xml')).toBe('application/xml')
    // An Override beats the extension Default (OPC §10.1.2.2).
    expect(contentTypeOf(types, 'ppt/presentation.xml')).toBe('application/pptx-main')
    expect(contentTypeOf(types, 'no-extension')).toBeUndefined()
  })

  it('drops prototype-pollution part names and keeps the map off the prototype chain', () => {
    const types = parseContentTypes(xml)
    expect(Object.getPrototypeOf(types.overrides)).toBeNull()
    expect(Object.getPrototypeOf(types.defaults)).toBeNull()
    // The Override itself is dropped. `contentTypeOf` still answers `application/xml` for that name
    // via the extension Default, which is correct — the pollution vector was the *key*, and it never
    // entered the map.
    expect(Object.keys(types.overrides)).toEqual(['ppt/presentation.xml'])
    expect(contentTypeOf(types, '__proto__/x.xml')).toBe('application/xml')
    expect(({} as Record<string, unknown>)['x.xml']).toBeUndefined()
  })
})

/** A minimal but well-formed package, built part by part so each failure mode is isolatable. */
function buildPackage(overrides: Partial<Record<string, string>> = {}): Record<string, Uint8Array> {
  const parts: Record<string, string> = {
    '[Content_Types].xml': `<Types>
      <Default Extension="xml" ContentType="application/xml"/>
      <Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>
    </Types>`,
    '_rels/.rels': `<Relationships><Relationship Id="rId1" Type="${RT_OFFICE_DOCUMENT}" Target="ppt/presentation.xml"/></Relationships>`,
    'ppt/presentation.xml': `<p:presentation><p:sldIdLst><p:sldId id="256" r:id="rIdS1"/><p:sldId id="257" r:id="rIdS2"/></p:sldIdLst><p:sldSz cx="12192000" cy="6858000"/></p:presentation>`,
    'ppt/_rels/presentation.xml.rels': `<Relationships>
      <Relationship Id="rIdS1" Type="${RT_SLIDE}" Target="slides/slide1.xml"/>
      <Relationship Id="rIdS2" Type="${RT_SLIDE}" Target="slides/slide2.xml"/>
    </Relationships>`,
    'ppt/slides/slide1.xml': '<p:sld/>',
    'ppt/slides/slide2.xml': '<p:sld/>',
    ...overrides,
  }
  const out = Object.create(null) as Record<string, Uint8Array>
  for (const [name, xml] of Object.entries(parts)) {
    if (xml !== undefined) out[name] = strToU8(xml)
  }
  return out
}

describe('readSlideGraph', () => {
  it('walks the package to an ordered slide list', () => {
    const graph = readSlideGraph(buildPackage())
    expect(graph.kind).toBe('presentation')
    expect(graph.presentationPart).toBe('ppt/presentation.xml')
    expect(graph.slideParts).toEqual(['ppt/slides/slide1.xml', 'ppt/slides/slide2.xml'])
    expect(graph.warnings).toEqual([])
  })

  it('honours sldIdLst order rather than part-name order', () => {
    const graph = readSlideGraph(
      buildPackage({
        'ppt/presentation.xml': `<p:presentation><p:sldIdLst><p:sldId r:id="rIdS2"/><p:sldId r:id="rIdS1"/></p:sldIdLst></p:presentation>`,
      }),
    )
    expect(graph.slideParts).toEqual(['ppt/slides/slide2.xml', 'ppt/slides/slide1.xml'])
  })

  it('deduplicates a slide part referenced more than once', () => {
    const graph = readSlideGraph(
      buildPackage({
        'ppt/presentation.xml': `<p:presentation><p:sldIdLst><p:sldId r:id="rIdS1"/><p:sldId r:id="rIdS1"/><p:sldId r:id="rIdS2"/></p:sldIdLst></p:presentation>`,
      }),
    )
    expect(graph.slideParts).toEqual(['ppt/slides/slide1.xml', 'ppt/slides/slide2.xml'])
    expect(graph.warnings.join(' ')).toContain('referenced more than once')
  })

  it('skips a missing slide part with a warning rather than failing the import', () => {
    const parts = buildPackage()
    delete parts['ppt/slides/slide2.xml']
    const graph = readSlideGraph(parts)
    expect(graph.slideParts).toEqual(['ppt/slides/slide1.xml'])
    expect(graph.warnings.join(' ')).toContain('missing from the package')
  })

  it('rejects a slide relationship that escapes the package', () => {
    expect(() =>
      readSlideGraph(
        buildPackage({
          'ppt/_rels/presentation.xml.rels': `<Relationships><Relationship Id="rIdS1" Type="${RT_SLIDE}" Target="../../../../evil.xml"/></Relationships>`,
          'ppt/presentation.xml': `<p:presentation><p:sldIdLst><p:sldId r:id="rIdS1"/></p:sldIdLst></p:presentation>`,
        }),
      ),
    ).toThrow(/escapes the package/)
  })

  it('rejects a package with no [Content_Types].xml, no root rels, or no officeDocument', () => {
    const noTypes = buildPackage()
    delete noTypes['[Content_Types].xml']
    expect(() => readSlideGraph(noTypes)).toThrow(/no \[Content_Types\]/)

    const noRels = buildPackage()
    delete noRels['_rels/.rels']
    expect(() => readSlideGraph(noRels)).toThrow(/no _rels\/\.rels/)

    expect(() => readSlideGraph(buildPackage({ '_rels/.rels': '<Relationships/>' }))).toThrow(
      /no officeDocument relationship/,
    )
  })

  it('rejects an officeDocument part that is not in the package', () => {
    expect(() =>
      readSlideGraph(
        buildPackage({
          '_rels/.rels': `<Relationships><Relationship Id="rId1" Type="${RT_OFFICE_DOCUMENT}" Target="ppt/missing.xml"/></Relationships>`,
        }),
      ),
    ).toThrow(/missing from the package/)
  })

  it('imports a template kind and warns about an unexpected main content type', () => {
    const template = readSlideGraph(
      buildPackage({
        '[Content_Types].xml': `<Types><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.template.main+xml"/></Types>`,
      }),
    )
    expect(template.kind).toBe('template')

    const odd = readSlideGraph(buildPackage({ '[Content_Types].xml': '<Types/>' }))
    expect(odd.kind).toBe('presentation')
    expect(odd.warnings.join(' ')).toContain('treating it as a presentation')
  })

  it('caps the declared slide count', () => {
    const many = `<p:presentation><p:sldIdLst>${'<p:sldId r:id="rIdS1"/>'.repeat(10)}</p:sldIdLst></p:presentation>`
    expect(() =>
      readSlideGraph(buildPackage({ 'ppt/presentation.xml': many }), {
        ...DEFAULT_OPC_LIMITS,
        maxSlides: 5,
      }),
    ).toThrow(/over the 5 limit/)
  })

  it('has zero slides for a presentation with no sldIdLst', () => {
    const graph = readSlideGraph(buildPackage({ 'ppt/presentation.xml': '<p:presentation/>' }))
    expect(graph.slideParts).toEqual([])
  })
})

describe('readSlideSize', () => {
  it('reads sldSz, and falls back for a missing or nonsensical one', () => {
    expect(readSlideSize(parseXml('<p><p:sldSz cx="9144000" cy="6858000"/></p>'))).toEqual({
      widthEmu: 9_144_000,
      heightEmu: 6_858_000,
    })
    expect(readSlideSize(parseXml('<p/>'))).toEqual({ widthEmu: 12_192_000, heightEmu: 6_858_000 })
    // A zero or negative dimension would make the px scale infinite or negative.
    expect(readSlideSize(parseXml('<p><p:sldSz cx="0" cy="100"/></p>')).widthEmu).toBe(12_192_000)
    expect(readSlideSize(parseXml('<p><p:sldSz cx="-5" cy="100"/></p>')).widthEmu).toBe(12_192_000)
    expect(readSlideSize(parseXml('<p><p:sldSz cx="abc" cy="x"/></p>')).widthEmu).toBe(12_192_000)
  })
})
