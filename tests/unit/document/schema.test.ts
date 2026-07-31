import { describe, expect, it } from 'vitest'
import {
  DeckManifestSchema,
  MAX_FORMAT_VERSION,
  isSafeArchivePath,
  MAX_THEME_FORMAT_VERSION,
  parseManifest,
  parseTheme,
  probeFormatVersion,
  SlideEntrySchema,
  THEME_ID_PATTERN,
} from '../../../src/shared/document/types'

const SLIDE_A = 's_01H8XQZ4P7K2M9NB3VYRTC6FDA'
const SLIDE_B = 's_01H8XR0M5S8T1WQZ9C4XKB7GEH'
const DECK_ID = 'd_01H8XQZ4P7K2M9NB3VYRTC6FDA'

/** The §2.1 example manifest from 30-slide-format.md, trimmed to two slides. */
function exampleManifest(): Record<string, unknown> {
  return {
    $schema: 'https://sloodge.app/schema/deck-1.json',
    formatVersion: 1,
    id: DECK_ID,
    title: 'Q3 Revenue Review',
    subtitle: 'Board deck — October 2026',
    authors: ['baochidangg@gmail.com'],
    createdAt: '2026-07-31T09:14:02.116Z',
    updatedAt: '2026-07-31T11:02:44.900Z',
    generator: { app: 'sloodge', version: '0.4.1' },
    canvas: { width: 1280, height: 720 },
    theme: 'theme/theme.json',
    slideOrder: [SLIDE_A, SLIDE_B],
    slides: {
      [SLIDE_A]: {
        id: SLIDE_A,
        file: `slides/${SLIDE_A}.html`,
        title: 'Q3 Revenue Review',
        kind: 'title',
        capabilities: ['static'],
        notes: `notes/${SLIDE_A}.md`,
        thumb: `thumbs/${SLIDE_A}.webp`,
        createdAt: '2026-07-31T09:14:02.116Z',
        updatedAt: '2026-07-31T09:31:10.004Z',
        origin: { type: 'agent', skill: 'slide-deck', sessionId: 'as_01H8' },
        validation: {
          status: 'pass',
          checkedAt: '2026-07-31T09:31:12.220Z',
          contentHash: `sha256:${'3f9a'.repeat(16)}`,
          issues: [],
        },
        hidden: false,
        transition: 'fade',
        advance: { mode: 'manual' },
      },
      [SLIDE_B]: {
        id: SLIDE_B,
        file: `slides/${SLIDE_B}.html`,
        title: 'Revenue by quarter',
        kind: 'chart',
        capabilities: ['interactive-js'],
        validation: {
          status: 'warn',
          issues: [
            {
              rule: 'SL-C07',
              severity: 'warn',
              message: 'axis label font-size 15px < 16px minimum',
              selector: '[data-sl-id="e_0f3"]',
            },
          ],
        },
        hidden: false,
      },
    },
    assets: {},
    presentation: { defaultTransition: 'fade', loop: false, showSlideNumbers: true },
  }
}

describe('manifest schema — happy paths', () => {
  it('accepts the spec §2.1 example manifest', () => {
    const result = parseManifest(exampleManifest())
    expect(result.ok).toBe(true)
  })

  it('accepts an empty deck (no slides, empty order)', () => {
    const manifest = exampleManifest()
    manifest['slideOrder'] = []
    manifest['slides'] = {}
    expect(parseManifest(manifest).ok).toBe(true)
  })

  it('preserves unknown top-level and per-slide keys (forward compat, §5.2)', () => {
    const manifest = exampleManifest()
    manifest['futureDeckField'] = { anything: [1, 2, 3] }
    const slides = manifest['slides'] as Record<string, Record<string, unknown>>
    slides[SLIDE_A]!['futureSlideField'] = 'keep me'
    const result = parseManifest(manifest)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.manifest['futureDeckField']).toEqual({ anything: [1, 2, 3] })
    expect(result.manifest.slides[SLIDE_A]?.['futureSlideField']).toBe('keep me')
  })
})

describe('manifest schema — cross-field invariants', () => {
  it('rejects a slideOrder that is not a permutation (orphaned slide)', () => {
    const manifest = exampleManifest()
    manifest['slideOrder'] = [SLIDE_A]
    const result = parseManifest(manifest)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.issues.some((issue) => issue.message.includes('missing from slideOrder'))).toBe(
      true,
    )
  })

  it('rejects duplicate ids in slideOrder', () => {
    const manifest = exampleManifest()
    manifest['slideOrder'] = [SLIDE_A, SLIDE_A, SLIDE_B]
    const result = parseManifest(manifest)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.issues.some((issue) => issue.message.includes('duplicate slide id'))).toBe(true)
  })

  it('rejects slideOrder entries with no matching slide', () => {
    const manifest = exampleManifest()
    manifest['slideOrder'] = [SLIDE_A, SLIDE_B, 's_01H8XR0M5S8T1WQZ9C4XKB7GEJ']
    const result = parseManifest(manifest)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.issues.some((issue) => issue.message.includes('unknown slide'))).toBe(true)
  })

  it('rejects a key/id mismatch in slides', () => {
    const manifest = exampleManifest()
    const slides = manifest['slides'] as Record<string, Record<string, unknown>>
    slides[SLIDE_A]!['id'] = SLIDE_B
    const result = parseManifest(manifest)
    expect(result.ok).toBe(false)
  })
})

