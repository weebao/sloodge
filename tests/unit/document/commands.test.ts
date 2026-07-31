import { describe, expect, it } from 'vitest'
import {
  applyBatch,
  applyCommand,
  commandBytes,
  invertCommand,
  type CommandError,
  type CommandResult,
  type DeckDoc,
  type DocCommand,
} from '../../../src/shared/document/commands'
import { createSlideEntry, getSlide, newSlideId } from '../../../src/shared/document/deck'
import {
  parseManifest,
  slideFilePath,
  type SlideId,
  type Theme,
} from '../../../src/shared/document/types'
import { makeDoc, makeTheme, T0 } from './deck-doc-fixture'

function expectOk<D>(result: CommandResult<D>): D {
  if (!result.ok) {
    throw new Error(`expected ok, got ${result.error.code}: ${result.error.message}`)
  }
  return result.doc
}

/** Widened over both result shapes: `applyCommand` returns a doc, `invertCommand` a command. */
function expectErr(result: { ok: true } | { ok: false; error: CommandError }): CommandError {
  if (result.ok) throw new Error('expected an error, got ok')
  return result.error
}

function invert(doc: DeckDoc, command: DocCommand): DocCommand {
  const result = invertCommand(doc, command)
  if (!result.ok) throw new Error(`expected an inverse, got ${result.error.code}`)
  return result.command
}

/**
 * The core property of the whole layer: `apply(invert(cmd, d), apply(cmd, d))` deep-equals `d`,
 * and neither call touched `d`. Returns the post-state so a caller can assert on it too.
 */
function roundTrip(doc: DeckDoc, command: DocCommand): DeckDoc {
  const before = structuredClone(doc)
  const inverse = invert(doc, command)
  const after = expectOk(applyCommand(doc, command))
  const restored = expectOk(applyCommand(after, inverse))
  expect(restored).toEqual(before)
  expect(doc).toEqual(before)
  expect(parseManifest(after.manifest).ok).toBe(true)
  return after
}

describe('slide.insert', () => {
  it('inserts the entry and its body at the requested index', () => {
    const { doc, ids } = makeDoc(3)
    const entry = createSlideEntry({ now: T0 + 99, title: 'Inserted', withNotes: true })
    const after = roundTrip(doc, {
      t: 'slide.insert',
      at: 1,
      slide: entry,
      html: '<main class="slide">new</main>',
      notes: 'new notes',
    })
    expect(after.manifest.slideOrder).toEqual([ids[0], entry.id, ids[1], ids[2]])
    expect(after.slides[entry.id]).toBe('<main class="slide">new</main>')
    expect(after.notes[entry.id]).toBe('new notes')
  })

  it('appends at the end and rejects an index past it', () => {
    const { doc, ids } = makeDoc(2)
    const entry = createSlideEntry({ now: T0 + 99 })
    const after = expectOk(applyCommand(doc, { t: 'slide.insert', at: 2, slide: entry, html: 'x' }))
    expect(after.manifest.slideOrder).toEqual([...ids, entry.id])

    const beyond = createSlideEntry({ now: T0 + 100 })
    const error = expectErr(
      applyCommand(doc, { t: 'slide.insert', at: 3, slide: beyond, html: 'x' }),
    )
    expect(error.code).toBe('index-out-of-range')
  })

  it('rejects a duplicate id — in the manifest or in the bodies alone', () => {
    const { doc, ids } = makeDoc(2)
    const existing = getSlide(doc.manifest, ids[0]!)!
    expect(
      expectErr(
        applyCommand(doc, { t: 'slide.insert', at: 0, slide: existing, html: 'x', notes: 'y' }),
      ).code,
    ).toBe('duplicate-slide-id')

    // A body with no manifest entry is invisible to readers but would be clobbered silently.
    const orphan = createSlideEntry({ now: T0 + 5 })
    const withOrphanBody: DeckDoc = {
      ...doc,
      slides: { ...doc.slides, [orphan.id]: 'orphaned body' },
    }
    expect(
      expectErr(
        applyCommand(withOrphanBody, { t: 'slide.insert', at: 0, slide: orphan, html: 'x' }),
      ).code,
    ).toBe('duplicate-slide-id')
  })

  it('rejects an entry the slide schema does not accept', () => {
    const { doc } = makeDoc(1)
    const entry = createSlideEntry({ now: T0 + 9 })
    const badId = expectErr(
      applyCommand(doc, {
        t: 'slide.insert',
        at: 0,
        slide: { ...entry, id: 'not-a-slide-id' as SlideId, file: 'slides/not-a-slide-id.html' },
        html: 'x',
      }),
    )
    expect(badId.code).toBe('invalid-slide-entry')
    expect(badId.issues?.length).toBeGreaterThan(0)

    const strayFile = expectErr(
      applyCommand(doc, {
        t: 'slide.insert',
        at: 0,
        slide: { ...entry, file: slideFilePath(newSlideId(T0)) },
        html: 'x',
      }),
    )
    expect(strayFile.code).toBe('invalid-slide-entry')
  })

  it('rejects a notes path and notes text that disagree, in either direction', () => {
    const { doc } = makeDoc(1)
    const withNotesPath = createSlideEntry({ now: T0 + 9, withNotes: true })
    expect(
      expectErr(applyCommand(doc, { t: 'slide.insert', at: 0, slide: withNotesPath, html: 'x' }))
        .code,
    ).toBe('notes-mismatch')

    const withoutNotesPath = createSlideEntry({ now: T0 + 10 })
    expect(
      expectErr(
        applyCommand(doc, {
          t: 'slide.insert',
          at: 0,
          slide: withoutNotesPath,
          html: 'x',
          notes: 'orphan notes',
        }),
      ).code,
    ).toBe('notes-mismatch')
  })
})

