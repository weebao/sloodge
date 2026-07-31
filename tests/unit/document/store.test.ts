import { mkdtemp, mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { strToU8, unzipSync, zipSync } from 'fflate'
import { beforeAll, describe, expect, it } from 'vitest'
import {
  addSlide,
  createEmptyDeck,
  createSlideEntry,
  newSlideId,
} from '../../../src/shared/document/deck'
import { createStarterSlideHtml } from '../../../src/shared/document/starter-slide'
import {
  DEFAULT_THEME_PATH,
  MAX_FORMAT_VERSION,
  type Theme,
} from '../../../src/shared/document/types'
import {
  packDeck,
  readDeck,
  writeDeck,
  hasStaleTmp,
  type DeckBundle,
} from '../../../src/main/document/store'

const T0 = 1_770_000_000_000
const THEME_ID = 't_01H8XQZ4P7K2M9NB3VYRTC6FDA'

let dir = ''

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'sloodge-store-'))
})

function fixtureTheme(): Theme {
  return {
    formatVersion: 1,
    id: THEME_ID,
    name: 'Midnight',
    mode: 'dark',
    derivedFrom: '#4c8dff',
    tokens: {
      color: { bg: '#0d1220', fg: '#f0f0f5', accent: '#4c8dff', muted: '#9aa4b8' },
      series: ['#4c8dff', '#f0a04b', '#7fd1ae'],
      font: { sans: 'Inter, sans-serif' },
      size: { title: 48, body: 24 },
      space: { pad: 48, gap: 16, radius: 14 },
    },
    version: 1,
  }
}

function fixtureBundle(): DeckBundle {
  const a = createSlideEntry({ now: T0, title: 'Title slide', kind: 'title', withNotes: true })
  const b = createSlideEntry({ now: T0 + 1, title: 'Chart', kind: 'chart' })
  // The fixture ships a theme, so it asks for the theme path explicitly — `createEmptyDeck` no
  // longer points at a `theme/theme.json` nobody writes (see its docblock).
  let manifest = createEmptyDeck({
    now: T0,
    title: 'Fixture deck',
    authors: ['a@example.com'],
    theme: DEFAULT_THEME_PATH,
  })
  manifest = addSlide(manifest, a)
  manifest = addSlide(manifest, b)
  return {
    manifest,
    slides: {
      [a.id]: createStarterSlideHtml({ id: a.id, title: 'Title slide' }),
      [b.id]: createStarterSlideHtml({ id: b.id, title: 'Chart' }),
    },
    notes: { [a.id]: '# Talk track\n\nOpen with the number.\n' },
    theme: fixtureTheme(),
    extras: {},
  }
}

/** Re-pack an archive from a fixture, with the entry map rewritten by `mutate`. */
async function craft(
  name: string,
  mutate: (entries: Record<string, Uint8Array>) => void,
  bundle: DeckBundle = fixtureBundle(),
): Promise<string> {
  const entries = unzipSync(await packDeck(bundle))
  mutate(entries)
  const path = join(dir, name)
  await writeFile(path, zipSync(entries))
  return path
}

function manifestOf(entries: Record<string, Uint8Array>): Record<string, unknown> {
  return JSON.parse(new TextDecoder().decode(entries['manifest.json']!)) as Record<string, unknown>
}

function setManifest(entries: Record<string, Uint8Array>, manifest: unknown): void {
  entries['manifest.json'] = strToU8(JSON.stringify(manifest, null, 2))
}

async function saveFixture(name: string, bundle: DeckBundle = fixtureBundle()): Promise<string> {
  const path = join(dir, name)
  const result = await writeDeck(path, bundle)
  expect(result.ok).toBe(true)
  return path
}

describe('writeDeck / readDeck round-trip', () => {
  it('round-trips the manifest exactly', async () => {
    const bundle = fixtureBundle()
    const path = await saveFixture('round-trip.sloodge', bundle)
    const read = await readDeck(path)
    expect(read.ok).toBe(true)
    if (!read.ok) return
    expect(read.bundle.manifest).toEqual(bundle.manifest)
    expect(read.warnings).toEqual([])
  })

  it('round-trips slide HTML, notes and the parsed theme', async () => {
    const bundle = fixtureBundle()
    const path = await saveFixture('content.sloodge', bundle)
    const read = await readDeck(path)
    expect(read.ok).toBe(true)
    if (!read.ok) return
    expect(read.bundle.slides).toEqual(bundle.slides)
    expect(read.bundle.notes).toEqual(bundle.notes)
    expect(read.bundle.theme).toEqual(bundle.theme)
    expect(read.bundle.extras).toEqual({})
  })

  it('preserves unknown manifest fields written by a future version', async () => {
    const bundle = fixtureBundle()
    const firstId = bundle.manifest.slideOrder[0]!
    bundle.manifest['futureDeckKey'] = { nested: [1, 'two', { three: true }] }
    bundle.manifest.slides[firstId]!['futureSlideKey'] = 'survive me'
    const path = await saveFixture('unknown-fields.sloodge', bundle)

    const read = await readDeck(path)
    expect(read.ok).toBe(true)
    if (!read.ok) return
    expect(read.bundle.manifest['futureDeckKey']).toEqual({ nested: [1, 'two', { three: true }] })
    expect(read.bundle.manifest.slides[firstId]?.['futureSlideKey']).toBe('survive me')

    // …and a second save keeps them, so an old build cannot silently strip a new build's data.
    const second = join(dir, 'unknown-fields-2.sloodge')
    expect((await writeDeck(second, read.bundle)).ok).toBe(true)
    const reread = await readDeck(second)
    expect(reread.ok && reread.bundle.manifest).toEqual(read.bundle.manifest)
  })

  it('copies unknown archive entries through verbatim', async () => {
    const bundle = fixtureBundle()
    const firstId = bundle.manifest.slideOrder[0]!
    bundle.extras[`thumbs/${firstId}.webp`] = new Uint8Array([1, 2, 3, 4])
    bundle.extras['future/dir/data.bin'] = new Uint8Array([9, 8, 7])
    const path = await saveFixture('extras.sloodge', bundle)

    const read = await readDeck(path)
    expect(read.ok).toBe(true)
    if (!read.ok) return
    expect(read.bundle.extras[`thumbs/${firstId}.webp`]).toEqual(new Uint8Array([1, 2, 3, 4]))
    expect(read.bundle.extras['future/dir/data.bin']).toEqual(new Uint8Array([9, 8, 7]))
  })

  it('writes mimetype first and STORED, OPC-style', async () => {
    const bytes = await packDeck(fixtureBundle())
    expect([...bytes.subarray(0, 4)]).toEqual([0x50, 0x4b, 0x03, 0x04])
    const method = bytes[8]! | (bytes[9]! << 8)
    expect(method).toBe(0) // 0 = stored
    const nameLength = bytes[26]! | (bytes[27]! << 8)
    expect(new TextDecoder().decode(bytes.subarray(30, 30 + nameLength))).toBe('mimetype')

    const entries = unzipSync(bytes)
    expect(new TextDecoder().decode(entries['mimetype']!)).toBe('application/vnd.sloodge.deck+zip')
    expect(Object.keys(entries)).toContain('manifest.json')
  })

  it('lays the archive out per §1.1', async () => {
    const path = await saveFixture('layout.sloodge')
    const entries = Object.keys(unzipSync(new Uint8Array(await readFile(path))))
    expect(entries).toContain('theme/theme.json')
    expect(entries.filter((name) => name.startsWith('slides/')).length).toBe(2)
    expect(entries.filter((name) => name.startsWith('notes/')).length).toBe(1)
  })
})