describe('manifest schema — path shape and zip-slip', () => {
  it('rejects a zip-slip thumb path', () => {
    const manifest = exampleManifest()
    const slides = manifest['slides'] as Record<string, Record<string, unknown>>
    slides[SLIDE_A]!['thumb'] = '../../../../home/baoro/.ssh/authorized_keys'
    const result = parseManifest(manifest)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.issues.some((issue) => issue.path.includes('thumb'))).toBe(true)
  })

  it('rejects an absolute theme path', () => {
    const manifest = exampleManifest()
    manifest['theme'] = '/etc/passwd'
    expect(parseManifest(manifest).ok).toBe(false)
  })

  it('rejects a slide file that does not match its slide id', () => {
    const manifest = exampleManifest()
    const slides = manifest['slides'] as Record<string, Record<string, unknown>>
    slides[SLIDE_A]!['file'] = `slides/${SLIDE_B}.html`
    expect(parseManifest(manifest).ok).toBe(false)
  })

  it('classifies archive paths', () => {
    expect(isSafeArchivePath('slides/s_01.html')).toBe(true)
    expect(isSafeArchivePath('')).toBe(false)
    expect(isSafeArchivePath('/abs/path')).toBe(false)
    expect(isSafeArchivePath('../escape')).toBe(false)
    expect(isSafeArchivePath('a/../../escape')).toBe(false)
    expect(isSafeArchivePath('C:/windows/system32')).toBe(false)
    expect(isSafeArchivePath('slides\\win.html')).toBe(false)
    expect(isSafeArchivePath('slides//double.html')).toBe(false)
    expect(isSafeArchivePath('thumbs/')).toBe(false)
  })
})

describe('manifest schema — field-level rejections', () => {
  it('rejects a non-1280x720 canvas in v1', () => {
    const manifest = exampleManifest()
    manifest['canvas'] = { width: 1920, height: 1080 }
    expect(parseManifest(manifest).ok).toBe(false)
  })

  it('rejects a malformed deck id and an empty title', () => {
    const bad = exampleManifest()
    bad['id'] = 'deck-1'
    expect(parseManifest(bad).ok).toBe(false)

    const empty = exampleManifest()
    empty['title'] = ''
    expect(parseManifest(empty).ok).toBe(false)
  })

  it('rejects duplicate capabilities and a bad lint rule id', () => {
    const dupes = SlideEntrySchema.safeParse({
      id: SLIDE_A,
      file: `slides/${SLIDE_A}.html`,
      title: 'x',
      capabilities: ['static', 'static'],
    })
    expect(dupes.success).toBe(false)

    const badRule = SlideEntrySchema.safeParse({
      id: SLIDE_A,
      file: `slides/${SLIDE_A}.html`,
      title: 'x',
      validation: { status: 'fail', issues: [{ rule: 'nope', severity: 'error', message: 'x' }] },
    })
    expect(badRule.success).toBe(false)
  })

  it('rejects a newer formatVersion but still probes it (§5.2 reader < writer)', () => {
    const manifest = exampleManifest()
    manifest['formatVersion'] = MAX_FORMAT_VERSION + 1
    expect(DeckManifestSchema.safeParse(manifest).success).toBe(false)
    expect(probeFormatVersion(manifest)).toBe(MAX_FORMAT_VERSION + 1)
    expect(probeFormatVersion({ formatVersion: 'one' })).toBeNull()
  })
})

describe('isSafeArchivePath prototype-key hardening', () => {
  it('accepts ordinary Object.prototype member names as file names', () => {
    for (const name of [
      'constructor',
      'toString',
      'valueOf',
      'hasOwnProperty',
      'assets/toString',
    ]) {
      expect(isSafeArchivePath(name)).toBe(true)
    }
  })

  it('rejects __proto__ in any position', () => {
    for (const name of ['__proto__', 'assets/__proto__', 'assets/__proto__/x.bin']) {
      expect(isSafeArchivePath(name)).toBe(false)
    }
  })
})