describe('slide.remove', () => {
  it('round-trips from every position, restoring body, notes and index', () => {
    const { doc, ids } = makeDoc(3)
    for (const [index, id] of ids.entries()) {
      const after = roundTrip(doc, { t: 'slide.remove', id })
      expect(after.manifest.slideOrder).toEqual(ids.filter((candidate) => candidate !== id))
      expect(Object.hasOwn(after.slides, id)).toBe(false)
      expect(Object.hasOwn(after.notes, id)).toBe(false)
      expect(index).toBeLessThan(3)
    }
  })

  it('carries the removed index in its inverse, not merely the slide', () => {
    const { doc, ids } = makeDoc(3)
    const inverse = invert(doc, { t: 'slide.remove', id: ids[2]! })
    expect(inverse).toMatchObject({ t: 'slide.insert', at: 2 })
  })

  it('refuses to remove a slide whose body the document does not hold', () => {
    // Revert-proof guard for `missing-slide-html`: without it the inverse would be an insert with
    // no HTML, so undoing a delete would silently resurrect the slide as an empty document.
    const { doc, ids } = makeDoc(2)
    const bodyless: DeckDoc = { ...doc, slides: { ...doc.slides } }
    delete bodyless.slides[ids[0]!]
    expect(expectErr(invertCommand(bodyless, { t: 'slide.remove', id: ids[0]! })).code).toBe(
      'missing-slide-html',
    )
  })

  it('reports an unknown id rather than no-oping', () => {
    const { doc } = makeDoc(1)
    expect(expectErr(applyCommand(doc, { t: 'slide.remove', id: newSlideId(T0) })).code).toBe(
      'slide-not-found',
    )
  })
})