describe('a brand-new deck (M3)', () => {
  it('creates, saves and reopens with no warnings at all', async () => {
    // The default happy path must not produce a document the reader considers damaged: with no
    // theme picked there is no `manifest.theme`, so there is no missing `theme/theme.json`.
    const slide = createSlideEntry({ now: T0, title: 'First slide' })
    const manifest = addSlide(createEmptyDeck({ now: T0, title: 'Brand new' }), slide)
    const bundle: DeckBundle = {
      manifest,
      slides: { [slide.id]: createStarterSlideHtml({ id: slide.id, title: 'First slide' }) },
      notes: {},
      theme: null,
      extras: {},
    }
    const path = join(dir, 'brand-new.sloodge')
    expect((await writeDeck(path, bundle)).ok).toBe(true)

    const read = await readDeck(path)
    expect(read.ok).toBe(true)
    if (!read.ok) return
    expect(read.warnings).toEqual([])
    expect(read.bundle.manifest.theme).toBeUndefined()
    expect(read.bundle.theme).toBeNull()
    expect(Object.keys(read.bundle.extras)).toEqual([])
  })

  it('refuses to pack theme bytes the manifest does not point at', async () => {
    const bundle = fixtureBundle()
    delete bundle.manifest.theme
    const result = await writeDeck(join(dir, 'orphan-theme.sloodge'), bundle)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('incomplete-bundle')
    expect(result.error.message).toContain('manifest.theme')
  })

  it('refuses to pack two different payloads onto one archive path', async () => {
    // `manifest.theme` is a free-form archive path, so pointing it at a slide's own HTML file used
    // to make the theme claim win and the slide body disappear from the saved deck without a word.
    const bundle = fixtureBundle()
    const firstId = bundle.manifest.slideOrder[0]!
    bundle.manifest.theme = `slides/${firstId}.html`
    const result = await writeDeck(join(dir, 'collide.sloodge'), bundle)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('incomplete-bundle')
    expect(result.error.message).toContain(`slides/${firstId}.html`)
  })
})

describe('atomic save', () => {
  it('leaves no .tmp file behind after a successful save', async () => {
    await saveFixture('atomic.sloodge')
    const files = await readdir(dir)
    expect(files).toContain('atomic.sloodge')
    expect(files.some((name) => name.endsWith('.tmp'))).toBe(false)
  })

  it('cleans up the .tmp file when the rename fails', async () => {
    const target = join(dir, 'occupied.sloodge')
    await mkdir(target) // renaming a file over a directory fails on every platform
    const result = await writeDeck(target, fixtureBundle())
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('io')
    const files = await readdir(dir)
    expect(files.filter((name) => name.startsWith('occupied.sloodge.'))).toEqual([])
  })

  it('stages through a unique tmp name so concurrent saves cannot collide', async () => {
    const path = join(dir, 'concurrent.sloodge')
    const a = fixtureBundle()
    const b = fixtureBundle()
    b.manifest.title = 'Second writer'
    const [first, second] = await Promise.all([writeDeck(path, a), writeDeck(path, b)])
    expect(first.ok && second.ok).toBe(true)
    const read = await readDeck(path)
    expect(read.ok).toBe(true)
    if (!read.ok) return
    // Last writer wins the rename; either way the file is a *complete* deck, never a mixture.
    expect(['Fixture deck', 'Second writer']).toContain(read.bundle.manifest.title)
    expect(await hasStaleTmp(path)).toBe(false)
  })

  it('refuses to pack a bundle that is missing a slide body instead of writing an empty one', async () => {
    const bundle = fixtureBundle()
    const firstId = bundle.manifest.slideOrder[0]!
    delete bundle.slides[firstId]
    const result = await writeDeck(join(dir, 'no-body.sloodge'), bundle)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('incomplete-bundle')
    expect(result.error.message).toContain(firstId)
  })
})

describe('hasStaleTmp', () => {
  it('is false next to a cleanly saved deck', async () => {
    const path = await saveFixture('clean-tmp.sloodge')
    expect(await hasStaleTmp(path)).toBe(false)
  })

  it('spots a tmp file left behind by a crash mid-save', async () => {
    const path = join(dir, 'crashed.sloodge')
    await writeFile(path, await packDeck(fixtureBundle()))
    expect(await hasStaleTmp(path)).toBe(false)
    await writeFile(`${path}.4242.a1b2c3d4.tmp`, 'half a deck')
    expect(await hasStaleTmp(path)).toBe(true)
  })

  it('ignores an unrelated sibling that merely ends in .tmp', async () => {
    const path = join(dir, 'neighbour.sloodge')
    await writeFile(path, await packDeck(fixtureBundle()))
    // A user's own backup file must not be reported as a crashed save (it would prompt recovery).
    await writeFile(`${path}.backup.tmp`, 'not ours')
    expect(await hasStaleTmp(path)).toBe(false)
    await writeFile(`${path}.4242.a1b2c3d4.tmp`, 'ours')
    expect(await hasStaleTmp(path)).toBe(true)
  })

  it('is false for a deck in a directory that does not exist', async () => {
    expect(await hasStaleTmp(join(dir, 'nowhere', 'ghost.sloodge'))).toBe(false)
  })

  it('overwrites an existing deck in place', async () => {
    const bundle = fixtureBundle()
    const path = await saveFixture('overwrite.sloodge', bundle)
    bundle.manifest.title = 'Renamed deck'
    expect((await writeDeck(path, bundle)).ok).toBe(true)
    const read = await readDeck(path)
    expect(read.ok && read.bundle.manifest.title).toBe('Renamed deck')
  })

  it('refuses to save an invalid manifest and never touches the disk', async () => {
    const bundle = fixtureBundle()
    bundle.manifest.slideOrder = [...bundle.manifest.slideOrder, newSlideId(T0 + 9)]
    const path = join(dir, 'never-written.sloodge')
    const result = await writeDeck(path, bundle)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('manifest-invalid')
    expect(await readdir(dir)).not.toContain('never-written.sloodge')
  })

  it('refuses to pack an unsafe extra entry name', async () => {
    const bundle = fixtureBundle()
    bundle.extras['../escape.txt'] = strToU8('nope')
    const result = await writeDeck(join(dir, 'unsafe.sloodge'), bundle)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('unsafe-entry')
  })
})

