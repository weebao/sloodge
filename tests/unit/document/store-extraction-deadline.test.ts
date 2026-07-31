import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { addSlide, createEmptyDeck, createSlideEntry } from '../../../src/shared/document/deck'
import { createStarterSlideHtml } from '../../../src/shared/document/starter-slide'
import { packDeck, readDeck, type DeckBundle } from '../../../src/main/document/store'

/**
 * `extractMembers` hands control back to the event loop between members through
 * `node:timers`' `setImmediate`. Swallowing that callback is an injected hang *inside* the
 * extraction promise — the shape the racing deadline timer exists for and the only thing that
 * distinguishes it from the in-loop `Date.now() > deadline` checks, which a stalled loop can
 * never reach. This lives in its own file because the mock is module-wide.
 */
vi.mock('node:timers', () => ({
  setImmediate: () => undefined,
}))

let dir = ''

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'sloodge-deadline-'))
})

function fixtureBundle(): DeckBundle {
  const slide = createSlideEntry({ now: 1_770_000_000_000, title: 'Only slide' })
  const manifest = addSlide(
    createEmptyDeck({ now: 1_770_000_000_000, title: 'Deadline fixture' }),
    slide,
  )
  return {
    manifest,
    slides: { [slide.id]: createStarterSlideHtml({ id: slide.id, title: 'Only slide' }) },
    notes: {},
    theme: null,
    extras: {},
  }
}

describe('the racing extraction deadline (r5 M2c)', () => {
  it('settles a read whose extraction hangs mid-loop, by the timer rather than the loop check', async () => {
    const path = join(dir, 'hung-extraction.sloodge')
    await writeFile(path, await packDeck(fixtureBundle()))

    const started = Date.now()
    const result = await readDeck(path, { extractionTimeoutMs: 25 })
    const elapsed = Date.now() - started

    // Without the racing timer this promise never settles and the test dies of its own timeout.
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('extraction-timeout')
    // `extraction exceeded …` is the *timer's* message; the in-loop checks say `timed out …`.
    expect(result.error.message).toContain('extraction exceeded 25 ms')
    expect(elapsed).toBeLessThan(2_000)
  })
})