describe('slide.move', () => {
  it('round-trips a move in both directions', () => {
    const { doc, ids } = makeDoc(4)
    const forward = roundTrip(doc, { t: 'slide.move', id: ids[0]!, to: 3 })
    expect(forward.manifest.slideOrder).toEqual([ids[1], ids[2], ids[3], ids[0]])
    const backward = roundTrip(doc, { t: 'slide.move', id: ids[3]!, to: 0 })
    expect(backward.manifest.slideOrder).toEqual([ids[3], ids[0], ids[1], ids[2]])
  })

  it('rejects an index outside the deck and an unknown id', () => {
    const { doc, ids } = makeDoc(2)
    expect(expectErr(applyCommand(doc, { t: 'slide.move', id: ids[0]!, to: 2 })).code).toBe(
      'index-out-of-range',
    )
    expect(expectErr(applyCommand(doc, { t: 'slide.move', id: ids[0]!, to: -1 })).code).toBe(
      'index-out-of-range',
    )
    expect(expectErr(applyCommand(doc, { t: 'slide.move', id: newSlideId(T0), to: 0 })).code).toBe(
      'slide-not-found',
    )
  })
})

describe('slide.setHtml', () => {
  it('replaces one body and round-trips', () => {
    const { doc, ids } = makeDoc(3)
    const after = roundTrip(doc, {
      t: 'slide.setHtml',
      id: ids[1]!,
      html: '<main>rewritten</main>',
    })
    expect(after.slides[ids[1]!]).toBe('<main>rewritten</main>')
    expect(after.slides[ids[0]!]).toBe(doc.slides[ids[0]!])
    // Untouched slices are shared, not copied — this is what keeps a 200-entry history affordable.
    expect(after.manifest).toBe(doc.manifest)
  })

  it('rejects an unknown slide and a body the document does not hold', () => {
    const { doc, ids } = makeDoc(1)
    expect(
      expectErr(applyCommand(doc, { t: 'slide.setHtml', id: newSlideId(T0), html: 'x' })).code,
    ).toBe('slide-not-found')

    const bodyless: DeckDoc = { ...doc, slides: {} }
    expect(
      expectErr(invertCommand(bodyless, { t: 'slide.setHtml', id: ids[0]!, html: 'x' })).code,
    ).toBe('missing-slide-html')
  })
})

describe('slide.setNotes', () => {
  it('adds a notes file to a slide that had none, and round-trips', () => {
    const { doc, ids } = makeDoc(2, { notes: false })
    const id = ids[0]!
    const after = roundTrip(doc, { t: 'slide.setNotes', id, notes: 'first note' })
    expect(after.notes[id]).toBe('first note')
    expect(getSlide(after.manifest, id)?.notes).toBe(`notes/${id}.md`)
  })

  it('removes both the text and the manifest reference, and round-trips', () => {
    const { doc, ids } = makeDoc(2)
    const id = ids[0]!
    const after = roundTrip(doc, { t: 'slide.setNotes', id, notes: null })
    expect(Object.hasOwn(after.notes, id)).toBe(false)
    expect(getSlide(after.manifest, id)?.notes).toBeUndefined()
    expect('notes' in getSlide(after.manifest, id)!).toBe(false)
  })

  it('rejects an unknown slide', () => {
    const { doc } = makeDoc(1)
    expect(
      expectErr(applyCommand(doc, { t: 'slide.setNotes', id: newSlideId(T0), notes: 'x' })).code,
    ).toBe('slide-not-found')
  })
})

