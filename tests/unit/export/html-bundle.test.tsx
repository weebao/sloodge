/**
 * @vitest-environment happy-dom
 *
 * The HTML bundle builder (M4.4) — `deck + range → { path: bytes }`, pure, so everything that makes
 * an export correct is a plain assertion over an object.
 *
 * The load-bearing property is **agreement**: the manifest's slide count, the number of files under
 * `slides/`, and the slide list the shell embeds must describe the same set, no matter what the range
 * selected or which slides failed. A shell whose embedded list names a file the zip does not contain
 * is a bundle that 404s mid-talk, and it is exactly what a naive "build the manifest from the range,
 * then loop" implementation produces the first time a slide fails.
 */

import { describe, expect, it } from 'vitest'
import {
  BUNDLE_INDEX_PATH,
  BUNDLE_MANIFEST_PATH,
  buildHtmlBundle,
  slidePathFor,
  slugifySlideTitle,
} from '../../../src/shared/export/html-bundle'
import { SHELL_MANIFEST_ELEMENT_ID } from '../../../src/shared/export/presenter-shell'
import type { BundleManifest } from '../../../src/shared/export/presenter-shell'
import type { SlideExportInput, SlideRange } from '../../../src/shared/export/types'

const decoder = new TextDecoder()

function slide(
  title: string,
  html = `<!doctype html><title>${title}</title><p>${title}</p>`,
): SlideExportInput {
  return { id: `s_${title.toLowerCase().replace(/\W/g, '')}`, title, html }
}

function deck(titles: string[]): SlideExportInput[] {
  return titles.map((title) => slide(title))
}

function build(slides: SlideExportInput[], range: SlideRange = { kind: 'all' }, currentIndex = 0) {
  return buildHtmlBundle({
    slides,
    range,
    currentIndex,
    outPath: '/tmp/deck.zip',
    deckTitle: 'My Deck',
  })
}

function embeddedManifest(files: ReadonlyMap<string, Uint8Array>): BundleManifest {
  const index = decoder.decode(files.get(BUNDLE_INDEX_PATH))
  const doc = new DOMParser().parseFromString(index, 'text/html')
  return JSON.parse(doc.getElementById(SHELL_MANIFEST_ELEMENT_ID)?.textContent ?? '')
}

function slidePaths(files: ReadonlyMap<string, Uint8Array>): string[] {
  return [...files.keys()].filter((path) => path.startsWith('slides/'))
}

describe('slugifySlideTitle', () => {
  it('lowercases and hyphenates', () => {
    expect(slugifySlideTitle('Q1 Results')).toBe('q1-results')
  })

  it('drops everything that is not ASCII alphanumeric', () => {
    // Path separators, shell metacharacters and Windows-reserved characters must not survive into a
    // filename that gets written to the viewer's disk.
    expect(slugifySlideTitle('../../etc/passwd')).toBe('etc-passwd')
    expect(slugifySlideTitle('a:b*c?d"e<f>g|h')).toBe('a-b-c-d-e-f-g-h')
    expect(slugifySlideTitle('rm -rf $HOME; echo')).toBe('rm-rf-home-echo')
  })

  it('falls back for a title with nothing to slug', () => {
    expect(slugifySlideTitle('日本語のタイトル')).toBe('slide')
    expect(slugifySlideTitle('')).toBe('slide')
    expect(slugifySlideTitle('!!!')).toBe('slide')
  })

  it('truncates a very long title without leaving a trailing hyphen', () => {
    const slug = slugifySlideTitle(`${'a'.repeat(30)} ${'b'.repeat(30)}`)
    expect(slug.length).toBeLessThanOrEqual(40)
    expect(slug.endsWith('-')).toBe(false)
  })
})