describe('readDeck failure modes', () => {
  it('reports a missing file', async () => {
    const result = await readDeck(join(dir, 'nope.sloodge'))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('not-found')
  })

  it('rejects a file that is not a zip', async () => {
    const path = join(dir, 'plain.sloodge')
    await writeFile(path, 'just some text, definitely not a deck')
    const result = await readDeck(path)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('not-a-zip')
  })

  it('rejects an archive with no manifest.json', async () => {
    const path = join(dir, 'no-manifest.sloodge')
    await writeFile(path, zipSync({ 'slides/a.html': strToU8('<html></html>') }))
    const result = await readDeck(path)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('manifest-missing')
  })

  it('rejects a zip-slip entry outright (§2.2 invariant 4)', async () => {
    const path = join(dir, 'slip.sloodge')
    const good = await packDeck(fixtureBundle())
    const entries = unzipSync(good)
    entries['../../../../evil.sh'] = strToU8('rm -rf /')
    await writeFile(path, zipSync(entries))
    const result = await readDeck(path)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('unsafe-entry')
    expect(result.error.message).toContain('evil.sh')
  })

  it('reports a deck saved by a newer Sloodge instead of a schema wall', async () => {
    const bundle = fixtureBundle()
    const entries = unzipSync(await packDeck(bundle))
    const manifest = JSON.parse(new TextDecoder().decode(entries['manifest.json']!)) as Record<
      string,
      unknown
    >
    manifest['formatVersion'] = MAX_FORMAT_VERSION + 1
    manifest['brandNewRequiredThing'] = { shape: 'unknown to us' }
    entries['manifest.json'] = strToU8(JSON.stringify(manifest))
    const path = join(dir, 'from-the-future.sloodge')
    await writeFile(path, zipSync(entries))

    const result = await readDeck(path)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('format-too-new')
    expect(result.error.fileFormatVersion).toBe(MAX_FORMAT_VERSION + 1)
    expect(result.error.maxFormatVersion).toBe(MAX_FORMAT_VERSION)
  })

  it('reports schema issues with a path when the manifest is malformed', async () => {
    const entries = unzipSync(await packDeck(fixtureBundle()))
    const manifest = JSON.parse(new TextDecoder().decode(entries['manifest.json']!)) as Record<
      string,
      unknown
    >
    manifest['canvas'] = { width: 1920, height: 1080 }
    entries['manifest.json'] = strToU8(JSON.stringify(manifest))
    const path = join(dir, 'bad-canvas.sloodge')
    await writeFile(path, zipSync(entries))

    const result = await readDeck(path)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('manifest-invalid')
    expect(result.error.issues?.some((issue) => issue.path.startsWith('canvas'))).toBe(true)
  })

  it('warns and repairs when a referenced slide or notes file is missing', async () => {
    const bundle = fixtureBundle()
    const firstId = bundle.manifest.slideOrder[0]!
    const entries = unzipSync(await packDeck(bundle))
    delete entries[`slides/${firstId}.html`]
    delete entries[`notes/${firstId}.md`]
    const path = join(dir, 'missing-parts.sloodge')
    await writeFile(path, zipSync(entries))

    const result = await readDeck(path)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.bundle.slides[firstId]).toBe('')
    expect(result.bundle.notes[firstId]).toBeUndefined()
    expect(result.warnings).toHaveLength(2)
    expect(result.warnings[0]).toContain('missing slide file')
  })
})

describe('prototype-named entries and manifest values (B1 / M1)', () => {
  it('does not throw when manifest.theme is an Object.prototype key with no matching entry', async () => {
    const path = await craft('theme-constructor.sloodge', (entries) => {
      delete entries['theme/theme.json']
      const manifest = manifestOf(entries)
      manifest['theme'] = 'constructor'
      setManifest(entries, manifest)
    })
    const result = await readDeck(path)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.bundle.theme).toBeNull()
    expect(result.warnings).toContain('missing theme file constructor')
  })

  it.each(['constructor', 'toString', 'valueOf', 'hasOwnProperty'])(
    'treats an archive entry named %s as data, not as a prototype member',
    async (name) => {
      const path = await craft(`entry-${name}.sloodge`, (entries) => {
        delete entries['theme/theme.json']
        entries[name] = strToU8('{"not":"a theme"}')
        const manifest = manifestOf(entries)
        manifest['theme'] = name
        setManifest(entries, manifest)
      })
      const result = await readDeck(path)
      expect(result.ok).toBe(true)
      if (!result.ok) return
      // The entry exists but is not a valid theme: warning, null theme, bytes preserved.
      expect(result.bundle.theme).toBeNull()
      expect(result.warnings.join('\n')).toContain('failed validation')
      expect(result.bundle.extras[name]).toEqual(strToU8('{"not":"a theme"}'))
    },
  )

  it('round-trips extras named after Object.prototype members instead of dropping them', async () => {
    const bundle = fixtureBundle()
    bundle.extras['toString'] = strToU8('one')
    bundle.extras['constructor'] = strToU8('two')
    bundle.extras['valueOf'] = strToU8('three')
    bundle.extras['hasOwnProperty'] = strToU8('four')
    bundle.extras['normal.bin'] = strToU8('five')
    const path = await saveFixture('proto-extras.sloodge', bundle)

    const read = await readDeck(path)
    expect(read.ok).toBe(true)
    if (!read.ok) return
    expect(read.bundle.extras).toEqual(bundle.extras)

    // …and they survive a second cycle, so nothing is lost on re-save either.
    const second = join(dir, 'proto-extras-2.sloodge')
    expect((await writeDeck(second, read.bundle)).ok).toBe(true)
    const reread = await readDeck(second)
    expect(reread.ok && reread.bundle.extras).toEqual(bundle.extras)
  })

  it('rejects an archive entry named __proto__ outright', async () => {
    // fflate cannot *write* a `__proto__` entry (its own internal maps are plain objects), so the
    // archive is built with a same-length placeholder name and byte-patched — which is exactly
    // what a hand-rolled hostile zip looks like.
    const entries = unzipSync(await packDeck(fixtureBundle()))
    entries['AAprotoAA'] = strToU8('pollute me')
    const patched = Buffer.from(zipSync(entries))
    let index = patched.indexOf('AAprotoAA', 0, 'latin1')
    while (index !== -1) {
      patched.write('__proto__', index, 'latin1')
      index = patched.indexOf('AAprotoAA', index + 9, 'latin1')
    }
    const path = join(dir, 'proto-entry.sloodge')
    await writeFile(path, patched)

    const result = await readDeck(path)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('unsafe-entry')
    expect(result.error.message).toContain('__proto__')
  })

  it('rejects a nested __proto__ path segment', async () => {
    const path = await craft('proto-segment.sloodge', (entries) => {
      entries['assets/__proto__/x.bin'] = strToU8('pollute me')
    })
    const result = await readDeck(path)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('unsafe-entry')
  })

  it('refuses to pack an extra named __proto__', async () => {
    const bundle = fixtureBundle()
    Object.defineProperty(bundle.extras, '__proto__', {
      value: strToU8('pollute me'),
      enumerable: true,
      configurable: true,
      writable: true,
    })
    const result = await writeDeck(join(dir, 'proto-pack.sloodge'), bundle)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('unsafe-entry')
  })

  it('rejects a manifest whose slides map is keyed __proto__', async () => {
    const path = await craft('proto-slide-key.sloodge', (entries) => {
      // Hand-written JSON: an object literal would set the prototype instead of adding a key.
      const text = new TextDecoder().decode(entries['manifest.json']!)
      entries['manifest.json'] = strToU8(
        text.replace('"slides": {', '"slides": {\n    "__proto__": { "id": "s_evil" },'),
      )
    })
    const result = await readDeck(path)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('manifest-invalid')
  })

  it('rejects a manifest whose slideOrder contains __proto__', async () => {
    const path = await craft('proto-order.sloodge', (entries) => {
      const manifest = manifestOf(entries)
      manifest['slideOrder'] = ['__proto__', ...(manifest['slideOrder'] as string[])]
      setManifest(entries, manifest)
    })
    const result = await readDeck(path)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('manifest-invalid')
  })
})