describe('deck.setTheme', () => {
  it('points the manifest at the default theme path when a deck first gets a theme', () => {
    const { doc } = makeDoc(1)
    expect(doc.manifest.theme).toBeUndefined()
    const after = roundTrip(doc, { t: 'deck.setTheme', theme: makeTheme() })
    expect(after.manifest.theme).toBe('theme/theme.json')
    expect(after.theme?.name).toBe('Fixture theme')
  })

  it('clears the manifest path when the theme is removed', () => {
    // A dangling `manifest.theme` is a "missing theme file" warning on every subsequent open.
    const { doc } = makeDoc(1, { theme: makeTheme() })
    const after = roundTrip(doc, { t: 'deck.setTheme', theme: null })
    expect(after.theme).toBeNull()
    expect('theme' in after.manifest).toBe(false)
  })

  it('honours an explicit path and round-trips it', () => {
    const { doc } = makeDoc(1)
    const after = roundTrip(doc, {
      t: 'deck.setTheme',
      theme: makeTheme(),
      path: 'theme/custom.json',
    })
    expect(after.manifest.theme).toBe('theme/custom.json')
  })

  it('rejects a theme the schema does not accept', () => {
    const { doc } = makeDoc(1)
    const broken = makeTheme({ mode: 'sideways' as 'light' })
    const error = expectErr(applyCommand(doc, { t: 'deck.setTheme', theme: broken }))
    expect(error.code).toBe('invalid-theme')
    expect(error.issues?.length).toBeGreaterThan(0)
  })
})

describe('deck.setThemeTokens', () => {
  it('merges tokens per group and round-trips added, changed and removed tokens', () => {
    const { doc } = makeDoc(1, { theme: makeTheme() })
    const after = roundTrip(doc, {
      t: 'deck.setThemeTokens',
      patch: {
        color: { accent: '#ff0055', surface: '#101828' },
        size: { body: 24 },
        font: { sans: null },
        series: ['#111111', '#222222', '#333333'],
      },
    })
    expect(after.theme?.tokens.color['accent']).toBe('#ff0055')
    expect(after.theme?.tokens.color['surface']).toBe('#101828')
    expect(after.theme?.tokens.size['body']).toBe(24)
    expect('sans' in after.theme!.tokens.font).toBe(false)
    expect(after.theme?.tokens.series).toEqual(['#111111', '#222222', '#333333'])
  })

  it('restores an absent token as absent, not as undefined', () => {
    // Revert-proof guard for the `null` arm of the inverse: a token that did not exist before must
    // come back *missing*, or every undo would leave a growing residue of dead keys in theme.json.
    const { doc } = makeDoc(1, { theme: makeTheme() })
    const command: DocCommand = {
      t: 'deck.setThemeTokens',
      patch: { color: { surface: '#101828' } },
    }
    const inverse = invert(doc, command)
    expect(inverse).toEqual({ t: 'deck.setThemeTokens', patch: { color: { surface: null } } })
    const restored = expectOk(applyCommand(expectOk(applyCommand(doc, command)), inverse))
    expect('surface' in restored.theme!.tokens.color).toBe(false)
  })

  it('removes the series palette with null and restores it', () => {
    const themed = makeTheme()
    themed.tokens.series = ['#111111', '#222222', '#333333']
    const { doc } = makeDoc(1, { theme: themed })
    const after = roundTrip(doc, { t: 'deck.setThemeTokens', patch: { series: null } })
    expect('series' in after.theme!.tokens).toBe(false)
  })

  it('refuses a patch that would make the theme invalid', () => {
    const { doc } = makeDoc(1, { theme: makeTheme() })
    expect(
      expectErr(applyCommand(doc, { t: 'deck.setThemeTokens', patch: { color: { bg: null } } }))
        .code,
    ).toBe('invalid-theme')
    expect(
      expectErr(applyCommand(doc, { t: 'deck.setThemeTokens', patch: { color: { bg: 'red' } } }))
        .code,
    ).toBe('invalid-theme')
    // §3.2's type scale is a theme-level invariant too: a 12 px body would make every slide fail lint.
    expect(
      expectErr(applyCommand(doc, { t: 'deck.setThemeTokens', patch: { size: { body: 12 } } }))
        .code,
    ).toBe('invalid-theme')
  })

  it('reports a themeless deck rather than inventing a theme', () => {
    const { doc } = makeDoc(1)
    expect(
      expectErr(
        applyCommand(doc, { t: 'deck.setThemeTokens', patch: { color: { bg: '#000000' } } }),
      ).code,
    ).toBe('no-theme')
    expect(
      expectErr(invertCommand(doc, { t: 'deck.setThemeTokens', patch: { color: { bg: '#000' } } }))
        .code,
    ).toBe('no-theme')
  })
})