describe('slidePathFor', () => {
  it('numbers from 001 and sorts in presentation order', () => {
    expect(slidePathFor(0, 'Title')).toBe('slides/001-title.html')
    expect(slidePathFor(9, 'Agenda')).toBe('slides/010-agenda.html')
    expect(slidePathFor(999, 'End')).toBe('slides/1000-end.html')
  })

  it('makes identical titles collide-free by construction', () => {
    expect(slidePathFor(2, 'Agenda')).not.toBe(slidePathFor(6, 'Agenda'))
  })
})

describe('buildHtmlBundle — layout', () => {
  it('emits the shell, the manifest, and one file per slide', () => {
    const { files, report } = build(deck(['Title', 'Agenda', 'End']))
    expect(files).not.toBeNull()
    expect([...files!.keys()]).toEqual([
      BUNDLE_INDEX_PATH,
      BUNDLE_MANIFEST_PATH,
      'slides/001-title.html',
      'slides/002-agenda.html',
      'slides/003-end.html',
    ])
    expect(report.fileCount).toBe(5)
  })

  it('stores each slide’s bytes verbatim', () => {
    const slides = deck(['Title', 'Agenda'])
    const { files } = build(slides)
    expect(decoder.decode(files!.get('slides/001-title.html'))).toBe(slides[0]!.html)
    expect(decoder.decode(files!.get('slides/002-agenda.html'))).toBe(slides[1]!.html)
  })

  it('emits no assets directory (the slide CSP forbids sibling files)', () => {
    const { files } = build(deck(['Title']))
    expect([...files!.keys()].some((path) => path.startsWith('assets/'))).toBe(false)
  })

  it('writes deck.json as the same manifest the shell embeds', () => {
    const { files, manifest } = build(deck(['Title', 'Agenda']))
    expect(JSON.parse(decoder.decode(files!.get(BUNDLE_MANIFEST_PATH)))).toEqual(manifest)
    expect(embeddedManifest(files!)).toEqual(manifest)
  })

  it('records each slide’s id so a re-import can match files back to slides', () => {
    const { manifest } = build(deck(['Title', 'Agenda']))
    expect(manifest!.slides.map((entry) => entry.id)).toEqual(['s_title', 's_agenda'])
  })
})

describe('buildHtmlBundle — manifest / slide-count agreement', () => {
  it('agrees across the manifest, the file map, and the embedded list', () => {
    const { files, manifest } = build(deck(['A', 'B', 'C', 'D']))
    const embedded = embeddedManifest(files!)
    expect(manifest!.slideCount).toBe(4)
    expect(manifest!.slides).toHaveLength(4)
    expect(slidePaths(files!)).toHaveLength(4)
    expect(embedded.slides.map((entry) => entry.file)).toEqual(slidePaths(files!))
  })

  it('never lists a file the bundle does not contain, even when a slide fails', () => {
    // The mutation this catches: building the manifest from the *range* rather than from the slides
    // that actually succeeded. That version lists 3 slides while the zip holds 2.
    const slides = [slide('A'), { id: 's_b', title: 'B', html: '   ' }, slide('C')]
    const { files, manifest } = build(slides)
    const embedded = embeddedManifest(files!)
    for (const entry of embedded.slides) {
      expect(files!.has(entry.file)).toBe(true)
    }
    expect(embedded.slides).toHaveLength(2)
    expect(manifest!.slideCount).toBe(2)
    expect(slidePaths(files!)).toHaveLength(2)
  })

  it('numbers surviving slides consecutively, leaving no gap where one failed', () => {
    const slides = [slide('A'), { id: 's_b', title: 'B', html: '' }, slide('C')]
    const { files } = build(slides)
    expect(slidePaths(files!)).toEqual(['slides/001-a.html', 'slides/002-c.html'])
  })
})