describe('archive resource caps (M2)', () => {
  /** 10 MB of zeros: ~10 kB on disk, 10 MB in memory. The classic expansion-ratio shape. */
  async function bombPath(name: string): Promise<string> {
    return craft(name, (entries) => {
      entries['assets/bomb.bin'] = new Uint8Array(10 * 1024 * 1024)
    })
  }

  it('the crafted bomb really is small on disk and large inflated', async () => {
    const path = await bombPath('bomb-shape.sloodge')
    const onDisk = (await readFile(path)).length
    expect(onDisk).toBeLessThan(200 * 1024)
    const read = await readDeck(path)
    expect(read.ok).toBe(true)
    if (!read.ok) return
    expect(read.bundle.extras['assets/bomb.bin']?.length).toBe(10 * 1024 * 1024)
  })

  it('rejects an entry that inflates past the per-entry cap', async () => {
    const path = await bombPath('bomb-entry.sloodge')
    const result = await readDeck(path, { limits: { maxEntryBytes: 64 * 1024 } })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('too-large')
    expect(result.error.message).toContain('assets/bomb.bin')
  })

  it('rejects an archive that inflates past the total cap', async () => {
    const path = await bombPath('bomb-total.sloodge')
    const result = await readDeck(path, {
      limits: { maxEntryBytes: 64 * 1024 * 1024, maxTotalBytes: 1024 * 1024 },
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('too-large')
  })

  it('rejects a file bigger than the compressed-size cap before parsing anything', async () => {
    const path = await saveFixture('cap-compressed.sloodge')
    const result = await readDeck(path, { limits: { maxCompressedBytes: 64 } })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('too-large')
    expect(result.error.message).toContain('64-byte limit')
  })

  it('rejects an archive with too many entries', async () => {
    const path = await craft('cap-entries.sloodge', (entries) => {
      for (let index = 0; index < 40; index += 1) {
        entries[`assets/pad-${String(index)}.bin`] = strToU8(String(index))
      }
    })
    const result = await readDeck(path, { limits: { maxEntries: 10 } })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('too-large')
    expect(result.error.message).toContain('10 limit')
  })

  it('accepts a normal deck under the shipped defaults', async () => {
    const path = await saveFixture('cap-default.sloodge')
    expect((await readDeck(path)).ok).toBe(true)
  })
})

/**
 * The r3 blocker shape, shrunk to nothing: one 5-byte STORED member whose *central* header
 * declares `compressedSize = originalSize = 0xffffffff` and carries a 0x0001 ZIP64 extra field
 * saying "really 5 and 5". `withZip64Eocd` toggles the only thing that makes that extra field
 * meaningful — the ZIP64 end-of-central-directory record and its locator.
 *
 * Kept to ~200 bytes on purpose: the bug is that our caps trusted the extra field while fflate
 * ignored it and allocated 0xffffffff, so the regression must be provable without ever letting
 * an allocation happen. Nothing here is big; the assertion is that the read stops at the gate.
 */
function zip64ExtraFieldZip(withZip64Eocd: boolean, entriesTotal = 1n): Uint8Array {
  const name = strToU8('assets/tiny.bin')
  const payload = strToU8('hello')

  const local = new Uint8Array(30 + name.length + payload.length)
  const localView = new DataView(local.buffer)
  localView.setUint32(0, 0x0403_4b50, true)
  localView.setUint16(4, 45, true) // version needed: 4.5 = zip64
  localView.setUint16(8, 0, true) // STORED
  localView.setUint32(18, payload.length, true)
  localView.setUint32(22, payload.length, true)
  localView.setUint16(26, name.length, true)
  local.set(name, 30)
  local.set(payload, 30 + name.length)

  const extraLength = 4 + 16
  const central = new Uint8Array(46 + name.length + extraLength)
  const centralView = new DataView(central.buffer)
  centralView.setUint32(0, 0x0201_4b50, true)
  centralView.setUint16(4, 45, true)
  centralView.setUint16(6, 45, true)
  centralView.setUint16(10, 0, true) // STORED
  centralView.setUint32(20, 0xffff_ffff, true) // compressed size: "see the extra field"
  centralView.setUint32(24, 0xffff_ffff, true) // uncompressed size: likewise
  centralView.setUint16(28, name.length, true)
  centralView.setUint16(30, extraLength, true)
  centralView.setUint32(42, 0, true) // local header offset
  central.set(name, 46)
  const extraAt = 46 + name.length
  centralView.setUint16(extraAt, 0x0001, true) // zip64 extended information
  centralView.setUint16(extraAt + 2, 16, true)
  centralView.setBigUint64(extraAt + 4, BigInt(payload.length), true) // uncompressed
  centralView.setBigUint64(extraAt + 12, BigInt(payload.length), true) // compressed

  const tail: Uint8Array[] = []
  const centralOffset = local.length
  if (withZip64Eocd) {
    const record = new Uint8Array(56)
    const recordView = new DataView(record.buffer)
    recordView.setUint32(0, 0x0606_4b50, true)
    recordView.setBigUint64(4, 44n, true) // size of the record after this field
    recordView.setUint16(12, 45, true)
    recordView.setUint16(14, 45, true)
    recordView.setBigUint64(24, 1n, true) // entries on this disk
    recordView.setBigUint64(32, entriesTotal, true) // entries total
    recordView.setBigUint64(40, BigInt(central.length), true)
    recordView.setBigUint64(48, BigInt(centralOffset), true)

    const locator = new Uint8Array(20)
    const locatorView = new DataView(locator.buffer)
    locatorView.setUint32(0, 0x0706_4b50, true)
    locatorView.setBigUint64(8, BigInt(centralOffset + central.length), true)
    locatorView.setUint32(16, 1, true) // total disks
    tail.push(record, locator)
  }

  const eocd = new Uint8Array(22)
  const eocdView = new DataView(eocd.buffer)
  eocdView.setUint32(0, 0x0605_4b50, true)
  eocdView.setUint16(8, 1, true)
  eocdView.setUint16(10, 1, true)
  eocdView.setUint32(12, central.length, true)
  eocdView.setUint32(16, centralOffset, true)
  tail.push(eocd)

  const parts = [local, central, ...tail]
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0))
  let at = 0
  for (const part of parts) {
    out.set(part, at)
    at += part.length
  }
  return out
}