describe('deck.setMeta', () => {
  it('renames a deck and round-trips the old title', () => {
    const { doc } = makeDoc(2)
    const after = roundTrip(doc, { t: 'deck.setMeta', meta: { title: 'Q3 review' } })
    expect(after.manifest.title).toBe('Q3 review')
  })

  it('adds and removes optional metadata, restoring absence exactly', () => {
    const { doc } = makeDoc(1)
    const added = roundTrip(doc, {
      t: 'deck.setMeta',
      meta: { subtitle: 'draft', authors: ['a@example.com'] },
    })
    expect(added.manifest.subtitle).toBe('draft')
    expect(added.manifest.authors).toEqual(['a@example.com'])

    const removed = roundTrip(added, { t: 'deck.setMeta', meta: { subtitle: null } })
    expect('subtitle' in removed.manifest).toBe(false)
  })

  it('refuses metadata the manifest schema rejects', () => {
    const { doc } = makeDoc(1)
    const error = expectErr(applyCommand(doc, { t: 'deck.setMeta', meta: { title: '' } }))
    expect(error.code).toBe('invalid-meta')
    expect(error.issues?.length).toBeGreaterThan(0)
    expect(
      expectErr(applyCommand(doc, { t: 'deck.setMeta', meta: { subtitle: 'x'.repeat(301) } })).code,
    ).toBe('invalid-meta')
  })
})

describe('applyBatch', () => {
  it('applies in order and inverts in reverse', () => {
    const { doc, ids } = makeDoc(3)
    const before = structuredClone(doc)
    const entry = createSlideEntry({ now: T0 + 50, title: 'Added' })
    const commands: DocCommand[] = [
      { t: 'slide.remove', id: ids[0]! },
      { t: 'slide.insert', at: 0, slide: entry, html: '<main>added</main>' },
      { t: 'slide.move', id: ids[2]!, to: 0 },
      { t: 'deck.setMeta', meta: { title: 'Batched' } },
    ]
    const applied = applyBatch(doc, commands)
    if (!applied.ok) throw new Error(applied.error.message)
    expect(applied.doc.manifest.title).toBe('Batched')
    expect(applied.doc.manifest.slideOrder).toEqual([ids[2], entry.id, ids[1]])

    const restored = applyBatch(applied.doc, applied.inverse)
    if (!restored.ok) throw new Error(restored.error.message)
    expect(restored.doc).toEqual(before)
  })

  it('is all-or-nothing: a failing command leaves the document identical by reference', () => {
    // Revert-proof guard for batch atomicity. If `applyBatch` ever committed the prefix of a
    // batch, this returns a *new* document that dropped a slide, and the identity check reds.
    const { doc, ids } = makeDoc(3)
    const result = applyBatch(doc, [
      { t: 'slide.remove', id: ids[0]! },
      { t: 'slide.move', id: newSlideId(T0), to: 0 },
      { t: 'deck.setMeta', meta: { title: 'never applied' } },
    ])
    if (result.ok) throw new Error('expected the batch to fail')
    expect(result.error.code).toBe('slide-not-found')
    expect(result.error.index).toBe(1)
    expect(doc.manifest.slideOrder).toEqual(ids)
    expect(Object.hasOwn(doc.slides, ids[0]!)).toBe(true)
  })

  it('treats an empty batch as a no-op that still returns a document', () => {
    const { doc } = makeDoc(1)
    const result = applyBatch(doc, [])
    if (!result.ok) throw new Error('an empty batch cannot fail')
    expect(result.doc).toBe(doc)
    expect(result.inverse).toEqual([])
  })
})