describe('buildHtmlBundle — range selection', () => {
  it('exports the whole deck for `all`', () => {
    const { report } = build(deck(['A', 'B', 'C']))
    expect(report.slideCount).toBe(3)
  })

  it('exports only the current slide for `current`', () => {
    const { files, manifest } = build(deck(['A', 'B', 'C']), { kind: 'current' }, 1)
    expect(manifest!.slides.map((entry) => entry.title)).toEqual(['B'])
    expect(slidePaths(files!)).toEqual(['slides/001-b.html'])
  })

  it('exports an inclusive 1-based span', () => {
    const { manifest } = build(deck(['A', 'B', 'C', 'D']), { kind: 'range', from: 2, to: 3 })
    expect(manifest!.slides.map((entry) => entry.title)).toEqual(['B', 'C'])
  })

  it('renumbers a range from 001 — the bundle is the export, not the deck', () => {
    const { files } = build(deck(['A', 'B', 'C', 'D']), { kind: 'range', from: 3, to: 4 })
    expect(slidePaths(files!)).toEqual(['slides/001-c.html', 'slides/002-d.html'])
  })

  it('writes nothing for an empty range', () => {
    const { files, manifest, report } = build(deck(['A', 'B']), { kind: 'range', from: 50, to: 60 })
    expect(files).toBeNull()
    expect(manifest).toBeNull()
    expect(report.slideCount).toBe(0)
    expect(report.fileCount).toBe(0)
    expect(report.warnings).toContain('The selected range contains no slides.')
  })

  it('writes nothing when `current` points past a shrunken deck', () => {
    const { files } = build(deck(['A']), { kind: 'current' }, 7)
    expect(files).toBeNull()
  })
})

describe('buildHtmlBundle — per-slide error isolation', () => {
  it('reports a blank slide as failed and still produces the bundle', () => {
    const slides = [slide('A'), { id: 's_b', title: 'B', html: '  \n  ' }, slide('C')]
    const { files, report } = build(slides)
    expect(files).not.toBeNull()
    expect(report.slides.map((outcome) => outcome.status)).toEqual(['ok', 'failed', 'ok'])
    expect(report.slides[1]?.error).toContain('empty')
    expect(report.warnings).toContain('Slide 2 (B) could not be exported.')
  })

  it('keeps report indices against the range, not against the survivors', () => {
    // `index` is "which slide the user selected", so it must not renumber when one drops out —
    // otherwise the warning points at the wrong slide in the deck.
    const slides = [{ id: 's_a', title: 'A', html: '' }, slide('B')]
    const { report } = build(slides)
    expect(report.slides.map((outcome) => outcome.index)).toEqual([0, 1])
  })

  it('writes nothing when every slide fails', () => {
    const slides = [
      { id: 's_a', title: 'A', html: '' },
      { id: 's_b', title: 'B', html: '' },
    ]
    const { files, manifest, report } = build(slides)
    expect(files).toBeNull()
    expect(manifest).toBeNull()
    expect(report.slideCount).toBe(2)
    expect(report.fileCount).toBe(0)
    expect(report.warnings).toContain('No slides could be exported.')
  })

  it('reports every slide ok on a clean export, with no warnings', () => {
    const { report } = build(deck(['A', 'B']))
    expect(report.warnings).toEqual([])
    expect(report.slides.every((outcome) => outcome.status === 'ok')).toBe(true)
    expect(report.format).toBe('html')
    expect(report.outPath).toBe('/tmp/deck.zip')
  })
})

describe('buildHtmlBundle — hostile deck title', () => {
  it('escapes the title into the shell without breaking any context', () => {
    const hostile = '</title><script>alert(1)</script>" onload="x'
    const { files } = buildHtmlBundle({
      slides: deck(['A']),
      range: { kind: 'all' },
      currentIndex: 0,
      outPath: '/tmp/deck.zip',
      deckTitle: hostile,
    })
    const doc = new DOMParser().parseFromString(
      decoder.decode(files!.get(BUNDLE_INDEX_PATH)),
      'text/html',
    )
    expect(doc.title).toBe(hostile)
    expect(doc.querySelectorAll('script')).toHaveLength(2)
    expect(embeddedManifest(files!).title).toBe(hostile)
  })
})