describe('theme.json schema (§4.2)', () => {
  const THEME_ID = 't_01H8XQZ4P7K2M9NB3VYRTC6FDA'

  function exampleTheme(): Record<string, unknown> {
    return {
      formatVersion: 1,
      id: THEME_ID,
      name: 'Midnight',
      mode: 'dark',
      derivedFrom: '#4c8dff',
      tokens: {
        color: { bg: '#0d1220', fg: '#f0f0f5', accent: '#4c8dff', muted: '#9aa4b8' },
        series: ['#4c8dff', '#f0a04b', '#7fd1ae'],
        font: { sans: 'Inter, sans-serif', mono: 'ui-monospace, monospace' },
        size: { titleHero: 72, title: 48, heading: 28, body: 24, caption: 16 },
        space: { pad: 48, gap: 16, radius: 14 },
      },
      version: 3,
    }
  }

  it('accepts the §4.2 example', () => {
    const parsed = parseTheme(exampleTheme())
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.theme.tokens.color.bg).toBe('#0d1220')
    expect(parsed.theme.version).toBe(3)
  })

  it('requires formatVersion, id, name, mode and tokens', () => {
    for (const key of ['formatVersion', 'id', 'name', 'mode', 'tokens']) {
      const theme = exampleTheme()
      delete theme[key]
      const parsed = parseTheme(theme)
      expect(parsed.ok).toBe(false)
      if (parsed.ok) continue
      expect(parsed.issues.some((issue) => issue.path === key)).toBe(true)
    }
  })

  it('requires a t_-prefixed ULID id (THEME_ID_PATTERN)', () => {
    expect(THEME_ID_PATTERN.test(THEME_ID)).toBe(true)
    const theme = exampleTheme()
    theme['id'] = 'd_01H8XQZ4P7K2M9NB3VYRTC6FDA'
    expect(parseTheme(theme).ok).toBe(false)
  })

  it('requires the four core colors and rejects a non-hex value anywhere in tokens.color', () => {
    const missing = exampleTheme()
    ;(missing['tokens'] as Record<string, unknown>)['color'] = { bg: '#000', fg: '#fff' }
    expect(parseTheme(missing).ok).toBe(false)

    const badHex = exampleTheme()
    const colors = (badHex['tokens'] as Record<string, Record<string, unknown>>)['color']!
    colors['accent'] = 'rebeccapurple'
    expect(parseTheme(badHex).ok).toBe(false)

    // additionalProperties is a hex pattern, not `true`: an unknown *color* is fine…
    const extraColor = exampleTheme()
    ;(extraColor['tokens'] as Record<string, Record<string, unknown>>)['color']!['info'] = '#00aaff'
    expect(parseTheme(extraColor).ok).toBe(true)
    // …but an unknown non-color is not.
    const extraJunk = exampleTheme()
    ;(extraJunk['tokens'] as Record<string, Record<string, unknown>>)['color']!['info'] = 12
    expect(parseTheme(extraJunk).ok).toBe(false)
  })

  it('accepts #rgb, #rrggbb and #rrggbbaa', () => {
    for (const hex of ['#fff', '#0d1220', '#0d1220ff']) {
      const theme = exampleTheme()
      ;(theme['tokens'] as Record<string, Record<string, unknown>>)['color']!['bg'] = hex
      expect(parseTheme(theme).ok).toBe(true)
    }
  })

  it('bounds sizes to the SL-C* type scale of §3.2', () => {
    for (const [key, bad] of [
      ['titleHero', 96],
      ['title', 60],
      ['heading', 40],
      ['body', 32],
      ['caption', 12],
    ] as const) {
      const theme = exampleTheme()
      ;(theme['tokens'] as Record<string, Record<string, unknown>>)['size']![key] = bad
      expect(parseTheme(theme).ok).toBe(false)
    }
  })

  it('bounds spacing and requires a 3–8 entry chart series', () => {
    const tight = exampleTheme()
    ;(tight['tokens'] as Record<string, Record<string, unknown>>)['space']!['pad'] = 24
    expect(parseTheme(tight).ok).toBe(false)

    const short = exampleTheme()
    ;(short['tokens'] as Record<string, unknown>)['series'] = ['#111', '#222']
    expect(parseTheme(short).ok).toBe(false)

    const long = exampleTheme()
    ;(long['tokens'] as Record<string, unknown>)['series'] = Array.from({ length: 9 }, () => '#111')
    expect(parseTheme(long).ok).toBe(false)
  })

  it('preserves unknown theme keys for a round-trip, like the manifest does', () => {
    const theme = exampleTheme()
    theme['futureThemeKey'] = { shadow: 'soft' }
    const parsed = parseTheme(theme)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.theme['futureThemeKey']).toEqual({ shadow: 'soft' })
  })

  it('rejects a theme from a newer format version', () => {
    const theme = exampleTheme()
    theme['formatVersion'] = MAX_THEME_FORMAT_VERSION + 1
    expect(parseTheme(theme).ok).toBe(false)
  })
})