describe('immutability and prototype discipline', () => {
  it('never mutates the document it is given', () => {
    const { doc, ids } = makeDoc(3, { theme: makeTheme() })
    const before = structuredClone(doc)
    const entry = createSlideEntry({ now: T0 + 77 })
    const commands: DocCommand[] = [
      { t: 'slide.setHtml', id: ids[0]!, html: 'changed' },
      { t: 'slide.remove', id: ids[1]! },
      { t: 'slide.insert', at: 0, slide: entry, html: 'inserted' },
      { t: 'slide.move', id: ids[2]!, to: 0 },
      { t: 'slide.setNotes', id: ids[0]!, notes: null },
      { t: 'deck.setMeta', meta: { title: 'other' } },
      { t: 'deck.setThemeTokens', patch: { color: { accent: '#010101' } } },
      { t: 'deck.setTheme', theme: null },
    ]
    for (const command of commands) applyCommand(doc, command)
    expect(doc).toEqual(before)
  })

  it('resolves prototype members as missing slides rather than as data', () => {
    // Slide ids reach this layer from the renderer and from model tool calls.
    const { doc } = makeDoc(1)
    for (const id of ['constructor', 'toString', '__proto__'] as SlideId[]) {
      expect(expectErr(applyCommand(doc, { t: 'slide.setHtml', id, html: 'x' })).code).toBe(
        'slide-not-found',
      )
      expect(expectErr(applyCommand(doc, { t: 'slide.remove', id })).code).toBe('slide-not-found')
      expect(expectErr(applyCommand(doc, { t: 'slide.move', id, to: 0 })).code).toBe(
        'slide-not-found',
      )
      expect(expectErr(applyCommand(doc, { t: 'slide.setNotes', id, notes: 'x' })).code).toBe(
        'slide-not-found',
      )
    }
  })

  it('produces null-prototype body maps', () => {
    const { doc, ids } = makeDoc(2)
    const after = expectOk(applyCommand(doc, { t: 'slide.setHtml', id: ids[0]!, html: 'x' }))
    expect(Object.getPrototypeOf(after.slides)).toBeNull()
    const removed = expectOk(applyCommand(doc, { t: 'slide.remove', id: ids[0]! }))
    expect(Object.getPrototypeOf(removed.slides)).toBeNull()
    expect(Object.getPrototypeOf(removed.notes)).toBeNull()
    expect(Object.getPrototypeOf(removed.manifest.slides)).toBeNull()
  })

  it('copies what a command stores into the document, so a caller cannot edit it afterwards', () => {
    // Revert-proof guard for the copy boundary. Without it the caller's `SlideEntry` *is* the
    // entry in the manifest, and editing it later rewrites the live deck with no revision, no
    // history entry and no patch — the back door the whole funnel exists to close.
    const { doc } = makeDoc(1)
    const entry = createSlideEntry({ now: T0 + 60, title: 'Original' })
    const after = expectOk(applyCommand(doc, { t: 'slide.insert', at: 0, slide: entry, html: 'h' }))
    expect(getSlide(after.manifest, entry.id)).not.toBe(entry)

    entry.title = 'HIJACKED'
    expect(getSlide(after.manifest, entry.id)?.title).toBe('Original')
  })

  it('copies a theme in, so retinting the caller’s object does not retint the deck', () => {
    const { doc } = makeDoc(1)
    const theme = makeTheme()
    const after = expectOk(applyCommand(doc, { t: 'deck.setTheme', theme }))
    expect(after.theme).not.toBe(theme)

    theme.tokens.color['bg'] = '#ff00ff'
    theme.name = 'HIJACKED'
    expect(after.theme?.tokens.color['bg']).toBe('#0d1220')
    expect(after.theme?.name).toBe('Fixture theme')
  })

  it('returns an error, not a DOMException, for a payload it cannot copy', () => {
    // `structuredClone` throws on a function; this layer promises error values, and the clone runs
    // before validation (validating the caller's object and copying it afterwards would leave a
    // window for a getter to return something else the second time).
    const { doc } = makeDoc(1)
    const entry = createSlideEntry({ now: T0 + 61 })
    const command = {
      t: 'slide.insert',
      at: 0,
      slide: { ...entry, onClick: () => undefined },
      html: 'h',
    } as unknown as DocCommand
    expect(expectErr(applyCommand(doc, command)).code).toBe('invalid-slide-entry')

    const theme = { ...makeTheme(), render: () => undefined } as unknown as Theme
    expect(expectErr(applyCommand(doc, { t: 'deck.setTheme', theme })).code).toBe('invalid-theme')
  })

  it('rejects a `__proto__` token name loudly instead of quietly doing nothing', () => {
    // Revert-proof guard for the null-prototype token maps: on an ordinary object the assignment
    // hits the prototype setter and vanishes, so the command would report success having changed
    // nothing. Null-prototype makes it a real key, which `parseTheme` then refuses.
    const { doc } = makeDoc(1, { theme: makeTheme() })
    // A computed key, because `{ __proto__: x }` in a literal is the prototype setter and never
    // becomes an own property at all — the patch would arrive empty.
    const color: Record<string, string> = { ['__proto__']: '#ffffff' }
    expect(Object.hasOwn(color, '__proto__')).toBe(true)

    const error = expectErr(applyCommand(doc, { t: 'deck.setThemeTokens', patch: { color } }))
    expect(error.code).toBe('invalid-theme')
    // And nothing leaked onto the real prototype chain on the way.
    expect(({} as Record<string, unknown>)['__proto__']).toBe(Object.prototype)
  })

  it('carries fields it does not know about straight through', () => {
    // `DocumentSession` applies commands to a whole `DeckBundle`; `extras` is the forward-compat
    // payload of §5.2 and losing it on the first edit would silently drop unknown archive entries.
    const { doc, ids } = makeDoc(2)
    const extras = { 'assets/logo.png': new Uint8Array([1, 2, 3]) }
    const bundle = { ...doc, extras }
    const after = expectOk(applyCommand(bundle, { t: 'slide.setHtml', id: ids[0]!, html: 'x' }))
    expect(after.extras).toBe(extras)
  })
})