const BLOB = 64 * 1024
const aliasName = (index: number): Uint8Array => strToU8(`assets/alias-${String(index)}.bin`)

describe('archive resource caps — STORED members and aliased local headers (B2)', () => {
  /**
   * Hand-rolled zip: `count` central-directory entries, all pointing at *one* STORED local header
   * holding `BLOB` bytes, each lying that it inflates to `originalSize` bytes. This is the shape
   * the r2 review exploited: fflate ignores `originalSize` for a stored member and hands back a
   * copy of `compressedSize`, so `count` copies of the blob are materialized while the declared
   * inflated total stays at zero. fflate cannot write this — it is what a hostile file looks like.
   */
  function aliasedStoredZip(count: number, originalSize = 0): Uint8Array {
    const localName = aliasName(0)
    const local = new Uint8Array(30 + localName.length + BLOB)
    const localView = new DataView(local.buffer)
    localView.setUint32(0, 0x0403_4b50, true)
    localView.setUint16(4, 20, true)
    localView.setUint16(8, 0, true) // method 0 = STORED
    localView.setUint32(18, BLOB, true) // compressed size
    localView.setUint32(22, BLOB, true) // uncompressed size
    localView.setUint16(26, localName.length, true)
    local.set(localName, 30)
    // The payload is left as zeros; nothing verifies it, and the point is the declared sizes.

    const centrals: Uint8Array[] = []
    for (let index = 0; index < count; index += 1) {
      const entryName = aliasName(index)
      const central = new Uint8Array(46 + entryName.length)
      const view = new DataView(central.buffer)
      view.setUint32(0, 0x0201_4b50, true)
      view.setUint16(4, 20, true)
      view.setUint16(6, 20, true)
      view.setUint16(10, 0, true) // STORED
      view.setUint32(20, BLOB, true) // compressed size — the real allocation
      view.setUint32(24, originalSize, true) // uncompressed size — the lie
      view.setUint16(28, entryName.length, true)
      view.setUint32(42, 0, true) // every entry aliases local header 0
      central.set(entryName, 46)
      centrals.push(central)
    }

    const centralSize = centrals.reduce((sum, part) => sum + part.length, 0)
    const eocd = new Uint8Array(22)
    const eocdView = new DataView(eocd.buffer)
    eocdView.setUint32(0, 0x0605_4b50, true)
    eocdView.setUint16(8, count, true)
    eocdView.setUint16(10, count, true)
    eocdView.setUint32(12, centralSize, true)
    eocdView.setUint32(16, local.length, true)

    const out = new Uint8Array(local.length + centralSize + eocd.length)
    out.set(local, 0)
    let at = local.length
    for (const part of centrals) {
      out.set(part, at)
      at += part.length
    }
    out.set(eocd, at)
    return out
  }

  async function writeCrafted(name: string, bytes: Uint8Array): Promise<string> {
    const path = join(dir, name)
    await writeFile(path, bytes)
    return path
  }

  it('rejects many central entries aliasing one STORED local header', async () => {
    // 40 entries x 64 kB declared compressed, in a ~64 kB file: 2.5 MB of allocation from a file
    // that declares zero inflated bytes. Scaled up this was 820 MB RSS from a 20 MB file.
    const path = await writeCrafted('alias-stored.sloodge', aliasedStoredZip(40))
    const result = await readDeck(path)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('too-large')
    // Caught by the sum-of-compressed vs. file-length cross-check, under the *shipped* defaults —
    // no injected cap needed, because no honest archive declares more data than it contains.
    expect(result.error.message).toContain('compressed bytes but is only')
  })

  it('rejects the aliased shape against a small injectable total-compressed cap too', async () => {
    const path = await writeCrafted('alias-stored-cap.sloodge', aliasedStoredZip(40))
    const result = await readDeck(path, {
      limits: { maxTotalCompressedBytes: 100 * 1024, maxTotalBytes: 1024 * 1024 * 1024 },
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('too-large')
    expect(result.error.message).toContain('compressed-data limit')
  })

  it('caps a single STORED member by its compressed size, not its declared inflated size', async () => {
    // One entry, no aliasing, `originalSize: 0`: the pre-fix caps saw "0 bytes inflated" and let
    // 64 kB through. Both the per-entry compressed cap and the effective-size cap must fire.
    const path = await writeCrafted('stored-lie.sloodge', aliasedStoredZip(1))
    const result = await readDeck(path, { limits: { maxEntryBytes: 8 * 1024 } })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('too-large')
    expect(result.error.message).toContain('assets/alias-0.bin')
  })

  it('counts a STORED member against maxTotalBytes by its compressed size', async () => {
    // Pins `allocates = max(originalSize, compressedSize)` for method 0, and *only* that branch:
    // the caps are chosen so every other gate passes. One entry (no aliasing), compressedSize 64 kB,
    // originalSize 0. maxEntryBytes 1 MB clears both per-entry caps, maxTotalCompressedBytes 1 GB
    // clears the compressed total, and the file is longer than 64 kB so the file-length cross-check
    // clears too. maxTotalBytes 32 kB is the only thing left, and it can only fire if the effective
    // size is the compressed 65536 rather than the declared 0. Revert the branch to a bare
    // `entry.originalSize` and this test — and only this test — goes red with `manifest-missing`.
    const path = await writeCrafted('stored-effective-size.sloodge', aliasedStoredZip(1, 0))
    const result = await readDeck(path, {
      limits: {
        maxEntryBytes: 1024 * 1024,
        maxTotalBytes: 32 * 1024,
        maxTotalCompressedBytes: 1024 ** 3,
      },
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('too-large')
    expect(result.error.message).toContain('inflates to over')
    expect(result.error.message).toContain('32768-byte limit')
  })

  it('still accepts an honest STORED member of the same shape', async () => {
    // Proof the rejections above are about the lie and the aliasing, not about hand-rolled zips:
    // one entry declaring its true size passes every cap and fails later, on the missing manifest.
    const path = await writeCrafted('stored-honest.sloodge', aliasedStoredZip(1, BLOB))
    const result = await readDeck(path)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('manifest-missing')
  })

  it('rejects a zip64 locator whose record is out of bounds instead of falling back', async () => {
    // fflate does no bounds check here, so a fallback would leave two parsers reading two
    // different directories — ours capped, fflate's not. Divergence is treated as malformed.
    const bytes = new Uint8Array(await readFile(await saveFixture('zip64-bait.sloodge')))
    const view = new DataView(bytes.buffer)
    const eocd = bytes.length - 22
    view.setUint32(eocd - 20, 0x0706_4b50, true) // zip64 locator signature
    view.setUint32(eocd - 12, bytes.length - 8, true) // record would run past the end
    view.setUint32(eocd - 8, 0, true)
    const path = join(dir, 'zip64-oob.sloodge')
    await writeFile(path, bytes)

    const result = await readDeck(path)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('not-a-zip')
    expect(result.error.message).toContain('zip64')
  })

  it('rejects a 0x0001 extra field when the archive has no zip64 end-of-central-directory', async () => {
    // The r3 blocker, PoC shape: our scanner honoured the extra field unconditionally and measured
    // this member at 5 bytes, while fflate — which resolves it only under a validated ZIP64 EOCD —
    // took 0xffffffff and allocated 4 GB. The extra field is now unreadable without the record, so
    // 0xffffffff means "unbounded" and the per-entry cap rejects the file before `unzip` is called.
    const bytes = zip64ExtraFieldZip(false)
    expect(bytes.length).toBeLessThan(512) // the fixture itself must stay free
    const path = await writeCrafted('zip64-extra-no-record.sloodge', bytes)

    const result = await readDeck(path)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('too-large')
    expect(result.error.message).toContain('assets/tiny.bin')
  })

  it('still honours a 0x0001 extra field when a valid zip64 record backs it', async () => {
    // The companion: same central header, same extra field, plus the record that licenses it. The
    // sizes resolve to 5/5, every cap passes, and the read gets all the way to the missing manifest
    // — so the fix above is a gate on the *record*, not a blanket refusal of zip64.
    const path = await writeCrafted('zip64-extra-with-record.sloodge', zip64ExtraFieldZip(true))
    const result = await readDeck(path)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('manifest-missing')
  })

  it('rejects a zip64 record whose entry count disagrees with the 16-bit EOCD count', async () => {
    // The r4 blocker, PoC shape: the *green* fixture above with exactly one field changed — the
    // zip64 record's `entries total`, 1n -> 0n — leaving the 16-bit EOCD count at 1. fflate gates
    // its per-entry loop on the 16-bit count, then overwrites the counter with the 32-bit zip64
    // count, so it enters the loop, runs it zero times, and never reaches the countdown that fires
    // its callback: `readDeck` used to return a promise that never settled. Two parsers, two entry
    // counts. The scan now refuses the disagreement outright.
    const bytes = zip64ExtraFieldZip(true, 0n)
    expect(bytes.length).toBeLessThan(512)
    const path = await writeCrafted('zip64-count-mismatch.sloodge', bytes)

    const started = Date.now()
    const result = await readDeck(path)
    // Settled at all is the headline assertion; settled in milliseconds rather than at the 30 s
    // extraction deadline proves it is the scan that rejected it, not the backstop timer.
    expect(Date.now() - started).toBeLessThan(1_000)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('not-a-zip')
    expect(result.error.message).toContain('entries')
  })

  it('rejects a zip64 record that declares more entries than the cap, before allocating them', async () => {
    // Pins the *pre-loop* entry-count guard, which the redundant post-scan check cannot stand in
    // for: a zip64 record may declare any count at all, so 10 M entries over a 209-byte file must
    // be `too-large` from the declaration rather than `not-a-zip` from walking off the end of the
    // directory. Delete the guard and this test — and only this test — goes red with `not-a-zip`.
    const path = await writeCrafted(
      'zip64-count-huge.sloodge',
      zip64ExtraFieldZip(true, 10_000_000n),
    )
    const result = await readDeck(path)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('too-large')
    expect(result.error.message).toContain('declares 10000000 entries')
  })
})

/** N members each individually well under every per-entry cap, summing to a lot. */
function manyMembersZip(count: number, size: number): Uint8Array {
  const payload = new Uint8Array(size)
  const entries: Record<string, Uint8Array> = {}
  for (let index = 0; index < count; index += 1) {
    entries[`assets/pad-${String(index)}.bin`] = payload
  }
  return zipSync(entries, { level: 6 })
}

/** The same, with the *first* member's declared inflated size rewritten to a lie. */
function manyMembersZipWithFirstLying(count: number, size: number, declared: number): Uint8Array {
  const bytes = manyMembersZip(count, size)
  const view = new DataView(bytes.buffer)
  const eocd = bytes.length - 22
  const firstCentral = view.getUint32(eocd + 16, true)
  view.setUint32(22, declared, true) // local header 0 (which sits at offset 0)
  view.setUint32(firstCentral + 24, declared, true) // its central header
  return bytes
}

/**
 * A DEFLATE member whose central *and* local headers declare a tiny inflated size over a stream
 * that inflates to something much larger. Declared sizes are attacker-controlled, so a cap that
 * only reads them is not a cap: the bytes have to be counted as they come out.
 */
function lyingDeflateZip(realSize: number, declaredSize: number): Uint8Array {
  const bytes = new Uint8Array(zipSync({ 'assets/liar.bin': new Uint8Array(realSize) }))
  const view = new DataView(bytes.buffer)
  const eocd = bytes.length - 22
  const central = view.getUint32(eocd + 16, true)
  expect(view.getUint16(central + 10, true)).toBe(8) // must really be DEFLATE
  view.setUint32(22, declaredSize, true) // local header uncompressed size
  view.setUint32(central + 24, declaredSize, true) // central header uncompressed size
  return bytes
}

/**
 * The r4 blocker-2 shape. fflate's async `unzip` starts every member in one loop with no
 * concurrency limit, so peak memory was the *sum* over members (measured at ~21x the declared
 * inflated size: a 185 kB archive cost 3 GB of RSS and a 1.2 MB archive killed the host process).
 * No cap on a total can bound a peak, so the read path no longer uses `unzip` at all — it drives
 * fflate's streaming inflater from our own validated scan, one member at a time.
 *
 * RSS assertions are too flaky to pin that, so these tests pin the *structural* property the
 * memory bound rests on: at most one member is ever in flight, and a member is measured by the
 * bytes it actually produces rather than the bytes it claims it will.
 */
describe('bounded sequential extraction (r4 B2)', () => {
  async function writeCrafted(name: string, bytes: Uint8Array): Promise<string> {
    const path = join(dir, name)
    await writeFile(path, bytes)
    return path
  }

  it('inflates one member at a time when the members would blow memory in aggregate', async () => {
    // 150 x 512 KiB = 75 MB declared inflated, from a file of a few kB. Every per-entry cap passes
    // (512 KiB << maxEntryBytes) and the total is under maxTotalBytes, so the archive is *admitted*
    // — which is the point: the old read path admitted this shape too and then allocated all of it
    // at once, one worker per member. 512 KiB is exactly fflate's async threshold, so every one of
    // these members took a worker.
    const count = 150
    const size = 512 * 1024
    const bytes = manyMembersZip(count, size)
    expect(bytes.length).toBeLessThan(512 * 1024) // tiny on disk, 75 MB inflated
    const path = await writeCrafted('many-members.sloodge', bytes)

    let live = 0
    let peak = 0
    let largestAllowed = 0
    const seen: string[] = []
    const result = await readDeck(path, {
      observer: {
        onMemberStart: (name, allowed) => {
          live += 1
          peak = Math.max(peak, live)
          largestAllowed = Math.max(largestAllowed, allowed)
          seen.push(name)
        },
        onMemberEnd: () => {
          live -= 1
        },
      },
    })

    // It settles, having inflated everything, and fails only on the missing manifest.
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('manifest-missing')

    expect(seen).toHaveLength(count)
    expect(live).toBe(0)
    // The whole memory guarantee in one number: peak concurrency is 1, so peak allocation is one
    // member's worth (512 KiB) and not 150 members' worth, independent of `count`.
    expect(peak).toBe(1)
    expect(largestAllowed).toBe(size)
  })

  it('stops at the first bad member of 150 instead of starting them all', async () => {
    // The sharpest structural probe available, and the one that actually distinguishes sequential
    // extraction from fan-out: the same 150-member archive, with the *first* member lying about
    // its inflated size. A driver that starts every member before any of them can fail — which is
    // exactly what fflate's async `unzip` does — reports 150 starts and has 150 output buffers
    // live when it finds out. Ours reports 1. Peak allocation is a function of that number.
    const path = await writeCrafted(
      'many-members-first-liar.sloodge',
      manyMembersZipWithFirstLying(150, 512 * 1024, 1_000),
    )
    const started: string[] = []
    const result = await readDeck(path, {
      observer: { onMemberStart: (name) => started.push(name) },
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('too-large')
    expect(started).toEqual(['assets/pad-0.bin'])
  })

  it('rejects the same shape when the aggregate is over the total cap, before inflating any of it', async () => {
    const path = await writeCrafted('many-members-cap.sloodge', manyMembersZip(150, 512 * 1024))
    let started = 0
    const result = await readDeck(path, {
      limits: { maxTotalBytes: 4 * 1024 * 1024 },
      observer: { onMemberStart: () => (started += 1) },
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('too-large')
    expect(started).toBe(0)
  })

  it('aborts a member whose stream produces more bytes than it declared', async () => {
    const path = await writeCrafted(
      'declared-size-lie.sloodge',
      lyingDeflateZip(4 * 1024 * 1024, 1_000),
    )
    let ended = 0
    const result = await readDeck(path, { observer: { onMemberEnd: () => (ended += 1) } })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('too-large')
    expect(result.error.message).toContain('assets/liar.bin')
    expect(result.error.message).toContain('declared')
    // Aborted mid-stream, not after materializing 4 MB: the member never completed.
    expect(ended).toBe(1)
  })

  it('still reads an honest member of exactly the same shape', async () => {
    const path = await writeCrafted(
      'declared-size-honest.sloodge',
      lyingDeflateZip(4 * 1024 * 1024, 4 * 1024 * 1024),
    )
    const result = await readDeck(path)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('manifest-missing')
  })

  it('always settles: a blown extraction deadline is an error value, not a hung promise', async () => {
    // The backstop behind every parser edge case, including the one blocker 1 exploited. With the
    // deadline already in the past the read must come back as an error value rather than sit on a
    // promise the caller can neither cancel nor report — and with its *own* code: a big-but-honest
    // deck that trips the 30 s ceiling must not be reported to the user as "not a zip archive".
    const path = await saveFixture('deadline.sloodge')
    expect((await readDeck(path)).ok).toBe(true)
    const result = await readDeck(path, { extractionTimeoutMs: -1 })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('extraction-timeout')
  })
})

describe('§2.2 invariant 4 — directory markers and symlinks (M4)', () => {
  it('rejects a directory entry that escapes the deck root', async () => {
    const path = await craft('dir-slip.sloodge', (entries) => {
      entries['../../evil/'] = new Uint8Array(0)
    })
    const result = await readDeck(path)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('unsafe-entry')
    expect(result.error.message).toContain('evil')
  })

  it('still accepts an ordinary directory marker', async () => {
    const path = await craft('dir-ok.sloodge', (entries) => {
      entries['assets/'] = new Uint8Array(0)
    })
    const result = await readDeck(path)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(Object.keys(result.bundle.extras)).not.toContain('assets/')
  })

  it('rejects an entry whose zip metadata marks it a symlink', async () => {
    const bundle = fixtureBundle()
    const plain = unzipSync(await packDeck(bundle))
    const zippable: Record<string, Uint8Array | [Uint8Array, { os: number; attrs: number }]> = {}
    for (const [name, data] of Object.entries(plain)) zippable[name] = data
    // 0o120777 = S_IFLNK | 0777, the mode `zip --symlinks` writes for a link.
    zippable['assets/link'] = [strToU8('../../../../etc/passwd'), { os: 3, attrs: 0o120777 << 16 }]
    const path = join(dir, 'symlink.sloodge')
    await writeFile(path, zipSync(zippable))

    const result = await readDeck(path)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('unsafe-entry')
    expect(result.error.message).toContain('symlink')
  })

  it('does not mistake an ordinary unix-mode entry for a symlink', async () => {
    const plain = unzipSync(await packDeck(fixtureBundle()))
    const zippable: Record<string, Uint8Array | [Uint8Array, { os: number; attrs: number }]> = {}
    for (const [name, data] of Object.entries(plain)) zippable[name] = data
    zippable['assets/regular.bin'] = [strToU8('plain data'), { os: 3, attrs: 0o100644 << 16 }]
    const path = join(dir, 'unix-mode.sloodge')
    await writeFile(path, zipSync(zippable))
    expect((await readDeck(path)).ok).toBe(true)
  })
})

describe('theme.json validation (M5)', () => {
  it('parses and returns a valid theme', async () => {
    const path = await saveFixture('theme-valid.sloodge')
    const read = await readDeck(path)
    expect(read.ok).toBe(true)
    if (!read.ok) return
    expect(read.bundle.theme?.id).toBe(THEME_ID)
    expect(read.bundle.theme?.tokens.color.accent).toBe('#4c8dff')
    expect(read.warnings).toEqual([])
  })

  it('warns, nulls the theme, and preserves the bytes when theme.json is invalid', async () => {
    const broken = strToU8('{"formatVersion":1,"name":"Broken","mode":"dark"}')
    const path = await craft('theme-invalid.sloodge', (entries) => {
      entries['theme/theme.json'] = broken
    })
    const read = await readDeck(path)
    expect(read.ok).toBe(true)
    if (!read.ok) return
    expect(read.bundle.theme).toBeNull()
    expect(read.warnings.join('\n')).toContain('theme/theme.json failed validation')
    expect(read.bundle.extras['theme/theme.json']).toEqual(broken)

    // Round-trip: a theme this build cannot read is re-emitted byte-for-byte, not deleted.
    const second = join(dir, 'theme-invalid-2.sloodge')
    expect((await writeDeck(second, read.bundle)).ok).toBe(true)
    const reread = await readDeck(second)
    expect(reread.ok && reread.bundle.extras['theme/theme.json']).toEqual(broken)
  })

  it('warns when theme.json is not JSON at all', async () => {
    const path = await craft('theme-not-json.sloodge', (entries) => {
      entries['theme/theme.json'] = strToU8('this is not json')
    })
    const read = await readDeck(path)
    expect(read.ok).toBe(true)
    if (!read.ok) return
    expect(read.bundle.theme).toBeNull()
    expect(read.warnings.join('\n')).toContain('is not valid JSON')
  })
})

/**
 * Walk a fixture archive's central directory so a test can corrupt one member's headers without
 * hand-rolling a whole zip. fflate writes no archive comment, so the EOCD is the last 22 bytes.
 */
function centralDirectory(bytes: Uint8Array): { name: string; central: number; local: number }[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const eocd = bytes.length - 22
  expect(view.getUint32(eocd, true)).toBe(0x0605_4b50)
  const count = view.getUint16(eocd + 8, true)
  let at = view.getUint32(eocd + 16, true)
  const out: { name: string; central: number; local: number }[] = []
  for (let index = 0; index < count; index += 1) {
    const nameLength = view.getUint16(at + 28, true)
    const extraLength = view.getUint16(at + 30, true)
    const commentLength = view.getUint16(at + 32, true)
    out.push({
      name: new TextDecoder().decode(bytes.subarray(at + 46, at + 46 + nameLength)),
      central: at,
      local: view.getUint32(at + 42, true),
    })
    at += 46 + nameLength + extraLength + commentLength
  }
  return out
}

/** Pack the fixture, hand the raw bytes to `mutate`, and write the result to `name`. */
async function craftHeaders(
  name: string,
  mutate: (bytes: Uint8Array, view: DataView, dir: ReturnType<typeof centralDirectory>) => void,
): Promise<string> {
  const bytes = await packDeck(fixtureBundle())
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  mutate(bytes, view, centralDirectory(bytes))
  const path = join(dir, name)
  await writeFile(path, bytes)
  return path
}

/**
 * The local-vs-central cross-checks the extractor rests on. Extraction is driven entirely from the
 * *central* entry the caps were applied to, so the local header is never trusted for sizes — but it
 * is what the compressed bytes are read from, and a local header that describes a different member
 * than the one the caps approved is exactly the two-directories divergence this rewrite exists to
 * remove. Each of these tests goes red, alone, when its guard is deleted.
 */
describe('local-vs-central header cross-checks (r5 M2)', () => {
  it('rejects a central entry whose local header names a different member', async () => {
    const path = await craftHeaders('local-name-mismatch.sloodge', (_bytes, view, entries) => {
      const slides = entries.filter((entry) => entry.name.startsWith('slides/'))
      expect(slides).toHaveLength(2)
      // Point the first slide's central entry at the *second* slide's local header. Every size the
      // caps looked at is unchanged; only the bytes we would read are someone else's.
      view.setUint32(slides[0]!.central + 42, slides[1]!.local, true)
    })
    const result = await readDeck(path)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('not-a-zip')
    expect(result.error.message).toContain('local header naming')
  })

  it('rejects a member whose local header disagrees about the compression method', async () => {
    const path = await craftHeaders('local-method-mismatch.sloodge', (_bytes, view, entries) => {
      const slide = entries.find((entry) => entry.name.startsWith('slides/'))!
      expect(view.getUint16(slide.central + 10, true)).toBe(8) // really DEFLATE centrally
      view.setUint16(slide.local + 8, 0, true) // …but STORED locally
    })
    const result = await readDeck(path)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('not-a-zip')
    expect(result.error.message).toContain('about method')
  })

  it('rejects a DEFLATE member that delivers fewer bytes than it declared', async () => {
    // `compressedSize: 0` is the degenerate under-delivery case: the push loop never runs, so the
    // member used to come back as zero bytes with no error and no warning — the slide opened empty
    // and re-saved as an empty file. Silent data loss is the one thing a reader must never do.
    const path = await craftHeaders('under-delivery.sloodge', (_bytes, view, entries) => {
      const slide = entries.find((entry) => entry.name.startsWith('slides/'))!
      expect(view.getUint32(slide.central + 20, true)).toBeGreaterThan(0)
      view.setUint32(slide.central + 20, 0, true) // central compressed size
      view.setUint32(slide.local + 18, 0, true) // and the local one, so the two still agree
    })
    const result = await readDeck(path)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('not-a-zip')
    expect(result.error.message).toContain('produced 0 bytes but declared')
  })
})

/**
 * The write half of the r4/r5 memory story. fflate's asynchronous `zip` fans out exactly the way
 * its `unzip` does — a Worker per entry over 160 kB, no queue, no limit — which measured +1.7 GB of
 * RSS to save a 240 kB deck that `readDeck` itself admits. `packDeck` therefore uses `zipSync`, and
 * bounds what it will serialize the way the read path bounds what it will inflate.
 */
describe('bounded synchronous write path (r5 B1)', () => {
  function bulkyBundle(count: number, size: number): DeckBundle {
    const bundle = fixtureBundle()
    // 300 kB each: over fflate's 160 kB async threshold, so every one of these took a Worker.
    for (let index = 0; index < count; index += 1) {
      bundle.extras[`assets/pad-${String(index)}.bin`] = new Uint8Array(size)
    }
    return bundle
  }

  it('deflates on the calling thread — no event-loop turn, so no worker fan-out', async () => {
    // The structural probe, mirroring "inflates one member at a time" on the read side: an RSS
    // assertion is too flaky, but fflate's async `zip` cannot deliver without at least one turn of
    // the event loop (its worker `message` events are macrotasks), while `zipSync` returns before
    // an already-queued `setImmediate` can run. Swap `zipSync` back for `zip` and this goes red.
    const bundle = bulkyBundle(8, 300 * 1024)
    let eventLoopTurned = false
    setImmediate(() => {
      eventLoopTurned = true
    })
    const bytes = await packDeck(bundle)
    expect(eventLoopTurned).toBe(false)
    expect(bytes.length).toBeGreaterThan(0)
    // …and it is still a readable deck with every extra intact.
    const path = join(dir, 'sync-pack.sloodge')
    await writeFile(path, bytes)
    const read = await readDeck(path)
    expect(read.ok).toBe(true)
    if (!read.ok) return
    expect(Object.keys(read.bundle.extras)).toHaveLength(8)
  })

  it('refuses to serialize more entries than the entry cap', async () => {
    const result = await writeDeck(join(dir, 'pack-entries.sloodge'), bulkyBundle(40, 8), {
      limits: { maxEntries: 12 },
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('too-large')
    expect(result.error.message).toContain('over the 12 limit')
    expect(await hasStaleTmp(join(dir, 'pack-entries.sloodge'))).toBe(false)
  })

  it('refuses to serialize more bytes than the total cap', async () => {
    const result = await writeDeck(join(dir, 'pack-bytes.sloodge'), bulkyBundle(4, 256 * 1024), {
      limits: { maxTotalBytes: 64 * 1024 },
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('too-large')
    expect(result.error.message).toContain('65536-byte limit')
  })

  it('still saves a deck that sits under both write caps', async () => {
    const path = join(dir, 'pack-under-cap.sloodge')
    const result = await writeDeck(path, bulkyBundle(4, 8 * 1024), {
      limits: { maxEntries: 32, maxTotalBytes: 1024 * 1024 },
    })
    expect(result.ok).toBe(true)
    expect((await readDeck(path)).ok).toBe(true)
  })
})
