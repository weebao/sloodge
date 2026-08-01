/**
 * @vitest-environment happy-dom
 *
 * The zip step of HTML export (M4.4), tested the only way a serializer is worth testing: by
 * **round-tripping**. Build a bundle, zip it, unzip it with the same library's independent read
 * path, and assert the file map came back byte-identical and that `index.html` still parses.
 *
 * Asserting on zip internals would test fflate. Asserting on the round trip tests *us*: the root
 * prefix, the path separators, that nothing was truncated, and that a slide's UTF-8 survived the
 * trip — which is what a user unzipping the bundle on their own machine actually experiences.
 */

import { unzipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import {
  BUNDLE_INDEX_PATH,
  BUNDLE_MANIFEST_PATH,
  buildHtmlBundle,
} from '../../../src/shared/export/html-bundle'
import {
  bundleRootName,
  defaultHtmlFileName,
  zipHtmlBundle,
} from '../../../src/main/export/html-export'
import { SHELL_MANIFEST_ELEMENT_ID } from '../../../src/shared/export/presenter-shell'
import type { BundleManifest } from '../../../src/shared/export/presenter-shell'
import type { SlideExportInput } from '../../../src/shared/export/types'

const decoder = new TextDecoder()

const SLIDES: SlideExportInput[] = [
  { id: 's_a', title: 'Title', html: '<!doctype html><title>Title</title><h1>Héllo — 世界</h1>' },
  { id: 's_b', title: 'Agenda', html: '<!doctype html><title>Agenda</title><ul><li>One</li></ul>' },
]

function buildAndZip(deckTitle = 'My Deck') {
  const { files } = buildHtmlBundle({
    slides: SLIDES,
    range: { kind: 'all' },
    currentIndex: 0,
    outPath: '/tmp/out.zip',
    deckTitle,
  })
  const root = bundleRootName(deckTitle)
  return { files: files!, root, zipped: zipHtmlBundle(files!, root) }
}

describe('bundleRootName / defaultHtmlFileName', () => {
  it('slugs a deck title into a folder and a filename', () => {
    expect(bundleRootName('My Deck')).toBe('My-Deck')
    expect(defaultHtmlFileName('My Deck')).toBe('My-Deck.zip')
  })

  it('falls back for a title that reduces to nothing', () => {
    expect(bundleRootName('')).toBe('deck')
    expect(bundleRootName('///')).toBe('deck')
    expect(defaultHtmlFileName('   ')).toBe('deck.zip')
  })

  it('drops path separators, so no member can escape the root', () => {
    expect(bundleRootName('../../etc')).toBe('etc')
    expect(bundleRootName('a/b')).toBe('ab')
  })
})

describe('zipHtmlBundle — round trip', () => {
  it('unzips to exactly the file map that went in', () => {
    const { files, root, zipped } = buildAndZip()
    const out = unzipSync(zipped)

    expect(Object.keys(out).toSorted()).toEqual(
      [...files.keys()].map((p) => `${root}/${p}`).toSorted(),
    )
    for (const [path, bytes] of files) {
      expect(Array.from(out[`${root}/${path}`]!)).toEqual(Array.from(bytes))
    }
  })

  it('nests everything under one folder named for the deck', () => {
    const { root, zipped } = buildAndZip()
    const paths = Object.keys(unzipSync(zipped))
    expect(paths.length).toBeGreaterThan(0)
    for (const path of paths) expect(path.startsWith(`${root}/`)).toBe(true)
  })

  it('produces an index.html that still parses, with its manifest intact', () => {
    const { root, zipped } = buildAndZip()
    const out = unzipSync(zipped)
    const html = decoder.decode(out[`${root}/${BUNDLE_INDEX_PATH}`])
    const doc = new DOMParser().parseFromString(html, 'text/html')

    expect(doc.title).toBe('My Deck')
    expect(doc.querySelectorAll('iframe').length).toBeGreaterThan(0)
    const manifest = JSON.parse(
      doc.getElementById(SHELL_MANIFEST_ELEMENT_ID)?.textContent ?? '',
    ) as BundleManifest
    expect(manifest.slides).toHaveLength(2)
    // Every file the shell will ask for is actually in the archive.
    for (const entry of manifest.slides) {
      expect(out[`${root}/${entry.file}`]).toBeDefined()
    }
  })

  it('round-trips non-ASCII slide content byte-for-byte', () => {
    const { root, zipped } = buildAndZip()
    const out = unzipSync(zipped)
    expect(decoder.decode(out[`${root}/slides/001-title.html`])).toBe(SLIDES[0]!.html)
  })

  it('keeps deck.json parseable after the trip', () => {
    const { root, zipped } = buildAndZip()
    const out = unzipSync(zipped)
    const manifest = JSON.parse(decoder.decode(out[`${root}/${BUNDLE_MANIFEST_PATH}`]))
    expect(manifest.generator).toBe('sloodge')
    expect(manifest.slideCount).toBe(2)
  })

  it('is byte-deterministic — the same deck zips to the same archive', () => {
    // `mtime: 0`. Without it the archive embeds the wall clock and two exports of an unchanged deck
    // differ, which makes a bundle undiffable and this suite unable to assert on the bytes at all.
    expect(Array.from(buildAndZip().zipped)).toEqual(Array.from(buildAndZip().zipped))
  })

  it('survives a hostile deck title through the whole pipeline', () => {
    const hostile = '</title><script>alert(1)</script>'
    const { root, zipped } = buildAndZip(hostile)
    const doc = new DOMParser().parseFromString(
      decoder.decode(unzipSync(zipped)[`${root}/${BUNDLE_INDEX_PATH}`]),
      'text/html',
    )
    expect(doc.title).toBe(hostile)
    expect(doc.querySelectorAll('script')).toHaveLength(2)
  })
})