describe('commandBytes', () => {
  it('counts the unbounded payloads and only those', () => {
    const html = 'x'.repeat(10_000)
    expect(commandBytes({ t: 'slide.setHtml', id: 's', html })).toBeGreaterThan(10_000)
    expect(commandBytes({ t: 'slide.move', id: 's', to: 1 })).toBeLessThan(1000)
    expect(commandBytes({ t: 'slide.setNotes', id: 's', notes: null })).toBeLessThan(1000)
  })

  it('never throws on a payload JSON cannot serialize', () => {
    // An estimate feeding an eviction cap has no business throwing, and `structuredClone` — the
    // boundary these payloads have already cleared — accepts both of these.
    const bigint = createSlideEntry({ now: T0 + 81 }) as Record<string, unknown>
    bigint['weight'] = 10n
    const cyclic = createSlideEntry({ now: T0 + 82 }) as Record<string, unknown>
    cyclic['self'] = cyclic

    for (const slide of [bigint, cyclic]) {
      const command = { t: 'slide.insert', at: 0, slide, html: 'x' } as unknown as DocCommand
      expect(() => commandBytes(command)).not.toThrow()
      expect(Number.isFinite(commandBytes(command))).toBe(true)
      // Charged high, not low: an unmeasurable payload should be evicted sooner, not retained.
      expect(commandBytes(command)).toBeGreaterThan(1000)
    }
  })

  it('counts the slide entry an insert carries — which is every delete’s inverse', () => {
    const entry = createSlideEntry({ now: T0 + 80, title: 'Counted', withNotes: true })
    const html = 'x'.repeat(1000)
    const bytes = commandBytes({ t: 'slide.insert', at: 0, slide: entry, html, notes: 'n' })
    expect(bytes).toBeGreaterThan(html.length + JSON.stringify(entry).length)
  })
})
